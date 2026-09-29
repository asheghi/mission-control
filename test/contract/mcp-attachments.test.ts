// Attachment tools over a real MCP client, on the in-memory transport.
//
// The contract these assert is what an agent actually depends on: metadata that
// never leaks a storage key, a small image a model can see, and honest refusals
// for things MCP is the wrong transport for.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initializeDatabase } from "../../src/db/database";
import { WorkboardService } from "../../src/app/workboard";
import { FilesystemBlobStore } from "../../src/storage/fs";
import { buildMcpServer } from "../../src/mcp/tools";
import type { Actor } from "../../src/domain/types";

const PNG = readFileSync(join(import.meta.dir, "../fixtures/media/probe.png"));
const MP4 = readFileSync(join(import.meta.dir, "../fixtures/media/probe.mp4"));

interface Session {
  readonly client: Client;
  readonly itemId: number;
  readonly db: Database;
  readonly close: () => Promise<void>;
}

async function withClient<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "wb-mcp-att-"));
  const db = initializeDatabase(dir);
  const blobs = new FilesystemBlobStore({ directory: join(dir, "blobs") });
  const service = new WorkboardService(db, undefined, undefined, { blobs });
  const alice = service.createParticipant({ participantId: 0, name: "bootstrap", kind: "human" }, { name: "alice", kind: "human" });
  const actor: Actor = { participantId: alice.id, name: "alice", kind: "human" };
  const itemId = service.createItem(actor, { title: "bug with screenshot" }).item.id;

  const server = buildMcpServer(service, actor);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const session: Session = {
    client,
    itemId,
    db,
    close: async () => {
      await client.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

interface Content {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

async function call(session: Session, name: string, args: Record<string, unknown>) {
  const result = (await session.client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return result;
}

function textOf(result: { content: Content[] }): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

describe("MCP attachment tools", () => {
  test("expose the full set alongside the original nine", async () => {
    await withClient(async (session) => {
      const tools = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toHaveLength(14);
      for (const name of ["list_attachments", "get_attachment", "view_attachment", "attach_file", "delete_attachment"]) {
        expect(tools).toContain(name);
      }
    });
  });

  test("attach a file, list it, read it, and delete it", async () => {
    await withClient(async (session) => {
      const attached = await call(session, "attach_file", {
        id: session.itemId,
        filename: "shot.png",
        mediaType: "image/png",
        contentBase64: PNG.toString("base64"),
      });
      expect(attached.isError).toBeFalsy();
      const attachment = JSON.parse(textOf(attached)) as { id: number; sizeBytes: number; kind: string; contentPath: string };
      expect(attachment.sizeBytes).toBe(PNG.byteLength);
      expect(attachment.kind).toBe("image");
      expect(attachment.contentPath).toBe(`/api/attachments/${attachment.id}/content`);

      const listed = await call(session, "list_attachments", { id: session.itemId });
      expect((JSON.parse(textOf(listed)) as { attachments: unknown[] }).attachments).toHaveLength(1);

      const fetched = await call(session, "get_attachment", { id: attachment.id });
      const metadata = JSON.parse(textOf(fetched)) as Record<string, unknown>;
      expect(metadata["filename"]).toBe("shot.png");
      // The storage key names an object in the backend and is not a caller's
      // business: it must not appear in any tool result.
      expect(JSON.stringify(metadata)).not.toContain("storageKey");

      const deleted = await call(session, "delete_attachment", { id: attachment.id });
      expect((JSON.parse(textOf(deleted)) as { deleted: boolean }).deleted).toBe(true);
      const after = await call(session, "get_attachment", { id: attachment.id });
      expect(after.isError).toBe(true);
    });
  });

  test("view_attachment returns a small image as an image block", async () => {
    await withClient(async (session) => {
      const attached = await call(session, "attach_file", {
        id: session.itemId,
        filename: "shot.png",
        mediaType: "image/png",
        contentBase64: PNG.toString("base64"),
      });
      const id = (JSON.parse(textOf(attached)) as { id: number }).id;
      const viewed = await call(session, "view_attachment", { id });
      expect(viewed.content.map((block) => block.type)).toEqual(["text", "image"]);
      const image = viewed.content.find((block) => block.type === "image");
      expect(image?.mimeType).toBe("image/png");
      // The base64 must be the actual bytes, not a placeholder.
      expect(Buffer.from(image?.data ?? "", "base64").byteLength).toBe(PNG.byteLength);
    });
  });

  test("view_attachment refuses video and points at REST", async () => {
    await withClient(async (session) => {
      const attached = await call(session, "attach_file", {
        id: session.itemId,
        filename: "clip.mp4",
        mediaType: "video/mp4",
        contentBase64: MP4.toString("base64"),
      });
      const id = (JSON.parse(textOf(attached)) as { id: number }).id;
      const viewed = await call(session, "view_attachment", { id });
      expect(viewed.content.map((block) => block.type)).toEqual(["text"]);
      expect(textOf(viewed)).toContain("does not return video");
      expect(textOf(viewed)).toContain("/content");
    });
  });

  test("refuse a file whose bytes contradict the declared type", async () => {
    await withClient(async (session) => {
      const svg = await call(session, "attach_file", {
        id: session.itemId,
        filename: "x.png",
        mediaType: "image/png",
        contentBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64"),
      });
      expect(svg.isError).toBe(true);
      expect(textOf(svg)).toContain("not a recognised image or video");
    });
  });

  test("report malformed base64 as an encoding problem, not a bad file", async () => {
    await withClient(async (session) => {
      // Buffer.from would silently decode this to garbage and the caller would
      // be told their media type was wrong.
      const result = await call(session, "attach_file", {
        id: session.itemId,
        filename: "x.png",
        mediaType: "image/png",
        contentBase64: "!!!not base64!!!",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not valid base64");
    });
  });

  test("refuse an attachment larger than the tool limit", async () => {
    await withClient(async (session) => {
      const result = await call(session, "attach_file", {
        id: session.itemId,
        filename: "big.png",
        mediaType: "image/png",
        contentBase64: "A".repeat(8 * 1024 * 1024),
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("tool limit");
    });
  });

  test("report an unknown attachment as an expected error, not a crash", async () => {
    await withClient(async (session) => {
      const result = await call(session, "get_attachment", { id: 999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("was not found");
    });
  });
});

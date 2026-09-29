// Attachment REST routes over a real Bun.serve instance: upload, metadata,
// content with ranges, and deletion. Driven through fetch, the way a client
// does, rather than by calling the service directly.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { WorkboardEventBroker } from "../../../src/app/events";
import { FilesystemBlobStore } from "../../../src/storage/fs";
import { createApiHandler } from "../../../src/api/app";
import { authenticate, issueToken } from "../../../src/auth/service";
import { parseRangeHeader, resolveRange } from "../../../src/api/attachments";
import type { Actor } from "../../../src/domain/types";

const PNG = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.png"));
const MP4 = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.mp4"));

interface Api {
  readonly base: string;
  readonly auth: Record<string, string>;
  readonly itemId: number;
  readonly db: Database;
  readonly dir: string;
  stop(): void;
}

function withApi<T>(fn: (api: Api) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "wb-att-http-"));
  const db = initializeDatabase(dir);
  const blobs = new FilesystemBlobStore({ directory: join(dir, "blobs") });
  const broker = new WorkboardEventBroker();
  const service = new WorkboardService(db, undefined, broker, { blobs });
  const alice = service.createParticipant({ participantId: 0, name: "bootstrap", kind: "human" }, { name: "alice", kind: "human" });
  const actor: Actor = { participantId: alice.id, name: "alice", kind: "human" };
  const token = issueToken(db, { participantId: alice.id, name: "t", now: new Date().toISOString() }).plaintext;
  const itemId = service.createItem(actor, { title: "shots" }).item.id;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApiHandler({ service, broker, authenticate: (credential, now) => authenticate(db, credential, now) }),
  });
  const api: Api = {
    base: `http://127.0.0.1:${server.port}`,
    auth: { Authorization: `Bearer ${token}` },
    itemId,
    db,
    dir,
    stop: () => {
      server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return Promise.resolve(fn(api)).finally(() => api.stop());
}

function upload(api: Api, bytes: Uint8Array, type: string, filename = "shot.png") {
  return fetch(`${api.base}/api/items/${api.itemId}/attachments`, {
    method: "POST",
    headers: { ...api.auth, "content-type": type, "x-filename": encodeURIComponent(filename) },
    body: new Blob([bytes]).stream(),
  });
}

describe("attachment upload over HTTP", () => {
  test("stores an image and returns its metadata without a storage key", async () => {
    await withApi(async (api) => {
      const response = await upload(api, PNG, "image/png", "a shot.png");
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: Record<string, unknown> };
      expect(body.data["filename"]).toBe("a shot.png");
      expect(body.data["sizeBytes"]).toBe(PNG.byteLength);
      expect(body.data["mediaType"]).toBe("image/png");
      expect(body.data["contentPath"]).toBe(`/api/attachments/${body.data["id"]}/content`);
      expect(JSON.stringify(body)).not.toContain("storageKey");
      expect(JSON.stringify(body)).not.toContain("attachments/2");
    });
  });

  test("accepts a video and reports its kind", async () => {
    await withApi(async (api) => {
      const response = await upload(api, MP4, "video/mp4", "clip.mp4");
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { kind: string } };
      expect(body.data.kind).toBe("video");
    });
  });

  test("refuses SVG, a lying content type, and unrecognisable bytes", async () => {
    await withApi(async (api) => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      expect((await upload(api, svg, "image/svg+xml")).status).toBe(400);
      expect((await upload(api, PNG, "image/jpeg")).status).toBe(400);
      expect((await upload(api, new Uint8Array([1, 2, 3, 4]), "image/png")).status).toBe(400);
      // A refused upload stores nothing at all.
      const listed = await fetch(`${api.base}/api/items/${api.itemId}/attachments`, { headers: api.auth });
      expect(((await listed.json()) as { data: unknown[] }).data).toEqual([]);
    });
  });

  test("requires authentication to upload", async () => {
    await withApi(async (api) => {
      const response = await fetch(`${api.base}/api/items/${api.itemId}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Blob([PNG]).stream(),
      });
      expect(response.status).toBe(401);
    });
  });

  test("uploads to a comment as well as an item", async () => {
    await withApi(async (api) => {
      const service = new WorkboardService(api.db);
      void service;
      // Create a comment through the REST surface so the target is real.
      const created = await fetch(`${api.base}/api/items/${api.itemId}/comments`, {
        method: "POST",
        headers: { ...api.auth, "content-type": "application/json" },
        body: JSON.stringify({ body: "look" }),
      });
      const commentId = ((await created.json()) as { data: { comment: { id: number } } }).data.comment.id;
      const response = await fetch(`${api.base}/api/comments/${commentId}/attachments`, {
        method: "POST",
        headers: { ...api.auth, "content-type": "image/png" },
        body: new Blob([PNG]).stream(),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { commentId: number; itemId: number | null } };
      expect(body.data.commentId).toBe(commentId);
      expect(body.data.itemId).toBeNull();

      const listed = await fetch(`${api.base}/api/comments/${commentId}/attachments`, { headers: api.auth });
      expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
    });
  });
});

describe("attachment content over HTTP", () => {
  test("serves the bytes with hardening headers and no caching", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { id: number; contentPath: string } };
      const response = await fetch(`${api.base}${created.data.contentPath}`, { headers: api.auth });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      // These hold the line against an upload that a browser would execute.
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("content-disposition")).toContain("inline");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(Buffer.compare(Buffer.from(bytes), PNG)).toBe(0);
    });
  });

  test("refuses anonymous access to content", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { contentPath: string } };
      expect((await fetch(`${api.base}${created.data.contentPath}`)).status).toBe(401);
    });
  });

  test("serves bounded, suffix, and open-ended ranges", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { contentPath: string } };
      const url = `${api.base}${created.data.contentPath}`;

      const bounded = await fetch(url, { headers: { ...api.auth, range: "bytes=0-7" } });
      expect(bounded.status).toBe(206);
      expect(Array.from(new Uint8Array(await bounded.arrayBuffer()))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(bounded.headers.get("content-range")).toBe(`bytes 0-7/${PNG.byteLength}`);

      const suffix = await fetch(url, { headers: { ...api.auth, range: "bytes=-4" } });
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("content-range")).toBe(`bytes ${PNG.byteLength - 4}-${PNG.byteLength - 1}/${PNG.byteLength}`);
      expect((await suffix.arrayBuffer()).byteLength).toBe(4);

      const open = await fetch(url, { headers: { ...api.auth, range: `bytes=${PNG.byteLength - 3}-` } });
      expect(open.status).toBe(206);
      expect((await open.arrayBuffer()).byteLength).toBe(3);

      // An end past the object is clamped rather than refused.
      const clamped = await fetch(url, { headers: { ...api.auth, range: "bytes=0-999999" } });
      expect(clamped.status).toBe(206);
      expect((await clamped.arrayBuffer()).byteLength).toBe(PNG.byteLength);
    });
  });

  test("answers an unsatisfiable range with 416 and the object size", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { contentPath: string } };
      const response = await fetch(`${api.base}${created.data.contentPath}`, {
        headers: { ...api.auth, range: `bytes=${PNG.byteLength + 50}-` },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${PNG.byteLength}`);
    });
  });

  test("ignores a multi-range request and sends the whole representation", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { contentPath: string } };
      const response = await fetch(`${api.base}${created.data.contentPath}`, {
        headers: { ...api.auth, range: "bytes=0-3,5-9" },
      });
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(PNG.byteLength);
    });
  });

  test("HEAD reports metadata with no body", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { contentPath: string } };
      const response = await fetch(`${api.base}${created.data.contentPath}`, { method: "HEAD", headers: api.auth });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    });
  });

  test("reports a missing attachment as 404", async () => {
    await withApi(async (api) => {
      expect((await fetch(`${api.base}/api/attachments/999/content`, { headers: api.auth })).status).toBe(404);
      expect((await fetch(`${api.base}/api/attachments/999`, { headers: api.auth })).status).toBe(404);
    });
  });
});

describe("attachment metadata and deletion over HTTP", () => {
  test("lists, fetches, and deletes an attachment", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { id: number; contentPath: string } };
      const listed = await fetch(`${api.base}/api/items/${api.itemId}/attachments`, { headers: api.auth });
      expect(((await listed.json()) as { data: Array<{ id: number }> }).data.map((a) => a.id)).toEqual([created.data.id]);

      const single = await fetch(`${api.base}/api/attachments/${created.data.id}`, { headers: api.auth });
      expect(single.status).toBe(200);

      const deleted = await fetch(`${api.base}/api/attachments/${created.data.id}`, { method: "DELETE", headers: api.auth });
      expect(deleted.status).toBe(200);
      // Gone from both the metadata and the content route.
      expect((await fetch(`${api.base}/api/attachments/${created.data.id}`, { headers: api.auth })).status).toBe(404);
      expect((await fetch(`${api.base}${created.data.contentPath}`, { headers: api.auth })).status).toBe(404);
    });
  });
});

describe("range parsing", () => {
  test("accepts the forms a media client sends", () => {
    expect(parseRangeHeader("bytes=0-99")).toEqual({ kind: "bounded", start: 0, endInclusive: 99 });
    expect(parseRangeHeader("bytes=100-")).toEqual({ kind: "open", start: 100 });
    expect(parseRangeHeader("bytes=-50")).toEqual({ kind: "suffix", length: 50 });
    expect(parseRangeHeader(null)).toBeNull();
  });

  test("ignores forms it does not implement rather than guessing", () => {
    expect(parseRangeHeader("bytes=0-3,5-9")).toBeNull();
    expect(parseRangeHeader("items=0-3")).toBeNull();
    expect(parseRangeHeader("bytes=-")).toBeNull();
    expect(parseRangeHeader("bytes=10-5")).toBeNull();
    expect(parseRangeHeader("bytes=abc-def")).toBeNull();
  });

  test("resolves ranges against the object size, clamping and refusing", () => {
    expect(resolveRange({ kind: "bounded", start: 0, endInclusive: 99 }, 10)).toEqual({ start: 0, endInclusive: 9 });
    expect(resolveRange({ kind: "suffix", length: 4 }, 10)).toEqual({ start: 6, endInclusive: 9 });
    // A suffix longer than the object means the whole object.
    expect(resolveRange({ kind: "suffix", length: 99 }, 10)).toEqual({ start: 0, endInclusive: 9 });
    expect(resolveRange({ kind: "open", start: 5 }, 10)).toEqual({ start: 5, endInclusive: 9 });
    // Past the end is unsatisfiable, not a truncated read.
    expect(resolveRange({ kind: "open", start: 10 }, 10)).toBeNull();
    expect(resolveRange({ kind: "bounded", start: 50, endInclusive: 60 }, 10)).toBeNull();
    expect(resolveRange({ kind: "suffix", length: 1 }, 0)).toBeNull();
  });
});

describe("range protocol details", () => {
  test("HEAD ignores Range and describes the whole resource", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { contentPath: string } };
      // A 206 to a HEAD would tell a client the resource is shorter than it is.
      const response = await fetch(`${api.base}${created.data.contentPath}`, {
        method: "HEAD",
        headers: { ...api.auth, range: "bytes=0-7" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("content-length")).toBe(String(PNG.byteLength));
    });
  });

  test("advertises an ETag derived from the stored bytes", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { contentPath: string; sha256: string } };
      const response = await fetch(`${api.base}${created.data.contentPath}`, { headers: api.auth });
      expect(response.headers.get("etag")).toBe(`"${created.data.sha256}"`);
    });
  });

  test("If-Range decides between a partial and the full body", async () => {
    await withApi(async (api) => {
      const created = (await (await upload(api, PNG, "image/png")).json()) as { data: { contentPath: string; sha256: string } };
      const url = `${api.base}${created.data.contentPath}`;

      // A matching validator: the range is honoured.
      const matching = await fetch(url, {
        headers: { ...api.auth, range: "bytes=0-7", "if-range": `"${created.data.sha256}"` },
      });
      expect(matching.status).toBe(206);
      expect((await matching.arrayBuffer()).byteLength).toBe(8);

      // A stale validator: answering 206 would let a client splice two versions
      // of the file together, so the whole representation is sent instead.
      const stale = await fetch(url, {
        headers: { ...api.auth, range: "bytes=0-7", "if-range": '"not-the-current-etag"' },
      });
      expect(stale.status).toBe(200);
      expect((await stale.arrayBuffer()).byteLength).toBe(PNG.byteLength);
    });
  });
});

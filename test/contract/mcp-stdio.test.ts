// Task 10 black-box tests: the stdio MCP server runs in a real subprocess
// (bun run src/entry.ts mcp --data <tmp> --as <name>) and is driven by the
// official SDK client; persistence and actor attribution are verified by
// reading the same SQLite file afterwards.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";

const ENTRY = join(import.meta.dir, "../../src/entry.ts");

function toolText(result: unknown): any {
  const typed = result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  expect(typed.isError ?? false, `tool error text: ${typed.content[0]?.text ?? "<none>"}`).toBe(false);
  return JSON.parse(typed.content[0]?.text ?? "null");
}

describe("stdio MCP server", () => {
  test("exposes the nine tools and persists attributed work", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", ENTRY, "mcp", "--data", dataDir, "--as", "bridge-agent"],
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect([...tools.map((tool) => tool.name)].sort()).toEqual([
        "add_work_relationship",
        "comment",
        "create_work",
        "get_work",
        "list_work",
        "my_work",
        "remove_work_relationship",
        "reorder_work",
        "update_work",
      ]);

      const created = toolText(
        await client.callTool({ name: "create_work", arguments: { title: "Via stdio", priority: 1 } }),
      );
      expect(created.item.title).toBe("Via stdio");
      expect(typeof created.item.createdBy).toBe("number");

      const commented = toolText(
        await client.callTool({ name: "comment", arguments: { id: created.item.id, body: "first!" } }),
      );
      expect(commented.comment.body).toBe("first!");
      expect(commented.comment.author.id).toBe(created.item.createdBy);

      // The creator is not automatically in their own queue: assign it first.
      const assigned = toolText(
        await client.callTool({
          name: "update_work",
          arguments: { id: created.item.id, assigneeId: created.item.createdBy },
        }),
      );
      expect(assigned.changedFields).toEqual(["assignee"]);

      const mine = toolText(await client.callTool({ name: "my_work", arguments: {} }));
      expect(mine.items.map((entry: { item: { id: number } }) => entry.item.id)).toContain(created.item.id);
    } finally {
      await client.close();
    }

    // Independent verification: read the same database from this process.
    const db = openDatabase(dataDir);
    try {
      const item = db.query("SELECT title FROM items WHERE title = 'Via stdio'").get() as
        | { title: string }
        | undefined;
      expect(item?.title).toBe("Via stdio");
      const actor = db
        .query("SELECT p.name, p.kind FROM items i JOIN participants p ON p.id = i.created_by WHERE i.title = 'Via stdio'")
        .get() as { name: string; kind: string } | undefined;
      expect(actor?.name).toBe("bridge-agent");
      expect(actor?.kind).toBe("agent");
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});

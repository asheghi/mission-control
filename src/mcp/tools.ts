// The six MCP tools exposed to agents (my_work, list_work, get_work,
// create_work, update_work, comment). The server instance is built per
// request/call and bound to the actor derived from the presented credential —
// never from tool arguments.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Actor } from "../domain/types";
import { workStatusSchema } from "../domain/validation";
import { resolveItemQuery } from "../app/item-query";
import type { WorkboardService } from "../app/workboard";
import { APP_VERSION } from "../version";
import { mcpErrorResult } from "./error-result";
import type { McpToolResult } from "./error-result";

function jsonTool(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const idSchema = z.number().int().positive();

export function buildMcpServer(service: WorkboardService, actor: Actor): McpServer {
  const server = new McpServer({ name: "workboard", version: APP_VERSION });

  server.registerTool(
    "my_work",
    {
      description:
        "The calling participant's own work queue: items assigned to or mentioning them, open items first, then most recently updated.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(512).optional(),
      },
    },
    async (args) => {
      try {
        const result = service.myWork(actor, args);
        return jsonTool({ items: result.items, nextCursor: result.nextCursor });
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "list_work",
    {
      description:
        "List work items with optional filters: status (todo|doing|blocked|done), assignee (participant name, numeric id, or \"unassigned\"), label name, free-text q, and limit (1-100, default 50).",
      inputSchema: {
        status: workStatusSchema.optional(),
        assignee: z.string().min(1).max(120).optional(),
        label: z.string().min(1).max(120).optional(),
        q: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(512).optional(),
      },
    },
    async (args) => {
      try {
        const { filter, emptyResult } = resolveItemQuery(service, actor, args);
        if (emptyResult) return jsonTool({ items: [], nextCursor: null });
        const result = service.listItems(actor, filter);
        return jsonTool({ items: result.items, nextCursor: result.nextCursor });
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_work",
    {
      description: "Fetch one work item by id, including its comments and history.",
      inputSchema: { id: idSchema },
    },
    async ({ id }) => {
      try {
        return jsonTool(service.getItem(actor, id));
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "create_work",
    {
      description:
        "Create a work item: title (required), optional body, priority (0-3, default 2), assigneeId (participant id or null), and label names.",
      inputSchema: {
        title: z.string().min(1).max(120),
        body: z.string().max(10_000).optional(),
        priority: z.number().int().min(0).max(3).optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
        labels: z.array(z.string().min(1).max(120)).optional(),
      },
    },
    async (args) => {
      try {
        return jsonTool(service.createItem(actor, args));
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "update_work",
    {
      description:
        "Partially update a work item by id: title, body, status, priority, assigneeId (null unassigns), labels (replaces the set). Only provided fields change.",
      inputSchema: {
        id: idSchema,
        title: z.string().min(1).max(120).optional(),
        body: z.string().max(10_000).optional(),
        status: workStatusSchema.optional(),
        priority: z.number().int().min(0).max(3).optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
        labels: z.array(z.string().min(1).max(120)).optional(),
      },
    },
    async ({ id, ...patch }) => {
      try {
        const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
        const result = service.updateItem(actor, id, defined);
        return jsonTool({ ...result, changedFields: result.changedFields });
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "comment",
    {
      description:
        "Add a comment to a work item. Mentions (@name) notify the mentioned participant and surface the item in their queue.",
      inputSchema: {
        id: idSchema,
        body: z.string().min(1).max(10_000),
      },
    },
    async ({ id, body }) => {
      try {
        const result = service.addComment(actor, id, { body });
        return jsonTool(result);
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  return server;
}

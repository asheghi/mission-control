// The nine MCP tools exposed to agents (my_work, list_work, get_work,
// create_work, update_work, comment, add_work_relationship,
// remove_work_relationship, reorder_work). The server instance is built per
// request/call and bound to the actor derived from the presented credential —
// never from tool arguments.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Actor } from "../domain/types";
import { itemRelationshipNameSchema, workItemTypeSchema, workStatusSchema } from "../domain/validation";
import { resolveItemQuery } from "../app/item-query";
import type { WorkboardService } from "../app/workboard";
import { APP_VERSION } from "../version";
import { mcpErrorResult } from "./error-result";
import type { McpToolResult } from "./error-result";

function jsonTool(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const idSchema = z.number().int().positive();

// Work-item types and relationship names are lowercase snake-case wire values.
// The descriptions spell the accepted set out literally so an agent never has
// to guess a spelling ("user story", "userStory", "UserStory") that the
// schema would reject.
const WORK_ITEM_TYPE_VALUES = "feature|user_story|bug|task";
const WORK_ITEM_TYPE_RULE =
  `Lowercase snake-case type: ${WORK_ITEM_TYPE_VALUES}. A Task must always have a parent, ` +
  "so type \"task\" is rejected without parentId; any type may parent any other type.";

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
        `List work items with optional type (${WORK_ITEM_TYPE_VALUES}), status, assignee, label, text, and pagination filters. ${WORK_ITEM_TYPE_RULE}`,
      inputSchema: {
        status: workStatusSchema.optional(),
        type: workItemTypeSchema.optional(),
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
      description: "Fetch one work item by id, including parent, children, relationships, comments, and history.",
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
        `Create a work item: title plus optional type, body, priority, assigneeId, parentId, and labels. ${WORK_ITEM_TYPE_RULE}`,
      inputSchema: {
        title: z.string().min(1).max(120),
        type: workItemTypeSchema.optional(),
        body: z.string().max(10_000).optional(),
        priority: z.number().int().min(0).max(3).optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
        parentId: z.number().int().positive().nullable().optional(),
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
        `Partially update a work item, including type or parentId. Only provided fields change. ${WORK_ITEM_TYPE_RULE}`,
      inputSchema: {
        id: idSchema,
        title: z.string().min(1).max(120).optional(),
        type: workItemTypeSchema.optional(),
        body: z.string().max(10_000).optional(),
        status: workStatusSchema.optional(),
        priority: z.number().int().min(0).max(3).optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
        parentId: z.number().int().positive().nullable().optional(),
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
    "add_work_relationship",
    {
      description:
        "Add a non-hierarchical relationship relative to id: related, predecessor, successor, duplicate, or duplicate_of.",
      inputSchema: { id: idSchema, name: itemRelationshipNameSchema, itemId: idSchema },
    },
    async ({ id, name, itemId }) => {
      try {
        return jsonTool(service.createRelationship(actor, id, { name, itemId }));
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "remove_work_relationship",
    {
      description: "Remove one relationship by its id from the selected work item.",
      inputSchema: { id: idSchema, relationshipId: idSchema },
    },
    async ({ id, relationshipId }) => {
      try {
        return jsonTool(service.deleteRelationship(actor, id, { relationshipId }));
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "reorder_work",
    {
      description:
        "Move a work item within sibling backlog order. parentId null means root; beforeId null appends. Tasks cannot move to root.",
      inputSchema: {
        id: idSchema,
        parentId: idSchema.nullable(),
        beforeId: idSchema.nullable().optional(),
      },
    },
    async ({ id, parentId, beforeId }) => {
      try {
        return jsonTool(service.reorderItem(actor, id, {
          parentId,
          ...(beforeId !== undefined ? { beforeId } : {}),
        }));
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

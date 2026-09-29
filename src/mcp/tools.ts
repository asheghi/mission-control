// The nine MCP tools exposed to agents (my_work, list_work, get_work,
// create_work, update_work, comment, add_work_relationship,
// remove_work_relationship, reorder_work). The server instance is built per
// request/call and bound to the actor derived from the presented credential —
// never from tool arguments.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ValidationError } from "../domain/errors";
import type { Actor } from "../domain/types";
import { itemRelationshipNameSchema, workItemTypeSchema, workStatusSchema } from "../domain/validation";
import { resolveItemQuery } from "../app/item-query";
import type { WorkboardService } from "../app/workboard";
import { APP_VERSION } from "../version";
import { mcpErrorResult } from "./error-result";
import { ATTACHMENT_MEDIA_TYPES, MCP_INLINE_IMAGE_MAX_BYTES, maxBytesFor, mediaKindOf } from "../domain/attachments";
import { streamBody } from "../api/response";
import type { McpToolResult } from "./error-result";

function jsonTool(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const idSchema = z.number().int().positive();

/**
 * Ceiling for an attachment that travels through a JSON tool argument.
 *
 * Base64 inflates by about a third and the whole payload is buffered, so a tool
 * call is the wrong transport for real media. This limit exists to make the
 * boundary explicit and refusable rather than to encourage it: anything larger
 * belongs on the REST upload route.
 */
export const MCP_ATTACH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Headroom a JSON-RPC envelope needs around a base64 payload.
 *
 * Base64 is 4 characters per 3 bytes, plus the JSON quoting, the method and
 * argument names, and a request id. Without this allowance the transport's body
 * cap would sit below the size the tool advertises, and a full-size attachment
 * would be rejected as 413 before the tool ever saw it.
 */
export const MCP_BASE64_ENVELOPE_OVERHEAD = Math.ceil((MCP_ATTACH_MAX_BYTES * 4) / 3) + 64 * 1024;

/**
 * Decode base64 with a hard size bound.
 *
 * The bound is applied to the decoded payload, and the encoded length is
 * checked first so a huge argument is rejected without allocating for it.
 */
function decodeBase64(input: string, maxBytes: number): Uint8Array {
  // 4 encoded characters carry at most 3 bytes; padding only shrinks the result.
  if (input.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new ValidationError(`Attachment content is larger than the ${maxBytes / (1024 * 1024)} MiB tool limit.`);
  }
  // `Buffer.from` is lenient: it skips characters it does not recognise and
  // silently yields different bytes. Verified — `!!!not base64!!!` decodes to
  // six bytes rather than failing. A caller whose base64 was malformed would
  // then be told their *file type* was wrong, which sends them looking in the
  // wrong place, so the encoding is checked before decoding.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.trim()) || input.trim().length % 4 !== 0) {
    throw new ValidationError("Attachment content is not valid base64.");
  }
  const decoded = Buffer.from(input.trim(), "base64");
  if (decoded.byteLength === 0) throw new ValidationError("Attachment content is not valid base64.");
  if (decoded.byteLength > maxBytes) {
    throw new ValidationError(`Attachment content is larger than the ${maxBytes / (1024 * 1024)} MiB tool limit.`);
  }
  return new Uint8Array(decoded);
}

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

  server.registerTool(
    "list_attachments",
    {
      description:
        `List the files attached to a work item (id, filename, mediaType, sizeBytes, contentPath). ` +
        `Accepted media types: ${ATTACHMENT_MEDIA_TYPES.join(", ")}. ` +
        "Fetch the bytes from contentPath with REST, or use view_attachment for a small image.",
      inputSchema: { id: idSchema },
    },
    async ({ id }) => {
      try {
        return jsonTool({ attachments: service.listItemAttachments(actor, id) });
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_attachment",
    {
      description: "Fetch one attachment's metadata by id. Never the stored object key.",
      inputSchema: { id: idSchema },
    },
    async ({ id }) => {
      try {
        return jsonTool(service.getAttachment(actor, id));
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "view_attachment",
    {
      description:
        `Return a small raster image (png, jpeg, webp, gif) up to ${MCP_INLINE_IMAGE_MAX_BYTES / (1024 * 1024)} MiB ` +
        "as an image the model can see. Video and larger images are refused: fetch those from contentPath over REST.",
      inputSchema: { id: idSchema },
    },
    async ({ id }) => {
      try {
        const attachment = service.getAttachment(actor, id);
        const kind = mediaKindOf(attachment.mediaType);
        if (kind === "video") {
          return jsonTool({
            error: "view_attachment does not return video.",
            attachment,
            hint: `Fetch ${attachment.contentPath} over REST instead.`,
          });
        }
        if (attachment.sizeBytes > MCP_INLINE_IMAGE_MAX_BYTES) {
          return jsonTool({
            error: `Image is larger than the ${MCP_INLINE_IMAGE_MAX_BYTES / (1024 * 1024)} MiB inline limit.`,
            attachment,
            hint: `Fetch ${attachment.contentPath} over REST instead.`,
          });
        }
        const opened = await service.openAttachment(actor, id);
        const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ attachment }) },
            { type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: attachment.mediaType },
          ],
        };
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "attach_file",
    {
      description:
        `Attach one image or video to a work item. Content is base64 in the request, so it is intentionally capped at ` +
        `${MCP_ATTACH_MAX_BYTES / (1024 * 1024)} MiB; larger media, and video of any size worth sending, must use the REST ` +
        `route POST /api/items/<id>/attachments. Accepted media types: ${ATTACHMENT_MEDIA_TYPES.join(", ")}; ` +
        "the declared mediaType is verified against the bytes.",
      inputSchema: {
        id: idSchema,
        filename: z.string().min(1).max(255),
        mediaType: z.enum(ATTACHMENT_MEDIA_TYPES),
        contentBase64: z.string().min(1),
      },
    },
    async ({ id, filename, mediaType, contentBase64 }) => {
      try {
        const bytes = decodeBase64(contentBase64, MCP_ATTACH_MAX_BYTES);
        const request = new Request("http://localhost/upload", {
          method: "POST",
          headers: { "content-type": mediaType },
          body: new Blob([bytes]).stream(),
        });
        const attachment = await service.uploadAttachment(actor, {
          itemId: id,
          declaredMediaType: mediaType,
          filename,
          body: streamBody(request, maxBytesFor(mediaType), 64),
        });
        return jsonTool(attachment);
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  server.registerTool(
    "delete_attachment",
    {
      description: "Delete an attachment and its stored bytes.",
      inputSchema: { id: idSchema },
    },
    async ({ id }) => {
      try {
        await service.deleteAttachment(actor, id);
        return jsonTool({ id, deleted: true });
      } catch (error) {
        return mcpErrorResult(error);
      }
    },
  );

  return server;
}

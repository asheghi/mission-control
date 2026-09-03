import { NotFoundError } from "../domain/errors";
import type { WorkboardService } from "../app/workboard";
import { jsonSuccess, readJsonBody } from "./response";
import type { HttpRouter } from "./router";

export interface ItemRouteDeps {
  readonly service: WorkboardService;
  readonly maxBodyBytes: number;
}

export function registerItemRoutes(router: HttpRouter, deps: ItemRouteDeps): void {
  router.add("GET", "/api/items", (ctx) => {
    const { filter, resolveAssigneeName } = parseItemListFilter(ctx.url);
    if (resolveAssigneeName !== undefined) {
      // Unknown assignee name is a filter, not an error: no matches.
      const participants = deps.service.listParticipants(ctx.actor);
      const match = participants.find((p) => p.name.toLowerCase() === resolveAssigneeName.toLowerCase());
      if (match === undefined) {
        return jsonSuccess([], { nextCursor: null }, ctx.requestId);
      }
      filter.assigneeId = match.id;
    }
    const result = deps.service.listItems(ctx.actor, filter);
    return jsonSuccess(result.items, { nextCursor: result.nextCursor }, ctx.requestId);
  });

  router.add("POST", "/api/items", async (ctx) => {
    const input = await readJsonBody(ctx.request, deps.maxBodyBytes);
    const detail = deps.service.createItem(ctx.actor, input);
    return jsonSuccess(detail, undefined, ctx.requestId, 201);
  });

  router.add("GET", "/api/items/:id", (ctx) => {
    const detail = deps.service.getItem(ctx.actor, parseIdParam(ctx.params.id));
    return jsonSuccess(detail, undefined, ctx.requestId);
  });

  router.add("PATCH", "/api/items/:id", async (ctx) => {
    const patch = await readJsonBody(ctx.request, deps.maxBodyBytes);
    const result = deps.service.updateItem(ctx.actor, parseIdParam(ctx.params.id), patch);
    return jsonSuccess(result, undefined, ctx.requestId);
  });

  router.add("DELETE", "/api/items/:id", (ctx) => {
    const id = parseIdParam(ctx.params.id);
    deps.service.deleteItem(ctx.actor, id);
    return jsonSuccess({ id, deleted: true }, undefined, ctx.requestId);
  });

  router.add("POST", "/api/items/:id/comments", async (ctx) => {
    const input = await readJsonBody(ctx.request, deps.maxBodyBytes);
    const result = deps.service.addComment(ctx.actor, parseIdParam(ctx.params.id), input);
    return jsonSuccess(result, undefined, ctx.requestId, 201);
  });

  router.add("GET", "/api/me/work", (ctx) => {
    const filter: Record<string, unknown> = {};
    const status = single(ctx.url, "status");
    if (status !== undefined) filter.status = status;
    const limit = single(ctx.url, "limit");
    if (limit !== undefined) filter.limit = Number(limit);
    const cursor = single(ctx.url, "cursor");
    if (cursor !== undefined) filter.cursor = cursor;

    const result = deps.service.myWork(ctx.actor, filter);
    return jsonSuccess(result.items, { nextCursor: result.nextCursor }, ctx.requestId);
  });
}

function single(url: URL, key: string): string | undefined {
  return url.searchParams.get(key) ?? undefined;
}

interface ParsedItemListFilter {
  readonly filter: Record<string, unknown>;
  readonly resolveAssigneeName?: string;
}

function parseItemListFilter(url: URL): ParsedItemListFilter {
  const filter: Record<string, unknown> = {};

  const status = single(url, "status");
  if (status !== undefined) filter.status = status;

  let resolveAssigneeName: string | undefined;
  const assignee = single(url, "assignee");
  if (assignee !== undefined) {
    if (assignee === "unassigned") {
      filter.unassigned = true;
    } else if (/^\d+$/.test(assignee)) {
      filter.assigneeId = Number(assignee);
    } else {
      resolveAssigneeName = assignee;
    }
  }

  const label = single(url, "label");
  if (label !== undefined) filter.labelName = label;

  const q = single(url, "q");
  if (q !== undefined) filter.q = q;

  const limit = single(url, "limit");
  if (limit !== undefined) filter.limit = Number(limit);

  const cursor = single(url, "cursor");
  if (cursor !== undefined) filter.cursor = cursor;

  return {
    filter,
    ...(resolveAssigneeName !== undefined ? { resolveAssigneeName } : {}),
  };
}

export function parseIdParam(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new NotFoundError("item", raw ?? "");
  }
  return id;
}

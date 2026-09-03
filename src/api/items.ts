import { NotFoundError } from "../domain/errors";
import type { WorkboardService } from "../app/workboard";
import { resolveItemQuery } from "../app/item-query";
import type { RawItemQuery } from "../app/item-query";
import { jsonSuccess, readJsonBody } from "./response";
import type { HttpRouter } from "./router";

export interface ItemRouteDeps {
  readonly service: WorkboardService;
  readonly maxBodyBytes: number;
}

export function registerItemRoutes(router: HttpRouter, deps: ItemRouteDeps): void {
  router.add("GET", "/api/items", (ctx) => {
    const status = single(ctx.url, "status");
    const assignee = single(ctx.url, "assignee");
    const label = single(ctx.url, "label");
    const q = single(ctx.url, "q");
    const limit = single(ctx.url, "limit");
    const cursor = single(ctx.url, "cursor");
    const raw: RawItemQuery = {
      ...(status !== undefined ? { status } : {}),
      ...(assignee !== undefined ? { assignee } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };

    const { filter, emptyResult } = resolveItemQuery(deps.service, ctx.actor, raw);
    if (emptyResult) {
      // Unknown assignee name is a filter, not an error: no matches.
      return jsonSuccess([], { nextCursor: null }, ctx.requestId);
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

export function parseIdParam(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new NotFoundError("item", raw ?? "");
  }
  return id;
}

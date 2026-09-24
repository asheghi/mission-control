import type { WorkboardService } from "../app/workboard";
import { parseIdParam } from "./items";
import { jsonSuccess, readJsonBody } from "./response";
import type { HttpRouter } from "./router";

export interface ParticipantRouteDeps {
  readonly service: WorkboardService;
  readonly maxBodyBytes: number;
}

export function registerParticipantRoutes(router: HttpRouter, deps: ParticipantRouteDeps): void {
  router.add("GET", "/api/participants", (ctx) => {
    return jsonSuccess(deps.service.listParticipants(ctx.actor), undefined, ctx.requestId);
  });

  router.add("POST", "/api/participants", async (ctx) => {
    const input = await readJsonBody(ctx.request, deps.maxBodyBytes);
    const participant = deps.service.createParticipant(ctx.actor, input);
    return jsonSuccess(participant, undefined, ctx.requestId, 201);
  });

  router.add("PATCH", "/api/participants/:id", async (ctx) => {
    const input = await readJsonBody(ctx.request, deps.maxBodyBytes);
    const participant = deps.service.renameParticipant(ctx.actor, parseIdParam(ctx.params.id), input);
    return jsonSuccess(participant, undefined, ctx.requestId);
  });
}

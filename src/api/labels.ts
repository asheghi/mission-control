import type { WorkboardService } from "../app/workboard";
import { jsonSuccess, readJsonBody } from "./response";
import type { HttpRouter } from "./router";

export interface LabelRouteDeps {
  readonly service: WorkboardService;
  readonly maxBodyBytes: number;
}

export function registerLabelRoutes(router: HttpRouter, deps: LabelRouteDeps): void {
  router.add("GET", "/api/labels", (ctx) => {
    return jsonSuccess(deps.service.listLabels(ctx.actor), undefined, ctx.requestId);
  });

  router.add("POST", "/api/labels", async (ctx) => {
    const input = await readJsonBody(ctx.request, deps.maxBodyBytes);
    const label = deps.service.createLabel(ctx.actor, input);
    return jsonSuccess(label, undefined, ctx.requestId, 201);
  });
}

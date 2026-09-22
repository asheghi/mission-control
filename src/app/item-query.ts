// Shared list-query interpretation for transports (REST + MCP): turn raw
// string/number fields into a service filter. Assignee accepts "unassigned",
// a numeric participant id, or a participant name (resolved case-insensitively
// here; unknown names mean "no matches", not an error).
import type { Actor } from "../domain/types";
import type { WorkboardService } from "./workboard";

export interface RawItemQuery {
  readonly status?: string | undefined;
  readonly type?: string | undefined;
  readonly assignee?: string | undefined;
  readonly label?: string | undefined;
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ResolvedItemQuery {
  readonly filter: Record<string, unknown>;
  /** True when an assignee name could not be resolved: the list is empty. */
  readonly emptyResult: boolean;
}

export function resolveItemQuery(service: WorkboardService, actor: Actor, raw: RawItemQuery): ResolvedItemQuery {
  const filter: Record<string, unknown> = {};
  let emptyResult = false;

  if (raw.status !== undefined) filter.status = raw.status;
  if (raw.type !== undefined) filter.type = raw.type;

  const assignee = raw.assignee;
  if (assignee !== undefined) {
    if (assignee === "unassigned") {
      filter.unassigned = true;
    } else if (/^\d+$/.test(assignee)) {
      filter.assigneeId = Number(assignee);
    } else {
      const lowered = assignee.toLowerCase();
      const match = service.listParticipants(actor).find((participant) => participant.name.toLowerCase() === lowered);
      if (match === undefined) {
        emptyResult = true;
      } else {
        filter.assigneeId = match.id;
      }
    }
  }

  if (raw.label !== undefined) filter.labelName = raw.label;
  if (raw.q !== undefined) filter.q = raw.q;
  if (raw.limit !== undefined) filter.limit = raw.limit;
  if (raw.cursor !== undefined) filter.cursor = raw.cursor;

  return { filter, emptyResult };
}

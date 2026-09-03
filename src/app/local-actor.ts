// Local (process-owner-trusted) actor resolution, shared by the CLI and the
// stdio MCP server: the participant name comes from --as / WORKBOARD_USER /
// default "local" — never from a request body.
import type { Actor } from "../domain/types";
import type { WorkboardService } from "./workboard";

export function resolveLocalActor(service: WorkboardService, name: string): Actor {
  const bootstrap: Actor = { participantId: 0, name: "system", kind: "human" };
  const lowered = name.toLowerCase();
  const existing = service
    .listParticipants(bootstrap)
    .find((participant) => participant.name.toLowerCase() === lowered);
  if (existing !== undefined) {
    return { participantId: existing.id, name: existing.name, kind: existing.kind };
  }
  const created = service.createParticipant(bootstrap, { name, kind: "agent" });
  return { participantId: created.id, name: created.name, kind: created.kind };
}

export const LOCAL_ACTOR_BOOTSTRAP: Actor = { participantId: 0, name: "system", kind: "human" };

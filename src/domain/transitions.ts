import type { WorkStatus } from "./types";

export interface StatusTimestamps {
  readonly closedAt: string | null;
}

export function statusTimestamps(
  previous: WorkStatus,
  next: WorkStatus,
  currentClosedAt: string | null,
  now: string,
): StatusTimestamps {
  if (previous === next) return { closedAt: currentClosedAt };
  if (next === "done") return { closedAt: now };
  if (previous === "done") return { closedAt: null };
  return { closedAt: currentClosedAt };
}

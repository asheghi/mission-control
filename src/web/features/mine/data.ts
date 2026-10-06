import type { Priority, WorkStatus } from "../../../domain/types";
import { listPageFromResponse } from "../list/data";
import type { ListItem } from "../list/types";

export interface MineItem {
  readonly item: ListItem;
  readonly assigned: boolean;
  readonly mentioned: boolean;
}

export interface MinePage {
  readonly items: readonly MineItem[];
  readonly nextCursor: string | null;
}

export function minePageFromResponse(value: unknown): MinePage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as { data?: unknown; meta?: unknown };
  if (!Array.isArray(response.data) || response.meta === null || typeof response.meta !== "object") return null;
  const wrappers = response.data as unknown[];
  const parsed = listPageFromResponse({
    data: wrappers.map((entry) => entry !== null && typeof entry === "object" ? (entry as { item?: unknown }).item : null),
    meta: response.meta,
  });
  if (parsed === null) return null;
  const items: MineItem[] = [];
  for (let index = 0; index < wrappers.length; index += 1) {
    const wrapper = wrappers[index];
    if (wrapper === null || typeof wrapper !== "object") return null;
    const row = wrapper as { item?: ListItem; assigned?: unknown; mentioned?: unknown };
    if (typeof row.assigned !== "boolean" || typeof row.mentioned !== "boolean" || (!row.assigned && !row.mentioned)) return null;
    const item = parsed.items[index];
    if (item === undefined) return null;
    items.push({ item, assigned: row.assigned, mentioned: row.mentioned });
  }
  return { items, nextCursor: parsed.nextCursor };
}

export function statusLabel(status: WorkStatus): string {
  return ({ todo: "To do", doing: "Doing", blocked: "Blocked", done: "Done" })[status];
}

export function priorityLabel(priority: Priority): string {
  return `P${priority}`;
}

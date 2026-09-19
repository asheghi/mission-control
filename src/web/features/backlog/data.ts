import type { Priority } from "../../../domain/types";
import type { BacklogGroup, BacklogItem } from "./types";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function item(value: unknown): BacklogItem | null {
  if (!record(value) || !id(value.id) || typeof value.title !== "string" || value.status !== "todo"
    || typeof value.priority !== "number" || ![0, 1, 2, 3].includes(value.priority)
    || (value.parentId !== undefined && value.parentId !== null && !id(value.parentId)) || !Array.isArray(value.labels)) return null;
  const labels: Array<{ id: number; name: string }> = [];
  for (const candidate of value.labels) {
    if (!record(candidate) || !id(candidate.id) || typeof candidate.name !== "string") return null;
    labels.push({ id: candidate.id, name: candidate.name });
  }
  let assignee: BacklogItem["assignee"] = null;
  if (value.assignee !== null) {
    if (!record(value.assignee) || !id(value.assignee.id) || typeof value.assignee.name !== "string"
      || (value.assignee.kind !== "human" && value.assignee.kind !== "agent")) return null;
    assignee = { id: value.assignee.id, name: value.assignee.name, kind: value.assignee.kind };
  }
  return { id: value.id, title: value.title, priority: value.priority as Priority, parentId: value.parentId === undefined ? null : value.parentId, assignee, labels };
}

export interface BacklogPage { readonly items: readonly BacklogItem[]; readonly nextCursor: string | null }

export function backlogPageFromResponse(value: unknown): BacklogPage | null {
  if (!record(value) || !Array.isArray(value.data) || !record(value.meta)) return null;
  const nextCursor = value.meta.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > 2_048)) return null;
  const result: BacklogItem[] = [];
  const ids = new Set<number>();
  for (const candidate of value.data) {
    const parsed = item(candidate);
    if (parsed === null || ids.has(parsed.id)) return null;
    ids.add(parsed.id);
    result.push(parsed);
  }
  return { items: result, nextCursor };
}

export function backlogItemsFromResponse(value: unknown): readonly BacklogItem[] | null {
  return backlogPageFromResponse(value)?.items ?? null;
}

export function groupBacklog(items: readonly BacklogItem[]): readonly BacklogGroup[] {
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  const children = new Map<number, BacklogItem[]>();
  const roots: BacklogItem[] = [];
  const order = (left: BacklogItem, right: BacklogItem) => left.priority - right.priority || right.id - left.id;

  for (const entry of items) {
    if (entry.parentId !== null && entry.parentId !== entry.id && byId.has(entry.parentId)) {
      const list = children.get(entry.parentId) ?? [];
      list.push(entry);
      children.set(entry.parentId, list);
    } else roots.push(entry);
  }

  const included = new Set<number>();
  const build = (entry: BacklogItem, ancestors: ReadonlySet<number>): BacklogGroup => {
    included.add(entry.id);
    const nextAncestors = new Set(ancestors).add(entry.id);
    return {
      item: entry,
      children: (children.get(entry.id) ?? [])
        .filter((child) => !nextAncestors.has(child.id))
        .sort(order)
        .map((child) => build(child, nextAncestors)),
    };
  };

  const result = roots.sort(order).map((entry) => build(entry, new Set()));
  // Keep malformed cyclic relationships visible rather than silently dropping
  // those items from the backlog. Their first sorted member becomes a root.
  for (const entry of [...items].sort(order)) {
    if (!included.has(entry.id)) result.push(build(entry, new Set()));
  }
  return result;
}

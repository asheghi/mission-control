import type { DetailItem, DetailLabel, DetailParticipant } from "./types";

/** The three item fields the detail view mutates one at a time. */
export type FieldName = "status" | "type" | "priority" | "assigneeId";

/** The item value a field's intent maps onto (`assigneeId` → `assignee`). */
export type FieldValue = DetailItem["status"] | DetailItem["type"] | DetailItem["priority"] | number | null;

export interface FieldPatch {
  readonly status?: DetailItem["status"];
  readonly type?: DetailItem["type"];
  readonly priority?: DetailItem["priority"];
  readonly assigneeId?: number | null;
}

export interface AcceptedItemPatch extends FieldPatch {
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly DetailLabel[];
}

export const FIELD_NAMES: readonly FieldName[] = ["status", "type", "priority", "assigneeId"];

/** One accepted mutation, keyed by kind. */
export interface MutationMark {
  readonly kind: "item" | "comment";
  readonly generation: number;
}

export function sameMutation(left: MutationMark, right: MutationMark): boolean {
  return left.kind === right.kind && left.generation === right.generation;
}

/** Read one mutated field off a patch, or undefined when that field is absent. */
export function patchValue(patch: FieldPatch, field: FieldName): FieldValue | undefined {
  if (field === "status") return patch.status;
  if (field === "type") return patch.type;
  if (field === "priority") return patch.priority;
  return patch.assigneeId;
}

/** Apply a patch to the fields it actually carries, leaving the rest untouched. */
export function withFields(item: DetailItem, patch: FieldPatch, participants: readonly DetailParticipant[]): DetailItem {
  let next = item;
  if (patch.status !== undefined) next = { ...next, status: patch.status };
  if (patch.type !== undefined) next = { ...next, type: patch.type };
  if (patch.priority !== undefined) next = { ...next, priority: patch.priority };
  if (patch.assigneeId !== undefined) {
    const assignee = patch.assigneeId === null
      ? null
      : participants.find((participant) => participant.id === patch.assigneeId) ?? null;
    next = { ...next, assignee };
  }
  return next;
}

/** Re-apply one field's latest local intent over an authoritative item. */
export function reapplyIntent(
  item: DetailItem,
  field: FieldName,
  intent: FieldValue | undefined,
  participants: readonly DetailParticipant[],
): DetailItem {
  if (intent === undefined) return item;
  if (field === "status") return { ...item, status: intent as DetailItem["status"] };
  if (field === "type") return { ...item, type: intent as DetailItem["type"] };
  if (field === "priority") return { ...item, priority: intent as DetailItem["priority"] };
  return withFields(item, { assigneeId: intent as number | null }, participants);
}

/** Re-apply all pending quick-field intents over a server-authored payload. */
export function reconcileItem(
  item: DetailItem,
  intents: ReadonlyMap<FieldName, FieldValue | undefined>,
  participants: readonly DetailParticipant[],
): DetailItem {
  let next = item;
  for (const field of FIELD_NAMES) {
    next = reapplyIntent(next, field, intents.get(field), participants);
  }
  return next;
}

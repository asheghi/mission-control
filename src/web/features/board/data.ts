import type { ParticipantKind, Priority, WorkStatus } from "../../../domain/types";
import { BOARD_STATUSES } from "./types";
import type { BoardAssignee, BoardItem, BoardLabel } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === "string" && BOARD_STATUSES.some((status) => status === value);
}

function boardPriority(value: unknown): Priority | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3
    ? value as Priority
    : null;
}

function boardLabels(value: unknown): readonly BoardLabel[] | null {
  if (!Array.isArray(value)) return null;
  const labels: BoardLabel[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !isPositiveId(candidate.id) || typeof candidate.name !== "string") return null;
    labels.push({ id: candidate.id, name: candidate.name });
  }
  return labels;
}

function boardAssignee(value: unknown): BoardAssignee | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)
    || !isPositiveId(value.id)
    || typeof value.name !== "string"
    || (value.kind !== "human" && value.kind !== "agent")) return undefined;
  return { id: value.id, name: value.name, kind: value.kind as ParticipantKind };
}

export function normalizeCommentCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

export function boardItem(value: unknown): BoardItem | null {
  if (!isRecord(value)
    || !isPositiveId(value.id)
    || typeof value.title !== "string"
    || !isWorkStatus(value.status)) return null;

  const priority = boardPriority(value.priority);
  const labels = boardLabels(value.labels);
  const assignee = boardAssignee(value.assignee);
  const commentCount = normalizeCommentCount(value.commentCount);
  if (priority === null || labels === null || assignee === undefined || commentCount === null) return null;

  return {
    id: value.id,
    title: value.title,
    status: value.status,
    priority,
    labels,
    commentCount,
    assignee,
  };
}

export function boardItemFromResponse(response: unknown): BoardItem | null {
  if (!isRecord(response) || !isRecord(response.data)) return null;
  return boardItem(response.data.item);
}

export function boardItemsFromResponse(response: unknown): readonly BoardItem[] | null {
  if (!isRecord(response) || !Array.isArray(response.data)) return null;
  const items: BoardItem[] = [];
  for (const candidate of response.data) {
    const item = boardItem(candidate);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/** Return the status at offset, clamped to the board's first and last columns. */
export function clampedStatusTarget(status: WorkStatus, offset: number): WorkStatus {
  const currentIndex = BOARD_STATUSES.indexOf(status);
  const safeIndex = currentIndex < 0 ? 0 : currentIndex;
  const finiteOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const targetIndex = Math.max(0, Math.min(BOARD_STATUSES.length - 1, safeIndex + finiteOffset));
  return BOARD_STATUSES[targetIndex] ?? BOARD_STATUSES[0];
}

/** Accept a drop only when its canonical payload matches the active internal drag. */
export function validateInternalDragId(payload: unknown, activeDragId: number | null): number | null {
  if (!isPositiveId(activeDragId) || typeof payload !== "string" || !/^\d+$/.test(payload)) return null;
  const payloadId = Number(payload);
  return isPositiveId(payloadId) && payload === String(payloadId) && payloadId === activeDragId ? payloadId : null;
}

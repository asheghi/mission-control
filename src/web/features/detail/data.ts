import type { Priority, WorkStatus } from "../../../domain/types";
import { DETAIL_PRIORITIES, DETAIL_STATUSES } from "./types";
import type {
  DetailComment,
  DetailHistoryEntry,
  DetailItem,
  DetailLabel,
  DetailParticipant,
  DetailPayload,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isStatus(value: unknown): value is WorkStatus {
  return typeof value === "string" && DETAIL_STATUSES.some((status) => status === value);
}

function isPriority(value: unknown): value is Priority {
  return typeof value === "number" && DETAIL_PRIORITIES.some((priority) => priority === value);
}

function participantFromValue(value: unknown): DetailParticipant | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string"
    || (value.kind !== "human" && value.kind !== "agent")) return null;
  return { id: value.id, name: value.name, kind: value.kind };
}

function labelFromValue(value: unknown): DetailLabel | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string" || typeof value.color !== "string") return null;
  return { id: value.id, name: value.name, color: value.color };
}

function itemFromValue(value: unknown): DetailItem | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.title !== "string" || typeof value.body !== "string"
    || !isStatus(value.status) || !isPriority(value.priority) || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt) || (value.closedAt !== null && !isTimestamp(value.closedAt))
    || (value.parentId !== undefined && value.parentId !== null && !isId(value.parentId)) || !Array.isArray(value.labels)) return null;
  const assignee = value.assignee === null ? null : participantFromValue(value.assignee);
  if (value.assignee !== null && assignee === null) return null;
  const labels: DetailLabel[] = [];
  for (const candidate of value.labels) {
    const label = labelFromValue(candidate);
    if (label === null) return null;
    labels.push(label);
  }
  return {
    id: value.id,
    title: value.title,
    body: value.body,
    status: value.status,
    priority: value.priority,
    assignee,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: value.closedAt,
    parentId: value.parentId === undefined ? null : value.parentId,
    labels,
  };
}

function commentFromValue(value: unknown): DetailComment | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.body !== "string" || !isTimestamp(value.createdAt)) return null;
  const author = participantFromValue(value.author);
  return author === null ? null : { id: value.id, author, body: value.body, createdAt: value.createdAt };
}

export function commentFromResponse(response: unknown): DetailComment | null {
  if (!isRecord(response) || !isRecord(response.data)) return null;
  return commentFromValue(response.data.comment);
}

function historyFromValue(value: unknown): DetailHistoryEntry | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.actorName !== "string" || typeof value.field !== "string"
    || (value.oldValue !== null && typeof value.oldValue !== "string")
    || (value.newValue !== null && typeof value.newValue !== "string") || !isTimestamp(value.createdAt)) return null;
  return {
    id: value.id,
    actorName: value.actorName,
    field: value.field,
    oldValue: value.oldValue,
    newValue: value.newValue,
    createdAt: value.createdAt,
  };
}

export function detailFromResponse(response: unknown): DetailPayload | null {
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.comments)
    || !Array.isArray(response.data.history)
    || (response.data.subtasks !== undefined && !Array.isArray(response.data.subtasks))) return null;
  const item = itemFromValue(response.data.item);
  const parentValue = response.data.parent ?? null;
  const parent = parentValue === null ? null : itemFromValue(parentValue);
  if (item === null || (parentValue !== null && parent === null)) return null;
  const subtasks: DetailItem[] = [];
  for (const candidate of response.data.subtasks ?? []) {
    const subtask = itemFromValue(candidate);
    if (subtask === null) return null;
    subtasks.push(subtask);
  }
  const comments: DetailComment[] = [];
  for (const candidate of response.data.comments) {
    const comment = commentFromValue(candidate);
    if (comment === null) return null;
    comments.push(comment);
  }
  const history: DetailHistoryEntry[] = [];
  for (const candidate of response.data.history) {
    const entry = historyFromValue(candidate);
    if (entry === null) return null;
    history.push(entry);
  }
  return { item, parent, subtasks, comments, history };
}

export function participantsFromResponse(response: unknown): readonly DetailParticipant[] | null {
  if (!isRecord(response) || !Array.isArray(response.data)) return null;
  const participants: DetailParticipant[] = [];
  const ids = new Set<number>();
  for (const candidate of response.data) {
    const participant = participantFromValue(candidate);
    if (participant === null || ids.has(participant.id)) return null;
    ids.add(participant.id);
    participants.push(participant);
  }
  return participants;
}

export function labelsFromResponse(response: unknown): readonly DetailLabel[] | null {
  if (!isRecord(response) || !Array.isArray(response.data)) return null;
  const labels: DetailLabel[] = [];
  const names = new Set<string>();
  for (const candidate of response.data) {
    const label = labelFromValue(candidate);
    if (label === null || names.has(label.name)) return null;
    names.add(label.name);
    labels.push(label);
  }
  return labels;
}

/**
 * Parse the single label a POST /api/labels create returns: `{ data: label }`.
 *
 * The id must come from this response. Synthesizing one (a counter, or
 * `MAX_SAFE_INTEGER - length` as a placeholder) produces a key that can never
 * be reconciled with a later authoritative read, so it would survive forever as
 * a phantom label. A create whose response cannot be parsed is treated as a
 * failure to create, never as a label with an invented id.
 */
export function labelFromResponse(response: unknown): DetailLabel | null {
  if (!isRecord(response)) return null;
  return labelFromValue(response.data);
}

/** Parse the item a PATCH /api/items/:id returns, from `{ data: item }`. */
export function itemFromDetailResponse(response: unknown): DetailItem | null {
  if (!isRecord(response)) return null;
  return itemFromValue(response.data);
}

export function mentionedNamesFromResponse(response: unknown): readonly string[] | null {
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.mentionedParticipants)) return null;
  const names: string[] = [];
  for (const candidate of response.data.mentionedParticipants) {
    const participant = participantFromValue(candidate);
    if (participant === null) return null;
    names.push(participant.name);
  }
  return names;
}

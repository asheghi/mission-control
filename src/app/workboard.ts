// WorkboardService — the only supported business entry point. REST, CLI,
// stdio MCP, and HTTP MCP all call these methods. Transports pass an Actor
// resolved by the auth service; request inputs never choose the actor.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { resolveMentions } from "../domain/mentions";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors";
import type { Actor, Clock, Priority, WorkStatus } from "../domain/types";
import { statusTimestamps } from "../domain/transitions";
import { systemClock } from "../domain/types";
import {
  bodySchema,
  colorSchema,
  commentBodySchema,
  handleSchema,
  labelNameSchema,
  parseInput,
  participantKindSchema,
  positiveIdSchema,
  prioritySchema,
  titleSchema,
  workStatusSchema,
} from "../domain/validation";
import {
  type CommentDto,
  type HistoryEntryDto,
  type ItemDto,
  type LabelDto,
  type MyWorkItemDto,
  type ParticipantDto,
  toCommentDto,
  toHistoryEntryDto,
  toItemDto,
  toLabelDto,
  toParticipantDto,
} from "./dto";
import { listComments } from "../db/repositories/comments";
import { createComment } from "../db/repositories/comments";
import { appendHistory, listHistory } from "../db/repositories/history";
import {
  type ItemColumnChanges,
  createItem as createItemRow,
  deleteItem as deleteItemRow,
  getItemById,
  getItemJoined,
  listItems,
  myWork,
  updateItem as updateItemRow,
} from "../db/repositories/items";
import {
  createLabel as createLabelRow,
  getLabelByName,
  labelsForItems,
  listLabels,
  listLabelsForItem,
  setItemLabels,
} from "../db/repositories/labels";
import type { LabelRow } from "../db/repositories/labels";
import { replaceCommentMentions, replaceItemMentions } from "../db/repositories/mentions";
import {
  createParticipant as createParticipantRow,
  getParticipantById,
  listParticipants,
} from "../db/repositories/participants";
import type { ParticipantRow } from "../db/repositories/participants";
import type { EventPublisher } from "./events";

// ---------------------------------------------------------------------------
// Service input schemas (strict: unknown fields — including any actor-spoof
// field — are rejected before they reach business logic).
// ---------------------------------------------------------------------------

const AVATAR_PALETTE = ["#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899"] as const;

export const createItemInputSchema = z.strictObject({
  title: titleSchema,
  body: bodySchema.optional().default(""),
  priority: prioritySchema.optional().default(2),
  assigneeId: positiveIdSchema.nullable().optional(),
  labels: z.array(labelNameSchema).max(20).optional().default([]),
});

export const updateItemInputSchema = z
  .strictObject({
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    status: workStatusSchema.optional(),
    priority: prioritySchema.optional(),
    assigneeId: positiveIdSchema.nullable().optional(),
    labels: z.array(labelNameSchema).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.");

export const addCommentInputSchema = z.strictObject({ body: commentBodySchema });

export const createParticipantInputSchema = z.strictObject({
  name: handleSchema,
  kind: participantKindSchema,
  avatarColor: colorSchema.optional(),
});

export const createLabelInputSchema = z.strictObject({ name: labelNameSchema, color: colorSchema });

export const listItemsFilterSchema = z.strictObject({
  status: workStatusSchema.optional(),
  assigneeId: positiveIdSchema.optional(),
  unassigned: z.boolean().optional(),
  labelName: labelNameSchema.optional(),
  q: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().max(512).optional(),
});

export const myWorkFilterSchema = z.strictObject({
  status: workStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().max(512).optional(),
});

export interface ItemDetailDto {
  readonly item: ItemDto;
  readonly comments: readonly CommentDto[];
  readonly history: readonly HistoryEntryDto[];
}

export type UpdateItemResult = ItemDetailDto & { readonly changedFields: readonly string[] };

export interface ItemListResult {
  readonly items: readonly ItemDto[];
  readonly nextCursor: string | null;
}

export interface MyWorkResult {
  readonly items: readonly MyWorkItemDto[];
  readonly nextCursor: string | null;
}

const DETAIL_COMMENT_LIMIT = 1000;
const DETAIL_HISTORY_LIMIT = 1000;

interface HistoryDraft {
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
}

export class WorkboardService {
  private readonly db: Database;
  private readonly clock: Clock;
  // Optional publisher; transports wire a broker to fan events out to SSE.
  private readonly events: EventPublisher | undefined;

  constructor(db: Database, clock: Clock = systemClock, events?: EventPublisher) {
    this.db = db;
    this.clock = clock;
    this.events = events;
  }

  // ------------------------------------------------------------------ reads

  listItems(actor: Actor, filter: unknown = {}): ItemListResult {
    void actor;
    const parsed = parseInput(listItemsFilterSchema, filter);
    const labelId = parsed.labelName !== undefined ? this.requireLabelByName(parsed.labelName).id : undefined;
    const result = listItems(this.db, {
      ...(parsed.status !== undefined ? { statusIn: [parsed.status] as const } : {}),
      ...(parsed.assigneeId !== undefined ? { assigneeId: parsed.assigneeId } : {}),
      ...(parsed.unassigned !== undefined ? { unassigned: parsed.unassigned } : {}),
      ...(labelId !== undefined ? { labelId } : {}),
      ...(parsed.q !== undefined ? { q: parsed.q } : {}),
      limit: parsed.limit,
      cursor: parsed.cursor ?? null,
    });
    const labelMap = labelsForItems(this.db, result.items.map((row) => row.id));
    return {
      items: result.items.map((row) => toItemDto(row, toLabelDtos(labelMap.get(row.id) ?? []))),
      nextCursor: result.nextCursor,
    };
  }

  getItem(actor: Actor, itemId: number): ItemDetailDto {
    void actor;
    parseInput(positiveIdSchema, itemId);
    const row = getItemJoined(this.db, itemId);
    if (row === null) throw new NotFoundError("item", itemId);
    const labels = toLabelDtos(listLabelsForItem(this.db, itemId));
    const comments = listComments(this.db, itemId, { limit: DETAIL_COMMENT_LIMIT }).comments.map(toCommentDto);
    const history = listHistory(this.db, itemId, { limit: DETAIL_HISTORY_LIMIT }).entries.map(toHistoryEntryDto);
    return { item: toItemDto(row, labels), comments, history };
  }

  myWork(actor: Actor, filter: unknown = {}): MyWorkResult {
    const parsed = parseInput(myWorkFilterSchema, filter);
    const result = myWork(this.db, actor.participantId, {
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      limit: parsed.limit,
      cursor: parsed.cursor ?? null,
    });
    const labelMap = labelsForItems(this.db, result.items.map((row) => row.id));
    return {
      items: result.items.map((row) => ({
        item: toItemDto(row, toLabelDtos(labelMap.get(row.id) ?? [])),
        assigned: row.assigned === 1,
        mentioned: row.mentioned === 1,
      })),
      nextCursor: result.nextCursor,
    };
  }

  listParticipants(actor: Actor): readonly ParticipantDto[] {
    void actor;
    return listParticipants(this.db).map(toParticipantDto);
  }

  listLabels(actor: Actor): readonly LabelDto[] {
    void actor;
    return listLabels(this.db).map(toLabelDto);
  }

  // -------------------------------------------------------------- mutations

  createItem(actor: Actor, input: unknown): ItemDetailDto {
    const parsed = parseInput(createItemInputSchema, input);
    const now = this.clock.now();
    const itemId = this.db.transaction(() => {
      const assigneeId = this.resolveOptionalAssignee(parsed.assigneeId);
      const labels = parsed.labels.length > 0 ? this.resolveLabelNames(parsed.labels) : [];
      const row = createItemRow(this.db, {
        title: parsed.title,
        body: parsed.body,
        status: "todo",
        priority: parsed.priority,
        assigneeId,
        createdBy: actor.participantId,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      });
      if (labels.length > 0) setItemLabels(this.db, row.id, labels.map((label) => label.id));
      replaceItemMentions(this.db, row.id, this.mentionIds(parsed.body), now);
      appendHistory(this.db, {
        itemId: row.id,
        actorId: actor.participantId,
        field: "created",
        oldValue: null,
        newValue: null,
        createdAt: now,
      });
      return row.id;
    })();
    // Published only after the transaction committed.
    this.events?.publish("item.created", itemId);
    return this.getItem(actor, itemId);
  }

  updateItem(actor: Actor, itemId: number, patch: unknown): UpdateItemResult {
    const parsed = parseInput(updateItemInputSchema, patch);
    const now = this.clock.now();

    const changedFields = this.db.transaction(() => {
      const current = getItemById(this.db, itemId);
      if (current === null) throw new NotFoundError("item", itemId);

      const changes: { fields: ItemColumnChanges; entries: HistoryDraft[] } = {
        fields: {},
        entries: [],
      };
      const changed: string[] = [];

      if (parsed.title !== undefined && parsed.title !== current.title) {
        changes.fields.title = parsed.title;
        changed.push("title");
        changes.entries.push({ field: "title", oldValue: current.title, newValue: parsed.title });
      }
      if (parsed.body !== undefined && parsed.body !== current.body) {
        changes.fields.body = parsed.body;
        changed.push("body");
        changes.entries.push({ field: "body", oldValue: current.body, newValue: parsed.body });
      }
      if (parsed.status !== undefined && parsed.status !== current.status) {
        changes.fields.status = parsed.status;
        changes.fields.closedAt = statusTimestamps(current.status, parsed.status, current.closed_at, now).closedAt;
        changed.push("status");
        changes.entries.push({ field: "status", oldValue: current.status, newValue: parsed.status });
      }
      if (parsed.priority !== undefined && parsed.priority !== current.priority) {
        changes.fields.priority = parsed.priority;
        changed.push("priority");
        changes.entries.push({ field: "priority", oldValue: String(current.priority), newValue: String(parsed.priority) });
      }
      if (parsed.assigneeId !== undefined) {
        const nextAssignee = parsed.assigneeId;
        if (nextAssignee !== current.assignee_id) {
          changes.fields.assigneeId = nextAssignee;
          changed.push("assignee");
          changes.entries.push({
            field: "assignee",
            oldValue: this.describeAssignee(current.assignee_id),
            newValue: this.describeAssignee(nextAssignee),
          });
        }
      }

      let labelsChanged = false;
      if (parsed.labels !== undefined) {
        const nextLabels = this.resolveLabelNames(parsed.labels ?? []);
        const currentLabels = listLabelsForItem(this.db, itemId);
        const currentLabelIds = new Set(currentLabels.map((label) => label.id));
        const nextIds = nextLabels.map((label) => label.id);
        const nextIdSet = new Set(nextIds);
        for (const label of nextLabels) {
          if (!currentLabelIds.has(label.id)) {
            changes.entries.push({ field: "label.added", oldValue: null, newValue: label.name });
          }
        }
        for (const existing of currentLabels) {
          if (!nextIdSet.has(existing.id)) {
            changes.entries.push({ field: "label.removed", oldValue: existing.name, newValue: null });
          }
        }
        setItemLabels(this.db, itemId, nextIds);
        labelsChanged = nextIds.length !== currentLabelIds.size ||
          [...nextIdSet].some((id) => !currentLabelIds.has(id));
        if (labelsChanged) changed.push("labels");
      }

      const hasFieldChanges = Object.keys(changes.fields).length > 0;
      if (!hasFieldChanges && !labelsChanged) {
        return []; // No-op: no history, no timestamp churn.
      }

      updateItemRow(this.db, itemId, changes.fields, now);
      for (const entry of changes.entries) {
        appendHistory(this.db, {
          itemId,
          actorId: actor.participantId,
          field: entry.field,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
          createdAt: now,
        });
      }
      if ("body" in parsed) {
        replaceItemMentions(this.db, itemId, this.mentionIds(parsed.body ?? ""), now);
      }
      return changed;
    })();

    if (changedFields.length > 0) this.events?.publish("item.updated", itemId);
    return { ...this.getItem(actor, itemId), changedFields };
  }

  deleteItem(actor: Actor, itemId: number): void {
    void actor;
    parseInput(positiveIdSchema, itemId);
    const deleted = this.db.transaction(() => deleteItemRow(this.db, itemId))();
    if (!deleted) throw new NotFoundError("item", itemId);
    this.events?.publish("item.deleted", itemId);
  }

  addComment(actor: Actor, itemId: number, input: unknown): { comment: CommentDto; mentionedParticipants: readonly ParticipantDto[] } {
    const parsed = parseInput(addCommentInputSchema, input);
    const now = this.clock.now();
    const result = this.db.transaction(() => {
      const item = getItemById(this.db, itemId);
      if (item === null) throw new NotFoundError("item", itemId);

      const mentioned = this.resolveMentionParticipants(parsed.body);
      const comment = createComment(this.db, {
        itemId,
        authorId: actor.participantId,
        body: parsed.body,
        createdAt: now,
      });
      if (mentioned.length > 0) {
        replaceCommentMentions(this.db, itemId, comment.id, mentioned.map((p) => p.id), now);
      }
      // A comment is activity: bump the item timestamp without a field history row.
      updateItemRow(this.db, itemId, {}, now);
      return { comment, mentioned };
    })();
    this.events?.publish("comment.created", itemId);
    return {
      comment: toCommentDto(listJoinedComment(this.db, result.comment.id)),
      mentionedParticipants: result.mentioned.map(toParticipantDto),
    };
  }

  createParticipant(actor: Actor, input: unknown): ParticipantDto {
    void actor;
    const parsed = parseInput(createParticipantInputSchema, input);
    const now = this.clock.now();
    const count = listParticipants(this.db).length;
    const color = parsed.avatarColor ?? AVATAR_PALETTE[count % AVATAR_PALETTE.length] ?? "#6B7280";
    try {
      const row = createParticipantRow(this.db, {
        name: parsed.name,
        kind: parsed.kind,
        avatarColor: color,
        createdAt: now,
      });
      this.events?.publish("participant.created", null);
      return toParticipantDto(row);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/.test(error.message)) {
        throw new ConflictError("A participant with that name already exists.");
      }
      throw error;
    }
  }

  createLabel(actor: Actor, input: unknown): LabelDto {
    void actor;
    const parsed = parseInput(createLabelInputSchema, input);
    const now = this.clock.now();
    try {
      const row = createLabelRow(this.db, { name: parsed.name, color: parsed.color, createdAt: now });
      this.events?.publish("label.created", null);
      return toLabelDto(row);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/.test(error.message)) {
        throw new ConflictError("A label with that name already exists.");
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- helpers

  private mentionIds(text: string): number[] {
    return this.resolveMentionParticipants(text).map((participant) => participant.id);
  }

  private resolveMentionParticipants(text: string): ParticipantRow[] {
    const candidates = listParticipants(this.db).map((row) => ({ name: row.name, value: row }));
    return resolveMentions(text, candidates);
  }

  private resolveOptionalAssignee(assigneeId: number | null | undefined): number | null {
    if (assigneeId === undefined || assigneeId === null) return null;
    const participant = getParticipantById(this.db, assigneeId);
    if (participant === null) throw new NotFoundError("participant", assigneeId);
    return participant.id;
  }

  private describeAssignee(assigneeId: number | null): string {
    if (assigneeId === null) return "(unassigned)";
    return getParticipantById(this.db, assigneeId)?.name ?? "(unassigned)";
  }

  private resolveLabelNames(names: readonly string[]): LabelRow[] {
    const byId = new Map<number, LabelRow>();
    for (const name of names) {
      const row = this.requireLabelByName(name);
      byId.set(row.id, row);
    }
    return [...byId.values()];
  }

  private requireLabelByName(name: string): LabelRow {
    const row = getLabelByName(this.db, name);
    if (row === null) throw new NotFoundError("label", name);
    return row;
  }
}

function toLabelDtos(rows: readonly LabelRow[]): LabelDto[] {
  return rows.map(toLabelDto);
}

function listJoinedComment(db: Database, commentId: number): Parameters<typeof toCommentDto>[0] {
  const row = db
    .query(
      "SELECT c.id, c.item_id, c.author_id, c.body, c.created_at, p.name AS author_name, p.kind AS author_kind " +
        "FROM comments c JOIN participants p ON p.id = c.author_id WHERE c.id = ?",
    )
    .get(commentId);
  if (row === null) throw new NotFoundError("comment", commentId);
  return row as Parameters<typeof toCommentDto>[0];
}

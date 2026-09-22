// WorkboardService — the only supported business entry point. REST, CLI,
// stdio MCP, and HTTP MCP all call these methods. Transports pass an Actor
// resolved by the auth service; request inputs never choose the actor.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { resolveMentions } from "../domain/mentions";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors";
import type { Actor, Clock, ItemRelationshipName, Priority, StoredItemLinkKind, WorkItemType, WorkStatus } from "../domain/types";
import { DEFAULT_CHILD_WORK_ITEM_TYPE, DEFAULT_TOP_LEVEL_WORK_ITEM_TYPE, RELATIONSHIPS_BY_LINK, systemClock } from "../domain/types";
import { statusTimestamps } from "../domain/transitions";
import {
  bodySchema,
  colorSchema,
  commentBodySchema,
  handleSchema,
  itemRelationshipNameSchema,
  labelNameSchema,
  parseInput,
  participantKindSchema,
  positiveIdSchema,
  prioritySchema,
  titleSchema,
  workItemTypeSchema,
  workStatusSchema,
} from "../domain/validation";
import {
  type CommentDto,
  type HistoryEntryDto,
  type ItemDto,
  type ItemRelationshipDto,
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
  listBacklogItems,
  listItems,
  moveItemInBacklog,
  myWork,
  updateItem as updateItemRow,
} from "../db/repositories/items";
import {
  createItemLink,
  deleteItemLink,
  getItemLinkById,
  listItemLinks,
} from "../db/repositories/item-links";
import type { ItemLinkRow } from "../db/repositories/item-links";
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
  parentId: positiveIdSchema.nullable().optional(),
  // Optional for backward compatibility: an omitted type is inferred from the
  // parent (see `resolveCreateType`), so existing callers keep working.
  type: workItemTypeSchema.optional(),
  labels: z.array(labelNameSchema).max(20).optional().default([]),
});

export const updateItemInputSchema = z
  .strictObject({
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    status: workStatusSchema.optional(),
    priority: prioritySchema.optional(),
    assigneeId: positiveIdSchema.nullable().optional(),
    parentId: positiveIdSchema.nullable().optional(),
    type: workItemTypeSchema.optional(),
    labels: z.array(labelNameSchema).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.");

export const addCommentInputSchema = z.strictObject({ body: commentBodySchema });

export const createItemRelationshipInputSchema = z.strictObject({
  name: itemRelationshipNameSchema,
  itemId: positiveIdSchema,
});

export const deleteItemRelationshipInputSchema = z.strictObject({
  relationshipId: positiveIdSchema,
});

export const reorderItemInputSchema = z.strictObject({
  // null (or omitted) means the top level.
  parentId: positiveIdSchema.nullable().optional(),
  // Insert immediately before this sibling; omitted appends to the end.
  beforeId: positiveIdSchema.nullable().optional(),
});

export const createParticipantInputSchema = z.strictObject({
  name: handleSchema,
  kind: participantKindSchema,
  avatarColor: colorSchema.optional(),
});

export const createLabelInputSchema = z.strictObject({ name: labelNameSchema, color: colorSchema });

export const listItemsFilterSchema = z.strictObject({
  status: workStatusSchema.optional(),
  type: workItemTypeSchema.optional(),
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
  readonly parent: ItemDto | null;
  /** Direct children. Renamed from the former `subtasks`, which was wrong for
   *  a model where any type may parent any other type. */
  readonly children: readonly ItemDto[];
  readonly related: readonly ItemRelationshipDto[];
  readonly predecessors: readonly ItemRelationshipDto[];
  readonly successors: readonly ItemRelationshipDto[];
  readonly duplicates: readonly ItemRelationshipDto[];
  readonly duplicateOf: ItemRelationshipDto | null;
  readonly comments: readonly CommentDto[];
  readonly history: readonly HistoryEntryDto[];
}

export type UpdateItemResult = ItemDetailDto & { readonly changedFields: readonly string[] };

/** Result of a backlog reorder: the moved item and both affected scopes. */
export interface ReorderItemResult {
  readonly item: ItemDto;
  readonly itemId: number;
  readonly parentId: number | null;
  readonly backlogPosition: number;
  readonly changedFields: readonly string[];
  /** The moved item's new scope, already re-sorted. */
  readonly siblings: readonly ItemDto[];
  /** The previous scope when the move crossed levels; empty otherwise. */
  readonly previousSiblings: readonly ItemDto[];
}

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
      ...(parsed.type !== undefined ? { typeIn: [parsed.type] as const } : {}),
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
    return this.buildDetail(itemId);
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

  /**
   * Every unfinished item in backlog order. Deliberately unpaginated and
   * uncapped: backlog order is positional, so a page limit would silently drop
   * siblings and a cursor would break as soon as positions changed.
   */
  listBacklog(actor: Actor): readonly ItemDto[] {
    void actor;
    const rows = listBacklogItems(this.db);
    const labelMap = labelsForItems(this.db, rows.map((row) => row.id));
    return rows.map((row) => toItemDto(row, toLabelDtos(labelMap.get(row.id) ?? [])));
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
      const parentId = this.resolveOptionalParent(parsed.parentId);
      const type = parsed.type ?? (parentId === null ? DEFAULT_TOP_LEVEL_WORK_ITEM_TYPE : DEFAULT_CHILD_WORK_ITEM_TYPE);
      if (type === "task" && parentId === null) throw new ValidationError("A Task must have a parent.");
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
        parentId,
        workItemType: type,
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
      const nextParent = parsed.parentId !== undefined
        ? this.resolveOptionalParent(parsed.parentId, itemId)
        : current.parent_id;
      const nextType = parsed.type ?? current.work_item_type;
      if (nextType === "task" && nextParent === null) {
        throw new ValidationError("A Task must have a parent.");
      }

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
        // Validate existence here (like createItem) so an unknown id surfaces
        // as 404 instead of a raw FOREIGN KEY constraint failure (500).
        const nextAssignee = this.resolveOptionalAssignee(parsed.assigneeId);
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
      if (parsed.parentId !== undefined && nextParent !== current.parent_id) {
        changes.fields.parentId = nextParent;
        changed.push("parent");
        changes.entries.push({
          field: "parent",
          oldValue: this.describeParent(current.parent_id),
          newValue: this.describeParent(nextParent),
        });
      }
      if (parsed.type !== undefined && nextType !== current.work_item_type) {
        changes.fields.workItemType = nextType;
        changed.push("type");
        changes.entries.push({ field: "type", oldValue: current.work_item_type, newValue: nextType });
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

      if (parsed.parentId !== undefined && nextParent !== current.parent_id) {
        // A Task cannot be detached at the database boundary. When one atomic
        // service patch changes it away from Task and removes its parent, apply
        // the type first inside this same transaction, then perform the move.
        if (current.work_item_type === "task" && nextType !== "task" && parsed.type !== undefined) {
          updateItemRow(this.db, itemId, { workItemType: nextType }, now);
          delete changes.fields.workItemType;
        }
        moveItemInBacklog(this.db, { itemId, parentId: nextParent, beforeId: null });
        delete changes.fields.parentId;
      }
      const hasFieldChanges = changed.length > 0;
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
    if (getItemById(this.db, itemId) === null) throw new NotFoundError("item", itemId);
    if (listItems(this.db, { parentId: itemId, limit: 1 }).items.length > 0) {
      throw new ConflictError("Reparent or delete this item's children before deleting it.");
    }
    const deleted = this.db.transaction(() => deleteItemRow(this.db, itemId))();
    if (!deleted) throw new NotFoundError("item", itemId);
    this.events?.publish("item.deleted", itemId);
  }

  createRelationship(actor: Actor, itemId: number, input: unknown): ItemDetailDto {
    parseInput(positiveIdSchema, itemId);
    const parsed = parseInput(createItemRelationshipInputSchema, input);
    const source = getItemById(this.db, itemId);
    if (source === null) throw new NotFoundError("item", itemId);
    if (getItemById(this.db, parsed.itemId) === null) throw new NotFoundError("item", parsed.itemId);
    const stored = relationshipStorage(parsed.name, itemId, parsed.itemId);
    const now = this.clock.now();
    this.db.transaction(() => {
      createItemLink(this.db, {
        kind: stored.kind,
        sourceItemId: stored.sourceItemId,
        targetItemId: stored.targetItemId,
        createdBy: actor.participantId,
        createdAt: now,
      });
      this.appendRelationshipHistory(actor.participantId, itemId, "relationship.added", parsed.name, parsed.itemId, now);
      this.appendRelationshipHistory(
        actor.participantId,
        parsed.itemId,
        "relationship.added",
        inverseRelationship(parsed.name),
        itemId,
        now,
      );
    })();
    this.events?.publish("item.updated", itemId);
    this.events?.publish("item.updated", parsed.itemId);
    return this.buildDetail(itemId);
  }

  deleteRelationship(actor: Actor, itemId: number, input: unknown): ItemDetailDto {
    parseInput(positiveIdSchema, itemId);
    const parsed = parseInput(deleteItemRelationshipInputSchema, input);
    const now = this.clock.now();
    const otherItemId = this.db.transaction(() => {
      const link = getItemLinkById(this.db, parsed.relationshipId);
      if (link === null || (link.source_item_id !== itemId && link.target_item_id !== itemId)) {
        throw new NotFoundError("relationship", parsed.relationshipId);
      }
      const otherId = link.source_item_id === itemId ? link.target_item_id : link.source_item_id;
      const currentName = relationshipNameFor(link, itemId);
      if (!deleteItemLink(this.db, link.id)) throw new NotFoundError("relationship", link.id);
      this.appendRelationshipHistory(actor.participantId, itemId, "relationship.removed", currentName, otherId, now);
      this.appendRelationshipHistory(
        actor.participantId,
        otherId,
        "relationship.removed",
        inverseRelationship(currentName),
        itemId,
        now,
      );
      return otherId;
    })();
    this.events?.publish("item.updated", itemId);
    this.events?.publish("item.updated", otherItemId);
    return this.buildDetail(itemId);
  }

  reorderItem(actor: Actor, itemId: number, input: unknown): ReorderItemResult {
    parseInput(positiveIdSchema, itemId);
    const parsed = parseInput(reorderItemInputSchema, input);
    const current = getItemById(this.db, itemId);
    if (current === null) throw new NotFoundError("item", itemId);
    const parentId = this.resolveOptionalParent(parsed.parentId ?? null, itemId);
    if (current.work_item_type === "task" && parentId === null) {
      throw new ValidationError("A Task must have a parent.");
    }
    const now = this.clock.now();
    const result = this.db.transaction(() => {
      const moved = moveItemInBacklog(this.db, {
        itemId,
        parentId,
        beforeId: parsed.beforeId ?? null,
      });
      updateItemRow(this.db, itemId, {}, now);
      if (current.parent_id !== parentId) {
        appendHistory(this.db, {
          itemId,
          actorId: actor.participantId,
          field: "parent",
          oldValue: this.describeParent(current.parent_id),
          newValue: this.describeParent(parentId),
          createdAt: now,
        });
      }
      appendHistory(this.db, {
        itemId,
        actorId: actor.participantId,
        field: "backlogPosition",
        oldValue: String(current.backlog_position),
        newValue: String(moved.backlogPosition),
        createdAt: now,
      });
      return moved;
    })();
    this.events?.publish("item.updated", itemId);
    const all = this.listBacklog(actor);
    return {
      item: this.buildDetail(itemId).item,
      itemId,
      parentId,
      backlogPosition: result.backlogPosition,
      changedFields: current.parent_id === parentId ? ["backlogPosition"] : ["parent", "backlogPosition"],
      siblings: all.filter((item) => item.parentId === parentId),
      previousSiblings: current.parent_id === parentId ? [] : all.filter((item) => item.parentId === current.parent_id),
    };
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

  private buildDetail(itemId: number): ItemDetailDto {
    const row = getItemJoined(this.db, itemId);
    if (row === null) throw new NotFoundError("item", itemId);
    const parentRow = row.parent_id === null ? null : getItemJoined(this.db, row.parent_id);
    const childRows = listItems(this.db, { parentId: itemId, limit: 100_000 }).items;
    const links = listItemLinks(this.db, itemId);
    const linkedRows = new Map<number, ReturnType<typeof getItemJoined>>();
    for (const link of links) {
      const otherId = link.source_item_id === itemId ? link.target_item_id : link.source_item_id;
      linkedRows.set(otherId, getItemJoined(this.db, otherId));
    }
    const relatedIds = [
      itemId,
      ...(parentRow === null ? [] : [parentRow.id]),
      ...childRows.map((child) => child.id),
      ...linkedRows.keys(),
    ];
    const labelMap = labelsForItems(this.db, relatedIds);
    const itemDto = (joined: NonNullable<ReturnType<typeof getItemJoined>>): ItemDto =>
      toItemDto(joined, toLabelDtos(labelMap.get(joined.id) ?? []));
    const relationshipDtos: ItemRelationshipDto[] = [];
    for (const link of links) {
      const otherId = link.source_item_id === itemId ? link.target_item_id : link.source_item_id;
      const other = linkedRows.get(otherId);
      if (other === null || other === undefined) continue;
      relationshipDtos.push({
        id: link.id,
        name: relationshipNameFor(link, itemId),
        item: itemDto(other),
        createdAt: link.created_at,
      });
    }
    const duplicateOf = relationshipDtos.find((entry) => entry.name === "duplicate_of") ?? null;
    return {
      item: itemDto(row),
      parent: parentRow === null ? null : itemDto(parentRow),
      children: childRows.map(itemDto),
      related: relationshipDtos.filter((entry) => entry.name === "related"),
      predecessors: relationshipDtos.filter((entry) => entry.name === "predecessor"),
      successors: relationshipDtos.filter((entry) => entry.name === "successor"),
      duplicates: relationshipDtos.filter((entry) => entry.name === "duplicate"),
      duplicateOf,
      comments: listComments(this.db, itemId, { limit: DETAIL_COMMENT_LIMIT }).comments.map(toCommentDto),
      history: listHistory(this.db, itemId, { limit: DETAIL_HISTORY_LIMIT }).entries.map(toHistoryEntryDto),
    };
  }

  private appendRelationshipHistory(
    actorId: number,
    itemId: number,
    field: "relationship.added" | "relationship.removed",
    name: ItemRelationshipName,
    otherItemId: number,
    createdAt: string,
  ): void {
    const descriptor = JSON.stringify({ name, itemId: otherItemId });
    appendHistory(this.db, {
      itemId,
      actorId,
      field,
      oldValue: field === "relationship.removed" ? descriptor : null,
      newValue: field === "relationship.added" ? descriptor : null,
      createdAt,
    });
    updateItemRow(this.db, itemId, {}, createdAt);
  }

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

  private resolveOptionalParent(parentId: number | null | undefined, itemId?: number): number | null {
    if (parentId === undefined || parentId === null) return null;
    if (itemId !== undefined && parentId === itemId) {
      throw new ValidationError("An item cannot be its own parent.");
    }
    let candidate = getItemById(this.db, parentId);
    if (candidate === null) throw new NotFoundError("item", parentId);
    const seen = new Set<number>();
    while (candidate !== null) {
      if (itemId !== undefined && candidate.id === itemId) {
        throw new ValidationError("Item relationships cannot contain a cycle.");
      }
      if (seen.has(candidate.id)) throw new ValidationError("Item relationships cannot contain a cycle.");
      seen.add(candidate.id);
      candidate = candidate.parent_id === null ? null : getItemById(this.db, candidate.parent_id);
    }
    return parentId;
  }

  private describeParent(parentId: number | null): string {
    if (parentId === null) return "(none)";
    const parent = getItemById(this.db, parentId);
    return parent === null ? "(none)" : `#${parent.id} ${parent.title}`;
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

function relationshipStorage(
  name: ItemRelationshipName,
  itemId: number,
  otherItemId: number,
): { readonly kind: StoredItemLinkKind; readonly sourceItemId: number; readonly targetItemId: number } {
  switch (name) {
    case "related":
      return { kind: "related", sourceItemId: itemId, targetItemId: otherItemId };
    case "successor":
      return { kind: "dependency", sourceItemId: itemId, targetItemId: otherItemId };
    case "predecessor":
      return { kind: "dependency", sourceItemId: otherItemId, targetItemId: itemId };
    case "duplicate_of":
      return { kind: "duplicate", sourceItemId: itemId, targetItemId: otherItemId };
    case "duplicate":
      return { kind: "duplicate", sourceItemId: otherItemId, targetItemId: itemId };
    default:
      throw new ValidationError("Parent and child relationships must be changed through parentId.");
  }
}

function relationshipNameFor(link: ItemLinkRow, itemId: number): ItemRelationshipName {
  const direction = link.source_item_id === itemId ? "outgoing" : "incoming";
  return RELATIONSHIPS_BY_LINK[link.kind][direction];
}

function inverseRelationship(name: ItemRelationshipName): ItemRelationshipName {
  switch (name) {
    case "parent": return "child";
    case "child": return "parent";
    case "predecessor": return "successor";
    case "successor": return "predecessor";
    case "duplicate": return "duplicate_of";
    case "duplicate_of": return "duplicate";
    default: return "related";
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

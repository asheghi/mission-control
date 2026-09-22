export const PARTICIPANT_KINDS = ["human", "agent"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

export const WORK_STATUSES = ["todo", "doing", "blocked", "done"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const PRIORITIES = [0, 1, 2, 3] as const;
export type Priority = (typeof PRIORITIES)[number];

// Work-item types. Wire and storage values are lowercase snake case; the UI
// renders human-readable labels for them.
export const WORK_ITEM_TYPES = ["feature", "user_story", "bug", "task"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

/** Default type for a top-level quick-add. */
export const DEFAULT_TOP_LEVEL_WORK_ITEM_TYPE: WorkItemType = "user_story";
/** Default type for a quick-add inside an existing item. */
export const DEFAULT_CHILD_WORK_ITEM_TYPE: WorkItemType = "task";

// Stored relationship kinds. `related` is symmetric and stored once;
// `dependency` is stored predecessor -> successor; `duplicate` is stored
// duplicate -> original.
export const STORED_ITEM_LINK_KINDS = ["related", "dependency", "duplicate"] as const;
export type StoredItemLinkKind = (typeof STORED_ITEM_LINK_KINDS)[number];

// Relationship names as seen from one item ("relative" to the requested item).
export const ITEM_RELATIONSHIP_NAMES = [
  "parent",
  "child",
  "related",
  "predecessor",
  "successor",
  "duplicate",
  "duplicate_of",
] as const;
export type ItemRelationshipName = (typeof ITEM_RELATIONSHIP_NAMES)[number];

// Directions in which a stored kind can be expressed relative to an item.
export const ITEM_LINK_DIRECTIONS = ["outgoing", "incoming"] as const;
export type ItemLinkDirection = (typeof ITEM_LINK_DIRECTIONS)[number];

/**
 * Maps a stored link kind and its direction relative to the requested item to
 * the relationship name that item sees. `related` is symmetric, so both
 * directions read as the same name.
 */
export const RELATIONSHIPS_BY_LINK: Readonly<
  Record<StoredItemLinkKind, Readonly<Record<ItemLinkDirection, ItemRelationshipName>>>
> = {
  related: { outgoing: "related", incoming: "related" },
  dependency: { outgoing: "successor", incoming: "predecessor" },
  duplicate: { outgoing: "duplicate_of", incoming: "duplicate" },
};

/** Human-readable labels for work-item types, used by UI presentation. */
export const WORK_ITEM_TYPE_LABELS: Readonly<Record<WorkItemType, string>> = {
  feature: "Feature",
  user_story: "User Story",
  bug: "Bug",
  task: "Task",
};

/** Human-readable labels for relative relationship names. */
export const ITEM_RELATIONSHIP_LABELS: Readonly<Record<ItemRelationshipName, string>> = {
  parent: "Parent",
  child: "Child",
  related: "Related",
  predecessor: "Predecessor",
  successor: "Successor",
  duplicate: "Duplicate",
  duplicate_of: "Duplicate Of",
};

export type ParticipantId = number;
export type ItemId = number;
export type CommentId = number;
export type LabelId = number;
export type TokenId = number;
export type HistoryId = number;

export interface Actor {
  readonly participantId: ParticipantId;
  readonly name: string;
  readonly kind: ParticipantKind;
}

export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

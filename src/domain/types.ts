export const PARTICIPANT_KINDS = ["human", "agent"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

export const WORK_STATUSES = ["todo", "doing", "blocked", "done"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const PRIORITIES = [0, 1, 2, 3] as const;
export type Priority = (typeof PRIORITIES)[number];

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

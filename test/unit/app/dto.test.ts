import { describe, expect, test } from "bun:test";
import type { CommentJoinedRow } from "../../../src/db/repositories/comments";
import type { HistoryJoinedRow } from "../../../src/db/repositories/history";
import type { ItemJoinedRow } from "../../../src/db/repositories/items";
import type { LabelRow } from "../../../src/db/repositories/labels";
import type { ParticipantRow } from "../../../src/db/repositories/participants";
import type { TokenRow } from "../../../src/db/repositories/tokens";
import { toCommentDto, toHistoryEntryDto, toItemDto, toLabelDto, toParticipantDto, toTokenDto } from "../../../src/app/dto";

const participant: ParticipantRow = {
  id: 1,
  name: "alice",
  kind: "human",
  avatar_color: "#101010",
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("dto mappers", () => {
  test("participant and label", () => {
    const participantDto = toParticipantDto(participant);
    expect(participantDto).toEqual({ id: 1, name: "alice", kind: "human", avatarColor: "#101010", createdAt: "2026-01-01T00:00:00.000Z" });

    const label: LabelRow = { id: 2, name: "bug", color: "#FF0000", created_at: "2026-01-01T00:00:00.000Z" };
    expect(toLabelDto(label)).toEqual({ id: 2, name: "bug", color: "#FF0000", createdAt: "2026-01-01T00:00:00.000Z" });
  });

  test("item maps assignee, labels, and counts", () => {
    const agent: ParticipantRow = { ...participant, id: 3, name: "bot", kind: "agent" };
    const row: ItemJoinedRow = {
      id: 10,
      title: "T",
      body: "B",
      status: "doing",
      priority: 3,
      assignee_id: agent.id,
      created_by: participant.id,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      closed_at: null,
      parent_id: null,
      assignee_name: "bot",
      assignee_kind: "agent",
      comment_count: 2,
    };
    const dto = toItemDto(row, [{ id: 2, name: "bug", color: "#FF0000", createdAt: "2026-01-01T00:00:00.000Z" }]);
    expect(dto.assignee).toEqual({ id: 3, name: "bot", kind: "agent" });
    expect(dto.labels).toHaveLength(1);
    expect(dto.commentCount).toBe(2);
    expect(dto.status).toBe("doing");
    expect(dto.closedAt).toBeNull();

    const unassigned = toItemDto({ ...row, assignee_id: null, assignee_name: null, assignee_kind: null }, []);
    expect(unassigned.assignee).toBeNull();
  });

  test("comment and history", () => {
    const comment: CommentJoinedRow = {
      id: 5,
      item_id: 10,
      author_id: 1,
      body: "hello",
      created_at: "2026-01-01T00:00:01.000Z",
      author_name: "alice",
      author_kind: "human",
    };
    expect(toCommentDto(comment).author).toEqual({ id: 1, name: "alice", kind: "human" });

    const history: HistoryJoinedRow = {
      id: 7,
      item_id: 10,
      actor_id: 1,
      field: "status",
      old_value: "todo",
      new_value: "doing",
      created_at: "2026-01-01T00:00:02.000Z",
      actor_name: "alice",
    };
    const historyDto = toHistoryEntryDto(history);
    expect(historyDto.actorName).toBe("alice");
    expect(historyDto.oldValue).toBe("todo");
    expect(historyDto.newValue).toBe("doing");
  });

  test("token", () => {
    const token: TokenRow = {
      id: 9,
      participant_id: 1,
      name: "bootstrap",
      token_prefix: "wb_abc12",
      secret_digest: "should-not-appear",
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
    };
    const dto = toTokenDto(token) as unknown as Record<string, unknown>;
    expect(dto.tokenPrefix).toBe("wb_abc12");
    expect("secretDigest" in dto).toBe(false);
    expect("secret_digest" in dto).toBe(false);
  });
});

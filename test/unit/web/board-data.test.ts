// Phase C unit tests for the typed board's pure data layer.
//
// `src/web/features/board/data.ts` is the only place the board trusts input:
// every DTO a transport can hand it is normalized here, and the two decisions
// that could corrupt the board if they were wrong — which column a keyboard
// move lands in, and whether a drop payload really is the card currently being
// dragged — are made by pure functions with no DOM and no fetch. That is
// exactly the part worth pinning down, so this suite drives those functions
// directly instead of rendering the component.
//
// Everything asserted below is behavior the component relies on; nothing here
// matches on formatting, ordering, or message text that the UI could reasonably
// change.
import { describe, expect, test } from "bun:test";
import type { Priority, WorkStatus } from "../../../src/domain/types";
import { WORK_ITEM_TYPES, WORK_ITEM_TYPE_LABELS } from "../../../src/domain/types";
import {
  boardItem,
  boardItemFromResponse,
  boardItemsFromResponse,
  clampedStatusTarget,
  isPositiveId,
  isWorkStatus,
  normalizeCommentCount,
  validateInternalDragId,
} from "../../../src/web/features/board/data";
import { BOARD_STATUSES } from "../../../src/web/features/board/types";
import { workItemTypeBadge } from "../../../src/web/views";

// --- fixtures ----------------------------------------------------------------

/**
 * A complete, valid board item exactly as the REST API returns it after the
 * board's own projection. Tests start from this and mutate one field, so a
 * rejection can never be blamed on a second, accidental difference.
 */
function validItem(): Record<string, unknown> {
  return {
    id: 7,
    title: "Ship the typed board",
    status: "doing",
    type: "user_story",
    backlogPosition: 3,
    priority: 2,
    labels: [{ id: 3, name: "phase-c" }, { id: 9, name: "web" }],
    commentCount: 4,
    assignee: { id: 11, name: "reviewer", kind: "agent" },
  };
}

/** A copy of the valid item with one field replaced. */
function withField(field: string, value: unknown): Record<string, unknown> {
  return { ...validItem(), [field]: value };
}

/** A copy of the valid item with one field removed entirely. */
function withoutField(field: string): Record<string, unknown> {
  const item = validItem();
  delete item[field];
  return item;
}

const EVERY_FIELD = ["id", "title", "status", "type", "backlogPosition", "priority", "labels", "commentCount", "assignee"] as const;

// --- complete valid normalization --------------------------------------------

describe("boardItem accepts a complete valid DTO", () => {
  test("normalizes every consumed field, dropping the rest", () => {
    // Extra wire fields the board does not render must not leak through: the
    // returned object is the validated subset, not the input passed along.
    const input = {
      ...validItem(),
      body: "internal notes",
      createdBy: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      closedAt: null,
    };
    const item = boardItem(input);

    expect(item).not.toBeNull();
    expect(item).toEqual({
      id: 7,
      title: "Ship the typed board",
      status: "doing" as WorkStatus,
      type: "user_story" as const,
      backlogPosition: 3,
      priority: 2 as Priority,
      labels: [{ id: 3, name: "phase-c" }, { id: 9, name: "web" }],
      commentCount: 4,
      assignee: { id: 11, name: "reviewer", kind: "agent" },
    });
    // Only the consumed keys exist — no pass-through of unmapped wire fields.
    expect(Object.keys(item!).sort()).toEqual(
      ["assignee", "backlogPosition", "commentCount", "id", "labels", "priority", "status", "title", "type"],
    );
  });

  test("keeps a human assignee and a null assignee distinct", () => {
    const human = boardItem(withField("assignee", { id: 2, name: "bahman", kind: "human" }));
    expect(human?.assignee).toEqual({ id: 2, name: "bahman", kind: "human" });

    // `null` is the valid "unassigned" value, not a malformed one.
    const unassigned = boardItem(withField("assignee", null));
    expect(unassigned).not.toBeNull();
    expect(unassigned?.assignee).toBeNull();
  });

  test("accepts every board status and every priority value", () => {
    for (const status of BOARD_STATUSES) {
      expect(isWorkStatus(status)).toBe(true);
      expect(boardItem(withField("status", status))?.status, status).toBe(status);
    }
    for (const priority of [0, 1, 2, 3] as const) {
      expect(boardItem(withField("priority", priority))?.priority, String(priority)).toBe(priority);
    }
  });

  test("accepts an empty label list", () => {
    const item = boardItem(withField("labels", []));
    expect(item).not.toBeNull();
    expect(item?.labels).toEqual([]);
  });
});

// --- comment count clamping --------------------------------------------------

describe("normalizeCommentCount truncates and clamps", () => {
  test("truncates fractional counts toward zero", () => {
    // A count is rendered as text and as a boolean "has comments" chip, so a
    // fractional value must land on an integer rather than reach the DOM.
    for (const [input, expected] of [
      [4.9, 4],
      [4.4, 4],
      [0.7, 0],
      [-0.7, 0],
      [-4.2, 0],
    ] as const) {
      expect(normalizeCommentCount(input), String(input)).toBe(expected);
      expect(Number.isInteger(normalizeCommentCount(input)), String(input)).toBe(true);
    }
  });

  test("clamps negative counts to zero rather than rejecting them", () => {
    expect(normalizeCommentCount(-1)).toBe(0);
    expect(normalizeCommentCount(-1000)).toBe(0);
    expect(normalizeCommentCount(0)).toBe(0);
  });

  test("rejects every non-finite or non-numeric value", () => {
    // `NaN`, `Infinity`, and `-Infinity` are all numbers, and all of them would
    // render as "NaN comments" or a nonsense count, so they are rejected here
    // instead of being clamped to something arbitrary.
    for (const value of [NaN, Infinity, -Infinity, "4", null, undefined, {}, [], true, 4n]) {
      expect(normalizeCommentCount(value), String(value)).toBeNull();
    }
  });

  test("a board item with an unclampable count is rejected outright", () => {
    // The clamp is a normalization, not a permission: a value outside it means
    // the payload is not the DTO the board understands.
    for (const value of [NaN, Infinity, "4", null, undefined, {}]) {
      expect(boardItem(withField("commentCount", value)), String(value)).toBeNull();
    }
    // Values inside the clamp are normalized onto the item instead.
    expect(boardItem(withField("commentCount", 3.9))?.commentCount).toBe(3);
    expect(boardItem(withField("commentCount", -5))?.commentCount).toBe(0);
  });
});

// --- malformed consumed fields -----------------------------------------------

describe("boardItem rejects malformed consumed fields", () => {
  test("rejects a malformed id", () => {
    for (const value of [0, -1, -7, 1.5, 2.0000001, NaN, Infinity, "7", "abc", "", null, undefined, {}, [], true]) {
      expect(boardItem(withField("id", value)), `id=${String(value)}`).toBeNull();
    }
    // Beyond Number.MAX_SAFE_INTEGER an id cannot round-trip through JSON, so it
    // is not an id the board can address — `data-id` would silently change.
    expect(boardItem(withField("id", Number.MAX_SAFE_INTEGER + 1))).toBeNull();
    expect(boardItem(withField("id", 1))?.id).toBe(1);
  });

  test("rejects a malformed title", () => {
    for (const value of [null, undefined, 7, {}, [], true, ["title"]]) {
      expect(boardItem(withField("title", value)), `title=${String(value)}`).toBeNull();
    }
    // An empty title is valid at this layer: the composer, not the board's
    // normalization, owns the "must not be blank" rule.
    expect(boardItem(withField("title", ""))?.title).toBe("");
  });

  test("rejects a malformed status", () => {
    for (const value of ["archived", "TODO", "Doing", "", null, undefined, 1, {}, [], true]) {
      expect(boardItem(withField("status", value)), `status=${String(value)}`).toBeNull();
    }
    expect(isWorkStatus("archived")).toBe(false);
    expect(isWorkStatus(1)).toBe(false);
    expect(isWorkStatus(null)).toBe(false);
  });

  test("rejects a malformed priority", () => {
    for (const value of [-1, 4, 3.5, 0.5, NaN, Infinity, "2", null, undefined, {}, [], true]) {
      expect(boardItem(withField("priority", value)), `priority=${String(value)}`).toBeNull();
    }
  });

  test("rejects a malformed label list", () => {
    for (const value of [
      null,
      undefined,
      {},
      "labels",
      7,
      [{ id: 3, name: "ok" }, null],
      [{ id: 3, name: "ok" }, { id: 0, name: "zero" }],
      [{ id: 3, name: "ok" }, { id: -1, name: "negative" }],
      [{ id: 3, name: "ok" }, { id: 1.5, name: "fractional" }],
      [{ id: 3, name: "ok" }, { id: "4", name: "string id" }],
      [{ id: 3, name: "ok" }, { id: 4 }],
      [{ id: 3, name: "ok" }, { id: 4, name: 9 }],
      [{ id: 3, name: "ok" }, { name: "no id" }],
      [{ id: 3, name: "ok" }, ["not", "a", "label"]],
    ]) {
      expect(boardItem(withField("labels", value)), `labels=${JSON.stringify(value)}`).toBeNull();
    }
  });

  test("rejects a malformed assignee", () => {
    for (const value of [
      undefined,
      {},
      "assignee",
      7,
      { id: 11, name: "reviewer" },
      { id: 11, name: "reviewer", kind: "robot" },
      { id: 11, name: "reviewer", kind: "HUMAN" },
      { id: 11, name: "reviewer", kind: null },
      { id: 0, name: "reviewer", kind: "human" },
      { id: -2, name: "reviewer", kind: "human" },
      { id: 1.5, name: "reviewer", kind: "human" },
      { id: "11", name: "reviewer", kind: "human" },
      { id: 11, name: 42, kind: "human" },
      { id: 11, kind: "human" },
      ["not", "an", "assignee"],
    ]) {
      expect(boardItem(withField("assignee", value)), `assignee=${JSON.stringify(value)}`).toBeNull();
    }
  });

  test("rejects a payload that is not an object at all", () => {
    for (const value of [null, undefined, 7, "item", true, [], [validItem()], () => validItem()]) {
      expect(boardItem(value), String(value)).toBeNull();
    }
    // An array is an object in JavaScript but never an item; `isRecord` must
    // exclude it before any field is read.
    expect(boardItem([validItem()])).toBeNull();
  });

  test("rejects every missing consumed field", () => {
    // A partial DTO must fail as a whole rather than rendering with a hole. The
    // board reads all seven of these unconditionally.
    for (const field of EVERY_FIELD) {
      expect(boardItem(withoutField(field)), `missing ${field}`).toBeNull();
    }
    expect(Object.keys(validItem()).every((key) => (EVERY_FIELD as readonly string[]).includes(key))).toBe(true);
  });
});

// --- response envelopes ------------------------------------------------------

describe("board response envelopes", () => {
  test("boardItemFromResponse unwraps { data: { item } }", () => {
    const item = boardItemFromResponse({ data: { item: validItem() } });
    expect(item?.id).toBe(7);
    // The envelope itself may carry other keys; only `data.item` is consumed.
    expect(boardItemFromResponse({ data: { item: validItem() }, meta: { page: 1 } })?.id).toBe(7);
  });

  test("boardItemFromResponse rejects malformed envelopes and items", () => {
    for (const response of [
      null,
      undefined,
      validItem(),
      [validItem()],
      {},
      { data: null },
      { data: [] },
      { data: "item" },
      { data: {} },
      { data: { item: null } },
      { data: { item: 7 } },
      { data: { item: withoutField("status") } },
      { data: { item: withField("id", -1) } },
    ]) {
      expect(boardItemFromResponse(response), JSON.stringify(response) ?? "").toBeNull();
    }
  });

  test("boardItemsFromResponse accepts a complete list, including an empty one", () => {
    const items = boardItemsFromResponse({ data: [validItem(), withField("id", 8), withField("id", 9)] });
    expect(items?.map((item) => item.id)).toEqual([7, 8, 9]);
    // An empty board is a valid board, not a failed load.
    expect(boardItemsFromResponse({ data: [] })).toEqual([]);
  });

  test("boardItemsFromResponse rejects a partial list atomically", () => {
    // The board replaces its canonical item set with this result in one step.
    // If a single malformed row were skipped, the board would silently show an
    // incomplete board as if it were the whole board — and, worse, a row that
    // vanished this way is indistinguishable from a deleted item. So one bad
    // row must reject the entire list, and must reject it as `null` rather than
    // as an empty array.
    const badRows: unknown[] = [
      null,
      7,
      "item",
      {},
      { ...validItem(), status: "archived" },
      { ...validItem(), id: 0 },
      { ...validItem(), priority: 9 },
      { ...validItem(), labels: null },
      { ...validItem(), assignee: { id: 1, name: "n", kind: "robot" } },
      { ...validItem(), commentCount: "3" },
    ];
    for (const bad of badRows) {
      const items = boardItemsFromResponse({ data: [validItem(), bad, withField("id", 9)] });
      expect(items, `bad row ${JSON.stringify(bad)}`).toBeNull();
    }
    // The same malformed row in the first or last position is equally fatal:
    // no ordering makes a partial list acceptable.
    const malformed = { ...validItem(), status: "nope" };
    expect(boardItemsFromResponse({ data: [malformed, validItem()] })).toBeNull();
    expect(boardItemsFromResponse({ data: [validItem(), malformed] })).toBeNull();
  });

  test("boardItemsFromResponse rejects malformed envelopes", () => {
    for (const response of [
      null,
      undefined,
      [validItem()],
      validItem(),
      {},
      { data: null },
      { data: {} },
      { data: { items: [validItem()] } },
      { data: "items" },
      { items: [validItem()] },
    ]) {
      expect(boardItemsFromResponse(response), JSON.stringify(response) ?? "").toBeNull();
    }
  });
});

// --- keyboard/clamped status moves -------------------------------------------

describe("clampedStatusTarget", () => {
  test("moves one column in each direction", () => {
    expect(clampedStatusTarget("todo", 1)).toBe("doing");
    expect(clampedStatusTarget("doing", 1)).toBe("blocked");
    expect(clampedStatusTarget("blocked", 1)).toBe("done");
    expect(clampedStatusTarget("done", -1)).toBe("blocked");
    expect(clampedStatusTarget("blocked", -1)).toBe("doing");
    expect(clampedStatusTarget("doing", -1)).toBe("todo");
  });

  test("clamps at the left boundary", () => {
    // The first column has nowhere to go: the caller compares the result with
    // the current status and skips the move, so a clamped no-op is the signal.
    expect(clampedStatusTarget("todo", -1)).toBe("todo");
    expect(clampedStatusTarget("todo", -99)).toBe("todo");
    expect(clampedStatusTarget("doing", -5)).toBe("todo");
    expect(clampedStatusTarget("done", -3)).toBe("todo");
    expect(clampedStatusTarget("done", -1000)).toBe("todo");
  });

  test("clamps at the right boundary", () => {
    expect(clampedStatusTarget("done", 1)).toBe("done");
    expect(clampedStatusTarget("done", 99)).toBe("done");
    expect(clampedStatusTarget("blocked", 5)).toBe("done");
    expect(clampedStatusTarget("todo", 3)).toBe("done");
    expect(clampedStatusTarget("todo", 1000)).toBe("done");
  });

  test("an offset of zero is always the current column", () => {
    for (const status of BOARD_STATUSES) {
      expect(clampedStatusTarget(status, 0), status).toBe(status);
    }
  });

  test("truncates a fractional offset instead of drifting between columns", () => {
    // Offsets come from ±1 key presses today, but a fractional value must not
    // be able to land between two columns.
    expect(clampedStatusTarget("todo", 1.9)).toBe("doing");
    expect(clampedStatusTarget("todo", 0.4)).toBe("todo");
    expect(clampedStatusTarget("blocked", -0.5)).toBe("blocked");
    expect(clampedStatusTarget("done", -1.5)).toBe("blocked");
  });

  test("a non-finite offset is treated as no move", () => {
    // `Math.trunc(NaN)` is NaN and every comparison against NaN is false, so an
    // unguarded implementation would index the status list with NaN and return
    // `undefined`, which is not a status at all.
    for (const offset of [NaN, Infinity, -Infinity]) {
      expect(clampedStatusTarget("doing", offset), String(offset)).toBe("doing");
    }
  });

  test("every result is a real board status", () => {
    // The result is written straight into the move call and then into a PATCH,
    // so it must always be one of the four columns rather than `undefined`.
    for (const status of BOARD_STATUSES) {
      for (const offset of [-4, -3, -2, -1, 0, 1, 2, 3, 4, NaN, Infinity, -Infinity, 1.5, -1.5]) {
        const target = clampedStatusTarget(status, offset);
        expect(BOARD_STATUSES, `${status} ${String(offset)} -> ${String(target)}`).toContain(target);
      }
    }
  });
});

// --- internal drag validation ------------------------------------------------

describe("validateInternalDragId", () => {
  test("accepts the exact canonical id of the active drag", () => {
    for (const id of [1, 7, 42, 999, Number.MAX_SAFE_INTEGER]) {
      expect(validateInternalDragId(String(id), id), String(id)).toBe(id);
    }
  });

  test("rejects a payload that is not a canonical decimal id", () => {
    // A drop payload is attacker-influenced: any page in the browser, an
    // extension, or a stale drag can put arbitrary text on the dataTransfer.
    // Only the canonical decimal form the card itself wrote is accepted.
    //
    // Note on coverage: the load-bearing check here is the round-trip
    // `payload === String(Number(payload))`, not the `/^\d+$/` shape test that
    // precedes it — exhaustive search over hostile short strings finds no input
    // the shape test rejects that the round-trip would accept. These assertions
    // pin the observable contract; they do not claim the shape test is
    // independently exercised.
    for (const payload of [
      "007",
      " 7",
      "7 ",
      "+7",
      "-7",
      "7.0",
      "7e0",
      "0x7",
      "7n",
      "",
      " ",
      "abc",
      "{}",
      '{"id":7}',
      "null",
      "undefined",
      "NaN",
      "Infinity",
    ]) {
      expect(validateInternalDragId(payload, 7), JSON.stringify(payload)).toBeNull();
    }
    // Non-string payloads are rejected: `getData` returns a string or nothing.
    for (const payload of [7, null, undefined, {}, [], true, 7n]) {
      expect(validateInternalDragId(payload, 7), String(payload)).toBeNull();
    }
  });

  test("rejects negative and zero payloads even when they match", () => {
    // There is no card for id 0 or a negative id, so matching one would mean
    // the board is about to PATCH a nonexistent item.
    expect(validateInternalDragId("0", 0)).toBeNull();
    expect(validateInternalDragId("-1", -1)).toBeNull();
    expect(validateInternalDragId("0", 7)).toBeNull();
    expect(validateInternalDragId("-7", 7)).toBeNull();
  });

  test("rejects a malformed active drag id", () => {
    // Without an active internal drag there is nothing to validate against, so
    // any drop — including one carrying a plausible id — is ignored. This is
    // what keeps an external drop (a text snippet, a link, a file) from moving
    // a card.
    for (const active of [null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "7", undefined]) {
      expect(validateInternalDragId("7", active as number | null), String(active)).toBeNull();
    }
  });

  test("rejects a payload that does not match the active drag", () => {
    // The exact mismatch this guard exists for: a drag that was started for one
    // card cannot be completed as another card, and a stale payload from a
    // previous drag cannot move the card being dragged now.
    expect(validateInternalDragId("8", 7)).toBeNull();
    expect(validateInternalDragId("7", 8)).toBeNull();
    expect(validateInternalDragId("9", 7)).toBeNull();
    expect(validateInternalDragId("70", 7)).toBeNull();
    expect(validateInternalDragId("7", 70)).toBeNull();
    // A canonical but unrelated external id stays rejected.
    expect(validateInternalDragId("12345", 7)).toBeNull();
  });

  test("a payload beyond the safe integer range is rejected", () => {
    // `Number("9007199254740993")` rounds, so accepting it would move a card
    // whose id is not the one on the payload.
    expect(validateInternalDragId("9007199254740993", 9007199254740992)).toBeNull();
  });
});

// --- shared id guards --------------------------------------------------------

describe("isPositiveId", () => {
  test("accepts only positive safe integers", () => {
    for (const value of [1, 7, 42, Number.MAX_SAFE_INTEGER]) {
      expect(isPositiveId(value), String(value)).toBe(true);
    }
    for (const value of [
      0,
      -1,
      -7,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "7",
      "",
      null,
      undefined,
      {},
      [],
      true,
      7n,
    ]) {
      expect(isPositiveId(value), String(value)).toBe(false);
    }
  });

  test("accepts exactly the ids the drag guard accepts", () => {
    // The two guards must agree: `validateInternalDragId` compares a parsed
    // payload against the active id using this predicate, and `moveItem` uses
    // it again before issuing the PATCH. A disagreement would let a drop pass
    // validation and then be dropped by the move.
    for (const id of [1, 7, 42, Number.MAX_SAFE_INTEGER]) {
      expect(validateInternalDragId(String(id), id)).toBe(id);
      expect(isPositiveId(id)).toBe(true);
    }
  });
});

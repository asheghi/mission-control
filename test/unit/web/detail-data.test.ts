// Phase E unit tests for the typed detail view's pure data layer.
//
// `src/web/features/detail/data.ts` is the only place the detail view trusts
// input. The REST client parses JSON without a schema, so every envelope the
// migrated view accepts — the whole-item read, the comment list, the history
// page, the roster, the label catalogue, and the four write confirmations —
// arrives through one of the functions below. That makes them the part worth
// pinning down, and it is why this suite drives them directly instead of
// rendering the component or the hook.
//
// Three contracts are load-bearing and are asserted here rather than in the
// browser suite:
//
//   1. Rejection is atomic. A view is accepted whole or not at all, so one
//      malformed row can never leave a half-rendered item: no comment list with
//      an entry missing and no history with a silently dropped row.
//   2. A write confirmation is never invented. A create that cannot be parsed is
//      a failure to create, not a resource with a synthesized id — the id must
//      come from the server, because a made-up key can never be reconciled with
//      the next read.
//   3. Structural duplicates are refused. The roster and the label catalogue key
//      their options by id and name, so a repeated id or a repeated name would
//      render two options competing for one key.
//
// Nothing here matches on formatting, ordering, or message text the UI could
// reasonably change, and nothing depends on a minified identifier: these are
// source-level functions.
import { describe, expect, test } from "bun:test";
import {
  commentFromResponse,
  detailFromResponse,
  itemFromDetailResponse,
  labelFromResponse,
  labelsFromResponse,
  mentionedNamesFromResponse,
  participantsFromResponse,
} from "../../../src/web/features/detail/data";
import type { DetailComment, DetailHistoryEntry, DetailItem } from "../../../src/web/features/detail/types";
import { views } from "../../../src/web/views.js";
// Importing the feature is what registers the view; the module itself exports
// the component, its props type, and the parsers under test.
import "../../../src/web/features/detail/index";

// --- fixtures ----------------------------------------------------------------

/** A complete, valid participant exactly as the API projects one. */
function validParticipant(): Record<string, unknown> {
  return { id: 11, name: "reviewer", kind: "agent" };
}

/** A complete, valid label exactly as `GET /api/labels` returns one. */
function validLabel(): Record<string, unknown> {
  return { id: 3, name: "phase-e", color: "#3B82F6" };
}

/**
 * A complete, valid item exactly as `GET /api/items/:id` returns it. Every
 * rejection test starts from this and changes one field, so a failure can never
 * be blamed on a second, accidental difference.
 */
function validItem(): Record<string, unknown> {
  return {
    id: 7,
    title: "Migrate the detail view",
    body: "## Plan\n\nRewrite the legacy detail module.",
    status: "doing",
    priority: 2,
    assignee: validParticipant(),
    createdAt: "2024-05-01T10:00:00.000Z",
    updatedAt: "2024-05-02T11:30:00.000Z",
    closedAt: null,
    labels: [validLabel()],
  };
}

/** A copy of the valid item with one field replaced. */
function itemWith(field: string, value: unknown): Record<string, unknown> {
  return { ...validItem(), [field]: value };
}

/** A complete, valid comment exactly as the item read returns one. */
function validComment(): Record<string, unknown> {
  return {
    id: 21,
    author: validParticipant(),
    body: "Looks good to me.",
    createdAt: "2024-05-02T12:00:00.000Z",
  };
}

/** A complete, valid history entry exactly as the item read returns one. */
function validHistory(): Record<string, unknown> {
  return {
    id: 31,
    actorName: "admin",
    field: "status",
    oldValue: "todo",
    newValue: "doing",
    createdAt: "2024-05-02T11:30:00.000Z",
  };
}

/** The `GET /api/items/:id` envelope: `{ data: { item, comments, history } }`. */
function detailEnvelope(): Record<string, unknown> {
  return { data: { item: validItem(), comments: [validComment()], history: [validHistory()] } };
}

/** A copy of the detail envelope with one top-level `data` key replaced. */
function detailWith(field: string, value: unknown): Record<string, unknown> {
  return { data: { ...(detailEnvelope().data as Record<string, unknown>), [field]: value } };
}

/** A valid detail envelope whose item has one field replaced. */
function detailWithItemField(field: string, value: unknown): Record<string, unknown> {
  return detailWith("item", itemWith(field, value));
}

/** A valid detail envelope whose single comment has one field replaced. */
function detailWithCommentField(field: string, value: unknown): Record<string, unknown> {
  return detailWith("comments", [{ ...validComment(), [field]: value }]);
}

/** A valid detail envelope whose single history entry has one field replaced. */
function detailWithHistoryField(field: string, value: unknown): Record<string, unknown> {
  return detailWith("history", [{ ...validHistory(), [field]: value }]);
}

/** The `{ data: item }` envelope a PATCH returns, plus `changedFields`. */
function patchEnvelope(): Record<string, unknown> {
  return { data: { ...validItem(), changedFields: ["title"] } };
}

/** Values no parser may ever accept as a record it can read fields from. */
const NOT_A_RECORD: readonly unknown[] = [null, undefined, 0, "", "nope", true, [], [validItem()], () => validItem()];

// --- the whole-item read -----------------------------------------------------

describe("detailFromResponse", () => {
  test("accepts a complete item, comment list, and history page", () => {
    const parsed = detailFromResponse(detailEnvelope());
    expect(parsed).not.toBeNull();
    // Exactly the three collections the view renders, and nothing carried over
    // from the wire object.
    expect(Object.keys(parsed!).sort()).toEqual(["comments", "history", "item"]);
    expect(parsed!.item.id).toBe(7);
    expect(parsed!.item.title).toBe("Migrate the detail view");
    expect(parsed!.item.status).toBe("doing");
    expect(parsed!.item.priority).toBe(2);
    expect(parsed!.item.assignee).toEqual({ id: 11, name: "reviewer", kind: "agent" });
    expect(parsed!.item.closedAt).toBeNull();
    expect(parsed!.item.labels).toEqual([{ id: 3, name: "phase-e", color: "#3B82F6" }]);
    expect(parsed!.comments).toHaveLength(1);
    expect(parsed!.comments[0]!.author.name).toBe("reviewer");
    expect(parsed!.history).toHaveLength(1);
    expect(parsed!.history[0]!.field).toBe("status");
  });

  test("accepts empty comment and history arrays, and an unassigned item", () => {
    // A brand-new item has neither comments nor history, and an unassigned item
    // must be distinguishable from a malformed one: `assignee: null` is valid.
    const parsed = detailFromResponse(detailWith("comments", []));
    expect(parsed).not.toBeNull();
    expect(parsed!.comments).toEqual([]);
    const unassigned = detailFromResponse(detailWithItemField("assignee", null));
    expect(unassigned).not.toBeNull();
    expect(unassigned!.item.assignee).toBeNull();
    const closed = detailFromResponse(detailWithItemField("closedAt", "2024-05-03T09:00:00.000Z"));
    expect(closed!.item.closedAt).toBe("2024-05-03T09:00:00.000Z");
  });

  test("accepts empty title and body strings, which the API itself permits", () => {
    // `bodySchema` allows an empty description and a title may be whitespace
    // only while it is being edited, so neither is a parse failure. Treating one
    // as malformed would blank the whole view on a legitimate payload.
    const parsed = detailFromResponse(detailWithItemField("body", ""));
    expect(parsed).not.toBeNull();
    expect(parsed!.item.body).toBe("");
    expect(detailFromResponse(detailWithItemField("title", ""))!.item.title).toBe("");
  });

  test("rejects an envelope without a data record or with missing collections", () => {
    for (const response of NOT_A_RECORD) expect(detailFromResponse(response)).toBeNull();
    expect(detailFromResponse({})).toBeNull();
    // `data` must be a record, not a bare collection.
    expect(detailFromResponse({ data: [validItem()] })).toBeNull();
    expect(detailFromResponse({ data: { item: validItem(), comments: [validComment()] } })).toBeNull();
    expect(detailFromResponse({ data: { item: validItem(), history: [validHistory()] } })).toBeNull();
    expect(detailFromResponse(detailWith("comments", {}))).toBeNull();
    expect(detailFromResponse(detailWith("history", "none"))).toBeNull();
    expect(detailFromResponse(detailWith("item", null))).toBeNull();
  });

  test("rejects an item whose id, status, or priority is not valid", () => {
    for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "7", null, undefined, {}, []]) {
      expect(detailFromResponse(detailWithItemField("id", id)), String(id)).toBeNull();
    }
    for (const status of ["", "DOING", "archived", 0, null, undefined, {}, []]) {
      expect(detailFromResponse(detailWithItemField("status", status)), String(status)).toBeNull();
    }
    for (const priority of [-1, 4, 2.5, NaN, Infinity, "2", null, undefined]) {
      expect(detailFromResponse(detailWithItemField("priority", priority)), String(priority)).toBeNull();
    }
  });

  test("rejects an item whose text fields or timestamps are malformed", () => {
    for (const field of ["title", "body"]) {
      for (const value of [null, undefined, 7, {}, []]) {
        expect(detailFromResponse(detailWithItemField(field, value)), `${field} ${String(value)}`).toBeNull();
      }
    }
    // A timestamp must be a non-empty string that parses, so a missing or
    // unparseable date cannot render as "Invalid Date" in the header.
    for (const field of ["createdAt", "updatedAt"]) {
      for (const value of ["", "not a date", 0, null, undefined, 1_700_000_000, {}]) {
        expect(detailFromResponse(detailWithItemField(field, value)), `${field} ${String(value)}`).toBeNull();
      }
    }
    for (const value of [0, "", "nope", undefined, {}, []]) {
      expect(detailFromResponse(detailWithItemField("closedAt", value)), String(value)).toBeNull();
    }
  });

  test("rejects an item whose assignee or label list is malformed", () => {
    for (const assignee of [{ id: 11, name: "reviewer" }, { id: 11, name: "reviewer", kind: "robot" }, { id: 0, name: "x", kind: "human" }, "reviewer", 11]) {
      expect(detailFromResponse(detailWithItemField("assignee", assignee)), JSON.stringify(assignee)).toBeNull();
    }
    // `labels` must be an array of valid labels, not a single object or strings.
    for (const labels of [{}, "phase-e", [validLabel(), { id: 0, name: "x", color: "#000000" }], [{ name: "phase-e", color: "#000000" }], [null]]) {
      expect(detailFromResponse(detailWithItemField("labels", labels)), JSON.stringify(labels)).toBeNull();
    }
  });

  test("rejects the whole view when one comment is malformed", () => {
    // Atomic rejection: the good comment next to the bad one may not survive,
    // because a partially rendered comment list silently hides a comment.
    expect(detailFromResponse(detailWith("comments", [validComment(), { id: 22, body: "hi", createdAt: "2024-05-01T00:00:00.000Z" }]))).toBeNull();
    expect(detailFromResponse(detailWith("comments", [validComment(), null]))).toBeNull();
    expect(detailFromResponse(detailWith("comments", [validComment(), "text"]))).toBeNull();
    for (const field of ["id", "body", "createdAt"]) {
      const broken = field === "id" ? 0 : field === "body" ? 7 : "";
      expect(detailFromResponse(detailWithCommentField(field, broken)), field).toBeNull();
    }
    expect(detailFromResponse(detailWithCommentField("author", { id: 11, name: "reviewer" }))).toBeNull();
  });

  test("rejects the whole view when one history entry is malformed", () => {
    expect(detailFromResponse(detailWith("history", [validHistory(), { id: 32, field: "title", createdAt: "2024-05-01T00:00:00.000Z" }]))).toBeNull();
    expect(detailFromResponse(detailWith("history", [validHistory(), null]))).toBeNull();
    for (const field of ["id", "actorName", "field", "createdAt"]) {
      const broken = field === "id" ? 0 : field === "createdAt" ? "" : 7;
      expect(detailFromResponse(detailWithHistoryField(field, broken)), field).toBeNull();
    }
    // Old and new values are `string | null`; a number would render as
    // `undefined` in the diff and misreport what the edit did.
    for (const field of ["oldValue", "newValue"]) {
      for (const value of [7, true, {}, [], undefined]) {
        expect(detailFromResponse(detailWithHistoryField(field, value)), `${field} ${String(value)}`).toBeNull();
      }
    }
    // A creation entry has no previous value, so both fields being null is valid.
    const created = detailFromResponse(detailWith("history", [{ ...validHistory(), field: "created", oldValue: null, newValue: null }]));
    expect(created).not.toBeNull();
    expect(created!.history[0]!.oldValue).toBeNull();
    expect(created!.history[0]!.newValue).toBeNull();
  });

  test("the parsed item and history entry carry exactly their declared keys", () => {
    // The parsers copy fields rather than passing the wire object along, so a
    // payload cannot smuggle `__proto__`, `commentCount`, or `changedFields`
    // into a rendered item.
    const parsed = detailFromResponse(detailEnvelope());
    const item = parsed!.item as unknown as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(
      ["assignee", "body", "closedAt", "createdAt", "id", "labels", "priority", "status", "title", "updatedAt"],
    );
    expect(item.commentCount).toBeUndefined();
    expect(item.author).toBeUndefined();
    const entry = parsed!.history[0] as unknown as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["actorName", "createdAt", "field", "id", "newValue", "oldValue"]);
  });

  test("a parse never throws on hostile input", () => {
    // The parser runs inside a promise chain that reports failures as a notice;
    // a throw would escape as an unhandled rejection instead.
    const hostile: unknown[] = [
      ...NOT_A_RECORD,
      detailWith("comments", [[[]]]),
      detailWith("history", [() => undefined]),
      detailWithItemField("labels", [{ get name(): string { throw new Error("boom"); } }]),
      detailWithItemField("status", Symbol("doing")),
    ];
    for (const response of hostile) {
      expect(() => detailFromResponse(response), String(response)).not.toThrow();
    }
  });
});

// --- write confirmations -----------------------------------------------------

describe("itemFromDetailResponse", () => {
  test("accepts the item a PATCH returns, ignoring the fields the view does not read", () => {
    const item = itemFromDetailResponse(patchEnvelope());
    expect(item).not.toBeNull();
    expect(item!.id).toBe(7);
    expect(item!.title).toBe("Migrate the detail view");
    expect((item as unknown as Record<string, unknown>).changedFields).toBeUndefined();
  });

  test("rejects an envelope with no readable item", () => {
    for (const response of NOT_A_RECORD) expect(itemFromDetailResponse(response)).toBeNull();
    expect(itemFromDetailResponse({})).toBeNull();
    expect(itemFromDetailResponse({ data: null })).toBeNull();
    // The whole-item read envelope is not an item: a PATCH response is `data`
    // itself, and reading the read-envelope's `item` here would accept a shape
    // the route never returns.
    expect(itemFromDetailResponse(detailEnvelope())).toBeNull();
    expect(itemFromDetailResponse({ data: { item: validItem() } })).toBeNull();
    expect(itemFromDetailResponse({ data: itemWith("updatedAt", "not a date") })).toBeNull();
  });

  test("rejects a partially valid item rather than merging it", () => {
    // A PATCH confirmation replaces the rendered item, so a degraded copy would
    // erase fields the view still shows. Nothing partial is accepted.
    for (const field of ["id", "status", "priority", "assignee", "labels", "createdAt", "updatedAt", "closedAt"]) {
      const value = field === "id" ? 0 : field === "closedAt" ? "never" : field === "labels" ? [{}] : field === "assignee" ? undefined : "bad";
      expect(itemFromDetailResponse({ data: itemWith(field, value) }), field).toBeNull();
    }
  });
});

describe("labelFromResponse", () => {
  test("accepts the single label a create returns and keeps the server's id", () => {
    const label = labelFromResponse({ data: validLabel() });
    expect(label).toEqual({ id: 3, name: "phase-e", color: "#3B82F6" });
    // The id is exactly the one the server sent, so the new label can be
    // reconciled with the next catalogue read.
    expect(labelFromResponse({ data: { id: 99, name: "new", color: "#10B981" } })!.id).toBe(99);
  });

  test("a create whose response cannot be parsed is a failure, never an invented label", () => {
    // The synthesizing version of this function (a counter, or a placeholder id
    // such as `MAX_SAFE_INTEGER - length`) would return a label here. Any id it
    // invented could never be reconciled with an authoritative read, so it would
    // survive as a phantom option for the rest of the session.
    for (const response of NOT_A_RECORD) expect(labelFromResponse(response)).toBeNull();
    expect(labelFromResponse({})).toBeNull();
    expect(labelFromResponse({ data: null })).toBeNull();
    expect(labelFromResponse({ data: { name: "phase-e", color: "#3B82F6" } })).toBeNull();
    expect(labelFromResponse({ data: { id: 3, name: "phase-e" } })).toBeNull();
    expect(labelFromResponse({ data: { id: 0, name: "phase-e", color: "#3B82F6" } })).toBeNull();
    expect(labelFromResponse({ data: { id: 3, name: "phase-e", color: 3 } })).toBeNull();
    // A catalogue envelope is not a create confirmation.
    expect(labelFromResponse({ data: [validLabel()] })).toBeNull();
  });

  test("the returned label carries only id, name, and color", () => {
    const label = labelFromResponse({ data: { ...validLabel(), createdAt: "2024-05-01T00:00:00.000Z", __proto__: { injected: true } } });
    expect(Object.keys(label!).sort()).toEqual(["color", "id", "name"]);
    expect((label as unknown as Record<string, unknown>).injected).toBeUndefined();
  });
});

describe("commentFromResponse", () => {
  test("accepts the comment a POST returns", () => {
    const comment = commentFromResponse({ data: { comment: validComment(), mentionedParticipants: [validParticipant()] } });
    expect(comment).not.toBeNull();
    expect(comment!.id).toBe(21);
    expect(comment!.body).toBe("Looks good to me.");
    expect(comment!.author).toEqual({ id: 11, name: "reviewer", kind: "agent" });
  });

  test("rejects a comment response that is missing, empty, or malformed", () => {
    for (const response of NOT_A_RECORD) expect(commentFromResponse(response)).toBeNull();
    expect(commentFromResponse({})).toBeNull();
    expect(commentFromResponse({ data: {} })).toBeNull();
    expect(commentFromResponse({ data: { comment: null } })).toBeNull();
    // A bare comment is not the envelope: the route wraps it in `data.comment`,
    // and accepting the bare form would hide a server contract change.
    expect(commentFromResponse({ data: validComment() })).toBeNull();
    expect(commentFromResponse({ data: { comment: { id: 22, body: "hi" } } })).toBeNull();
    expect(commentFromResponse({ data: { comment: { ...validComment(), id: 0 } } })).toBeNull();
    expect(commentFromResponse({ data: { comment: { ...validComment(), createdAt: "" } } })).toBeNull();
  });
});

describe("mentionedNamesFromResponse", () => {
  test("accepts the participants the server actually notified, in order", () => {
    // The notice lists these names, so order and content must be the server's
    // rather than a re-derivation from the comment body.
    const names = mentionedNamesFromResponse({
      data: { comment: validComment(), mentionedParticipants: [validParticipant(), { id: 12, name: "admin", kind: "human" }] },
    });
    expect(names).toEqual(["reviewer", "admin"]);
  });

  test("an accepted comment with no mention yields an empty list, not a failure", () => {
    // The composer still clears the draft and reports "Comment added."; a
    // failure here would be indistinguishable from a rejected write.
    expect(mentionedNamesFromResponse({ data: { comment: validComment(), mentionedParticipants: [] } })).toEqual([]);
  });

  test("rejects an unreadable mention list so the notice falls back rather than guessing", () => {
    for (const response of NOT_A_RECORD) expect(mentionedNamesFromResponse(response)).toBeNull();
    expect(mentionedNamesFromResponse({})).toBeNull();
    expect(mentionedNamesFromResponse({ data: {} })).toBeNull();
    expect(mentionedNamesFromResponse({ data: { mentionedParticipants: null } })).toBeNull();
    expect(mentionedNamesFromResponse({ data: { mentionedParticipants: "reviewer" } })).toBeNull();
    expect(mentionedNamesFromResponse({ data: { mentionedParticipants: [{ id: 11, name: "reviewer" }] } })).toBeNull();
    expect(mentionedNamesFromResponse({ data: { mentionedParticipants: [null] } })).toBeNull();
    // An unreadable list with a good comment must still be reported as unreadable:
    // half-parsed mentions would announce the wrong people.
    expect(mentionedNamesFromResponse({ data: { comment: validComment(), mentionedParticipants: [validParticipant(), 0] } })).toBeNull();
  });
});

// --- option catalogues -------------------------------------------------------

describe("participantsFromResponse", () => {
  test("accepts the roster the assignment control is built from", () => {
    const participants = participantsFromResponse({ data: [validParticipant(), { id: 12, name: "admin", kind: "human" }] });
    expect(participants).toEqual([
      { id: 11, name: "reviewer", kind: "agent" },
      { id: 12, name: "admin", kind: "human" },
    ]);
  });

  test("an empty roster is valid: nobody may be assignable yet", () => {
    expect(participantsFromResponse({ data: [] })).toEqual([]);
  });

  test("rejects a roster with a malformed or duplicated member", () => {
    // The options are keyed by id, so a duplicate would render two entries for
    // one participant and make the selected value ambiguous.
    expect(participantsFromResponse({ data: [validParticipant(), validParticipant()] })).toBeNull();
    expect(participantsFromResponse({ data: [{ id: 11, name: "reviewer", kind: "agent" }, { id: 11, name: "other", kind: "human" }] })).toBeNull();
    expect(participantsFromResponse({ data: [validParticipant(), { id: 0, name: "nobody", kind: "human" }] })).toBeNull();
    expect(participantsFromResponse({ data: [{ id: 11, name: "", kind: "bot" }] })).toBeNull();
    expect(participantsFromResponse({ data: [validParticipant(), null] })).toBeNull();
  });

  test("rejects an envelope that is not a data array", () => {
    for (const response of NOT_A_RECORD) expect(participantsFromResponse(response)).toBeNull();
    expect(participantsFromResponse({})).toBeNull();
    expect(participantsFromResponse({ data: {} })).toBeNull();
    // A paged list envelope is not a roster; reading `data` as the array would
    // accept a shape this route never returns.
    expect(participantsFromResponse({ data: { items: [validParticipant()] } })).toBeNull();
    expect(participantsFromResponse({ data: validParticipant() })).toBeNull();
  });
});

describe("labelsFromResponse", () => {
  test("accepts the label catalogue the suggestions are built from", () => {
    const labels = labelsFromResponse({ data: [validLabel(), { id: 9, name: "web", color: "#EF4444" }] });
    expect(labels).toEqual([
      { id: 3, name: "phase-e", color: "#3B82F6" },
      { id: 9, name: "web", color: "#EF4444" },
    ]);
  });

  test("rejects a catalogue whose entries are malformed, keeping name uniqueness", () => {
    // The suggestion buttons key by name and the add path deduplicates by name,
    // so a repeated name would offer one label twice. Ids need not be unique
    // here: the roster is the collection whose keys are ids.
    expect(labelsFromResponse({ data: [validLabel(), { id: 9, name: "phase-e", color: "#EF4444" }] })).toBeNull();
    expect(labelsFromResponse({ data: [validLabel(), { id: 9, name: "web" }] })).toBeNull();
    // `color` is passed through as the string the server sent; it is a CSS
    // token value here, not re-validated against the server's color regex.
    expect(labelsFromResponse({ data: [{ id: 3, name: "phase-e", color: "" }] })).toEqual([{ id: 3, name: "phase-e", color: "" }]);
    expect(labelsFromResponse({ data: [{ id: 3, name: "phase-e", color: 3 }] })).toBeNull();
    expect(labelsFromResponse({ data: [null] })).toBeNull();
  });

  test("rejects an envelope that is not a data array, though an empty one is valid", () => {
    for (const response of NOT_A_RECORD) expect(labelsFromResponse(response)).toBeNull();
    expect(labelsFromResponse({})).toBeNull();
    expect(labelsFromResponse({ data: validLabel() })).toBeNull();
    expect(labelsFromResponse({ data: { labels: [] } })).toBeNull();
    expect(labelsFromResponse({ data: [] })).toEqual([]);
  });
});

// --- view registration -------------------------------------------------------

describe("the detail view registration", () => {
  test("registers `detail` as a Preact component with the fixed route", () => {
    const entry = views["detail"];
    expect(entry).toBeDefined();
    // `kind: "component"` is what routes the view through the Preact host rather
    // than the legacy `mount` path; `component` is the renderer itself.
    expect(entry?.kind).toBe("component");
    expect(typeof (entry as { component?: unknown } | undefined)?.component).toBe("function");
    expect(entry?.title).toBe("Item");
    expect(entry?.href).toBe("#/item");
    // So the shell's hash router resolves `#/item` to this entry.
    expect(Object.values(views).some((candidate) => candidate.href === "#/item")).toBe(true);
  });

  test("registers no legacy mount, and stays out of the navigation", () => {
    const entry = views["detail"] as { mount?: unknown; hidden?: unknown } | undefined;
    // The migrated view is a component: a surviving `mount` would mean the
    // legacy `src/web/detail.js` module is still registering the route.
    expect(entry?.mount).toBeUndefined();
    // Detail remains reachable only through `#/item/:id`, never as a nav entry.
    expect(entry?.hidden).toBe(true);
  });
});

// --- what the parser hands the renderer --------------------------------------

describe("the accepted view is safe to render", () => {
  test("a parsed view is plain data with no inherited members", () => {
    const parsed = detailFromResponse({
      data: {
        item: { ...validItem(), __proto__: { injected: true }, constructor: "nope" },
        comments: [{ ...validComment(), __proto__: { injected: true } }],
        history: [validHistory()],
      },
    });
    expect(parsed).not.toBeNull();
    const item = parsed!.item as DetailItem;
    const comment = parsed!.comments[0] as DetailComment;
    const entry = parsed!.history[0] as DetailHistoryEntry;
    for (const value of [item, comment, entry]) {
      expect(Object.prototype.hasOwnProperty.call(value, "injected")).toBe(false);
    }
    expect(Object.keys(item).sort()).toEqual(
      ["assignee", "body", "closedAt", "createdAt", "id", "labels", "priority", "status", "title", "updatedAt"],
    );
    expect(Object.keys(comment).sort()).toEqual(["author", "body", "createdAt", "id"]);
    expect(Object.keys(entry).sort()).toEqual(["actorName", "createdAt", "field", "id", "newValue", "oldValue"]);
  });
});

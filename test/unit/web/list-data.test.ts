// Phase D unit tests for the typed list's pure data layer.
//
// `src/web/features/list/data.ts` is the only place the list trusts input. The
// REST client parses JSON with no schema, so every DTO — including a `nextCursor`
// string that is later handed straight back to the server as a query parameter —
// reaches the UI through these three functions. That makes them the part worth
// pinning down, and it is why this suite drives them directly rather than
// rendering the component or the hook.
//
// Two contracts are load-bearing and are asserted here rather than in the
// browser suite:
//
//   1. Rejection is atomic. A page is accepted whole or not at all; one bad row
//      must not leave a half-populated table, and a duplicate id must not render
//      two `<tr>`s sharing a key.
//   2. A cursor is passed through unchanged or refused. The parser validates
//      exactly the shape the server's opaque base64url cursors occupy and never
//      rewrites one, because normalizing it would silently move the page boundary.
//
// The last section covers the two Phase D wiring facts a unit test can see: that
// `features/list` registers the `list` view as a Preact component (the bundle
// suite proves the served bytes), and that the status filter the feature persists
// only ever holds a real status. Nothing here matches on formatting or message
// text the UI could reasonably change.
import { describe, expect, test } from "bun:test";
import type { Priority, WorkStatus } from "../../../src/domain/types";
import {
  labelsFromResponse,
  listPageFromResponse,
  participantsFromResponse,
} from "../../../src/web/features/list/data";
import { LIST_STATUSES } from "../../../src/web/features/list/types";
import type { ListItem, ListParticipant } from "../../../src/web/features/list/types";
import { createFilterStore, emptyFilters } from "../../../src/web/ui-state.js";
import { views } from "../../../src/web/views";
// Importing the feature is what registers the view; the module itself exports
// only the component and its props type.
import "../../../src/web/features/list/index";

// --- fixtures ----------------------------------------------------------------

/**
 * A complete, valid list item exactly as `GET /api/items` returns it after the
 * server's projection. Every rejection test starts from this and changes one
 * field, so a failure can never be blamed on a second, accidental difference.
 */
function validItem(): Record<string, unknown> {
  return {
    id: 7,
    title: "Migrate the list view",
    status: "doing",
    priority: 2,
    labels: [{ id: 3, name: "phase-d" }, { id: 9, name: "web" }],
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

/**
 * A page response wrapping one or more rows and a cursor. The default covers the
 * common case (last page); pass a cursor explicitly to test pass-through, or
 * build the envelope literally to test an absent key.
 */
function page(data: unknown[], nextCursor: unknown = null): Record<string, unknown> {
  return { data, meta: { nextCursor } };
}

/**
 * A real server cursor: `encodeCursor([updatedAt, id])` — base64url of a JSON
 * tuple. Building it here rather than hard-coding a literal keeps this suite
 * honest about the alphabet the server actually emits.
 */
function serverCursor(updatedAt: string, id: number): string {
  return Buffer.from(JSON.stringify([updatedAt, id]), "utf8").toString("base64url");
}

const EVERY_FIELD = ["id", "title", "status", "priority", "labels", "assignee"] as const;

// --- complete valid normalization --------------------------------------------

describe("listPageFromResponse accepts a complete valid page", () => {
  test("normalizes every consumed field and drops the rest", () => {
    // Extra wire fields the list does not render (body, timestamps, counts) must
    // not leak through: the returned item is the validated subset, not the input
    // passed along.
    const input = {
      ...validItem(),
      body: "internal notes",
      commentCount: 4,
      createdBy: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      closedAt: null,
    };
    const result = listPageFromResponse(page([input]));

    expect(result).not.toBeNull();
    expect(result?.items).toEqual([{
      id: 7,
      title: "Migrate the list view",
      status: "doing" as WorkStatus,
      priority: 2 as Priority,
      labels: [{ id: 3, name: "phase-d" }, { id: 9, name: "web" }],
      assignee: { id: 11, name: "reviewer", kind: "agent" },
    }]);
    expect(Object.keys(result!.items[0]!).sort()).toEqual(
      ["assignee", "id", "labels", "priority", "status", "title"],
    );
    expect(result?.nextCursor).toBeNull();
  });

  test("keeps a human assignee, an agent assignee, and null distinct", () => {
    const human = listPageFromResponse(page([withField("assignee", { id: 2, name: "bahman", kind: "human" })]));
    expect(human?.items[0]?.assignee).toEqual({ id: 2, name: "bahman", kind: "human" });

    const agent = listPageFromResponse(page([validItem()]));
    expect(agent?.items[0]?.assignee?.kind).toBe("agent");

    // `null` is the valid "unassigned" value, not a malformed one.
    const unassigned = listPageFromResponse(page([withField("assignee", null)]));
    expect(unassigned).not.toBeNull();
    expect(unassigned?.items[0]?.assignee).toBeNull();
  });

  test("accepts every list status, every priority, an empty label list, and an empty page", () => {
    // The status the server sends is the status the row must render; the filter
    // dropdown offers exactly these four.
    for (const status of LIST_STATUSES) {
      const result = listPageFromResponse(page([withField("status", status)]));
      expect(result?.items[0]?.status, status).toBe(status as WorkStatus);
    }
    for (const priority of [0, 1, 2, 3] as const) {
      const result = listPageFromResponse(page([withField("priority", priority)]));
      expect(result?.items[0]?.priority, String(priority)).toBe(priority as Priority);
    }
    const bare = listPageFromResponse(page([withField("labels", [])]));
    expect(bare).not.toBeNull();
    expect(bare?.items[0]?.labels).toEqual([]);

    // "No work items match these filters" is a valid page, not a parse failure:
    // an empty row set with a null cursor is the canonical empty result.
    const empty = listPageFromResponse(page([]));
    expect(empty).not.toBeNull();
    expect(empty?.items).toEqual([]);
    expect(empty?.nextCursor).toBeNull();
  });
});

// --- rejection ---------------------------------------------------------------

describe("listPageFromResponse rejects malformed pages", () => {
  test("rejects every item field that is missing", () => {
    for (const field of EVERY_FIELD) {
      expect(listPageFromResponse(page([withoutField(field)])), `missing ${field}`).toBeNull();
    }
  });

  test("rejects a well-formed item carrying a hostile field value", () => {
    const cases: readonly [string, unknown][] = [
      ["id", 0],
      ["id", -1],
      ["id", 1.5],
      ["id", "7"],
      ["id", Number.MAX_SAFE_INTEGER + 1],
      ["title", 7],
      ["title", null],
      ["status", "archived"],
      ["status", "TODO"],
      ["status", 4],
      ["priority", -1],
      ["priority", 4],
      ["priority", 1.5],
      ["priority", "2"],
      ["priority", NaN],
      ["labels", null],
      ["labels", {}],
      ["labels", [{ id: 3, name: 7 }]],
      ["labels", [{ id: 0, name: "phase-d" }]],
      ["labels", ["phase-d"]],
      ["assignee", {}],
      ["assignee", { id: 11, name: "reviewer", kind: "robot" }],
      ["assignee", { id: 11, name: "reviewer" }],
    ];
    for (const [field, value] of cases) {
      expect(listPageFromResponse(page([withField(field, value)])), `${field}=${JSON.stringify(value)}`).toBeNull();
    }
  });

  test("rejects a row that is not an object at all", () => {
    for (const row of [null, undefined, 7, "item", true, []]) {
      expect(listPageFromResponse(page([row])), JSON.stringify(row)).toBeNull();
    }
  });

  test("rejects the whole page when a later row is malformed", () => {
    // The row is never the unit of acceptance: a page that would render one good
    // `<tr>` and one broken one is refused entirely.
    expect(listPageFromResponse(page([validItem(), withField("status", "archived")]))).toBeNull();
    expect(listPageFromResponse(page([withField("title", 7), validItem()]))).toBeNull();
  });

  test("rejects a page whose rows repeat an id", () => {
    // Two rows with the same id would be two list entries keyed identically: the
    // selection set and the delete-on-load dedup both assume ids are unique.
    const first = validItem();
    const duplicate = { ...validItem(), title: "A different title, same id" };
    expect(listPageFromResponse(page([first, duplicate]))).toBeNull();
    // Distinct ids in the same shape stay accepted, so the check is on identity
    // and not on row equality.
    expect(listPageFromResponse(page([first, { ...duplicate, id: 8 }]))).not.toBeNull();
  });

  test("rejects an envelope that is not a page", () => {
    expect(listPageFromResponse(null)).toBeNull();
    expect(listPageFromResponse(undefined)).toBeNull();
    expect(listPageFromResponse("page")).toBeNull();
    expect(listPageFromResponse([])).toBeNull();
    // `data` must be an array, and `meta` must be present: an item detail
    // response (`{ data: { item } }`) is not a list page.
    expect(listPageFromResponse({ data: {} })).toBeNull();
    expect(listPageFromResponse({ data: [validItem()] })).toBeNull();
    expect(listPageFromResponse({ data: [validItem()], meta: null })).toBeNull();
    expect(listPageFromResponse({ data: validItem(), meta: { nextCursor: null } })).toBeNull();
    // A meta object without the cursor key is missing the pagination fact, not
    // reporting "no more pages".
    expect(listPageFromResponse({ data: [], meta: {} })).toBeNull();
  });
});

// --- cursor canonical behavior -----------------------------------------------

describe("listPageFromResponse passes pagination cursors through unchanged", () => {
  test("returns a server-shaped cursor exactly as sent", () => {
    // A real cursor, a max-id cursor, and the 2048-character boundary are all
    // checked by identity: the string the server issued is the string the UI puts
    // back in the `cursor` query parameter, byte for byte — never re-encoded,
    // padded, or trimmed on the way through.
    const boundary = "a".repeat(2_048);
    for (const cursor of [
      serverCursor("2026-01-02T03:04:05.678Z", 7),
      serverCursor("2026-01-02T03:04:05.678Z", Number.MAX_SAFE_INTEGER),
      "abc",
      "-_~",
      boundary,
    ]) {
      const result = listPageFromResponse(page([validItem()], cursor));
      expect(result, cursor).not.toBeNull();
      expect(result!.nextCursor, cursor).toBe(cursor);
    }
    // An empty-string cursor is the one non-null value that is *not* canonical.
    expect(listPageFromResponse(page([validItem()], ""))).toBeNull();
  });

  test("treats null as the canonical last page", () => {
    const result = listPageFromResponse(page([validItem()], null));
    expect(result?.nextCursor).toBeNull();
    expect(result?.items).toHaveLength(1);
  });

  test("rejects a cursor outside the canonical alphabet", () => {
    // Whitespace, padding, and control characters are not cursor bytes; passing
    // one back would put a rejected value into the URL query string.
    for (const cursor of ["has space", "trailing\n", " pad", "pad ", "a\u0000b", "café", "❯"]) {
      expect(listPageFromResponse(page([], cursor)), JSON.stringify(cursor)).toBeNull();
    }
  });

  test("rejects an empty cursor and never invents one", () => {
    // "" is neither a cursor nor null: accepting it would silently mean "fetch
    // the first page again" and duplicate rows already on screen.
    expect(listPageFromResponse(page([], ""))).toBeNull();
    // An envelope with no `nextCursor` key is malformed. Note the runtime rules
    // here: JSON.parse never yields `undefined`, so a missing key and an explicit
    // `undefined` are the same input — both are refused, so absent data is never
    // read as a pagination decision.
    expect(listPageFromResponse({ data: [], meta: {} })).toBeNull();
    expect(listPageFromResponse({ data: [], meta: { nextCursor: undefined } })).toBeNull();
    // Only a real `null` means "this is the last page", and the last page reports
    // an actual `null` rather than a stringified one.
    expect(listPageFromResponse(page([], null))?.nextCursor).toBeNull();
    expect(listPageFromResponse(page([], "null"))?.nextCursor).toBe("null");
  });

  test("rejects an over-long cursor and a non-string cursor", () => {
    // Bound: a cursor longer than the server would ever issue is refused before
    // it reaches a request.
    expect(listPageFromResponse(page([], "a".repeat(2_049)))).toBeNull();
    for (const cursor of [7, {}, [], true, 0]) {
      expect(listPageFromResponse(page([], cursor)), JSON.stringify(cursor)).toBeNull();
    }
  });
});

// --- the cursor the UI sends back --------------------------------------------

/**
 * Two facts the list UI depends on that the page parser alone does not establish:
 * a cursor it accepted is a string the UI can hand straight back to the API, and
 * the status filter it persists is always one of the four statuses the API
 * accepts. The hook reads `nextCursor` as "there is more" and sends that exact
 * string back as the `cursor` parameter, so a cursor is never normalized on the
 * way through; a stale or hand-written status has to fall back to "all" instead
 * of reaching a request the API would reject.
 */
describe("pagination cursor and filter state the list sends back", () => {
  const store = createFilterStore({ location: undefined, history: undefined, storage: undefined });

  test("a cursor the page accepted is a usable query value", () => {
    // Whatever the parser accepts must survive `URLSearchParams`, which is how the
    // API client encodes it: no character is silently re-encoded or dropped.
    const cursor = serverCursor("2026-01-02T03:04:05.678Z", 7);
    const accepted = listPageFromResponse(page([validItem()], cursor))?.nextCursor;
    expect(accepted).toBe(cursor);
    const encoded = new URLSearchParams({ cursor: accepted! }).get("cursor");
    expect(encoded).toBe(cursor);
  });

  test("the restored filter state is a valid status or empty", () => {
    const loaded = store.load();
    expect(loaded.status === "" || LIST_STATUSES.some((status) => status === loaded.status)).toBe(true);
    expect(Object.keys(loaded).sort()).toEqual(["assignee", "label", "q", "status"]);

    // The guard the hook applies to a restored status is exactly this predicate:
    // a stale value is replaced by "" rather than kept, and the three filters
    // beside it are untouched.
    const stale = { ...emptyFilters(), status: "archived", assignee: "11", label: "phase-d", q: "retry" };
    const corrected = store.set({ ...stale, status: "" });
    expect(corrected).toEqual({ status: "", assignee: "11", label: "phase-d", q: "retry" });
    expect(store.reset()).toEqual(emptyFilters());
    expect(store.load()).toEqual(emptyFilters());
  });
});

// --- the other two list DTOs -------------------------------------------------

describe("filter-option DTOs accept only complete rows", () => {
  test("participantsFromResponse normalizes a complete set", () => {
    // Annotating the fixture with the real DTO type is part of the assertion: the
    // parser's output must be assignable to `ListParticipant`, so a `kind` that
    // widened to plain `string` would fail to compile here.
    const rows: readonly ListParticipant[] = [
      { id: 1, name: "bahman", kind: "human" },
      { id: 11, name: "reviewer", kind: "agent" },
    ];
    expect(participantsFromResponse({ data: rows })).toEqual(rows);
    expect(participantsFromResponse({ data: [] })).toEqual([]);
  });

  test("participantsFromResponse rejects a malformed participant", () => {
    const cases: readonly [unknown, string][] = [
      [{ data: [{ id: 0, name: "bahman", kind: "human" }] }, "zero id"],
      [{ data: [{ id: 1, name: "bahman" }] }, "missing kind"],
      [{ data: [{ id: 1, name: "bahman", kind: "robot" }] }, "unknown kind"],
      [{ data: [{ id: 1, name: 7, kind: "human" }] }, "non-string name"],
      [{ data: [{ id: 1, name: "bahman", kind: "human" }, "bahman"] }, "non-object row"],
      [{ data: {} }, "data not an array"],
      [null, "null envelope"],
    ];
    for (const [response, label] of cases) {
      expect(participantsFromResponse(response), label).toBeNull();
    }
    // Rejection is all-or-nothing across the set, exactly as for a page: one bad
    // participant refuses the whole vocabulary, so the list never offers a filter
    // value the API would then reject.
    expect(participantsFromResponse({ data: [{ id: 1, name: "bahman", kind: "human" }, { id: 0, name: "x", kind: "human" }] }))
      .toBeNull();
    expect(participantsFromResponse("participants")).toBeNull();
  });

  test("labelsFromResponse normalizes the label vocabulary", () => {
    const rows = [{ id: 3, name: "phase-d" }, { id: 9, name: "web" }];
    expect(labelsFromResponse({ data: rows })).toEqual(rows);
    // An empty vocabulary is valid: the list then offers no label filter.
    expect(labelsFromResponse({ data: [] })).toEqual([]);
  });

  test("labelsFromResponse rejects a malformed label", () => {
    // A half-parsed vocabulary would offer a filter value the API rejects, so one
    // bad label invalidates the set rather than being skipped.
    expect(labelsFromResponse({ data: [{ id: 3, name: "phase-d" }, { id: 0, name: "web" }] })).toBeNull();
    expect(labelsFromResponse({ data: [{ id: 3, name: "phase-d" }, { name: "web" }] })).toBeNull();
    expect(labelsFromResponse({ data: [{ id: 3, name: "phase-d" }, ["web"]] })).toBeNull();
    expect(labelsFromResponse({ data: { id: 3, name: "phase-d" } })).toBeNull();
    expect(labelsFromResponse({})).toBeNull();
    expect(labelsFromResponse(undefined)).toBeNull();
  });
});

// --- view registration -------------------------------------------------------

describe("the list view registration", () => {
  test("registers `list` as a Preact component with the fixed route", () => {
    const entry = views["list"];
    expect(entry).toBeDefined();
    // `kind: "component"` is what routes the view through the Preact host rather
    // than the legacy `mount` path; `component` is the renderer itself.
    expect(entry?.kind).toBe("component");
    expect(typeof (entry as { component?: unknown } | undefined)?.component).toBe("function");
    expect(entry?.title).toBe("All work");
    expect(entry?.href).toBe("#/list");
    // So the shell's hash router resolves `#/list` to this entry.
    expect(Object.values(views).some((candidate) => candidate.href === "#/list")).toBe(true);
  });

  test("registers neither a legacy mount nor a hidden nav entry", () => {
    const entry = views["list"] as { mount?: unknown; hidden?: unknown } | undefined;
    expect(entry?.mount).toBeUndefined();
    expect(entry?.hidden).toBeUndefined();
  });
});

// --- shared status vocabulary ------------------------------------------------

describe("LIST_STATUSES", () => {
  test("is exactly the four statuses the API accepts, in order", () => {
    expect(LIST_STATUSES).toEqual(["todo", "doing", "blocked", "done"]);
    // A non-empty list guarantees the filter dropdown always offers a choice, and
    // the list is typed against `WorkStatus` so it cannot drift from the domain.
    expect(LIST_STATUSES.length).toBeGreaterThan(0);
  });
});

// --- what the parser hands the renderer ---------------------------------------

describe("the accepted page is safe to render", () => {
  test("a parsed item is plain data with no inherited members", () => {
    // The validator copies fields rather than passing the wire object along, so a
    // row can never smuggle a `__proto__`/`constructor` key into the table.
    const result = listPageFromResponse(page([{
      ...validItem(),
      __proto__: { injected: true },
      constructor: "nope",
    }]));
    expect(result).not.toBeNull();
    const item = result!.items[0] as ListItem;
    expect(Object.keys(item).sort()).toEqual(
      ["assignee", "id", "labels", "priority", "status", "title"],
    );
    expect((item as unknown as Record<string, unknown>).injected).toBeUndefined();
  });
});

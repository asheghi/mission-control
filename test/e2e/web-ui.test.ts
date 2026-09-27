// End-to-end tests for the web UI in a real browser.
//
// The rest of the suite covers the pieces: the service, the REST surface, the
// bundle's bytes. None of that can see the thing that actually breaks a UI —
// a component that renders but does not respond, a route that resolves to the
// wrong view, an event that never arrives, a control that writes to the server
// and shows nothing. So this file drives a real Chromium against a real server
// and asserts on what a person would see.
//
// The server is the compiled binary when `dist/workboard` exists and the source
// entrypoint otherwise, so the same suite checks the shipped artifact after
// `bun run build` and still runs under a plain `bun test`.
//
// The browser is skipped, loudly, when this machine has no Chromium: set
// `WORKBOARD_CHROME` to point at one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "../helpers/browser";
import { findChromium, launchBrowser } from "../helpers/browser";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BINARY = join(REPO_ROOT, "dist", "workboard");
const ENTRY = join(REPO_ROOT, "src", "entry.ts");
const CHROMIUM = findChromium();

interface Board {
  readonly baseUrl: string;
  readonly dataDir: string;
  /** A live token for a seeded human participant. */
  readonly token: string;
  /** How the board is being served, for the failure message when it is not. */
  readonly source: string;
  stop(): Promise<void>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  itemIdByTitle(title: string): Promise<number>;
}

function runCommand(args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const command = existsSync(BINARY) ? [BINARY, ...args] : [process.execPath, ENTRY, ...args];
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return {
    code: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** Start a seeded board in a throwaway data directory. */
async function startSeededBoard(): Promise<Board> {
  const dataDir = mkdtempSync(join(tmpdir(), "workboard-e2e-"));
  const source = existsSync(BINARY) ? "dist/workboard" : "src/entry.ts";
  const must = (args: readonly string[]): string => {
    const result = runCommand([...args, "--dir", dataDir], dataDir);
    if (result.code !== 0) {
      throw new Error(`workboard ${args.join(" ")} failed (${result.code})\n${result.stderr}`);
    }
    return result.stdout;
  };

  must(["init", "--hide-token"]);
  must(["seed", "--reset"]);
  const token = must(["token", "create", "--participant", "ada", "--name", "e2e"])
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("wb_"));
  if (token === undefined) throw new Error("token create printed no token");

  const server = Bun.spawn(
    existsSync(BINARY)
      ? [BINARY, "serve", "--dir", dataDir, "--port", "0"]
      : [process.execPath, ENTRY, "serve", "--dir", dataDir, "--port", "0"],
    { cwd: dataDir, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );

  // The server's stderr is drained for the whole run, not just until the banner
  // arrives. It carries one line per request, and a pipe nobody reads fills up
  // and then blocks the writer — which stalls the server in the middle of a test
  // and looks exactly like a hang in the page.
  let banner = "";
  const drained = (async () => {
    const reader = server.stderr.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.value !== undefined) banner += new TextDecoder().decode(chunk.value);
      if (chunk.done === true) return;
    }
  })();
  let baseUrl: string | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && baseUrl === null) {
    await Bun.sleep(50);
    baseUrl = banner.match(/listening on (http:\/\/\S+)/)?.[1] ?? null;
  }
  if (baseUrl === null) {
    const stdout = new TextDecoder().decode(await new Response(server.stdout).arrayBuffer());
    server.kill("SIGKILL");
    await server.exited;
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(
      `the server never announced its URL (exit ${String(server.exitCode)}):\nstderr: ${banner}\nstdout: ${stdout}`,
    );
  }

  const url = baseUrl;
  const request = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const payload = (await response.json()) as { data?: T; error?: { message?: string } };
    if (!response.ok) throw new Error(`${path} → ${response.status}: ${payload.error?.message ?? "failed"}`);
    return payload.data as T;
  };
  return {
    baseUrl: url,
    dataDir,
    token,
    source,
    stop: async () => {
      server.kill("SIGTERM");
      await server.exited;
      await drained;
      rmSync(dataDir, { recursive: true, force: true });
    },
    request,
    itemIdByTitle: async (title: string): Promise<number> => {
      // GET /api/items answers `{ data: [items], meta: { nextCursor } }`, so the
      // items are the payload itself.
      const items = await request<{ id: number; title: string }[]>("/api/items?limit=100");
      const found = items.find((item) => item.title === title);
      if (found === undefined) throw new Error(`no seeded item titled "${title}"`);
      return found.id;
    },
  };
}

/**
 * Sign in from scratch.
 *
 * The list view persists its filters in local storage, so a filter left by one
 * test would silently change what the next one sees.
 *
 * The wipe happens on `about:blank`, with the origin named explicitly: the app
 * is not running, so nothing can notice the storage disappearing underneath it.
 * Clearing it while a live session is signed in would leave the shell fetching
 * with no token, and its next request would fail the way it should.
 */
async function signIn(page: Page, board: Board, route = "#/backlog"): Promise<void> {
  await page.goto("about:blank");
  await page.clearStorage(board.baseUrl);
  await page.goto(`${board.baseUrl}/#token=${board.token}${route}`);
}

let board: Board;
let browser: Browser;
let page: Page;

// Starting a server, a browser, and a page is not a five-second job on a cold
// machine, so the hooks run on the same generous default as the tests.
setDefaultTimeout(60_000);

// One page per test. It buys isolation that matters for this app in particular:
// every signed-in page holds a Server-Sent Events connection, and a page that is
// merely navigated away can keep its sockets alive. Reusing one page for the
// whole run piles those up until a navigation is waiting on a free connection.
beforeEach(async () => {
  page = await browser.newPage();
});

afterEach(async () => {
  if (page !== undefined) await page.close();
});

beforeAll(async () => {
  board = await startSeededBoard();
  browser = await launchBrowser();
});

afterAll(async () => {
  if (browser !== undefined) await browser.close();
  if (board !== undefined) await board.stop();
});

/**
 * Nothing in the page may have logged an error, thrown, failed a request, or
 * received an error response. This is the check that catches a regression the
 * assertions never look at: a 404 asset, a thrown effect, a rejected fetch.
 */
async function expectNoProblems(): Promise<void> {
  expect(await page.problems(), "the page reported problems").toEqual([]);
}

function skipWithoutChromium(): boolean {
  if (CHROMIUM !== null) return false;
  console.warn("SKIP: no Chromium binary found; set WORKBOARD_CHROME to run the web UI end-to-end tests");
  return true;
}

describe("web UI in a real browser", () => {
  test("serves the compiled binary when it is built, and the source otherwise", () => {
    if (skipWithoutChromium()) return;
    // The whole point of the fallback: a plain `bun test` still exercises the
    // real server, and a run after `bun run build` exercises the artifact that
    // actually ships.
    expect(board.source).toBe(existsSync(BINARY) ? "dist/workboard" : "src/entry.ts");
    expect(browser.version).toStartWith("Chrome/");
  });

  test("signs in from a token link and shows the seeded backlog", async () => {
    if (skipWithoutChromium()) return;
    await signIn(page, board);
    // The table shell renders immediately; the rows arrive from the API, so wait
    // for the seeded content rather than for the container.
    await page.waitFor(`document.querySelectorAll("tr[data-row-id]").length > 0`, { description: "backlog rows" });

    // The token is a credential: it must be gone from the address bar, stored
    // instead, before the shell paints.
    const href = await page.url();
    expect(href, "the token stayed in the address bar").not.toContain("token=");
    expect(href).toContain("#/backlog");
    expect(await page.evaluate<string | null>(`localStorage.getItem("workboard.token")`)).toBe(board.token);

    expect(await page.text(".brand")).toContain("MissionControl");
    expect(await page.allText(`nav[aria-label="Primary navigation"] a`)).toEqual(["Backlog", "Board", "All work"]);
    expect(await page.count(".live-indicator")).toBe(1);
    // The shell marks the current page, so the URL and the navigation agree.
    expect(await page.text(`nav[aria-label="Primary navigation"] a[aria-current="page"]`)).toBe("Backlog");

    // The seeded board is really on screen: a top-level feature and its status.
    const rows = await page.allText("tr[data-row-id] .backlog-item-title a");
    expect(rows.some((row) => row.includes("Backlog view with nested sub-tasks"))).toBe(true);
    expect(await page.count("tr[data-row-id]")).toBeGreaterThan(5);

    // The event feed is connected, not merely open.
    await page.waitFor(`document.querySelector(".live-indicator").dataset.connection === "connected"`, {
      description: "the live indicator to report a connected feed",
    });
    expect(await page.text(".live-label")).toBe("Live");
    await expectNoProblems();
  }, 60_000);

  test("backlog: children are hidden until expanded, and a new item is saved", async () => {
    if (skipWithoutChromium()) return;
    await signIn(page, board);
    await page.waitFor(`document.querySelectorAll("tr[data-row-id]").length > 0`, { description: "backlog rows" });

    const parentId = await board.itemIdByTitle("Backlog view with nested sub-tasks");
    const childTitle = "Reorder a row without a pointer";

    // Children are loaded but collapsed: the hierarchy is on purpose, not a
    // flat list, so the parent must start closed.
    expect(await page.count(`tr[aria-level="2"]`)).toBe(0);
    expect(await page.count(`tr[data-row-id="${parentId}"] .backlog-toggle`)).toBe(1);

    await page.click(`tr[data-row-id="${parentId}"] .backlog-toggle`);
    await page.waitFor(`document.querySelectorAll('tr[aria-level="2"]').length > 0`, { description: "expanded children" });
    const children = await page.allText(`tr[aria-level="2"] .backlog-item-title a`);
    expect(children.some((row) => row.includes(childTitle))).toBe(true);
    // The disclosure reports what it controls.
    const expanded = await page.evaluate<string | null>(
      `document.querySelector('tr[data-row-id="${parentId}"] .backlog-toggle').getAttribute("aria-expanded")`,
    );
    expect(expanded).toBe("true");

    // Collapse again: the toggle is a disclosure, not a one-way door.
    await page.click(`tr[data-row-id="${parentId}"] .backlog-toggle`);
    await page.waitFor(`document.querySelectorAll('tr[aria-level="2"]').length === 0`, { description: "collapsed children" });

    // Add an item through the form the user has.
    const title = "Written by the browser test";
    await page.fill("#backlog-add-title", title);
    await page.click(`.backlog-add button[type="submit"]`);
    await page.waitFor(
      `Array.from(document.querySelectorAll("tr[data-row-id] .backlog-item-title a")).some((a) => a.textContent.includes(${JSON.stringify(title)}))`,
      { description: "the new backlog row" },
    );
    // The row is a real item on the server, not an optimistic ghost.
    const created = await board.request<{ id: number; title: string }[]>(`/api/items?limit=100&q=${encodeURIComponent(title)}`);
    expect(created.map((item) => item.title)).toEqual([title]);
    // The input is cleared so the next item starts from empty.
    const cleared = await page.evaluate<string>(`document.querySelector("#backlog-add-title").value`);
    expect(cleared).toBe("");
    await expectNoProblems();
  }, 60_000);

  test("board: a card moves between columns and the server agrees", async () => {
    if (skipWithoutChromium()) return;
    await signIn(page, board, "#/board");
    await page.waitFor(`document.querySelectorAll(".board-column").length === 4`, { description: "four columns" });
    await page.waitFor(`document.querySelectorAll(".board-card:not(.board-card-skeleton)").length > 0`, {
      description: "board cards",
    });

    const columns = await page.allText(".board-column-title");
    for (const label of ["To do", "Doing", "Blocked", "Done"]) {
      expect(columns.some((column) => column.startsWith(label)), `missing column ${label}`).toBe(true);
    }

    const id = await board.itemIdByTitle("Filter the backlog by label");
    const before = await board.request<{ item: { status: string } }>(`/api/items/${id}`);
    expect(before.item.status).toBe("todo");
    expect(await page.count(`.board-cards[data-status="todo"] .board-card[data-id="${id}"]`)).toBe(1);

    // The card's own status control, exactly as a keyboard user would use it.
    await page.select(`.board-card[data-id="${id}"] select`, "doing");
    await page.waitFor(
      `document.querySelector('.board-cards[data-status="doing"] .board-card[data-id="${id}"]') !== null`,
      { description: "the card in the Doing column" },
    );
    const after = await board.request<{ item: { status: string } }>(`/api/items/${id}`);
    expect(after.item.status, "the card moved on screen but not on the server").toBe("doing");
    await expectNoProblems();
  }, 60_000);

  test("list: filters, search, and pagination all change what is shown", async () => {
    if (skipWithoutChromium()) return;
    await signIn(page, board, "#/list");
    await page.waitFor(`document.querySelectorAll(".list-table tbody tr[data-id]").length > 0`, {
      description: "list rows",
    });

    // The seeded board is bigger than one page, so the footer counts what is
    // loaded and offers the rest.
    expect(await page.text(".list-footer .muted")).toBe("25 items loaded");
    expect(await page.count(".list-footer button")).toBe(1);
    await page.click(".list-footer button");
    await page.waitFor(`document.querySelectorAll(".list-table tbody tr[data-id]").length === 50`, {
      description: "the second page",
    });
    expect(await page.text(".list-footer .muted")).toBe("50 items loaded");

    // The status filter narrows the table and is reflected in the URL, so the
    // view can be shared or reloaded.
    await page.select(`.list-toolbar select[name="status"]`, "blocked");
    await page.waitFor(
      `document.querySelectorAll(".list-table tbody tr[data-id]").length > 0 &&
       Array.from(document.querySelectorAll(".list-table tbody tr[data-id]")).every((row) => row.querySelector(".status-blocked") !== null)`,
      { description: "only blocked items" },
    );
    expect(await page.url()).toContain("status=blocked");

    // Clearing filters restores the whole board.
    await page.click(".list-toolbar .clear-filters");
    await page.waitFor(`!location.hash.includes("status=blocked")`, { description: "the cleared filter" });
    await page.waitFor(`document.querySelectorAll(".list-table tbody tr[data-id]").length === 25`, {
      description: "the unfiltered first page",
    });

    // Search is debounced, so this is the slow path a user actually waits on.
    await page.fill(`.list-toolbar input[name="title-search"]`, "Backlog order jumps");
    await page.waitFor(
      `document.querySelectorAll(".list-table tbody tr[data-id]").length === 1 &&
       document.querySelector(".list-table tbody tr[data-id] .list-item-title").textContent.includes("Backlog order jumps")`,
      { description: "the searched row" },
    );
    await expectNoProblems();
  }, 60_000);

  test("detail: renaming and commenting reach the server and the history", async () => {
    if (skipWithoutChromium()) return;
    const id = await board.itemIdByTitle("Long titles overflow the board card");
    await signIn(page, board, `#/item/${id}`);
    await page.waitFor(`document.querySelector("#detail-title") !== null`, { description: "the detail view" });

    expect(await page.text(".detail-page-title")).toBe(`Work item #${id}`);
    const titleValue = await page.evaluate<string>(`document.querySelector("#detail-title").value`);
    expect(titleValue).toBe("Long titles overflow the board card");
    // The description renders as markdown, not as raw syntax.
    await page.waitFor(`document.querySelector("#body-panel-preview .markdown") !== null`, {
      description: "the description preview",
    });

    // Rename it. The title saves on blur, so the edit has to be a real one.
    const renamed = "Long titles wrap onto a second line";
    await page.click("#detail-title");
    await page.fill("#detail-title", renamed);
    await page.blur("#detail-title");
    // The save is debounced, so the assertion is on what the server holds once
    // the user has moved on — not on a transient status string.
    await page.waitFor(
      `(async () => (await (await fetch("/api/items/${id}", { headers: { Authorization: "Bearer " + localStorage.getItem("workboard.token") } })).json()).data.item.title === ${JSON.stringify(renamed)})()`,
      { description: "the saved title", intervalMs: 200 },
    );
    const saved = await board.request<{ item: { title: string } }>(`/api/items/${id}`);
    expect(saved.item.title).toBe(renamed);

    // A comment with a mention, through the composer and its autocomplete.
    await page.fill("#detail-comment", "Reproduced at 1440px. cc @a");
    await page.waitFor(`document.querySelector(".mention-list:not([hidden]) .mention-option") !== null`, {
      description: "the mention list",
    });
    const options = await page.allText(".mention-option");
    expect(options.some((option) => option.includes("@ada"))).toBe(true);
    await page.click(".mention-option");
    const draft = await page.evaluate<string>(`document.querySelector("#detail-comment").value`);
    expect(draft, "choosing a mention should insert it").toContain("@ada");

    await page.click(".composer button[type='submit']");
    await page.waitFor(
      `Array.from(document.querySelectorAll(".detail-comments .comment")).some((comment) => comment.textContent.includes("Reproduced at 1440px"))`,
      { description: "the posted comment" },
    );
    const detail = await board.request<{ comments: { body: string; author: { name: string } }[]; history: { field: string }[] }>(
      `/api/items/${id}`,
    );
    expect(detail.comments.some((comment) => comment.body.includes("@ada"))).toBe(true);
    expect(detail.history.some((entry) => entry.field === "title")).toBe(true);
    // The history is the audit trail of the rename the user just made.
    await page.waitFor(`document.querySelector(".detail-history").textContent.includes("title")`, {
      description: "the title change in history",
    });
    await expectNoProblems();
  }, 60_000);

  test("live: a change made elsewhere appears without reloading", async () => {
    if (skipWithoutChromium()) return;
    await signIn(page, board, "#/board");
    await page.waitFor(`document.querySelector(".live-indicator").dataset.connection === "connected"`, {
      description: "the live feed",
    });

    const title = "Created out of band";
    await board.request("/api/items", { method: "POST", body: JSON.stringify({ title }) });
    // No reload and no navigation: the event stream has to carry the change.
    await page.waitFor(
      `Array.from(document.querySelectorAll(".board-card-title")).some((link) => link.textContent.includes(${JSON.stringify(title)}))`,
      { description: "the new card from the live feed" },
    );
    await expectNoProblems();
  }, 60_000);

  test("signs out, and refuses a token that is not accepted", async () => {
    if (skipWithoutChromium()) return;
    await signIn(page, board);
    await page.waitFor(`document.querySelector(".backlog-table") !== null`, { description: "the signed-in shell" });

    await page.click(".topbar-actions .button-invisible");
    await page.waitFor(`document.querySelector(".login") !== null`, { description: "the sign-in form" });
    expect(await page.evaluate(`localStorage.getItem("workboard.token")`)).toBeNull();

    // A wrong token is refused, with the failure where a keyboard user lands.
    await page.fill("#api-token", "wb_not-a-real-token");
    await page.click(".login button.primary");
    await page.waitFor(`document.querySelector(".login .error").textContent.trim() !== ""`, {
      description: "the sign-in error",
    });
    expect(await page.text(".login .error")).toBe("That token was not accepted.");
    expect(await page.count(".backlog-table")).toBe(0);
  }, 60_000);
});

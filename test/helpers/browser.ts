// A minimal Chrome DevTools Protocol client, written against Bun's built-in
// WebSocket. It exists so the web UI's end-to-end tests can drive a real
// browser — real rendering, real events, real fetch — without adding a browser
// automation dependency to a project that deliberately has three.
//
// What it deliberately is not: a test runner. There is no assertion language
// here, no auto-waiting selector engine, and no retries beyond one bounded
// poll. A test that fails says what it saw; that is the whole contract.
//
// The suite skips itself when no Chromium binary is present, so this file is
// allowed to assume the browser launches.
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Candidate binaries, in preference order. `WORKBOARD_CHROME` overrides all. */
const CHROMIUM_CANDIDATES = [
  process.env["WORKBOARD_CHROME"],
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
] as const;

/** The browser to drive, or null when this machine has none. */
export function findChromium(): string | null {
  for (const candidate of CHROMIUM_CANDIDATES) {
    if (candidate !== undefined && candidate !== "" && existsSync(candidate)) return candidate;
  }
  return null;
}

export interface BrowserOptions {
  readonly executablePath?: string;
  /** How long to wait for the browser to announce its debugging port. */
  readonly launchTimeoutMs?: number;
}

export interface Browser {
  newPage(): Promise<Page>;
  readonly version: string;
  close(): Promise<void>;
}

interface PendingCall {
  readonly resolve: (value: CdpResponse) => void;
  readonly method: string;
}

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
  readonly sessionId?: string;
}

interface ConsoleMessage {
  readonly level: string;
  readonly text: string;
}

/**
 * Injected before every document so it survives navigation: the tests read and
 * drive the page through these helpers rather than pasting a different snippet
 * into each call site.
 *
 * `setValue` goes through the prototype's own setter on purpose. Assigning
 * `input.value` from script is invisible to a framework that tracks the last
 * value it wrote, so Preact would keep rendering the old draft; calling the
 * native setter and dispatching the event the component listens for is what a
 * real keystroke ends up doing.
 */
const PAGE_HELPERS = `
globalThis.__wb = (() => {
  const require = (selector) => {
    const element = document.querySelector(selector);
    if (element === null) throw new Error("no element matches " + selector);
    return element;
  };
  const setValue = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
    setter.call(element, value);
  };
  const fire = (element, type) => {
    element.dispatchEvent(new Event(type, { bubbles: true, cancelable: false }));
  };
  return {
    require,
    text: (selector) => { const el = document.querySelector(selector); return el === null ? null : el.textContent; },
    allText: (selector) => Array.from(document.querySelectorAll(selector)).map((el) => el.textContent),
    count: (selector) => document.querySelectorAll(selector).length,
    click: (selector) => { require(selector).click(); return true; },
    focus: (selector) => { require(selector).focus(); return true; },
    blur: (selector) => { require(selector).blur(); return true; },
    fill: (selector, value) => {
      const element = require(selector);
      setValue(element, value);
      fire(element, "input");
      fire(element, "change");
      return element.value;
    },
    select: (selector, value) => {
      const element = require(selector);
      if (!(element instanceof HTMLSelectElement)) throw new Error(selector + " is not a <select>");
      if (!Array.from(element.options).some((option) => option.value === value)) {
        throw new Error(selector + " has no option " + value);
      }
      setValue(element, value);
      fire(element, "change");
      return element.value;
    },
    key: (selector, key) => {
      const element = require(selector);
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      return true;
    },
    checked: (selector) => require(selector).checked,
  };
})();
`;

export async function launchBrowser(options: BrowserOptions = {}): Promise<Browser> {
  const executablePath = options.executablePath ?? findChromium();
  if (executablePath === null) throw new Error("no Chromium binary found");
  const launchTimeoutMs = options.launchTimeoutMs ?? 30_000;
  const profile = mkdtempSync(join(tmpdir(), "workboard-e2e-chrome-"));

  const process: Subprocess = Bun.spawn(
    [
      executablePath,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      // Containers give /dev/shm a small quota; without this a page that loads a
      // bundle can die with a renderer crash that looks like a test failure.
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--mute-audio",
      // Refuse to resolve anything that is not loopback. The board is the only
      // thing this browser is allowed to talk to, and the app's own test for
      // that (no third-party origins) is then enforced by the network stack
      // rather than only by reading the bundle.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
  );

  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + launchTimeoutMs;
  let endpoint = "";
  while (Date.now() < deadline && endpoint === "") {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split("\n");
      if (port !== undefined && path !== undefined && port.trim() !== "" && path.trim() !== "") {
        endpoint = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
        break;
      }
    }
    if (process.exitCode !== null) {
      // Bun types the subprocess stream as a union; it is a ReadableStream here.
      const stderr = new TextDecoder().decode(
        await new Response(process.stderr as unknown as ReadableStream<Uint8Array>).arrayBuffer(),
      );
      rmSync(profile, { recursive: true, force: true });
      throw new Error(`the browser exited before it was ready (code ${process.exitCode}):\n${stderr.slice(0, 2000)}`);
    }
    await Bun.sleep(50);
  }
  if (endpoint === "") {
    process.kill("SIGKILL");
    await process.exited;
    rmSync(profile, { recursive: true, force: true });
    throw new Error("the browser never announced its debugging port");
  }

  const connection = await CdpConnection.open(endpoint);
  const version = await connection.call("Browser.getVersion");
  const browser: Browser = {
    version: String((version.result?.["product"] as string | undefined) ?? "unknown"),
    newPage: () => connection.newPage(),
    close: async () => {
      try {
        await connection.call("Browser.close");
      } catch {
        // A browser that already died needs no goodbye.
      }
      connection.dispose();
      process.kill("SIGKILL");
      await process.exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
  return browser;
}

/** Key codes for the keys the web tests press, so `Input.dispatchKeyEvent` can send real ones. */
const KEY_CODES: Readonly<Record<string, { key: string; code: string; keyCode: number; text?: string }>> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** What was being waited for; used in the timeout message. */
  readonly description?: string;
}

export interface Page {
  goto(url: string, options?: WaitOptions): Promise<void>;
  /** The page's current URL, fragment included. */
  url(): Promise<string>;
  /** Evaluate an expression in the page and return its value. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Poll `expression` until it returns something truthy. */
  waitFor(expression: string, options?: WaitOptions): Promise<unknown>;
  text(selector: string): Promise<string | null>;
  allText(selector: string): Promise<string[]>;
  count(selector: string): Promise<number>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  focus(selector: string): Promise<void>;
  blur(selector: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  /**
   * Wipe the origin's storage through the browser rather than through the page.
   * Clearing it from inside the running app races that app's own boot: the shell
   * may already have decided it is signed in and then send a request with no
   * token, which the server rightly refuses.
   */
  clearStorage(origin?: string): Promise<void>;
  /** Console errors, uncaught exceptions, failed requests, and 4xx/5xx responses. */
  problems(): Promise<readonly string[]>;
  close(): Promise<void>;
}

class CdpConnection {
  private socket: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId: string | undefined) => void>>();

  private constructor(private readonly url: string) {}

  static async open(url: string): Promise<CdpConnection> {
    const connection = new CdpConnection(url);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`could not connect to the browser at ${url}`));
    });
    socket.onmessage = (event) => connection.receive(String(event.data));
    connection.socket = socket;
    return connection;
  }

  private receive(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      pending?.resolve(message);
      return;
    }
    if (message.method === undefined) return;
    for (const listener of this.listeners.get(message.method) ?? []) {
      listener(message.params ?? {}, message.sessionId);
    }
  }

  on(method: string, listener: (params: Record<string, unknown>, sessionId: string | undefined) => void): void {
    const existing = this.listeners.get(method) ?? new Set();
    existing.add(listener);
    this.listeners.set(method, existing);
  }

  once(method: string, sessionId: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const listener = (params: Record<string, unknown>, eventSession: string | undefined): void => {
        if (eventSession !== sessionId) return;
        this.listeners.get(method)?.delete(listener);
        resolve(params);
      };
      this.on(method, listener);
    });
  }

  call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResponse> {
    const socket = this.socket;
    if (socket === null) return Promise.reject(new Error("the browser connection is closed"));
    const id = (this.nextId += 1);
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, method });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  async newPage(): Promise<Page> {
    const created = await this.call("Target.createTarget", { url: "about:blank" });
    const targetId = String(created.result?.["targetId"] ?? "");
    const attached = await this.call("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = String(attached.result?.["sessionId"] ?? "");
    return new CdpPage(this, sessionId, targetId);
  }

  dispose(): void {
    this.socket?.close();
    this.socket = null;
    this.pending.clear();
    this.listeners.clear();
  }
}

class CdpPage implements Page {
  private readonly collected: ConsoleMessage[] = [];
  private initialized = false;
  private closed = false;

  constructor(private readonly connection: CdpConnection, private readonly sessionId: string, private readonly targetId: string) {
    connection.on("Runtime.consoleAPICalled", (params, session) => {
      if (session !== this.sessionId) return;
      const type = String(params["type"] ?? "");
      if (type !== "error" && type !== "assert") return;
      const args = Array.isArray(params["args"]) ? params["args"] : [];
      const text = args
        .map((arg) => {
          const record = arg as { value?: unknown; description?: unknown };
          if (record.value !== undefined) return typeof record.value === "string" ? record.value : JSON.stringify(record.value);
          return typeof record.description === "string" ? record.description : "<unprintable>";
        })
        .join(" ");
      this.collected.push({ level: "console", text: text === "" ? `${type} with no message` : text });
    });
    connection.on("Runtime.exceptionThrown", (params, session) => {
      if (session !== this.sessionId) return;
      const details = params["exceptionDetails"] as { text?: string; exception?: { description?: string } } | undefined;
      const text = details?.exception?.description ?? details?.text ?? "uncaught exception";
      this.collected.push({ level: "exception", text });
    });
    connection.on("Log.entryAdded", (params, session) => {
      if (session !== this.sessionId) return;
      const entry = params["entry"] as { level?: string; text?: string; url?: string } | undefined;
      if (entry?.level !== "error") return;
      this.collected.push({ level: "log", text: `${entry.text ?? "log error"}${entry.url === undefined ? "" : ` (${entry.url})`}` });
    });
    connection.on("Network.loadingFailed", (params, session) => {
      if (session !== this.sessionId) return;
      if (params["canceled"] === true) return; // an aborted SSE stream on navigation
      this.collected.push({ level: "network", text: `request failed: ${String(params["errorText"] ?? "unknown")}` });
    });
    connection.on("Network.responseReceived", (params, session) => {
      if (session !== this.sessionId) return;
      const response = params["response"] as { status?: number; url?: string } | undefined;
      const status = response?.status ?? 0;
      if (status < 400) return;
      // A 401/403 on the event stream is how a revoked token is discovered, and
      // the client handles it; everything else is a real failure.
      this.collected.push({ level: "http", text: `HTTP ${status} for ${response?.url ?? "?"}` });
    });
  }

  private async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.connection.call(method, params, this.sessionId);
    if (response.error !== undefined) {
      throw new Error(`${method} failed: ${response.error.message ?? "unknown error"}`);
    }
    return response.result ?? {};
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    // Log and Network are what turn "the page quietly failed" into a test
    // failure: a 404 asset and a console error are otherwise invisible.
    await this.send("Log.enable");
    await this.send("Network.enable");
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
  }

  async goto(url: string, options: WaitOptions = {}): Promise<void> {
    await this.init();
    const loaded = this.connection.once("Page.loadEventFired", this.sessionId);
    const result = await this.send("Page.navigate", { url });
    // A navigation that only changes the fragment never loads a document, so
    // no load event is coming and waiting for one would time out.
    if (result["loaderId"] === undefined) return;
    await withTimeout(loaded, options.timeoutMs ?? 20_000, `loading ${url}`);
  }

  async url(): Promise<string> {
    return await this.evaluate<string>("location.href");
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // A test that evaluates a promise and never resolves must fail on its own
      // timer rather than hang the whole suite.
      timeout: 15_000,
    });
    const details = result["exceptionDetails"] as { text?: string; exception?: { description?: string } } | undefined;
    if (details !== undefined) {
      throw new Error(`page evaluation failed: ${details.exception?.description ?? details.text ?? "unknown error"}`);
    }
    return (result["result"] as { value?: T } | undefined)?.value as T;
  }

  async waitFor(expression: string, options: WaitOptions = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const intervalMs = options.intervalMs ?? 50;
    const what = options.description ?? expression;
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
      last = await this.evaluate<unknown>(expression);
      if (last) return last;
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (last value: ${JSON.stringify(last)})`);
      }
      await Bun.sleep(intervalMs);
    }
  }

  text(selector: string): Promise<string | null> {
    return this.evaluate<string | null>(`__wb.text(${JSON.stringify(selector)})`);
  }

  allText(selector: string): Promise<string[]> {
    return this.evaluate<string[]>(`__wb.allText(${JSON.stringify(selector)})`);
  }

  count(selector: string): Promise<number> {
    return this.evaluate<number>(`__wb.count(${JSON.stringify(selector)})`);
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(`__wb.click(${JSON.stringify(selector)})`);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.evaluate(`__wb.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)})`);
  }

  async select(selector: string, value: string): Promise<void> {
    await this.evaluate(`__wb.select(${JSON.stringify(selector)}, ${JSON.stringify(value)})`);
  }

  async focus(selector: string): Promise<void> {
    await this.evaluate(`__wb.focus(${JSON.stringify(selector)})`);
  }

  async blur(selector: string): Promise<void> {
    await this.evaluate(`__wb.blur(${JSON.stringify(selector)})`);
  }

  /** Dispatch a real key event to the focused element, the way a keyboard would. */
  async press(selector: string, key: string): Promise<void> {
    const spec = KEY_CODES[key];
    if (spec === undefined) throw new Error(`no key code for ${key}`);
    await this.evaluate(`__wb.focus(${JSON.stringify(selector)})`);
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
    await this.send("Input.dispatchKeyEvent", { type: spec.text === undefined ? "rawKeyDown" : "keyDown", ...base });
    if (spec.text !== undefined) {
      await this.send("Input.dispatchKeyEvent", { type: "char", text: spec.text, ...base });
    }
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Console errors, uncaught exceptions, failed requests, and error responses. */
  async problems(): Promise<readonly string[]> {
    return this.collected.map((entry) => `${entry.level}: ${entry.text}`);
  }

  async clearStorage(origin?: string): Promise<void> {
    const target = origin ?? (await this.evaluate<string>("location.origin"));
    await this.send("Storage.clearDataForOrigin", { origin: target, storageTypes: "all" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection.call("Target.closeTarget", { targetId: this.targetId });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

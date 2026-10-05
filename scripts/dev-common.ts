// Shared plumbing for the development board scripts (dev.ts, dev-link.ts).
//
// SECURITY — code here prints a live bearer token on purpose, for a throwaway
// local board only. See the security note at the top of scripts/dev.ts.
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

export const ENTRY = resolve(import.meta.dir, "..", "src", "entry.ts");
export const BUN = process.execPath;

export interface Options {
  readonly dataDir: string;
  readonly participant: string;
  readonly host: string;
  readonly port: number;
  readonly route: string;
  /** Fill the board with development data before serving. */
  readonly seed: boolean;
}

export function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--seed") { switches.add("seed"); continue; }
    if (token === undefined || !["--dir", "--as", "--host", "--port", "--route"].includes(token)) {
      throw new Error("unknown development option");
    }
    const next = argv[index + 1];
    if (next === undefined || next.trim() === "" || next.startsWith("--")) {
      throw new Error(`missing value for ${token}`);
    }
    flags.set(token.slice(2), next);
    index += 1;
  }
  const port = Number(flags.get("port") ?? process.env.WORKBOARD_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid --port: ${flags.get("port")}`);
  }
  devOrigin(flags.get("host") ?? "127.0.0.1", port);
  return {
    // The current directory doubles as the data directory: `workboard.sqlite`
    // and `workboard.pid` are created right here. Those files are gitignored
    // (see .gitignore), so a checkout never shows the board in git. Pass
    // `--dir <path>` to keep the board somewhere else.
    dataDir: flags.get("dir") ?? process.cwd(),
    participant: flags.get("as") ?? "dev",
    host: flags.get("host") ?? "127.0.0.1",
    port,
    route: flags.get("route") ?? "#/backlog",
    seed: switches.has("seed") || flags.has("seed"),
  };
}

/** Run one CLI command against the dev data dir and capture stdout. */
export async function workboard(args: readonly string[]): Promise<string> {
  const child = spawn(BUN, [ENTRY, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number>((settle) => child.on("close", (value) => settle(value ?? 1)));
  if (code !== 0) {
    // stderr from the CLI is a human-readable diagnostic; the token is only ever
    // read from stdout of `token create`, so echoing this cannot leak it.
    throw new Error(`workboard ${args.join(" ")} failed (exit ${code})\n${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Idempotent board bootstrap: apply migrations, ensure the participant exists,
 * optionally seed development data, and mint a fresh `dev-bootstrap` token.
 * Running it again reuses what is already there instead of piling up
 * participants and tokens; each call still issues a new token without revoking
 * older ones. Returns the plaintext token for the printed login URL.
 */
export async function bootstrapBoard(options: Options): Promise<string> {
  const dataArgs = ["--data", options.dataDir];

  // 1. Initialize (idempotent: applies pending migrations, seeds nothing else).
  await workboard([...dataArgs, "init"]);

  // 2. Ensure the participant exists. `participant add` fails on a duplicate, so
  //    presence is checked first rather than treating the conflict as fatal.
  //    `participant --json` prints a bare array of DTOs.
  const roster = await workboard([...dataArgs, "--json", "participant"]);
  const parsedRoster = JSON.parse(roster) as Array<{ name: string }> | { participants?: Array<{ name: string }> };
  const entries = Array.isArray(parsedRoster) ? parsedRoster : parsedRoster.participants ?? [];
  const known = new Set(entries.map((entry) => entry.name.toLowerCase()));
  if (!known.has(options.participant.toLowerCase())) {
    await workboard([...dataArgs, "participant", "add", "--name", options.participant, "--kind", "human"]);
  }

  // 3. Explicit opt-in replaces the work-item graph only.
  //    Participants, labels and existing tokens survive --reset.
  if (options.seed) {
    const seeded = await workboard([...dataArgs, "seed", "--reset"]);
    console.log(seeded.trim());
    console.log("");
  }

  // 4. Issue a token for that participant.
  const issued = await workboard([
    ...dataArgs,
    "--json",
    "token",
    "create",
    "--participant",
    options.participant,
    "--name",
    "dev-bootstrap",
  ]);
  const token = (JSON.parse(issued) as { token?: string }).token;
  if (token === undefined || token === "") {
    throw new Error("token create did not return a token");
  }
  return token;
}

/** Format raw or bracketed IPv6 hosts without accepting embedded ports. */
export function devOrigin(host: string, port: number): string {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const authority = bare.includes(":") ? `[${bare}]` : bare;
  const url = new URL(`http://${authority}:${port}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid development host");
  return url.origin;
}

/** The signed-in URL: token in the fragment, then the in-app route. */
export function loginUrl(options: Options, token: string): string {
  const origin = devOrigin(options.host, options.port);
  return `${origin}/#token=${token}${options.route.startsWith("#") ? options.route : `#${options.route}`}`;
}

/**
 * Print the ready-to-open login block. The token lives in the URL fragment, so
 * it never reaches the server, and the web client strips it from the address
 * bar on load (see consumeTokenFromHash in src/web/api.js).
 */
export function printLoginBlock(options: Options, token: string, header: string): void {
  console.log("");
  console.log(`  ${header}`);
  console.log(`  data    ${options.dataDir}`);
  console.log(`  as      ${options.participant}`);
  console.log("");
  console.log("  Open this URL — it signs you in and then removes the token from the address bar:");
  console.log("");
  console.log(`    ${loginUrl(options, token)}`);
  console.log("");
  console.log("  Plain URL (signs in with the token already in this browser):");
  console.log(`    ${devOrigin(options.host, options.port)}/`);
  console.log("");
  console.log("  This link is a live credential. Revoke it with:");
  console.log(`    bun run workboard -- --data ${options.dataDir} token revoke --id <token-id>`);
  console.log("");
}

export function runForeground(args: readonly string[]): Promise<void> {
  const child = spawn(BUN, args, { stdio: "inherit" });
  return new Promise((resolve) => {
    child.on("close", (value) => {
      process.exitCode = value ?? 0;
      resolve();
    });
  });
}

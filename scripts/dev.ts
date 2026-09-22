// Development bootstrap.
//
// One command to go from an empty checkout to a signed-in browser tab:
//
//   bun run dev:board
//
// It initializes a data directory, ensures a human participant, issues that
// participant a token, prints a ready-to-open URL that signs in automatically,
// and starts serving. Every step is idempotent, so running it again reuses what
// is already there instead of piling up participants and tokens.
//
// SECURITY — this script prints a live bearer token on purpose.
//
// The token in the URL fragment is a real credential: anyone who sees the link
// has full access to that participant's board. That is acceptable for a
// throwaway local board and is NOT acceptable for anything shared or long-lived,
// which is why:
//
//   * the URL uses a `#fragment`, never a query string, so the token is never
//     sent to the server and cannot land in an access log or a `Referer`;
//   * the browser erases it from the address bar on load (see
//     `consumeTokenFromHash` in src/web/api.js) and adopts it into storage;
//   * the token is scoped to one participant, so revoking it
//     (`bun run workboard -- token revoke --id <id>`) ends the exposure.
//
// Treat any printed link as a secret: do not paste it into a chat, an issue, or
// a screenshot.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "..", "src", "entry.ts");
const BUN = process.execPath;

interface Options {
  readonly dataDir: string;
  readonly participant: string;
  readonly host: string;
  readonly port: number;
  readonly route: string;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(token.slice(2), next);
      index += 1;
    }
  }
  const port = Number(flags.get("port") ?? process.env.WORKBOARD_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid --port: ${flags.get("port")}`);
  }
  return {
    // `.tmp/` is gitignored, so the throwaway board never shows up in git.
    dataDir: flags.get("dir") ?? join(process.cwd(), ".tmp", "dev-board"),
    participant: flags.get("as") ?? "dev",
    host: flags.get("host") ?? "127.0.0.1",
    port,
    route: flags.get("route") ?? "#/backlog",
  };
}

/** Run one CLI command against the dev data dir and capture stdout. */
async function workboard(args: readonly string[]): Promise<string> {
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

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const dataArgs = ["--data", options.dataDir];

  const fresh = !existsSync(join(options.dataDir, "workboard.sqlite"));

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

  // 3. Issue a token for that participant.
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

  const origin = `http://${options.host}:${options.port}`;
  const loginUrl = `${origin}/#token=${token}${options.route.startsWith("#") ? options.route : `#${options.route}`}`;

  console.log("");
  console.log(`  workboard dev board${fresh ? " (new)" : ""}`);
  console.log(`  data    ${options.dataDir}`);
  console.log(`  as      ${options.participant}`);
  console.log("");
  console.log("  Open this URL — it signs you in and then removes the token from the address bar:");
  console.log("");
  console.log(`    ${loginUrl}`);
  console.log("");
  console.log("  Plain URL (signs in with the token already in this browser):");
  console.log(`    ${origin}/`);
  console.log("");
  console.log("  This link is a live credential. Revoke it with:");
  console.log(`    bun run workboard -- --data ${options.dataDir} token revoke --id <token-id>`);
  console.log("");

  // 4. Serve in the foreground, inheriting stdio so Ctrl-C behaves normally.
  const server = spawn(
    BUN,
    [ENTRY, "serve", ...dataArgs, "--host", options.host, "--port", String(options.port)],
    { stdio: "inherit" },
  );
  const code = await new Promise<number>((settle) => server.on("close", (value) => settle(value ?? 0)));
  process.exitCode = code;
}

await main();

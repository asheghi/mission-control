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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENTRY, bootstrapBoard, parseOptions, printLoginBlock, runForeground } from "./dev-common";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const fresh = !existsSync(join(options.dataDir, "workboard.sqlite"));
  const token = await bootstrapBoard(options);
  printLoginBlock(options, token, `workboard dev board${fresh ? " (new)" : ""}`);

  // Serve in the foreground, inheriting stdio so Ctrl-C behaves normally.
  await runForeground([
    ENTRY,
    "serve",
    "--data",
    options.dataDir,
    "--host",
    options.host,
    "--port",
    String(options.port),
  ]);
}

await main();

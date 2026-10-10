// Development link printer.
//
//   bun run dev:link
//
// `dev:board` bootstraps and then serves in the foreground, so a second run
// fails with EADDRINUSE while the first one still holds the terminal. This
// command covers the case where the server is already running:
//
//   * nothing on the configured origin and no live serve lock: hand off to
//     `bun run dev:board` with the same flags, so a cold start still builds the
//     web bundle and serves in the foreground;
//   * a server answering: bootstrap the board locally, mint a fresh
//     `dev-bootstrap` token, confirm the server accepts it, print the
//     signed-in URL, and exit.
//
// The confirmation matters because a port is shared by every board: a live
// serve lock in this data directory and a listener on this port do not have to
// belong to the same board. Require anonymous refusal and an authenticated
// participant envelope before printing a link. This local sanity check does
// not authenticate a hostile listener. Pass the
// matching --port and --dir when that happens.
//
// SECURITY — same contract as scripts/dev.ts: the printed link carries a live
// bearer token in the URL fragment. Treat it as a secret.
import { findRunningServePid, findRunningServeInfo } from "../src/maintenance/serve-lock";
import { bootstrapBoard, parseOptions, printLoginBlock, runForeground } from "./dev-common";

import { healthEndpointResponds, tokenAcceptedOnOrigin } from "./dev-probe";

function fail(message: string): never {
  console.error(`dev-link: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseOptions(args);
  const servePid = findRunningServePid(options.dataDir);
  const healthy = await healthEndpointResponds(options.host, options.port);

  if (!healthy) {
    if (servePid !== null) {
      const info = findRunningServeInfo(options.dataDir);
      const endpoint = info?.appUrl !== undefined ? `; recorded server URL: ${info.appUrl}` : "";
      fail(`serve lock (${servePid > 0 ? `pid ${servePid}` : "owner unavailable"}) holds ${options.dataDir}, but /api/health on http://${options.host}:${options.port} did not answer${endpoint}; pass the right --host and --port, or stop the owning server; never delete an active lock file`);
    }
    console.error(`dev-link: nothing on http://${options.host}:${options.port}; starting dev:board`);
    await runForeground(args.length > 0 ? ["run", "dev:board", "--", ...args] : ["run", "dev:board"]);
    return;
  }

  // Something answers on the origin. A token minted here is the one credential
  // that identifies which board it serves.
  if (options.seed) {
    console.error("dev-link: server already running; ignoring --seed");
  }
  const token = await bootstrapBoard({ ...options, seed: false });
  if ((await tokenAcceptedOnOrigin(options.host, options.port, token)) === "no") {
    fail(`port ${options.port} answers /api/health, but refused a token from ${options.dataDir} — another board is serving there; pass the matching --port and --dir`);
  }
  printLoginBlock(options, token, "workboard dev board (server already running)");
}

await main();

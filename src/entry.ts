import { join } from "node:path";
import { initializeDatabase } from "./db/database";
import { WorkboardService } from "./app/workboard";
import { runStdioMcpServer, resolveStdioActor } from "./mcp/stdio";

const VERSION = "0.1.0";

function printUsage(): void {
  console.error("Usage: workboard [--version] | mcp [--data <dir>] [--as <name>]");
}

function valueOf(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

async function runMcpCommand(argv: readonly string[]): Promise<number> {
  const dataDir = valueOf(argv, "--data") ?? process.env.WORKBOARD_DATA_DIR ?? join(process.cwd(), "workboard-data");
  const actorName = valueOf(argv, "--as") ?? process.env.WORKBOARD_USER ?? "local";
  if (actorName === "local") {
    // Keep stdio clean: chatter belongs on stderr, never stdout (JSON-RPC).
    console.error("[workboard] no --as given; attributing work to 'local'");
  }

  let db;
  try {
    db = initializeDatabase(dataDir);
  } catch (error) {
    console.error(`[workboard] cannot open data directory: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    const service = new WorkboardService(db);
    const actor = resolveStdioActor(service, actorName);
    await runStdioMcpServer(service, actor);
    return 0;
  } catch (error) {
    console.error(`[workboard] mcp failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return 0;
  }
  if (argv[0] === "mcp") {
    return runMcpCommand(argv.slice(1));
  }
  printUsage();
  return 1;
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}

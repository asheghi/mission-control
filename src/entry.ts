import { APP_VERSION as VERSION } from "./version";

function printUsage(): void {
  console.error("Usage: workboard [--version]");
}

export function main(argv: readonly string[]): number {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return 0;
  }
  printUsage();
  return 1;
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
  process.exit(main(process.argv.slice(2)));
}

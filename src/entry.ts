import { runCli } from "./cli";

const isDirectRun = import.meta.main;
if (isDirectRun) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}

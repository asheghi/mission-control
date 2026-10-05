import { describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeDatabase, openDatabase } from "../../../src/db/database";
import { withTempDataDir } from "../../helpers/temp-dir";

const RUNTIME_PATHS = [
  "workboard.sqlite",
  "workboard.sqlite-wal",
  "workboard.sqlite-shm",
  "workboard.sqlite-journal",
  "workboard.pid",
  "workboard.restore.lock",
  "workboard.storage.json",
  "workboard.storage.json.tmp-example",
  "blobs/attachments/example.bin",
];

describe("data directory .gitignore", () => {
  test("creates scoped defaults in a new nested data directory", () => {
    withTempDataDir((dir) => {
      const dataDir = join(dir, "nested", "board");
      initializeDatabase(dataDir).close();
      const content = readFileSync(join(dataDir, ".gitignore"), "utf8");
      expect(content).toBe(
        "# Workboard runtime data\n" +
        RUNTIME_PATHS.slice(0, -2).map((path) => `/${path}\n`).join("") +
        "/workboard.storage.json.tmp-*\n/blobs/\n",
      );
      initializeDatabase(dataDir).close();
      expect(readFileSync(join(dataDir, ".gitignore"), "utf8")).toBe(content);
    });
  });

  test("also creates defaults on implicit database initialization", () => {
    withTempDataDir((dir) => {
      openDatabase(dir).close();
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("/workboard.sqlite\n");
    });
  });

  for (const content of ["", "# User rules\n/src/generated/\n!keep.sqlite\n"]) {
    test(`preserves an existing ${content === "" ? "empty" : "custom"} .gitignore byte-for-byte`, () => {
      withTempDataDir((dir) => {
        const path = join(dir, ".gitignore");
        writeFileSync(path, content);
        initializeDatabase(dir).close();
        initializeDatabase(dir).close();
        expect(readFileSync(path, "utf8")).toBe(content);
      });
    });
  }

  test("preserves an existing dangling .gitignore symlink", () => {
    withTempDataDir((dir) => {
      const path = join(dir, ".gitignore");
      symlinkSync("missing-ignore-file", path);
      initializeDatabase(dir).close();
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    });
  });

  test("ignores root runtime data but not source or similarly named nested files", () => {
    withTempDataDir((dir) => {
      const init = Bun.spawnSync(["git", "init", "--quiet", dir]);
      expect(init.exitCode).toBe(0);
      initializeDatabase(dir).close();
      const sourcePaths = [
        ".gitignore",
        "AGENTS.md",
        "package.json",
        "src/db/database.ts",
        "src/storage/blobs/example.ts",
        "src/workboard.sqlite",
        "src/workboard.pid",
        "other.sqlite",
      ];
      const ignored = Bun.spawnSync(["git", "-C", dir, "check-ignore", "--no-index", "--stdin"], {
        stdin: Buffer.from(`${[...RUNTIME_PATHS, ...sourcePaths].join("\n")}\n`),
      });
      expect(ignored.exitCode).toBe(0);
      expect(ignored.stdout.toString().trim().split("\n")).toEqual(RUNTIME_PATHS);
    });
  });
});

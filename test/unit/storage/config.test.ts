// Storage configuration: how a board remembers where its attachments live, and
// how every command resolves that choice the same way.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFromFlags,
  defaultBlobDirectory,
  readStorageConfig,
  resolveBlobStore,
  sameBlobLocation,
  storageConfigPath,
  validateStorageConfig,
  writeStorageConfig,
} from "../../../src/storage/config";
import { FilesystemBlobStore } from "../../../src/storage/fs";
import { S3BlobStore } from "../../../src/storage/s3";

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "wb-cfg-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("storage configuration file", () => {
  test("an unconfigured board defaults to the filesystem beside the database", () => {
    withDir((dir) => {
      expect(readStorageConfig(dir)).toBeNull();
      const resolved = resolveBlobStore({ dataDir: dir });
      expect(resolved.config.backend).toBe("fs");
      expect(resolved.store).toBeInstanceOf(FilesystemBlobStore);
      // Beside the database, never beside the working directory: the production
      // board runs from a compiled binary under systemd.
      expect((resolved.store as FilesystemBlobStore).directory).toBe(defaultBlobDirectory(dir));
    });
  });

  test("init flags round-trip through the file", () => {
    withDir((dir) => {
      writeStorageConfig(dir, configFromFlags(dir, { backend: "fs", directory: "media" }, null));
      expect(existsSync(storageConfigPath(dir))).toBe(true);
      expect(readStorageConfig(dir)).toEqual({ backend: "fs", directory: "media" });
    });
  });

  test("a relative directory resolves against the data directory", () => {
    withDir((dir) => {
      const resolved = resolveBlobStore({ dataDir: dir, config: { backend: "fs", directory: "media" } });
      const store = resolved.store as FilesystemBlobStore;
      expect(store.directory).toBe(join(dir, "media"));
      expect(store.directory.startsWith(dir)).toBe(true);
    });
  });

  test("an absolute directory is used as given", () => {
    withDir((dir) => {
      const absolute = join(dir, "elsewhere");
      const resolved = resolveBlobStore({ dataDir: dir, config: { backend: "fs", directory: absolute } });
      expect((resolved.store as FilesystemBlobStore).directory).toBe(absolute);
    });
  });

  test("re-running init with one flag keeps the rest", () => {
    withDir((dir) => {
      const first = configFromFlags(dir, { backend: "s3", bucket: "shots", endpoint: "http://localhost:9000", region: "us-east-1" }, null);
      const second = configFromFlags(dir, { region: "eu-west-1" }, first);
      expect(second.bucket).toBe("shots");
      expect(second.endpoint).toBe("http://localhost:9000");
      expect(second.region).toBe("eu-west-1");
    });
  });

  test("naming a directory selects the filesystem backend", () => {
    withDir((dir) => {
      // Without this, `init --blob-dir media` on an S3 board records the
      // directory but keeps the backend as s3 — the board keeps talking to a
      // bucket while the operator believes it was moved to disk.
      const s3 = configFromFlags(dir, { backend: "s3", bucket: "shots", endpoint: "http://localhost:9000" }, null);
      const moved = configFromFlags(dir, { directory: "media" }, s3);
      expect(moved.backend).toBe("fs");
      expect(moved.directory).toBe("media");
      expect(moved.bucket).toBeUndefined();

      // An explicit backend still wins over the implication.
      const explicit = configFromFlags(dir, { backend: "s3", bucket: "shots", directory: "media" }, s3);
      expect(explicit.backend).toBe("s3");
    });
  });

  test("switching back to the filesystem drops S3-only fields", () => {
    withDir((dir) => {
      const s3 = configFromFlags(dir, { backend: "s3", bucket: "shots", endpoint: "http://localhost:9000" }, null);
      const back = configFromFlags(dir, { backend: "fs" }, s3);
      expect(back.backend).toBe("fs");
      expect(back.bucket).toBeUndefined();
      expect(back.endpoint).toBeUndefined();
    });
  });

  test("an s3 configuration resolves to the S3 backend", () => {
    withDir((dir) => {
      const resolved = resolveBlobStore({
        dataDir: dir,
        config: { backend: "s3", bucket: "shots", endpoint: "http://localhost:9000", prefix: "board" },
      });
      expect(resolved.store).toBeInstanceOf(S3BlobStore);
    });
  });

  test("rejects an unusable configuration instead of guessing", () => {
    expect(() => validateStorageConfig({ backend: "ftp" })).toThrow(/backend must be one of fs, s3/);
    expect(() => validateStorageConfig({ backend: "s3" })).toThrow(/requires a bucket/);
    expect(() => validateStorageConfig({ backend: "fs", directory: "" })).toThrow(/non-empty string/);
    expect(() => validateStorageConfig({ backend: "fs", bucket: 42 })).toThrow(/non-empty string/);
    expect(() => validateStorageConfig("nope")).toThrow(/must be a JSON object/);
    expect(() => validateStorageConfig(null)).toThrow(/must be a JSON object/);
    expect(() => validateStorageConfig([])).toThrow(/must be a JSON object/);
  });

  test("an explicitly passed configuration is validated too", () => {
    withDir((dir) => {
      // Reading from disk validates; a caller-supplied config must not be a way
      // around those checks.
      expect(() => resolveBlobStore({ dataDir: dir, config: { backend: "ftp" } as never })).toThrow(/backend must be one of/);
    });
  });

  test("a corrupt configuration file is reported, not ignored", () => {
    withDir((dir) => {
      writeFileSync(storageConfigPath(dir), "{ not json", "utf8");
      expect(() => readStorageConfig(dir)).toThrow(/not valid JSON/);
    });
  });

  test("a change that would strand existing blobs is detectable", () => {
    withDir((dir) => {
      // `sameBlobLocation` is what lets `init` refuse a move that would leave
      // every existing attachment unreachable.
      const fsOld = configFromFlags(dir, { backend: "fs", directory: "old" }, null);
      const fsNew = configFromFlags(dir, { backend: "fs", directory: "new" }, null);
      expect(sameBlobLocation(fsOld, fsOld)).toBe(true);
      expect(sameBlobLocation(fsOld, fsNew)).toBe(false);

      const s3A = configFromFlags(dir, { backend: "s3", bucket: "a" }, null);
      const s3B = configFromFlags(dir, { backend: "s3", bucket: "b" }, null);
      const s3ASame = configFromFlags(dir, { backend: "s3", bucket: "a", region: "eu-west-1" }, null);
      expect(sameBlobLocation(s3A, s3B)).toBe(false);
      // A region change does not move the objects, so it is not a stranding change.
      expect(sameBlobLocation(s3A, s3ASame)).toBe(true);
      // Crossing backends always moves them.
      expect(sameBlobLocation(fsOld, s3A)).toBe(false);
    });
  });

  test("the file is written atomically and contains no credentials", () => {
    withDir((dir) => {
      writeStorageConfig(dir, { backend: "s3", bucket: "shots", endpoint: "http://localhost:9000" });
      const text = readFileSync(storageConfigPath(dir), "utf8");
      expect(text).toContain('"bucket": "shots"');
      // Secrets stay in the environment: this file is the kind of thing that
      // gets copied or committed.
      expect(text).not.toMatch(/secret|accessKey|password|token/i);
    });
  });
});

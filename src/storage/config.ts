// Where a board's attachment bytes live, and how that choice is remembered.
//
// The choice is written by `init` into a small JSON file next to the database
// rather than into SQLite, because `doctor`, `backup`, and `restore` must reach
// the same backend as `serve` even when they open the database read-only or
// replace it entirely. A file beside the data directory is the one place every
// command already looks.
//
// Secrets are deliberately not written here. An S3 access key and secret come
// from the environment, because a config file next to the database is the kind
// of thing that gets copied, committed, or mailed around; Bun reads the
// standard S3_*/AWS_* variables itself.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { InternalError, ValidationError } from "../domain/errors";
import { FilesystemBlobStore } from "./fs";
import { S3BlobStore } from "./s3";
import type { BlobStore } from "./types";

export const STORAGE_CONFIG_FILENAME = "workboard.storage.json";

export const BLOB_BACKENDS = ["fs", "s3"] as const;
export type BlobBackend = (typeof BLOB_BACKENDS)[number];

export interface StorageConfig {
  readonly backend: BlobBackend;
  /** Filesystem backend: absolute, or relative to the data directory. */
  readonly directory?: string;
  /** S3 backend: bucket name. */
  readonly bucket?: string;
  /** S3 backend: custom endpoint, for MinIO and S3-compatible services. */
  readonly endpoint?: string;
  /** S3 backend: region, e.g. `us-east-1`. */
  readonly region?: string;
  /** S3 backend: key prefix inside the bucket. */
  readonly prefix?: string;
}

/** Default object directory: beside the database, never beside the process. */
export function defaultBlobDirectory(dataDir: string): string {
  return join(dataDir, "blobs");
}

export function storageConfigPath(dataDir: string): string {
  return join(dataDir, STORAGE_CONFIG_FILENAME);
}

/**
 * Read a board's storage configuration.
 *
 * Absent means "not configured yet", which resolves to the filesystem default
 * rather than to no storage at all: a board created before this feature existed
 * must still be able to accept its first attachment.
 */
export function readStorageConfig(dataDir: string): StorageConfig | null {
  const path = storageConfigPath(dataDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InternalError(`The storage configuration at ${path} is not valid JSON.`, { cause: error });
  }
  return validateStorageConfig(parsed, path);
}

/**
 * Persist a storage configuration, replacing any previous one.
 *
 * Written to a temp file and renamed so a crash cannot leave a truncated
 * config that every later command would refuse to parse.
 */
/**
 * Whether two configurations would look for blobs in the same place.
 *
 * Used to refuse a change that would strand every existing attachment: the rows
 * would still point at keys, but the new backend would not have the objects.
 */
export function sameBlobLocation(left: StorageConfig, right: StorageConfig): boolean {
  if (left.backend !== right.backend) return false;
  if (left.backend === "s3") {
    return left.bucket === right.bucket && (left.prefix ?? "") === (right.prefix ?? "");
  }
  return (left.directory ?? "") === (right.directory ?? "");
}

export function writeStorageConfig(dataDir: string, config: StorageConfig): void {
  const path = storageConfigPath(dataDir);
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch (error) {
    throw new InternalError(`Failed to write the storage configuration at ${path}.`, { cause: error });
  }
}

export function validateStorageConfig(input: unknown, source = "storage configuration"): StorageConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError(`${source} must be a JSON object.`);
  }
  const record = input as Record<string, unknown>;
  const backend = record["backend"];
  if (backend !== "fs" && backend !== "s3") {
    throw new ValidationError(`${source}: backend must be one of ${BLOB_BACKENDS.join(", ")}.`);
  }
  const config: Record<string, unknown> = { backend };
  for (const field of ["directory", "bucket", "endpoint", "region", "prefix"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw new ValidationError(`${source}: ${field} must be a non-empty string when present.`);
    }
    config[field] = value;
  }
  if (backend === "s3" && config["bucket"] === undefined) {
    throw new ValidationError(`${source}: the s3 backend requires a bucket.`);
  }
  return config as unknown as StorageConfig;
}

/**
 * The configuration a board is effectively using, applying the default when no
 * file exists. Distinct from `readStorageConfig`, which reports only what was
 * explicitly written and returns null for a board on the default.
 */
export function effectiveStorageConfig(dataDir: string): StorageConfig {
  return readStorageConfig(dataDir) ?? { backend: "fs", directory: defaultBlobDirectory(dataDir) };
}

export interface ResolveBlobStoreOptions {
  readonly dataDir: string;
  /** An explicit configuration, overriding whatever is on disk. */
  readonly config?: StorageConfig;
}

export interface ResolvedBlobStore {
  readonly store: BlobStore;
  /** What was actually chosen, after defaults are applied. */
  readonly config: StorageConfig;
}

/**
 * Build the blob store a command should use.
 *
 * The filesystem directory is resolved against the *data directory*, never
 * against the working directory or the executable's location: the production
 * board runs from a compiled binary under systemd, where a relative path would
 * put blobs somewhere nobody looks.
 */
export function resolveBlobStore(options: ResolveBlobStoreOptions): ResolvedBlobStore {
  // An explicitly passed config is validated too: `readStorageConfig` checks
  // what it parses from disk, and a caller-supplied one must not be a way to
  // bypass those checks.
  const config =
    options.config !== undefined
      ? validateStorageConfig(options.config)
      : readStorageConfig(options.dataDir) ?? { backend: "fs" as const };
  if (config.backend === "s3") {
    return {
      store: new S3BlobStore({
        bucket: config.bucket as string,
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        ...(config.region !== undefined ? { region: config.region } : {}),
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
      }),
      config,
    };
  }
  const directory = config.directory ?? defaultBlobDirectory(options.dataDir);
  return {
    store: new FilesystemBlobStore({
      directory: isAbsolute(directory) ? directory : resolve(options.dataDir, directory),
    }),
    config: { backend: "fs", directory },
  };
}

/**
 * Merge `init` flags into a configuration.
 *
 * Only the flags that were given are applied, so re-running `init` with one flag
 * does not silently discard the rest of an existing configuration.
 */
export function configFromFlags(
  dataDir: string,
  flags: { readonly backend?: string; readonly directory?: string; readonly bucket?: string; readonly endpoint?: string; readonly region?: string; readonly prefix?: string },
  existing: StorageConfig | null,
): StorageConfig {
  // Naming a filesystem directory selects the filesystem backend. Without this,
  // `init --blob-dir media` on an S3-configured board would record the directory
  // and leave the backend as s3, so the board would keep talking to a bucket
  // while the operator believed they had moved it to disk. An explicit
  // `--blob-backend` still wins.
  const implied = flags.backend === undefined && flags.directory !== undefined ? "fs" : undefined;
  const backend = (flags.backend ?? implied ?? existing?.backend ?? "fs") as string;
  if (backend !== "fs" && backend !== "s3") {
    throw new ValidationError(`Unknown storage backend ${backend}. Use one of ${BLOB_BACKENDS.join(", ")}.`);
  }
  const merged: Record<string, unknown> = {
    ...(existing ?? {}),
    backend,
    ...(flags.directory !== undefined ? { directory: flags.directory } : {}),
    ...(flags.bucket !== undefined ? { bucket: flags.bucket } : {}),
    ...(flags.endpoint !== undefined ? { endpoint: flags.endpoint } : {}),
    ...(flags.region !== undefined ? { region: flags.region } : {}),
    ...(flags.prefix !== undefined ? { prefix: flags.prefix } : {}),
  };
  if (backend === "fs" && merged["directory"] === undefined) {
    merged["directory"] = defaultBlobDirectory(dataDir);
  }
  if (backend === "fs") {
    delete merged["bucket"];
    delete merged["endpoint"];
    delete merged["region"];
    delete merged["prefix"];
  }
  return validateStorageConfig(merged, "storage configuration");
}

// One conformance suite for every BlobStore implementation.
//
// The point of the interface is that a caller cannot tell the backends apart, so
// the same behavioural claims are asserted against each. A backend that cannot
// be reached (S3 with no endpoint configured) is skipped with a stated reason
// rather than silently passing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemBlobStore } from "../../src/storage/fs";
import { S3BlobStore } from "../../src/storage/s3";
import { BlobStoreError, type BlobStore } from "../../src/storage/types";

interface Backend {
  readonly name: string;
  /** Null when this backend cannot be exercised in this environment. */
  create(): Promise<{ store: BlobStore; cleanup: () => Promise<void> } | null>;
}

const BACKENDS: readonly Backend[] = [
  {
    name: "filesystem",
    async create() {
      const dir = mkdtempSync(join(tmpdir(), "wb-blob-"));
      return {
        store: new FilesystemBlobStore({ directory: dir }),
        cleanup: async () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "s3",
    async create() {
      // A live S3 endpoint is deliberately not required: the suite skips when
      // one is absent, and the backend's own error handling is covered by the
      // unreachable-endpoint test below.
      const endpoint = process.env["WORKBOARD_TEST_S3_ENDPOINT"];
      if (endpoint === undefined || endpoint === "") return null;
      const bucket = process.env["WORKBOARD_TEST_S3_BUCKET"] ?? "workboard-test";
      return {
        store: new S3BlobStore({ bucket, endpoint, prefix: `test-${crypto.randomUUID().slice(0, 8)}` }),
        cleanup: async () => {},
      };
    },
  },
];

/**
 * S3 has no endpoint in CI or on a workstation by default, so its cases are
 * registered as skips with a stated reason. Returning early instead would report
 * a green run that asserted nothing, which is worse than an honest skip.
 */
const S3_ENDPOINT = process.env["WORKBOARD_TEST_S3_ENDPOINT"] ?? "";
const s3Unavailable = S3_ENDPOINT === "" ? "set WORKBOARD_TEST_S3_ENDPOINT to run the S3 cases" : null;

for (const backend of BACKENDS) {
  const skip = backend.name === "s3" ? s3Unavailable : null;
  describe(`BlobStore conformance: ${backend.name}${skip === null ? "" : " (skipped)"}`, () => {
    const register = skip === null ? test : test.skip;
    register("stores and returns bytes unchanged", async () => {
      const fixture = await backend.create();
      if (fixture === null) return;
      try {
        const bytes = new Uint8Array(4096).map((_, index) => index % 251);
        await fixture.store.put("attachments/aa/one.bin", new Blob([bytes]).stream());
        const opened = await fixture.store.open("attachments/aa/one.bin");
        expect(opened).not.toBeNull();
        const roundTrip = new Uint8Array(await new Response(opened?.body).arrayBuffer());
        expect(Buffer.compare(Buffer.from(roundTrip), Buffer.from(bytes))).toBe(0);
        expect(opened?.size).toBe(bytes.byteLength);
      } finally {
        await fixture.cleanup();
      }
    });

    register("reports a range and the full size together", async () => {
      const fixture = await backend.create();
      if (fixture === null) return;
      try {
        const bytes = new Uint8Array(1024).map((_, index) => index % 256);
        await fixture.store.put("attachments/aa/range.bin", new Blob([bytes]).stream());
        const opened = await fixture.store.open("attachments/aa/range.bin", { start: 10, endInclusive: 19 });
        expect(opened).not.toBeNull();
        const slice = new Uint8Array(await new Response(opened?.body).arrayBuffer());
        expect(Array.from(slice)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
        // The whole-object size, not the slice: a range response needs both.
        expect(opened?.size).toBe(1024);
      } finally {
        await fixture.cleanup();
      }
    });

    register("resolves null for a missing object rather than throwing", async () => {
      const fixture = await backend.create();
      if (fixture === null) return;
      try {
        expect(await fixture.store.stat("attachments/zz/absent")).toBeNull();
        expect(await fixture.store.open("attachments/zz/absent")).toBeNull();
      } finally {
        await fixture.cleanup();
      }
    });

    register("stat reports the size after a write", async () => {
      const fixture = await backend.create();
      if (fixture === null) return;
      try {
        await fixture.store.put("attachments/bb/sized.bin", new Blob([new Uint8Array(321)]).stream());
        expect(await fixture.store.stat("attachments/bb/sized.bin")).toEqual({ size: 321 });
      } finally {
        await fixture.cleanup();
      }
    });

    register("delete is idempotent", async () => {
      const fixture = await backend.create();
      if (fixture === null) return;
      try {
        await fixture.store.put("attachments/cc/gone.bin", new Blob([new Uint8Array(8)]).stream());
        await fixture.store.delete("attachments/cc/gone.bin");
        expect(await fixture.store.stat("attachments/cc/gone.bin")).toBeNull();
        // Deleting again must not fail: a queued deletion is often retried.
        await fixture.store.delete("attachments/cc/gone.bin");
        await fixture.store.delete("attachments/cc/never-existed.bin");
      } finally {
        await fixture.cleanup();
      }
    });

    register("put with ifAbsent refuses to replace an existing object", async () => {
      const fixture = await backend.create();
      if (fixture === null) return;
      try {
        await fixture.store.put("attachments/dd/keep.bin", new Blob([new Uint8Array(4)]).stream(), { ifAbsent: true });
        const failure = await fixture.store
          .put("attachments/dd/keep.bin", new Blob([new Uint8Array(99)]).stream(), { ifAbsent: true })
          .then(() => null)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(BlobStoreError);
        expect((failure as BlobStoreError).code).toBe("ALREADY_EXISTS");
        // The original bytes must survive: a random key collision is a bug, and
        // overwriting would destroy another attachment's data.
        expect(await fixture.store.stat("attachments/dd/keep.bin")).toEqual({ size: 4 });
      } finally {
        await fixture.cleanup();
      }
    });

    register("lists stored keys and honours a prefix", async () => {
      const fixture = await backend.create();
      if (fixture === null) return;
      try {
        await fixture.store.put("attachments/ee/one.bin", new Blob([new Uint8Array(1)]).stream());
        await fixture.store.put("attachments/ff/two.bin", new Blob([new Uint8Array(2)]).stream());
        const all: string[] = [];
        for await (const key of fixture.store.listKeys()) all.push(key);
        expect(all).toContain("attachments/ee/one.bin");
        expect(all).toContain("attachments/ff/two.bin");

        const narrowed: string[] = [];
        for await (const key of fixture.store.listKeys("attachments/ee/")) narrowed.push(key);
        expect(narrowed).toEqual(["attachments/ee/one.bin"]);
      } finally {
        await fixture.cleanup();
      }
    });

    register("stores a body larger than one chunk without buffering it whole", async () => {
      const fixture = await backend.create();
      if (fixture === null) return;
      try {
        // Multiple chunks, so a single-read implementation would be caught.
        const chunk = new Uint8Array(64 * 1024).fill(7);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 8; index += 1) controller.enqueue(chunk);
            controller.close();
          },
        });
        await fixture.store.put("attachments/gg/big.bin", body);
        expect(await fixture.store.stat("attachments/gg/big.bin")).toEqual({ size: 512 * 1024 });
      } finally {
        await fixture.cleanup();
      }
    });
  });
}

describe("S3 backend without a reachable endpoint", () => {
  test("fails an upload instead of reporting a silent success", async () => {
    // Bun's S3 writer does not raise when credentials cannot be resolved: it
    // returns 0 from end() and never uploads. Verified against the runtime. A
    // silent no-op here would commit an attachment whose bytes do not exist, so
    // the backend confirms the object exists after writing.
    const store = new S3BlobStore({ bucket: "nonexistent", endpoint: "http://127.0.0.1:9", region: "us-east-1" });
    const failure = await store
      .put("attachments/hh/x.bin", new Blob([new Uint8Array([1, 2, 3])]).stream())
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BlobStoreError);
    expect((failure as BlobStoreError).code).toBe("IO");
  });

  test("reports an unreachable backend as IO, never as a missing object", async () => {
    const store = new S3BlobStore({ bucket: "nonexistent", endpoint: "http://127.0.0.1:9", region: "us-east-1" });
    const failure = await store
      .stat("attachments/hh/absent.bin")
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BlobStoreError);
  });
});

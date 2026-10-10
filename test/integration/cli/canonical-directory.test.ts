import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRunningServeInfo, findRunningServePid, findRestoreHolder } from "../../../src/maintenance/serve-lock";
import { initializeDatabase } from "../../../src/db/database";
import { createBundle } from "../../../src/maintenance/bundle";
import { resolveBlobStore } from "../../../src/storage/config";

const cliModule = join(import.meta.dir, "../../../src/cli.ts");

function start(dir: string, host: string, retarget?: { alias: string; target: string }) {
  // Retarget at a synchronous startup boundary, not after a timing-based sleep:
  // SQLite/blob storage are open, but lock metadata has not yet been updated.
  const script = `
    import { runCli } from ${JSON.stringify(cliModule)};
    import { unlinkSync, symlinkSync } from "node:fs";
    const original = Bun.serve;
    Bun.serve = function(options) {
      const server = original(options);
      ${retarget === undefined ? "" : `unlinkSync(${JSON.stringify(retarget.alias)}); symlinkSync(${JSON.stringify(retarget.target)}, ${JSON.stringify(retarget.alias)});`}
      return server;
    };
    process.exit(await runCli(${JSON.stringify(["serve", "--dir", dir, "--host", host, "--port", "0", "--hide-token"])}));
  `;
  return Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
}

type Child = ReturnType<typeof start>;
async function banner(child: Child): Promise<string> {
  const reader = child.stderr.getReader();
  let text = "";
  try {
    while (!text.includes("  Web:")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`serve exited before banner: ${text}`);
      text += new TextDecoder().decode(chunk.value);
    }
    return text;
  } finally { reader.releaseLock(); }
}

const stopping = new WeakMap<Child, Promise<void>>();
function stop(child: Child): Promise<void> {
  const previous = stopping.get(child);
  if (previous !== undefined) return previous;
  const pending = (async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    const reader = child.stderr.getReader();
    try { while (!(await reader.read()).done) { /* drain diagnostics */ } }
    finally { reader.releaseLock(); }
  })();
  stopping.set(child, pending);
  return pending;
}

test("serve pins database, metadata and lock release despite a deterministic symlink retarget", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-cli-canonical-"));
  const original = join(root, "original");
  const replacement = join(root, "replacement");
  const alias = join(root, "alias");
  mkdirSync(original);
  mkdirSync(replacement);
  symlinkSync(original, alias);
  const child = start(alias, "127.0.0.1", { alias, target: replacement });
  try {
    const output = await banner(child);
    const info = findRunningServeInfo(original);
    expect(info?.pid).toBe(child.pid);
    expect(info?.dataDir).toBe(original);
    expect(output).toContain(info!.appUrl!);
    expect(existsSync(join(original, "workboard.sqlite"))).toBe(true);
    expect(existsSync(join(replacement, "workboard.sqlite"))).toBe(false);
    expect(existsSync(join(replacement, "workboard.pid"))).toBe(false);
    expect(existsSync(join(replacement, "blobs"))).toBe(false);
    await stop(child);
    expect(child.exitCode).toBe(0);
    expect(findRunningServePid(original)).toBeNull();
    // Graceful release clears metadata on the locked inode, not its new alias.
    expect(readFileSync(join(original, "workboard.pid"), "utf8").trim()).toBe("");
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("restore pins blob resolution, database replacement and lock release when its alias is retargeted", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-restore-canonical-"));
  const source = join(root, "source");
  const original = join(root, "original");
  const replacement = join(root, "replacement");
  const alias = join(root, "alias");
  const bundle = join(root, "bundle");
  mkdirSync(original);
  mkdirSync(replacement);
  symlinkSync(original, alias);
  try {
    const db = initializeDatabase(source);
    try {
      await createBundle({ dataDir: source, db, blobs: resolveBlobStore({ dataDir: source }).store, outputPath: bundle, now: new Date(0) });
    } finally { db.close(); }
    const configModule = join(import.meta.dir, "../../../src/storage/config.ts");
    const script = `
      import { mock } from "bun:test";
      import { unlinkSync, symlinkSync } from "node:fs";
      const config = await import(${JSON.stringify(configModule)});
      const originalResolve = config.resolveBlobStore;
      let resolvedDir;
      mock.module(${JSON.stringify(configModule)}, () => ({ ...config, resolveBlobStore(options) {
        resolvedDir = options.dataDir;
        unlinkSync(${JSON.stringify(alias)});
        symlinkSync(${JSON.stringify(replacement)}, ${JSON.stringify(alias)});
        return originalResolve(options);
      }}));
      const { runCli } = await import(${JSON.stringify(cliModule)});
      const code = await runCli(${JSON.stringify(["--dir", alias, "restore", "--input", bundle])});
      console.log(JSON.stringify({ code, resolvedDir }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ code: 0, resolvedDir: original });
    expect(existsSync(join(original, "workboard.sqlite"))).toBe(true);
    expect(existsSync(join(replacement, "workboard.sqlite"))).toBe(false);
    expect(existsSync(join(replacement, "workboard.restore.lock"))).toBe(false);
    expect(existsSync(join(replacement, "blobs"))).toBe(false);
    expect(findRestoreHolder(original)).toBeNull();
    expect(readFileSync(join(original, "workboard.restore.lock"), "utf8").trim()).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);

for (const host of ["::1", "[::1]"]) {
  test(`serve normalizes ${host} in metadata and every printed URL`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-cli-ipv6-"));
    const child = start(dir, host);
    try {
      const output = await banner(child);
      const info = findRunningServeInfo(dir);
      expect(info?.hostname).toBe("::1");
      const url = `http://[::1]:${info!.port}`;
      expect(info?.appUrl).toBe(url);
      expect(output).toContain(`workboard listening on ${url}\n`);
      expect(output).toContain(`REST:  ${url}/api/health`);
      expect(output).toContain(`MCP:   ${url}/mcp`);
      expect(output).toContain(`Web:   ${url}/`);
      expect(output).not.toContain("[[");
      expect(new URL(info!.appUrl!).hostname).toBe("[::1]");
      await stop(child);
      expect(child.exitCode).toBe(0);
    } finally {
      await stop(child);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
}

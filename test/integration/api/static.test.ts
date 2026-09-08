// Task 12 black-box tests: the embedded web shell is served by the same
// handler as the API, with traversal-proof path matching and correct
// content types.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { WorkboardEventBroker } from "../../../src/app/events";
import { authenticate } from "../../../src/auth/service";
import { createApiHandler } from "../../../src/api/app";
import indexHtml from "../../../src/web/index.html" with { type: "text" };
import appJs from "../../../src/web/app.js" with { type: "text" };
import apiJs from "../../../src/web/api.js" with { type: "text" };
import stylesCss from "../../../src/web/styles.css" with { type: "text" };
import viewsJs from "../../../src/web/views.js" with { type: "text" };
import boardJs from "../../../src/web/board.js" with { type: "text" };
import listJs from "../../../src/web/list.js" with { type: "text" };
import detailJs from "../../../src/web/detail.js" with { type: "text" };

const ASSETS = {
  "/": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/assets/styles.css": { body: stylesCss, contentType: "text/css; charset=utf-8" },
  "/assets/app.js": { body: appJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/api.js": { body: apiJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/views.js": { body: viewsJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/board.js": { body: boardJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/list.js": { body: listJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/detail.js": { body: detailJs, contentType: "text/javascript; charset=utf-8" },
};

function startWithStatic(): { url: string; stop(): void } {
  const dir = mkdtempSync(join(tmpdir(), "wb-static-"));
  const db = initializeDatabase(dir);
  const service = new WorkboardService(db);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApiHandler({
      service,
      broker: new WorkboardEventBroker(),
      authenticate: (credential, now) => authenticate(db, credential, now),
      staticAssets: ASSETS,
    }),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("static web shell", () => {
  test("serves the shell with correct content types", async () => {
    const server = startWithStatic();
    try {
      const index = await fetch(`${server.url}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain('src="/assets/app.js"');

      const js = await fetch(`${server.url}/assets/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("text/javascript");
      expect(await js.text()).toContain("subscribeEvents");

      const apiJsServed = await fetch(`${server.url}/assets/api.js`);
      expect(apiJsServed.status).toBe(200);
      const servedApiJs = await apiJsServed.text();
      expect(servedApiJs).toContain("localStorage");
      expect(servedApiJs).toContain("sessionStorage");

      const css = await fetch(`${server.url}/assets/styles.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
    } finally {
      server.stop();
    }
  });

  test("unknown and traversal paths are 404s, never file reads", async () => {
    const server = startWithStatic();
    try {
      for (const path of ["/nope", "/../package.json", "/%2e%2e/package.json", "/assets/../../../package.json", "/index.html/extra"]) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status, path).toBe(404);
      }
    } finally {
      server.stop();
    }
  });

  test("API and MCP keep working alongside static assets", async () => {
    const server = startWithStatic();
    try {
      const health = await fetch(`${server.url}/api/health`);
      expect(health.status).toBe(200);
      const mcp = await fetch(`${server.url}/mcp`, { method: "GET" });
      expect(mcp.status).toBe(405);
      const api404 = await fetch(`${server.url}/api/nope`);
      expect(api404.status).toBe(404);
    } finally {
      server.stop();
    }
  });
});

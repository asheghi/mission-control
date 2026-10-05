import { describe, expect, test } from "bun:test";
import { devOrigin, parseOptions } from "../../scripts/dev-common";
import { tokenAcceptedOnOrigin } from "../../scripts/dev-probe";

describe("development options", () => {
  test("seed is a switch and value options are strict", () => {
    const options = parseOptions(["--", "--seed", "--port", "8765", "--route", "#/board"]);
    expect(options.seed).toBe(true);
    expect(options.route).toBe("#/board");
    for (const args of [["--host", "--seed", "localhost"], ["--port"], ["--port", ""], ["--port", "0"], ["--unknown"]]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });
  test("IPv6 hosts format correctly and embedded ports fail", () => {
    expect(devOrigin("::1", 8765)).toBe("http://[::1]:8765");
    expect(devOrigin("[::1]", 8765)).toBe("http://[::1]:8765");
    expect(() => devOrigin("localhost:8080", 8765)).toThrow();
  });
});

describe("development origin verification", () => {
  test("rejects anonymous 200 without sending a credential", async () => {
    let authenticated = false;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      authenticated ||= request.headers.has("authorization");
      return new Response("foreign app");
    } });
    try {
      expect(await tokenAcceptedOnOrigin("127.0.0.1", server.port!, "test-credential")).toBe("no");
      expect(authenticated).toBe(false);
    } finally { server.stop(true); }
  });
  test("requires a valid authenticated participant envelope", async () => {
    let valid = false;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      if (!request.headers.has("authorization")) return new Response(null, { status: 401 });
      return Response.json(valid ? { data: [{ id: 1, name: "dev", kind: "human" }] } : { participants: [] });
    } });
    try {
      expect(await tokenAcceptedOnOrigin("127.0.0.1", server.port!, "test-credential")).toBe("no");
      valid = true;
      expect(await tokenAcceptedOnOrigin("127.0.0.1", server.port!, "test-credential")).toBe("yes");
    } finally { server.stop(true); }
  });
  test("refuses redirects", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
      return new Response(null, { status: 302, headers: { location: "/other" } });
    } });
    try {
      expect(await tokenAcceptedOnOrigin("127.0.0.1", server.port!, "test-credential")).toBe("no");
    } finally { server.stop(true); }
  });
});

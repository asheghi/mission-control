# Stateless MCP for a Shared DeepSeek Harness Task Tracker

**Generated:** 2026-09-02 (UTC)  
**Requested source:** Codex-in-Chrome Research  
**Research workflow status:** **Unavailable.** The dedicated Chrome agent opened `https://Codex.ai`, but that URL redirected to `generaltranslation.com`; no Codex Research interface or Research toggle was available. Per the follow-up instruction, this report was completed directly from authoritative official Model Context Protocol specification and official TypeScript SDK sources.

## Executive conclusion

For a shared Agent Workboard exposing ordinary task CRUD, use **stateless Streamable HTTP** with durable task state in SQLite and caller identity/authorization derived independently on every HTTP request. “Stateless” should describe the **MCP protocol/server instance between requests**, not the database: the task rows, audit history, and idempotency records remain persistent application state.

There are now two materially different Streamable HTTP eras:

1. **Current MCP revision `2026-07-28`: natively per-request/stateless.** There is no `initialize` handshake, no protocol session, no `Mcp-Session-Id`, no GET notification endpoint, and no `Last-Event-ID` resumption. Every request carries protocol/client metadata; each JSON-RPC message is a POST and receives JSON or request-scoped SSE. This is the preferred target when DeepSeek Harness and the deployed SDK support the current revision. See the official [2026-07-28 transport overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [Streamable HTTP binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), and [lifecycle/versioning rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle).
2. **MCP `2025-03-26` through `2025-11-25`: initialization-based Streamable HTTP.** These revisions support either sessionful operation (server mints `Mcp-Session-Id`) or an SDK-specific stateless pattern (no session ID, fresh server/transport per request). This remains relevant for deployed clients. See [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and the official TypeScript SDK’s [v1 stateless example](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts).

For Workboard, JSON responses are enough for CRUD calls. Use SSE only for progress or subscriptions/change notifications. Do not select a sessionful transport merely because SQLite is stateful; transport sessions and durable application state are separate concerns.

## 1. Terminology: what “stateless MCP” can mean

The phrase is ambiguous and should be qualified:

- **Stateless protocol core / per-request MCP:** each request contains what the server needs to interpret it; no protocol session is established. This is the native model in `2026-07-28`.
- **Stateless Streamable HTTP server (2025-era compatibility):** the server still handles the legacy `initialize` exchange expected by a 2025 client, but does not mint `Mcp-Session-Id`; an SDK can create and close a server/transport for each HTTP request. The official v1 TypeScript example sets `sessionIdGenerator: undefined` and returns 405 for GET/DELETE.
- **Stateless application:** no business data survives requests. This is **not** appropriate for a task tracker.
- **Stateless compute with durable backing store:** MCP handlers are disposable, while tasks live in SQLite or another database. This is the recommended Workboard interpretation.
- **Connectionless:** inaccurate. HTTP requests and SSE streams are real connections; “stateless” concerns what must be retained *between* them.

A server can therefore be protocol-stateless and horizontally disposable while still providing persistent CRUD backed by a database.

## 2. Protocol revisions and transport history

| Revision / era | Relevant transport behavior |
|---|---|
| `2024-11-05` | Defined stdio and the old two-endpoint **HTTP+SSE** transport. The server opened an SSE stream and sent an `endpoint` event telling the client where to POST. Official historical source: [2024-11-05 transports](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports). |
| `2025-03-26` | Introduced **Streamable HTTP**, replacing HTTP+SSE; one MCP endpoint supported POST and GET, with optional protocol sessions. The [2025-03-26 changelog](https://modelcontextprotocol.io/specification/2025-03-26/changelog) explicitly records the replacement. |
| `2025-06-18` | Continued initialization-based Streamable HTTP; added/clarified protocol-version header behavior and related transport requirements. See [2025-06-18 transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). |
| `2025-11-25` | Last “legacy era” revision: `initialize`, optional `Mcp-Session-Id`, GET SSE, DELETE session termination, and optional `Last-Event-ID` resumption. See [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). |
| `2026-07-28` (current `latest` when researched) | New stateless protocol core. Removes protocol-level sessions and GET stream endpoint; messages are per-request POSTs with JSON or request-scoped SSE. See [current Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). |

The current specification calls revisions through `2025-11-25` **legacy** (session initialized) and `2026-07-28` **modern** (per-request metadata). The official TypeScript SDK’s [protocol versions guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md) documents dual-era negotiation and compatibility.

## 3. Transport comparison

| Property | stdio | Stateful Streamable HTTP (2025 era) | Stateless Streamable HTTP | Legacy HTTP+SSE |
|---|---|---|---|---|
| Topology | Client launches one subprocess | Independent HTTP service, potentially many clients | Independent HTTP service; per-request handler/instance | Independent HTTP service with separate SSE and POST flows |
| Framing | One UTF-8 JSON-RPC message per line | POST requests; GET can open server stream; DELETE can end session | Current: each message is POST; response is JSON or request-scoped SSE | Initial GET opens SSE; server sends an `endpoint` event; client POSTs elsewhere |
| Session | Process/connection naturally scopes interaction; legacy clients initialize | Server may mint `Mcp-Session-Id` during initialize | Current revision has no protocol session or session ID; 2025 SDK pattern omits session ID | Connection-oriented SSE arrangement, predating Streamable HTTP session model |
| Server push | Over stdout while process lives; modern protocol uses subscriptions/results | GET SSE and/or POST response SSE; server-initiated requests allowed in 2025 era | Request-related SSE; current long-lived changes use `subscriptions/listen`; no independent server JSON-RPC requests | Long-lived SSE channel |
| Resume | Process restart means reconnect/reinitialize | Optional event IDs + `Last-Event-ID` with event store | Current revision explicitly does **not** support `Last-Event-ID` resumability | Not the modern Streamable HTTP resumption model |
| Scaling | Usually one private process per client | Requires sticky routing or distributed session/event infrastructure | Easy stateless HTTP load balancing; shared business DB still required | Awkward legacy connection routing |
| Auth | Environment/OS/process boundary; MCP HTTP OAuth flow should not be applied | HTTP auth/OAuth | HTTP auth/OAuth | Legacy; avoid for new deployments |
| Best use | Local, single-user Harness integration | Features genuinely requiring legacy session/server push | Shared CRUD service | Compatibility only |

### stdio

The current official [stdio binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) requires newline-delimited JSON-RPC on stdin/stdout, permits logs only on stderr, and makes the client responsible for spawning and terminating the server. It is operationally simple and has a strong local trust boundary, but it is not itself a shared network service. Separate Harness processes normally get separate server processes; sharing requires moving persistence to a common database or proxy.

### Stateful Streamable HTTP (2025-era)

In `2025-11-25`, the server may generate a globally unique, cryptographically secure session ID during initialization and return it in `Mcp-Session-Id`. A client receiving it must send it on all subsequent requests. Missing required IDs should produce HTTP 400; an expired/unknown ID produces 404, after which the client must initialize a new session; clients should DELETE sessions they no longer need. These are normative rules in [2025-11-25 Session Management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management).

This mode is justified when the server must retain negotiated client capabilities, pending server-to-client requests, subscriptions, or replay state tied to one client. It creates deployment obligations: route all requests for a session to its owner, or externalize the relevant session and event state.

### Stateless Streamable HTTP

**Modern (`2026-07-28`):** the single endpoint accepts POST. Every request carries protocol metadata; the server replies with `application/json` or `text/event-stream`. GET/DELETE and protocol sessions are removed. `Mcp-Session-Id` and `Last-Event-ID` are ignored for modern requests. The normative details are in [current Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

**Legacy-compatible (2025-era SDK pattern):** the v1 TypeScript SDK’s official example creates a fresh `McpServer` and `StreamableHTTPServerTransport` per POST with `sessionIdGenerator: undefined`, then closes both when the request ends; GET and DELETE return 405. See [`simpleStatelessStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts). This is an SDK deployment pattern, not a separate named transport in the normative 2025 specification.

### Obsolete HTTP+SSE

HTTP+SSE from `2024-11-05` is deprecated and replaced. New servers should not use it. Retain it only if an actual client cannot speak Streamable HTTP. The spec gives compatibility probing/fallback rules, and the TypeScript SDK retains legacy transports/examples for backward compatibility; see the [v1 SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md).

## 4. Initialization, discovery, and sessions

### 2025-era behavior

The client begins with `initialize`, sending its supported protocol version, capabilities, and identity. The server answers with the negotiated version, server capabilities, and server identity; the client then sends `notifications/initialized`. Except for ping/logging exceptions noted by the spec, normal operations wait for completion. Subsequent HTTP requests include the negotiated `MCP-Protocol-Version`. See [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

A session ID is optional for the server to assign, but once assigned it is not optional for the client to echo. It should be treated as a bearer-like routing secret: high entropy, securely handled, not logged, and not used as authorization by itself.

### Current `2026-07-28` behavior

There is no connection-scoped `initialize`. Protocol version, client identity/capabilities, and related metadata are carried per request. `server/discover` can advertise supported versions/capabilities, but clients may also attempt a preferred version and retry after `UnsupportedProtocolVersionError`. See [current lifecycle/versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle).

Dual-era implementations can probe modern support and fall back to initialize-based behavior. This matters for DeepSeek Harness: choose the wire era the Harness client actually supports, not merely the newest server package.

## 5. JSON, SSE, resumability, and notifications

- A simple CRUD tool call should normally return one JSON-RPC response in `application/json`.
- SSE is a response representation, not a separate modern transport: use it for progress/log messages before a final result or for a long-lived `subscriptions/listen` response.
- In current `2026-07-28`, each SSE response is scoped to its originating request; closing it signals cancellation. Independent server requests are replaced by result-based multi-round-trip interaction. `Last-Event-ID` resumption is explicitly unsupported. See [Receiving Messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#receiving-messages).
- In 2025-era stateful Streamable HTTP, servers may assign SSE event IDs. Clients reconnect with GET plus `Last-Event-ID`; the server may replay later events. Event IDs must identify the correct stream and not leak across unrelated streams. See [2025 resumability/redelivery](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#resumability-and-redelivery).
- The TypeScript SDK’s official [sessions/state/scaling guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md) explains that legacy sessionful resumption needs an `EventStore`; its in-memory reference implementation is single-process only. Cross-node delivery needs shared storage/pub-sub.

For Workboard CRUD, avoid transport-level replay complexity. Make write tools idempotent where retries are possible (for example, accept an operation/request ID and enforce a UNIQUE constraint in SQLite). If real-time task updates are later added, use current subscriptions with a shared event bus, or application-level cursor/change-sequence replay rather than assuming SSE transport resumption.

## 6. Official TypeScript SDK support

### Current v2 line

The official [`modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk) documents v2 as the stable line for the `2026-07-28` specification. It splits packages such as:

- `@modelcontextprotocol/server`
- `@modelcontextprotocol/client`
- `@modelcontextprotocol/node` for Node HTTP adapters
- framework middleware packages for Express, Fastify, and Hono

The v2 `createMcpHandler(factory)` builds a fresh server for each HTTP request and is stateless by default. It exposes a web-standard `fetch` handler suitable for Bun, Deno, and Workers; Node adapters wrap it. `responseMode: 'json'` forces terminal JSON and drops mid-call notifications; `'sse'` forces streaming. See the official [Serve over HTTP](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md), [web-standard runtimes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md), and [sessions/state/scaling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md) guides.

The repository explicitly states that v2 runs on **Node.js, Bun, and Deno**, and shows `bun add @modelcontextprotocol/server`. This is stronger evidence for Bun than the older Node/Express-only examples, but Workboard should still run integration tests under its exact Bun version—especially streaming cancellation, header behavior, and SQLite concurrency.

### v1 line / 2025-era clients

The v1 branch supports:

- `StdioServerTransport`
- `StreamableHTTPServerTransport`
- deprecated `SSEServerTransport` for compatibility

For stateless 2025-era HTTP:

```ts
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined
});
```

Create the server/transport for each POST and close it at request completion. For sessionful operation, use a cryptographic ID generator and retain a transport map keyed by session ID. `enableJsonResponse: true` is a response-shaping option and is independent of whether sessions are enabled; the official [`jsonResponseStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/jsonResponseStreamableHttp.ts) is sessionful despite returning JSON.

**Important distinction:** `enableJsonResponse: true` does not mean stateless, and SSE does not necessarily mean stateful.

## 7. Authentication and security

For remote/shared HTTP deployments:

1. **Validate `Origin`.** Streamable HTTP servers must validate present Origin headers and return 403 for invalid values. For local service, bind to `127.0.0.1`, not `0.0.0.0`. These are normative transport requirements in [Security & Endpoint](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security--endpoint).
2. **Validate Host as defense in depth.** SDK handlers do not inherently trust-check Host/Origin/token in every runtime. The official TypeScript SDK provides framework or helper guards; its [HTTP guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md#validate-host-and-origin-in-front-of-it) explains their placement. Host checks are especially useful against DNS rebinding on localhost.
3. **Authenticate every HTTP request.** Do not bind identity to `Mcp-Session-Id`; it is a session/routing identifier, not authorization. Modern stateless handlers must reconstruct caller context from a verified token on every request.
4. **Follow MCP OAuth for general-purpose remote interoperability.** The current [authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) treats the MCP server as an OAuth 2.1 resource server. It requires Protected Resource Metadata, bearer tokens in the Authorization header (never query strings), audience validation, PKCE for authorization-code clients, resource indicators, TLS for authorization endpoints, and suitable 401/403 challenges.
5. **Never pass through tokens to downstream APIs.** Validate that tokens are intended for this MCP resource and obtain separate downstream credentials. The official [security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) describe token passthrough/confused-deputy, SSRF, session hijacking, and local server risks.
6. **Authorize tools and objects, not just connections.** Enforce per-caller permissions inside `tasks.create`, `tasks.update`, `tasks.delete`, etc. Use least-privilege scopes such as `tasks:read` and `tasks:write`; record actor identity in audit rows.
7. **Treat tool inputs as hostile.** Validate schemas, use parameterized SQLite queries, constrain list pagination/sort fields, cap body sizes, rate-limit mutations, and avoid returning filesystem/SQL errors.

For a private Harness-only deployment, a reverse proxy or service-mesh identity can verify a short-lived audience-bound bearer token before the MCP handler. If DeepSeek Harness lacks the full interactive OAuth flow, pre-provisioned credentials can be an operational bridge, but they should still be TLS-protected, scoped, rotated, and validated per request.

## 8. Horizontal scaling and SQLite

Stateless MCP removes **protocol affinity**, not database coordination.

### Stateless compute

With current v2 `createMcpHandler`, any HTTP request can go to any replica. No sticky sessions are required. Shared notifications still need a cross-node bus; the default in-process bus cannot fan out events emitted on another node. The official SDK [scaling guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md) calls this out explicitly.

### Legacy sessionful compute

For 2025-era sessions, choose one:

- sticky load balancing so a session always reaches its in-memory transport owner;
- a shared session/event store plus routing; or
- pub/sub forwarding to the owning node.

An event store can replay dropped SSE messages, but it does not automatically serialize arbitrary live transport objects across nodes.

### SQLite implications

SQLite is excellent for a single Workboard service process or a small deployment with one writer and WAL mode. It gives transactions, constraints, indexes, and low operational cost. However:

- Do not mount one SQLite file on a generic network filesystem and assume safe horizontally scaled multi-writer semantics.
- Multiple local processes can contend on one local file; WAL improves read/write concurrency but still has one writer at a time.
- Multiple application replicas on separate hosts need a database accessible to all. Use a client/server database (often PostgreSQL) for straightforward horizontal writes, or a deliberately designed SQLite replication/single-writer system.
- If SQLite remains the requirement, scale reads/HTTP carefully but keep one authoritative writer/service, or route all CRUD through one Workboard process. Backups/replication do not by themselves provide multi-writer coordination.

Use SQLite transactions and constraints for correctness: foreign keys, optimistic version columns, uniqueness, tombstones or audit history, and idempotency keys for retried create/update operations.

## 9. Recommended Workboard architecture

### Preferred current design

```text
DeepSeek Harness MCP clients
        |
        | HTTPS + per-request bearer token
        v
Reverse proxy / auth + Origin/Host validation
        |
        v
Stateless Streamable HTTP endpoint (/mcp)
TypeScript SDK v2 createMcpHandler(factory)
        |
        +-- task CRUD service (transactions, authorization, audit)
        |
        +-- SQLite (single deployment / one writer)
        |
        `-- optional shared pub/sub for task-change subscriptions
```

Recommended tools:

- `tasks.create`
- `tasks.get`
- `tasks.list` (cursor pagination and filters)
- `tasks.update` (optimistic `expectedVersion`)
- `tasks.delete` or `tasks.archive`
- optionally `tasks.claim`, `tasks.release`, and `tasks.complete` as atomic domain operations

Keep tool registration cheap and side-effect-free; create the DB pool/connection service at module scope, but derive caller authorization context per request. Use JSON response mode for CRUD. Add SSE/subscriptions only when Harness has a demonstrated need for live updates.

### Compatibility design if Harness only supports 2025-era MCP

Use the official v1 `StreamableHTTPServerTransport` stateless pattern (`sessionIdGenerator: undefined`) and a fresh server/transport per POST. Do not implement GET/DELETE unless opting into sessions. If a specific Harness integration requires server notifications or capability state tied to initialize, use stateful sessions deliberately and document sticky-routing/event-store requirements.

### Local-only alternative

For a single Harness instance, stdio plus the same SQLite database is simplest and minimizes network auth. It is not a shared server by itself. A practical migration path is to keep business logic transport-neutral, support stdio first, and mount the same tool registrations under stateless Streamable HTTP for shared deployments.

## 10. Decision checklist

- Confirm which MCP revisions/transports DeepSeek Harness currently supports.
- Prefer `2026-07-28` stateless Streamable HTTP when both ends support it.
- Otherwise use the v1 2025-era stateless Streamable HTTP example; avoid legacy HTTP+SSE.
- Keep task state in SQLite; never store durable task state in an MCP session object.
- Use sessionful mode only for a concrete feature that cannot be expressed per request/subscription.
- Authenticate and authorize every HTTP request; never treat session IDs as auth.
- Validate Origin and Host; bind localhost only for local mode; use TLS remotely.
- Make mutations transactional and idempotent under retries.
- For one SQLite writer, keep a single authoritative Workboard service. Move to a shared database or intentional SQLite replication architecture before adding independent writer replicas.
- Test Bun’s HTTP/SSE cancellation and SQLite behavior under the exact deployed versions.

## Primary sources

1. Model Context Protocol, [2026-07-28 transport overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).
2. Model Context Protocol, [2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
3. Model Context Protocol, [2026-07-28 stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio).
4. Model Context Protocol, [2026-07-28 lifecycle/version negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle).
5. Model Context Protocol, [2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
6. Model Context Protocol, [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
7. Model Context Protocol, [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).
8. Model Context Protocol, [2024-11-05 transports / HTTP+SSE](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports).
9. Official TypeScript SDK, [repository and v2 status/runtime support](https://github.com/modelcontextprotocol/typescript-sdk).
10. Official TypeScript SDK, [Serve over HTTP](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md).
11. Official TypeScript SDK, [Sessions, state, and scaling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md).
12. Official TypeScript SDK, [Protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md).
13. Official TypeScript SDK v1, [stateless Streamable HTTP example](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts).
14. Official TypeScript SDK v1, [server guide and legacy examples](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md).

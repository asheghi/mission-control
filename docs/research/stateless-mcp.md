# Stateless MCP Research Index

The complete, current research report is:

- [`2026-09-02-stateless-mcp-shared-task-tracker.md`](./2026-09-02-stateless-mcp-shared-task-tracker.md)

## Implementation takeaway

MCP has two relevant protocol eras:

- **Modern MCP 2026-07-28:** natively per-request/stateless, without `initialize` or `Mcp-Session-Id`.
- **2025-era compatibility:** initialization-based Streamable HTTP can still be deployed statelessly with a fresh server/transport per POST and no session ID; the official v1 TypeScript SDK uses `sessionIdGenerator: undefined`.

The currently inspected DSH installation uses `@modelcontextprotocol/sdk` `^1.12.0` through `@deepseek-ai/dsh-mcp-client`, so Agent Workboard must first prove compatibility with that real DSH client and use the 2025-era stateless pattern if necessary. Modern protocol support can be enabled only after an end-to-end compatibility test confirms both sides support it.

For either era, Workboard keeps durable task state in SQLite, authenticates every HTTP request, uses JSON responses for CRUD, and does not implement legacy HTTP+SSE or transport sessions without a demonstrated requirement.

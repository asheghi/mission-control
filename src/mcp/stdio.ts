// stdio MCP server (Task 10): the same six tools as HTTP, served over the
// official StdioServerTransport for local agents and smoke tests. Local mode
// trusts the process owner: the actor comes from the --as participant name,
// never from tool arguments.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Actor } from "../domain/types";
import type { WorkboardService } from "../app/workboard";
import { buildMcpServer } from "./tools";

export async function runStdioMcpServer(service: WorkboardService, actor: Actor): Promise<void> {
  const server = buildMcpServer(service, actor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Serve until stdin closes (the SDK ends the transport, firing onclose).
  await new Promise<void>((resolve) => {
    const previous = transport.onclose;
    transport.onclose = () => {
      if (typeof previous === "function") previous.call(transport);
      resolve();
    };
  });
}

export { resolveLocalActor as resolveStdioActor } from "../app/local-actor";

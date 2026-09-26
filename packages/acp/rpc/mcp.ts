import type { AgentApp } from "@agentclientprotocol/sdk";

import { McpMessageSchema, type AcpMcpBridge } from "../mcp-acp.ts";
import type { ConnectionGate } from "./connection.ts";

/** Registers mcp/message as a request and as a notification. */
export function registerMcpBridge(
  app: AgentApp,
  deps: Readonly<{
    gate: Pick<ConnectionGate, "requireInitialized">;
    bridge: Pick<AcpMcpBridge, "request" | "notify">;
  }>,
): readonly string[] {
  const { gate, bridge } = deps;
  app
    .onRequest("mcp/message", McpMessageSchema, ({ params, signal }) => {
      gate.requireInitialized();
      return bridge.request(params, signal);
    })
    .onNotification("mcp/message", McpMessageSchema, ({ params }) => bridge.notify(params));
  return ["mcp/message"];
}

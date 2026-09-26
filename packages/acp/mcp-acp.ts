import { RequestError, type AgentContext, type MessageMcpRequest } from "@agentclientprotocol/sdk";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { diagnostic, diagnosticError } from "../core/logging/index.ts";
import { waitForBoundary } from "./session-config.ts";

export const McpMessageSchema = z.object({
  connectionId: z.string().min(1).max(4096),
  method: z.string().min(1).max(4096),
  params: z.record(z.string(), z.unknown()).nullish(),
});
const ConnectResultSchema = z.object({ connectionId: z.string().min(1).max(4096) });

/** Routes ACP-transported MCP traffic between the client and each session's MCP transports. */
export type AcpMcpBridge = Readonly<{
  request(params: MessageMcpRequest, signal: AbortSignal): Promise<unknown>;
  notify(params: MessageMcpRequest): void;
  transport(serverId: string, client: AgentContext): Transport;
}>;

/** Connection IDs belong to one ACP connection; MCP request IDs remain transport-local. */
export function acpMcpBridge(connectionSignal: () => AbortSignal): AcpMcpBridge {
  type Endpoint = {
    request: (params: MessageMcpRequest, signal: AbortSignal) => Promise<unknown>;
    notify: (params: MessageMcpRequest) => void;
  };
  const endpoints = new Map<string, Endpoint>();
  return {
    request(params: MessageMcpRequest, signal: AbortSignal) {
      const endpoint = endpoints.get(params.connectionId);
      if (!endpoint) throw RequestError.invalidParams(undefined, "Unknown MCP connection");
      return endpoint.request(params, signal);
    },
    notify(params: MessageMcpRequest) {
      endpoints.get(params.connectionId)?.notify(params);
    },
    transport(serverId: string, client: AgentContext): Transport {
      const lifetime = new AbortController();
      const outgoing = new Map<RequestId, AbortController>();
      const incoming = new Map<
        RequestId,
        { resolve: (value: unknown) => void; reject: (error: unknown) => void }
      >();
      let connectionId: string | undefined;
      let closed = false;
      let started = false;
      let closing: Promise<void> | undefined;
      const disconnect = async (id: string) => {
        if (connectionSignal().aborted) return;
        const signal = AbortSignal.any([connectionSignal(), AbortSignal.timeout(2000)]);
        try {
          await waitForBoundary(
            client.request("mcp/disconnect", { connectionId: id }, { cancellationSignal: signal }),
            signal,
          );
        } catch (error) {
          diagnostic("acp", "warning", "mcp.proxy.disconnect.failed", {
            serverId,
            connectionId: id,
            error: diagnosticError(error),
          });
          /* Local release must not wait indefinitely for the host. */
        }
      };
      const endpoint: Endpoint = {
        async request(params, signal) {
          const cancellation = AbortSignal.any([
            signal,
            lifetime.signal,
            connectionSignal(),
            AbortSignal.timeout(60000),
          ]);
          cancellation.throwIfAborted();
          const id = `acp/${crypto.randomUUID()}`;
          const result = new Promise<unknown>((resolve, reject) =>
            incoming.set(id, { resolve, reject }),
          );
          const abort = () =>
            transport.onmessage?.({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id },
            });
          cancellation.addEventListener("abort", abort, { once: true });
          try {
            transport.onmessage?.({
              jsonrpc: "2.0",
              id,
              method: params.method,
              ...(params.params != null ? { params: params.params } : {}),
            });
            return await waitForBoundary(result, cancellation);
          } finally {
            cancellation.removeEventListener("abort", abort);
            incoming.delete(id);
          }
        },
        notify(params) {
          if (!closed)
            transport.onmessage?.({
              jsonrpc: "2.0",
              method: params.method,
              ...(params.params != null ? { params: params.params } : {}),
            });
        },
      };
      const transport: Transport = {
        async start() {
          if (started || closed) throw new Error("MCP transport already started or closed");
          started = true;
          // Keep observing connect after local cancellation so a late resource ID can be released.
          const pending = client.request("mcp/connect", { serverId }).then(async (raw) => {
            const result = ConnectResultSchema.parse(raw);
            if (endpoints.has(result.connectionId))
              throw new Error("Host reused an active MCP connection ID");
            if (closed) {
              await disconnect(result.connectionId);
              throw new Error("MCP transport closed while connecting");
            }
            connectionId = result.connectionId;
            diagnostic("acp", "debug", "mcp.proxy.connected", { serverId, connectionId });
            endpoints.set(connectionId, endpoint);
          });
          await waitForBoundary(pending, AbortSignal.any([lifetime.signal, connectionSignal()]));
        },
        async send(message: JSONRPCMessage) {
          if (closed || !connectionId) throw new Error("MCP transport is not connected");
          if (!("method" in message)) {
            const pending = message.id === undefined ? undefined : incoming.get(message.id);
            if ("error" in message)
              pending?.reject(
                new RequestError(message.error.code, message.error.message, message.error.data),
              );
            else pending?.resolve(message.result);
            return;
          }
          if (!("id" in message)) {
            if (message.method === "notifications/cancelled") {
              const id = message.params?.requestId;
              if (typeof id === "string" || typeof id === "number") outgoing.get(id)?.abort();
              return;
            }
            await client.notify("mcp/message", {
              connectionId,
              method: message.method,
              ...(message.params ? { params: message.params } : {}),
            });
            return;
          }
          const started = performance.now();
          const fields = {
            serverId,
            connectionId,
            requestId: String(message.id),
            method: message.method,
          };
          diagnostic("acp", "debug", "mcp.proxy.request.started", fields);
          const controller = new AbortController();
          outgoing.set(message.id, controller);
          const signal = AbortSignal.any([controller.signal, lifetime.signal, connectionSignal()]);
          // send acknowledges dispatch, not the response, as required by the MCP SDK transport.
          void client
            .request(
              "mcp/message",
              {
                connectionId,
                method: message.method,
                ...(message.params ? { params: message.params } : {}),
              },
              { cancellationSignal: signal },
            )
            .then(
              (result) => {
                diagnostic("acp", "debug", "mcp.proxy.request.completed", {
                  ...fields,
                  durationMs: performance.now() - started,
                  discarded: closed || signal.aborted,
                });
                if (!closed && !signal.aborted)
                  transport.onmessage?.({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: result as Record<string, unknown>,
                  });
              },
              (error: unknown) => {
                diagnostic(
                  "acp",
                  signal.aborted ? "info" : "warning",
                  signal.aborted ? "mcp.proxy.request.cancelled" : "mcp.proxy.request.failed",
                  {
                    ...fields,
                    durationMs: performance.now() - started,
                    error: diagnosticError(error),
                  },
                );
                if (!closed && !signal.aborted)
                  transport.onmessage?.({
                    jsonrpc: "2.0",
                    id: message.id,
                    error:
                      error instanceof RequestError
                        ? {
                            code: error.code,
                            message: error.message,
                            ...(error.data !== undefined ? { data: error.data } : {}),
                          }
                        : { code: -32603, message: "ACP MCP request failed" },
                  });
              },
            )
            .finally(() => outgoing.delete(message.id));
        },
        close() {
          if (closing) return closing;
          closed = true;
          diagnostic("acp", "debug", "mcp.proxy.closed", {
            serverId,
            connectionId,
            outgoingCount: outgoing.size,
            incomingCount: incoming.size,
          });
          if (connectionId && endpoints.get(connectionId) === endpoint)
            endpoints.delete(connectionId);
          lifetime.abort();
          for (const pending of incoming.values())
            pending.reject(new Error("MCP transport closed"));
          incoming.clear();
          outgoing.clear();
          transport.onclose?.();
          closing = connectionId ? disconnect(connectionId) : Promise.resolve();
          return closing;
        },
      };
      return transport;
    },
  };
}

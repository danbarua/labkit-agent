import type { McpServer } from "@agentclientprotocol/sdk";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

function remoteSettings(server: Extract<McpServer, { type: "http" | "sse" }>) {
  const url = new URL(server.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("MCP URL must use HTTP(S), with credentials supplied as headers");
  const headers = new Headers();
  for (const header of server.headers) {
    if (headers.has(header.name)) throw new Error("MCP header names must be unique");
    headers.set(header.name, header.value);
  }
  return { url, headers };
}
export function validateMcpTransport(server: McpServer) {
  if ("type" in server) {
    if (server.type === "acp") throw new Error("ACP-proxied MCP servers are not supported");
    remoteSettings(server);
  } else if (new Set(server.env.map((entry) => entry.name)).size !== server.env.length)
    throw new Error("MCP environment names must be unique");
}
export function mcpTransport(
  server: McpServer,
  cwd: string,
): { transport: Transport; dispose?: () => Promise<void> } {
  if (!("type" in server))
    return {
      transport: new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
        cwd,
        stderr: "inherit",
        maxBufferSize: 1024 * 1024,
      }),
    };
  if (server.type === "acp") throw new Error("ACP-proxied MCP servers are not supported");
  const { url, headers } = remoteSettings(server);
  const lifetime = new AbortController();
  const fetchRemote: FetchLike = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== url.origin)
      throw new Error("MCP endpoints must stay on the configured origin");
    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
    new Headers(init?.headers).forEach((value, key) => {
      requestHeaders.set(key, value);
    });
    const signals = [lifetime.signal];
    if (init?.signal) signals.push(init.signal);
    if (input instanceof Request) signals.push(input.signal);
    if (init?.method === "DELETE") signals.push(AbortSignal.timeout(2000));
    return fetch(input, {
      ...init,
      headers: requestHeaders,
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
  };
  const transport =
    server.type === "http"
      ? new StreamableHTTPClientTransport(url, {
          fetch: fetchRemote,
          requestInit: { headers },
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        })
      : new SSEClientTransport(url, { fetch: fetchRemote, requestInit: { headers } });
  let closing: Promise<void> | undefined;
  return {
    transport,
    dispose: () => {
      closing ??= (async () => {
        try {
          if (transport instanceof StreamableHTTPClientTransport)
            await transport.terminateSession();
        } catch {
          /* Remote termination is best-effort; local resources still close. */
        } finally {
          lifetime.abort();
          await transport.close();
        }
      })();
      return closing;
    },
  };
}

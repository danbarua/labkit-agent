import { createHash, timingSafeEqual } from "node:crypto";

import type { Stream } from "@agentclientprotocol/sdk";
import { AcpServer, type AgentFactory } from "@agentclientprotocol/sdk/experimental/server";

import { diagnostic, diagnosticError } from "../core/logging/index.ts";
import { connectAcp, type AcpOptions } from "./adapter.ts";
import { sessionLease } from "./rpc/lease.ts";

/** The only interface the host binds: the endpoint runs commands and writes files. */
const host = "127.0.0.1";
const path = "/acp";
const minimumTokenLength = 32;
/** Above the SDK's 15 s SSE keepalive, so idle event streams stay open. */
const idleTimeoutSeconds = 60;
const connectionHeader = "Acp-Connection-Id";

export type AcpHttpHandler = Readonly<{
  /** Answers one request to the ACP endpoint. */
  fetch(request: Request): Promise<Response>;
  /** Closes every ACP connection; resolves after their sessions have shut down. */
  close(): Promise<void>;
}>;

export type AcpHttpServer = Readonly<{
  /** `http://127.0.0.1:<port>/acp` */
  url: string;
  port: number;
  /** Stops listening after every ACP connection and its sessions have closed. */
  close(): Promise<void>;
}>;

/** Equal-length digests let `timingSafeEqual` compare tokens of any length in constant time. */
const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Streamable HTTP ACP endpoint at `/acp` for embedding and tests. Every request needs
 * `Authorization: Bearer <token>`. Each ACP connection is one `connectAcp`; all share one
 * process-wide session lease, so at most one runtime per session is live (the newest claim wins).
 */
export function acpHttpHandler(
  options: AcpOptions,
  { token }: Readonly<{ token: string }>,
): AcpHttpHandler {
  if (options.loadSession !== true)
    throw new Error(
      "ACP over HTTP requires loadSession: true: a client that reconnects opens a new ACP connection and continues its session with session/load. Set loadSession: true with a sessionOptions factory that restores saved sessions.",
    );
  if (typeof token !== "string" || token.length < minimumTokenLength)
    throw new Error(
      `ACP over HTTP requires a bearer token of at least ${minimumTokenLength} characters; set LABKIT_ACP_HTTP_TOKEN, for example to the output of \`openssl rand -hex 32\``,
    );
  const expected = digest(token);
  const sessions = sessionLease();
  /** Each connection's `closed` resolves after its sessions shut down. */
  const live = new Set<Promise<void>>();
  const adapterIds = new Map<string, string>();
  let stopping: Promise<void> | undefined;

  const agent =
    (opened: (connectionId: string, closed: Promise<void>) => void): AgentFactory =>
    () => ({
      connect(stream, connect) {
        // AcpServer refuses batch frames until ACP v2 is negotiated (connection.js writeInbound);
        // this agent speaks v1, so the wire stream carries single messages only.
        const acp = connectAcp(stream as Stream, options, { connect, sessions });
        live.add(acp.closed);
        void acp.closed.finally(() => live.delete(acp.closed));
        opened(acp.connectionId, acp.closed);
        return {
          closed: acp.closed,
          startConnectHandlers: () => acp.connection.startConnectHandlers?.(),
        };
      },
    });

  const server = new AcpServer({ createAgent: agent(() => {}) });

  function authorize(header: string | null) {
    const bearer = header ? /^Bearer +(\S+) *$/i.exec(header)?.[1] : undefined;
    if (!bearer) return "missing_token";
    return timingSafeEqual(digest(bearer), expected) ? undefined : "bad_token";
  }

  return {
    async fetch(request) {
      const started = performance.now();
      const requested = request.headers.get(connectionHeader) ?? undefined;
      const trace = {
        method: request.method,
        path: new URL(request.url).pathname,
        httpConnectionId: requested,
      };
      let response: Response;
      if (trace.path !== path) response = new Response("Not Found", { status: 404 });
      else {
        const rejected = authorize(request.headers.get("Authorization"));
        if (rejected) {
          diagnostic("acp", "warning", "acp.http.rejected", {
            ...trace,
            reason: rejected,
            // Worded so that log redaction of "Bearer <credential>" text leaves it readable.
            consequence:
              rejected === "missing_token"
                ? "Answered 401: the request carried no token (no Authorization header of scheme Bearer); the client or the proxy in front of it must send LABKIT_ACP_HTTP_TOKEN"
                : "Answered 401: the token in the Authorization header does not match this host's LABKIT_ACP_HTTP_TOKEN",
          });
          return new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          });
        }
        if (stopping) response = new Response("ACP HTTP host is stopping", { status: 503 });
        else {
          let adapter: Readonly<{ connectionId: string; closed: Promise<void> }> | undefined;
          try {
            response = await server.handleRequest(request, {
              createAgent: agent((connectionId, closed) => {
                adapter = { connectionId, closed };
              }),
            });
          } catch (error) {
            diagnostic("acp", "error", "acp.http.request.failed", {
              ...trace,
              durationMs: performance.now() - started,
              error: diagnosticError(error),
            });
            return new Response("Internal Server Error", { status: 500 });
          }
          const httpConnectionId = response.headers.get(connectionHeader);
          if (adapter && httpConnectionId && response.ok) {
            const { connectionId, closed } = adapter;
            adapterIds.set(httpConnectionId, connectionId);
            void closed.then(() => adapterIds.delete(httpConnectionId));
            diagnostic("acp", "info", "acp.http.connection.opened", {
              connectionId,
              httpConnectionId,
            });
          }
          if (request.method === "DELETE" && requested && response.status === 202)
            diagnostic("acp", "info", "acp.http.connection.closed", {
              httpConnectionId: requested,
              connectionId: adapterIds.get(requested),
            });
        }
      }
      const failed = response.status >= 400;
      diagnostic("acp", response.status >= 500 ? "error" : "debug", "acp.http.request", {
        ...trace,
        httpConnectionId: requested ?? response.headers.get(connectionHeader) ?? undefined,
        status: response.status,
        durationMs: performance.now() - started,
        // The SDK explains refusals in a short text body, e.g. "Invalid JSON".
        ...(failed ? { reason: (await response.clone().text()).slice(0, 500) } : {}),
      });
      return response;
    },
    close() {
      stopping ??= (async () => {
        await server.close();
        await Promise.allSettled([...live]);
      })();
      return stopping;
    },
  };
}

/** Serves `acpHttpHandler` on 127.0.0.1 only; `port: 0` picks a free port. */
export function serveAcpHttp(
  options: AcpOptions,
  { port, token }: Readonly<{ port: number; token: string }>,
): AcpHttpServer {
  const handler = acpHttpHandler(options, { token });
  const server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: idleTimeoutSeconds,
    fetch: (request) => handler.fetch(request),
  });
  const bound = server.port ?? port;
  const url = `http://${host}:${bound}${path}`;
  diagnostic("acp", "info", "acp.http.listening", { host, port: bound, url });
  let stopping: Promise<void> | undefined;
  return {
    url,
    port: bound,
    close() {
      stopping ??= (async () => {
        try {
          await handler.close();
        } finally {
          await server.stop(true);
          diagnostic("acp", "info", "acp.http.stopped", { host, port: bound });
        }
      })();
      return stopping;
    },
  };
}

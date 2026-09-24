import { isAbsolute } from "node:path";

import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";
import type { ToolRunContext } from "@labkit-agent/core/host";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

import { waitForBoundary } from "./session-config.ts";
import { MAX_FILE_BYTES } from "./workspace-files.ts";

/** Session-bound client ports. Missing methods were not advertised by the client. */
export type ClientFiles = Readonly<{
  readText?: (path: string, signal: AbortSignal, context?: ToolRunContext) => Promise<string>;
  write?: (
    path: string,
    text: string,
    signal: AbortSignal,
    context?: ToolRunContext,
  ) => Promise<{ path: string; bytes: number }>;
}>;

export function clientFiles(
  client: AgentContext,
  capabilities: ClientCapabilities,
  session: () => string,
  connectionSignal: AbortSignal,
): ClientFiles {
  const check = (path: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    connectionSignal.throwIfAborted();
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("Client file path must be absolute");
    return AbortSignal.any([signal, connectionSignal, AbortSignal.timeout(60000)]);
  };
  const observed = async <T>(
    operation: string,
    path: string,
    signal: AbortSignal,
    run: () => Promise<T>,
    context?: ToolRunContext,
  ): Promise<T> => {
    const started = performance.now();
    const fields = {
      sessionId: session(),
      toolCallId: context?.toolCallId,
      operationId: crypto.randomUUID(),
      operation,
      path,
      timeoutMs: 60000,
    };
    diagnostic("acp", "debug", "client_file.requested", fields);
    try {
      const result = await run();
      diagnostic("acp", "debug", "client_file.completed", {
        ...fields,
        durationMs: performance.now() - started,
        bytes:
          typeof result === "string"
            ? Buffer.byteLength(result)
            : (result as { bytes?: number }).bytes,
      });
      return result;
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const cancelled = !timedOut && (signal.aborted || connectionSignal.aborted);
      diagnostic(
        "acp",
        cancelled ? "info" : "warning",
        cancelled ? "client_file.cancelled" : "client_file.failed",
        {
          ...fields,
          durationMs: performance.now() - started,
          outcome: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
          error: diagnosticError(error),
        },
      );
      if (cancelled || timedOut) throw error;
      const details = diagnosticError(error);
      throw new Error(
        `${operation} failed for ${path}: ${details.message ?? "Unknown client error"}${details.data === undefined ? "" : `; ${JSON.stringify(details.data)}`}`,
        {
          cause: error,
        },
      );
    }
  };
  return {
    ...(capabilities.fs?.readTextFile === true
      ? {
          readText: async (path: string, signal: AbortSignal, context?: ToolRunContext) =>
            observed(
              "fs/read_text_file",
              path,
              signal,
              async () => {
                const cancellationSignal = check(path, signal);
                const response = await waitForBoundary(
                  client.request(
                    "fs/read_text_file",
                    {
                      sessionId: session(),
                      path,
                    },
                    { cancellationSignal },
                  ),
                  cancellationSignal,
                );
                if (Buffer.byteLength(response.content) > MAX_FILE_BYTES)
                  throw new Error("Client file exceeds 256 KiB; narrow the requested file");
                return response.content;
              },
              context,
            ),
        }
      : {}),
    ...(capabilities.fs?.writeTextFile === true
      ? {
          write: async (
            path: string,
            text: string,
            signal: AbortSignal,
            context?: ToolRunContext,
          ) =>
            observed(
              "fs/write_text_file",
              path,
              signal,
              async () => {
                const cancellationSignal = check(path, signal);
                const bytes = Buffer.byteLength(text);
                if (bytes > MAX_FILE_BYTES)
                  throw new Error("Write exceeds 256 KiB; narrow the write");
                await waitForBoundary(
                  client.request(
                    "fs/write_text_file",
                    {
                      sessionId: session(),
                      path,
                      content: text,
                    },
                    { cancellationSignal },
                  ),
                  cancellationSignal,
                );
                return { path, bytes };
              },
              context,
            ),
        }
      : {}),
  };
}

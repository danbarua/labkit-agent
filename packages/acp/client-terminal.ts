import type { AgentContext, TerminalOutputRequest } from "@agentclientprotocol/sdk";
import { defineTool } from "@labkit-agent/core";
import type { ToolRunContext } from "@labkit-agent/core/host";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import { z } from "zod";

import { waitForBoundary } from "./session-config.ts";
import { MAX_FILE_BYTES } from "./workspace-files.ts";

export type ClientTerminal = Readonly<{
  run: (
    command: string,
    args: string[],
    signal: AbortSignal,
    context?: ToolRunContext,
  ) => Promise<{
    output: string;
    truncated: boolean;
    exitCode: number | null;
    signal: string | null;
  }>;
}>;

/** One terminal per tool operation; the client owns processes and the agent owns release requests. */
export function clientTerminal(
  client: AgentContext,
  session: () => string,
  cwd: string,
  connectionSignal: AbortSignal,
  onTerminal?: (toolCallId: string, terminalId: string) => void | Promise<void>,
): ClientTerminal {
  return {
    async run(command, args, signal, context) {
      const cancellation = AbortSignal.any([signal, connectionSignal, AbortSignal.timeout(120000)]);
      cancellation.throwIfAborted();
      const sessionId = session();
      const started = performance.now();
      const fields = {
        sessionId,
        toolCallId: context?.toolCallId,
        cwd,
        operation: "terminal/run",
        operationId: crypto.randomUUID(),
      };
      diagnostic("acp", "debug", "client_terminal.requested", { ...fields, timeoutMs: 120000 });
      let terminalId: string | undefined;
      let exited = false;
      let cleanup: Promise<void> | undefined;
      const release = () => {
        if (!terminalId) return Promise.resolve();
        const params = { sessionId, terminalId };
        cleanup ??= (async () => {
          if (!exited) {
            const timeout = AbortSignal.any([connectionSignal, AbortSignal.timeout(2000)]);
            try {
              await waitForBoundary(
                client.request("terminal/kill", params, { cancellationSignal: timeout }),
                timeout,
              );
            } catch (error) {
              diagnostic("acp", "warning", "client_terminal.kill_failed", {
                ...fields,
                terminalId,
                error: diagnosticError(error),
              });
              /* Release also terminates running commands. */
            }
          }
          diagnostic("acp", "debug", "client_terminal.releasing", {
            ...fields,
            terminalId,
            timeoutMs: 2000,
          });
          const timeout = AbortSignal.any([connectionSignal, AbortSignal.timeout(2000)]);
          await waitForBoundary(
            client.request("terminal/release", params, { cancellationSignal: timeout }),
            timeout,
          );
          diagnostic("acp", "debug", "client_terminal.released", { ...fields, terminalId });
        })().catch((error) => {
          diagnostic("acp", "warning", "client_terminal.release_failed", {
            ...fields,
            terminalId,
            error: diagnosticError(error),
          });
          throw error;
        });
        return cleanup;
      };
      // Keep the create response alive after operation cancellation so a late ID can be released.
      // Disconnect ends this wait; the client then owns cleanup of its connection resources.
      const created = client.request(
        "terminal/create",
        {
          sessionId,
          command,
          args: [...args],
          cwd,
          outputByteLimit: MAX_FILE_BYTES,
        },
        { cancellationSignal: connectionSignal },
      );
      void created
        .then(async (result) => {
          terminalId = result.terminalId;
          if (cancellation.aborted) {
            diagnostic("acp", "warning", "client_terminal.late_create", { ...fields, terminalId });
            await release();
          }
        })
        .catch(() => {});
      try {
        const handle = await waitForBoundary(created, cancellation);
        terminalId = handle.terminalId;
        diagnostic("acp", "debug", "client_terminal.waiting_for_exit", { ...fields, terminalId });
        cancellation.throwIfAborted();
        if (context) {
          try {
            void Promise.resolve(onTerminal?.(context.toolCallId, handle.terminalId)).catch(
              (error) =>
                diagnostic("acp", "warning", "client_terminal.display_failed", {
                  ...fields,
                  terminalId,
                  error: diagnosticError(error),
                }),
            );
          } catch (error) {
            diagnostic("acp", "warning", "client_terminal.display_failed", {
              ...fields,
              terminalId,
              error: diagnosticError(error),
            });
            /* Display subscribers cannot decide execution. */
          }
        }
        const params: TerminalOutputRequest = { sessionId, terminalId: handle.terminalId };
        const status = await waitForBoundary(
          client.request<"terminal/wait_for_exit">("terminal/wait_for_exit", params, {
            cancellationSignal: cancellation,
          }),
          cancellation,
        );
        exited = true;
        const result = await waitForBoundary(
          client.request<"terminal/output">("terminal/output", params, {
            cancellationSignal: cancellation,
          }),
          cancellation,
        );
        if (Buffer.byteLength(result.output) > MAX_FILE_BYTES)
          throw new Error("Client terminal output exceeds 256 KiB");
        diagnostic("acp", "debug", "client_terminal.exited", {
          ...fields,
          terminalId,
          exitCode: status.exitCode ?? undefined,
          bytes: Buffer.byteLength(result.output),
          durationMs: performance.now() - started,
        });
        return {
          output: result.output,
          truncated: result.truncated,
          exitCode: status.exitCode ?? null,
          signal: status.signal ?? null,
        };
      } catch (error) {
        const timedOut =
          cancellation.reason instanceof Error && cancellation.reason.name === "TimeoutError";
        const cancelled = cancellation.aborted && !timedOut;
        diagnostic(
          "acp",
          cancelled ? "info" : "warning",
          cancelled ? "client_terminal.cancelled" : "client_terminal.failed",
          {
            ...fields,
            terminalId,
            durationMs: performance.now() - started,
            outcome: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
            timeoutMs: 120000,
            error: diagnosticError(error),
          },
        );
        throw error;
      } finally {
        // A cancelled/failed operation must not wait indefinitely for a client cleanup reply.
        // Cleanup failure on the successful path is surfaced as a failed tool operation.
        if (cancellation.aborted) await release().catch(() => {});
        else await release();
      }
    },
  };
}

export function terminalTool(terminal: ClientTerminal, cwd: string) {
  return defineTool({
    description:
      "Run a command through the client's terminal in the workspace. This can modify files and access resources outside the workspace. Requires approval; limited to 120 seconds and 256 KiB of retained output.",
    kind: "execute",
    input: z.object({
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(16384)).max(256).default([]),
    }),
    locations: () => [{ path: cwd }],
    run: ({ command, args }, signal, context) => terminal.run(command, args, signal, context),
  });
}

import { isAbsolute } from "node:path";

import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";

import { waitForBoundary } from "./session-config.ts";
import { MAX_FILE_BYTES } from "./workspace-files.ts";

/** Session-bound client ports. Missing methods were not advertised by the client. */
export type ClientFiles = Readonly<{
  readText?: (path: string, signal: AbortSignal) => Promise<string>;
  write?: (
    path: string,
    text: string,
    signal: AbortSignal,
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
  return {
    ...(capabilities.fs?.readTextFile === true
      ? {
          readText: async (path: string, signal: AbortSignal) => {
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
        }
      : {}),
    ...(capabilities.fs?.writeTextFile === true
      ? {
          write: async (path: string, text: string, signal: AbortSignal) => {
            const cancellationSignal = check(path, signal);
            const bytes = Buffer.byteLength(text);
            if (bytes > MAX_FILE_BYTES) throw new Error("Write exceeds 256 KiB; narrow the write");
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
        }
      : {}),
  };
}

import { Writable } from "node:stream";

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { diagnostic } from "../core/logging/index.ts";
import { connectAcp, type AcpOptions } from "./adapter.ts";

/** stdout belongs exclusively to ACP. The launcher owns durable diagnostics. */
export async function serveAcpStdio(options: AcpOptions): Promise<void> {
  const server = connectAcp(
    ndJsonStream(Writable.toWeb(process.stdout), Bun.stdin.stream()),
    options,
  );
  const stop = (signal: string) => {
    diagnostic("acp", "info", "stdio.shutdown_requested", { signal });
    void server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  diagnostic("acp", "info", "stdio.listening");
  try {
    await server.closed;
  } finally {
    diagnostic("acp", "info", "stdio.closed");
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

import { Writable } from "node:stream";

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { connectAcp, type AcpOptions } from "./adapter.ts";

/** stdout belongs exclusively to ACP. Configure diagnostics on stderr in the launcher. */
export async function serveAcpStdio(options: AcpOptions): Promise<void> {
  const server = connectAcp(
    ndJsonStream(Writable.toWeb(process.stdout), Bun.stdin.stream()),
    options,
  );
  const stop = () => {
    void server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await server.closed;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

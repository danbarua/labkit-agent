import { client } from "@agentclientprotocol/sdk";

import type { FileSystemHandler } from "../handlers/FileSystemHandler";
import type { PermissionHandler } from "../handlers/PermissionHandler";
import type { SessionUpdateHandler } from "../handlers/SessionUpdateHandler";
import type { TerminalHandler } from "../handlers/TerminalHandler";

/** Preserve request cancellation context at the protocol boundary. */
export function clientApp(handlers: {
  files: FileSystemHandler;
  permissions: PermissionHandler;
  terminals: TerminalHandler;
  updates: SessionUpdateHandler;
}) {
  return client()
    .onRequest("session/request_permission", ({ params, signal, requestId }) =>
      handlers.permissions.requestPermission(params, signal, requestId),
    )
    .onNotification("session/update", ({ params }) => handlers.updates.handleUpdate(params))
    .onRequest("fs/read_text_file", ({ params }) => handlers.files.readTextFile(params))
    .onRequest("fs/write_text_file", ({ params }) => handlers.files.writeTextFile(params))
    .onRequest("terminal/create", ({ params }) => handlers.terminals.createTerminal(params))
    .onRequest("terminal/output", ({ params }) => handlers.terminals.terminalOutput(params))
    .onRequest("terminal/wait_for_exit", ({ params, signal }) =>
      handlers.terminals.waitForTerminalExit(params, signal),
    )
    .onRequest("terminal/kill", ({ params }) => handlers.terminals.killTerminal(params))
    .onRequest("terminal/release", ({ params }) => handlers.terminals.releaseTerminal(params));
}

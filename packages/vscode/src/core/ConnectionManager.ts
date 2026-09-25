import { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ClientConnection, InitializeResponse, Stream } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

import { version as extensionVersion } from "../../package.json";
import { FileSystemHandler } from "../handlers/FileSystemHandler";
import { PermissionHandler } from "../handlers/PermissionHandler";
import { SessionUpdateHandler } from "../handlers/SessionUpdateHandler";
import { TerminalHandler } from "../handlers/TerminalHandler";
import { log, logError, logTraffic } from "../utils/Logger";
import { clientApp } from "./client-app";

export interface ConnectionInfo {
  connection: ClientConnection;
  permissions: PermissionHandler;
  terminalHandler: TerminalHandler;
  initResponse: InitializeResponse;
}

/**
 * Manages ACP connections to agent processes.
 * Creates typed client connections from spawned child processes.
 */
export class ConnectionManager {
  private connections: Map<string, ConnectionInfo> = new Map();

  constructor(
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly editor: typeof vscode = vscode,
  ) {}

  /**
   * Create an ACP connection from a child process.
   * Sets up streams, creates connection, and performs initialization handshake.
   */
  async connect(agentId: string, process: ChildProcess, cwd?: string): Promise<ConnectionInfo> {
    if (!process.stdout || !process.stdin) {
      throw new Error("Agent process missing stdio streams");
    }

    log(`ConnectionManager: connecting to agent ${agentId}`);

    // Create Web Streams from Node.js streams
    const readable = Readable.toWeb(process.stdout) as unknown as ReadableStream<Uint8Array>;
    const writable = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>;

    const stream = ndJsonStream(writable, readable);

    // Wrap the stream to intercept and log all ACP traffic
    const tappedStream = this.tapStream(stream);

    // Create handlers
    const fsHandler = new FileSystemHandler(this.editor);
    const terminalHandler = new TerminalHandler(
      this.editor,
      (update) => this.sessionUpdateHandler.terminalOutput(update),
      cwd,
    );
    const permissionHandler = new PermissionHandler(this.editor);
    const connection = clientApp({
      files: fsHandler,
      terminals: terminalHandler,
      permissions: permissionHandler,
      updates: this.sessionUpdateHandler,
    }).connect(tappedStream);

    const cleanup = () => {
      permissionHandler.dispose();
      void terminalHandler.dispose();
    };

    process.once("close", () => {
      connection.close();
      cleanup();
    });
    connection.signal.addEventListener("abort", cleanup, { once: true });

    // Initialize the connection
    log(`ConnectionManager: initializing connection to agent ${agentId}`);
    const initResponse = await connection.agent
      .request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: "vscode-acp-client",
          version: extensionVersion,
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      })
      .catch(async (error) => {
        connection.close(error);
        permissionHandler.dispose();
        await terminalHandler.dispose();
        throw error;
      });

    log(
      `ConnectionManager: initialized. Agent: ${initResponse.agentInfo?.name || "unknown"} v${initResponse.agentInfo?.version || "?"}`,
    );

    const info: ConnectionInfo = {
      connection,
      permissions: permissionHandler,
      initResponse,
      terminalHandler,
    };
    this.connections.set(agentId, info);

    return info;
  }

  getConnection(agentId: string): ConnectionInfo | undefined {
    return this.connections.get(agentId);
  }

  removeConnection(agentId: string): void {
    const info = this.connections.get(agentId);
    this.connections.delete(agentId);
    if (info) {
      info.permissions.dispose();
      info.connection.close();
      void info.terminalHandler.dispose();
    }
  }

  dispose(): void {
    for (const agentId of this.connections.keys()) this.removeConnection(agentId);
  }

  /**
   * Wrap a Stream to intercept and log all messages in both directions.
   */
  private tapStream(stream: Stream): Stream {
    // Tap outgoing messages (client → agent)
    const sendTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        logTraffic("send", chunk);
        controller.enqueue(chunk);
      },
    });

    // Tap incoming messages (agent → client)
    const recvTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        logTraffic("recv", chunk);
        controller.enqueue(chunk);
      },
    });

    // Pipe: sendTap.readable → original writable, original readable → recvTap.writable
    // These run in the background — no need to await
    void sendTap.readable
      .pipeTo(stream.writable)
      .catch((e) => logError("Traffic tap send pipe error", e));
    void stream.readable
      .pipeTo(recvTap.writable)
      .catch((e) => logError("Traffic tap recv pipe error", e));

    return {
      writable: sendTap.writable,
      readable: recvTap.readable,
    };
  }
}

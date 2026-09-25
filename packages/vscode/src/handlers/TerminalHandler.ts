import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { RequestError } from "@agentclientprotocol/sdk";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

import { diagnosticError } from "../../../core/logging/index.ts";
import { logDiagnostic, registerEnvironmentSecrets } from "../utils/Logger";

export type TerminalDisplay = TerminalOutputResponse & {
  sessionId: string;
  terminalId: string;
  released?: boolean;
};

type ManagedTerminal = {
  sessionId: string;
  terminalId: string;
  command: string;
  process: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitStatus?: WaitForTerminalExitResponse;
  failure?: RequestError;
  done: Promise<void>;
  release?: Promise<ReleaseTerminalResponse>;
  terminal: vscode.Terminal;
  writer: vscode.EventEmitter<string>;
};

/** Each connection owns its processes; display snapshots survive protocol release. */
export class TerminalHandler {
  private terminals = new Map<string, ManagedTerminal>();
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(
    private readonly editor: typeof vscode = vscode,
    private readonly display: (update: TerminalDisplay) => void = () => {},
    private readonly defaultCwd?: string,
  ) {}

  private snapshot(terminal: ManagedTerminal): TerminalDisplay {
    return {
      sessionId: terminal.sessionId,
      terminalId: terminal.terminalId,
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    };
  }

  private publish(terminal: ManagedTerminal, released = false) {
    try {
      this.display({ ...this.snapshot(terminal), ...(released ? { released: true } : {}) });
    } catch (error) {
      logDiagnostic("error", "vscode.terminal.display_failed", {
        sessionId: terminal.sessionId,
        terminalId: terminal.terminalId,
        cause: diagnosticError(error),
      });
    }
  }

  private failure(
    terminal: Pick<ManagedTerminal, "sessionId" | "terminalId" | "command">,
    phase: string,
    error: unknown,
  ) {
    const data = {
      sessionId: terminal.sessionId,
      terminalId: terminal.terminalId,
      command: terminal.command,
      phase,
      cause: diagnosticError(error),
    };
    const message = `Terminal ${terminal.terminalId} (${terminal.command}) failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`;
    logDiagnostic("error", "vscode.terminal.failed", { ...data, message });
    return new RequestError(-32603, message, data);
  }

  private get(params: { sessionId: string; terminalId: string }) {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal || terminal.sessionId !== params.sessionId) {
      const message = `Terminal ${params.terminalId} is not available in session ${params.sessionId}; it may have been released`;
      logDiagnostic("warning", "vscode.terminal.unavailable", { ...params, message });
      throw RequestError.invalidParams(params, message);
    }
    return terminal;
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    if (this.disposed)
      throw RequestError.invalidRequest(undefined, "The terminal connection is closed");
    const terminalId = crypto.randomUUID();
    const identity = { sessionId: params.sessionId, terminalId, command: params.command };
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024;
    const cwd = params.cwd ?? this.defaultCwd;
    if (
      !Number.isSafeInteger(outputByteLimit) ||
      outputByteLimit < 0 ||
      (cwd != null && !isAbsolute(cwd))
    ) {
      throw RequestError.invalidParams(
        { ...identity, outputByteLimit, cwd },
        "Use a non-negative integer outputByteLimit and an absolute cwd",
      );
    }
    const env = {
      ...process.env,
      ...Object.fromEntries((params.env ?? []).map((value) => [value.name, value.value])),
    };
    registerEnvironmentSecrets(env);
    logDiagnostic("info", "vscode.terminal.started", {
      ...identity,
      args: params.args ?? [],
      cwd,
      outputByteLimit,
    });
    const writer = new this.editor.EventEmitter<string>();
    let opened = false;
    let managed: ManagedTerminal | undefined;
    const terminal = this.editor.window.createTerminal({
      name: `ACP: ${params.command}`,
      pty: {
        onDidWrite: writer.event,
        open: () => {
          opened = true;
          if (managed) writer.fire(managed.output.replace(/\r?\n/g, "\r\n"));
        },
        close: () => {
          if (managed && !managed.exitStatus)
            void this.kill(managed).catch((error) => {
              logDiagnostic("error", "vscode.terminal.user_close_failed", {
                ...identity,
                cause: diagnosticError(error),
              });
            });
        },
      },
    });
    let child: ChildProcess;
    try {
      child = spawn(params.command, params.args ?? [], {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      terminal.dispose();
      writer.dispose();
      throw this.failure(identity, "spawn", error);
    }
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    managed = {
      ...identity,
      process: child,
      output: "",
      truncated: false,
      outputByteLimit,
      done,
      terminal,
      writer,
    };
    const current = managed;
    this.terminals.set(terminalId, current);

    const append = (text: string) => {
      if (!text) return;
      current.output += text;
      let excess = Buffer.byteLength(current.output) - outputByteLimit;
      if (excess > 0) {
        let offset = 0;
        for (const character of current.output) {
          excess -= Buffer.byteLength(character);
          offset += character.length;
          if (excess <= 0) break;
        }
        current.output = current.output.slice(offset);
        current.truncated = true;
      }
      if (opened) writer.fire(text.replace(/\r?\n/g, "\r\n"));
      this.publish(current);
    };

    const stdout = new StringDecoder("utf8");
    const stderr = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk) => append(stdout.write(chunk)));
    child.stderr?.on("data", (chunk) => append(stderr.write(chunk)));
    child.on("error", (error) => {
      current.failure = this.failure(current, child.pid === undefined ? "spawn" : "process", error);
    });
    child.once("close", (exitCode, signal) => {
      append(stdout.end());
      append(stderr.end());
      current.exitStatus = { exitCode, signal };
      logDiagnostic(
        exitCode === 0 || signal || current.failure ? "info" : "warning",
        "vscode.terminal.exited",
        {
          ...identity,
          exitCode,
          signal,
          outputBytes: Buffer.byteLength(current.output),
          truncated: current.truncated,
          message: `Terminal command ${params.command} exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}`,
        },
      );
      this.publish(current);
      settled();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      await done;
      this.terminals.delete(terminalId);
      terminal.dispose();
      writer.dispose();
      throw current.failure ?? this.failure(current, "spawn", error);
    }
    if (this.disposed) {
      await done;
      throw RequestError.invalidRequest(
        identity,
        "The connection closed while starting the terminal",
      );
    }
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.get(params);
    if (terminal.failure) throw terminal.failure;
    const { output, truncated, exitStatus } = this.snapshot(terminal);
    return { output, truncated, ...(exitStatus ? { exitStatus } : {}) };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
    signal?: AbortSignal,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.get(params);
    logDiagnostic("debug", "vscode.terminal.waiting", {
      ...params,
      reason: "Waiting for command exit and output stream closure",
    });
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => {
        signal?.removeEventListener("abort", cancelled);
        logDiagnostic("info", "vscode.terminal.wait_cancelled", {
          ...params,
          reason: "request_cancelled",
          message:
            "Stopped waiting for terminal exit; the command remains available until killed or released",
        });
        reject(
          RequestError.requestCancelled(
            params,
            "Terminal exit wait cancelled; the command has not been killed",
          ),
        );
      };

      if (signal?.aborted) {
        cancelled();
        return;
      }
      signal?.addEventListener("abort", cancelled, { once: true });
      void terminal.done.then(() => {
        signal?.removeEventListener("abort", cancelled);
        resolve();
      });
    });
    if (terminal.failure) throw terminal.failure;
    return terminal.exitStatus!;
  }

  private async kill(terminal: ManagedTerminal) {
    if (terminal.exitStatus) return;
    logDiagnostic("info", "vscode.terminal.killing", {
      sessionId: terminal.sessionId,
      terminalId: terminal.terminalId,
      command: terminal.command,
    });
    try {
      if (process.platform !== "win32" && terminal.process.pid)
        process.kill(-terminal.process.pid, "SIGKILL");
      else if (!terminal.process.kill("SIGKILL"))
        throw new Error("The process did not accept the kill signal");
    } catch (error) {
      if ((error as { code?: string }).code !== "ESRCH")
        throw this.failure(terminal, "kill", error);
    }
    await terminal.done;
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    await this.kill(this.get(params));
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const terminal = this.get(params);
    return (terminal.release ??= this.release(terminal));
  }

  private async release(terminal: ManagedTerminal): Promise<ReleaseTerminalResponse> {
    await this.kill(terminal);
    this.publish(terminal, true);
    terminal.terminal.dispose();
    terminal.writer.dispose();
    this.terminals.delete(terminal.terminalId);
    logDiagnostic("info", "vscode.terminal.released", {
      sessionId: terminal.sessionId,
      terminalId: terminal.terminalId,
      outputBytes: Buffer.byteLength(terminal.output),
      truncated: terminal.truncated,
    });
    return {};
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return (this.disposal ??= this.cleanup());
  }

  private async cleanup(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.terminals.values()].map((terminal) => this.releaseTerminal(terminal)),
    );
    for (const result of results)
      if (result.status === "rejected")
        logDiagnostic("error", "vscode.terminal.cleanup_failed", {
          cause: diagnosticError(result.reason),
        });
  }
}

import { z } from "zod";

import type { TurnCommand } from "../../agent/agent-fsm.ts";
import {
  toolBatchMachine,
  type BatchCommand,
  type BatchEvent,
  type BatchState,
} from "../../agent/tool-batch.ts";
import { failure, type ActorId } from "../../agent/types.ts";
import { Actor } from "../../fsm/fsm.ts";
import { diagnostic, diagnosticError } from "../../logging/index.ts";
import type { HostContext } from "../context.ts";
import type { ExecutionContext, HostToolOutcome } from "../host.ts";
import { ToolLocationSchema } from "../ports.ts";

/**
 * Runs a completion's tool calls as a tool batch actor. Installs the remembered grants of the
 * approving permission request, then spawns each call as the batch asks; each raw outcome goes to
 * `host.reportTool` and counts toward the batch only once released.
 *
 * @throws When `command.permission` names a request that did not approve this batch.
 */
export function runTools(
  host: HostContext,
  turnId: ActorId,
  command: Extract<TurnCommand, { type: "run_tools" }>,
  context: ExecutionContext,
): void {
  const grant = command.permission ? host.grants.get(command.permission.id) : undefined;
  if (
    command.permission &&
    (!grant?.approved ||
      grant.batchId !== command.child.id ||
      command.completion.calls.some(
        (call) => !grant.inputs.has(call.id) && !grant.invalidInputs.has(call.id),
      ))
  )
    throw new Error("Missing tool permission grant");
  for (const [toolName, grantId] of grant?.remembered ?? []) {
    host.remembered.set(toolName, grantId);
    diagnostic("host", "info", "permission.granted", {
      sessionId: host.sessionId,
      turnId,
      childId: command.child.id,
      toolName,
      grantId,
      scope: "live-session-tool",
      policyVersion: context.policyVersion,
      reason:
        "User approved this tool for all arguments until this session closes, tool scope changes, or permissions are explicitly reset",
    });
  }
  if (command.permission) host.grants.delete(command.permission.id);
  let batch: Actor<BatchState, BatchEvent, BatchCommand>;
  const runBatchCommand = (batchCommand: BatchCommand): undefined => {
    switch (batchCommand.type) {
      case "spawn_tool": {
        const tool = host.tools.get(batchCommand.call.name)!;
        const identity = {
          ...(host.sessionId ? { sessionId: host.sessionId } : {}),
          turnId,
          batchId: command.child.id,
          callId: batchCommand.call.id,
          toolCallId: batchCommand.child.id,
          name: batchCommand.call.name,
        };
        diagnostic("host", "debug", "tool.admitted", {
          ...identity,
          toolName: batchCommand.call.name,
          kind: tool.kind ?? "other",
          permission: grant?.invalidInputs.has(batchCommand.call.id)
            ? "not_requested_invalid_input"
            : grant
              ? "approved"
              : "not_required",
        });
        if (!grant)
          host.notifyTool({
            ...identity,
            sessionUpdate: "tool_call",
            title: batchCommand.call.name,
            name: batchCommand.call.name,
            kind: tool.kind ?? "other",
            status: "pending",
            rawInput: batchCommand.call.args,
          });
        if (host.closed) break;
        let status = "pending";

        host.spawn(
          batchCommand.child,
          {
            input: batchCommand.call.args,
            timeoutMs: context.toolTimeoutMs,
            failureContext: {
              operation: {
                id: batchCommand.child.id,
                kind: "tool",
                sessionId: host.sessionId,
                turnId,
                toolName: batchCommand.call.name,
                callId: batchCommand.call.id,
              },
            },
            parseInput: async (raw) => {
              if (grant) {
                const invalid = grant.invalidInputs.get(batchCommand.call.id);
                if (invalid) throw invalid;
                return grant.inputs.get(batchCommand.call.id);
              }
              const input = await tool.parseInput(raw);
              if (!host.closed && status === "pending" && tool.locations) {
                try {
                  const locations = z
                    .array(ToolLocationSchema)
                    .parse(tool.locations(structuredClone(input)));
                  diagnostic("host", "debug", "tool.locations_resolved", {
                    ...identity,
                    toolName: batchCommand.call.name,
                    locations,
                  });
                  host.notifyTool({
                    ...identity,
                    sessionUpdate: "tool_call_update",
                    locations,
                  });
                } catch (error) {
                  diagnostic("host", "warning", "tool.locations_failed", {
                    sessionId: host.sessionId,
                    childId: batchCommand.child.id,
                    toolName: batchCommand.call.name,
                    error: diagnosticError(error),
                  });
                }
              }
              return input;
            },
            run: (input, signal) => tool.run(input, signal, Object.freeze(identity)),
            parseOutput: (value) => {
              const parsed = z.json().safeParse(value);
              if (!parsed.success)
                throw new Error(
                  "Tool output must be a JSON value: null, boolean, finite number, string, array, or plain object",
                );
              return typeof parsed.data === "string" ? parsed.data : JSON.stringify(parsed.data);
            },
          },
          (result) => {
            const outcome: HostToolOutcome = {
              turnId,
              batchId: command.child.id,
              callId: batchCommand.call.id,
              result,
            };
            host.pendingTools.set(`${outcome.batchId}/${outcome.callId}`, {
              outcome,
              batch,
              toolFailure: context.toolFailure,
            });
            diagnostic("host", "debug", "tool.awaiting_release", {
              ...identity,
              toolName: batchCommand.call.name,
              outcome: result.kind,
              reason:
                "Result reported; awaiting caller release (session journal receipt when durable)",
            });
            host.reportTool(outcome);
          },
          (state) => {
            const next =
              state.status === "succeeded"
                ? "completed"
                : state.status === "failed" || state.status === "cancelled"
                  ? "failed"
                  : state.status === "running" || state.status === "validating_output"
                    ? "in_progress"
                    : "pending";
            if (next === status) return;
            diagnostic(
              "host",
              state.status === "failed" ? "warning" : "debug",
              "tool.status_changed",
              {
                ...identity,
                toolName: batchCommand.call.name,
                previousStatus: status,
                status: next,
                ...(state.status === "failed" ? { error: diagnosticError(state.error) } : {}),
              },
            );
            status = next;
            host.notifyTool({
              ...identity,
              sessionUpdate: "tool_call_update",
              status: next,
              ...(state.status === "succeeded"
                ? { rawOutput: state.value }
                : state.status === "failed"
                  ? { rawOutput: { error: state.error.message } }
                  : state.status === "cancelled"
                    ? { rawOutput: { error: "Tool cancelled" } }
                    : {}),
            });
          },
        );
        break;
      }
      case "cancel_tool":
        host.cancel(batchCommand.child, batchCommand.reason);
        break;
      case "notify":
        host.children.delete(command.child.id);
        for (const [key, pending] of host.pendingTools)
          if (pending.outcome.batchId === command.child.id) host.pendingTools.delete(key);
        host.post(turnId, {
          type: "batch_settled",
          child: command.child,
          outcome: batchCommand.outcome,
        });
        break;
    }
    return undefined;
  };
  batch = new Actor<BatchState, BatchEvent, BatchCommand>(
    { status: "ready", calls: command.completion.calls },
    toolBatchMachine(command.child),
    runBatchCommand,
    (_, error) => ({ type: "failed", error: failure(error) }),
  );
  host.children.set(command.child.id, {
    ref: command.child,
    actor: {
      get snapshot() {
        return batch.snapshot;
      },
      cancel: () => batch.send({ type: "cancel" }),
    },
  });
  void batch.send({ type: "start" });
}

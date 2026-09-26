import { z } from "zod";

import type { TurnCommand } from "../../agent/agent-fsm.ts";
import { PermissionDecisionsSchema, type PermissionDecisions } from "../../agent/permissions.ts";
import { failure, ref, type ActorId, type Failure } from "../../agent/types.ts";
import { freeze } from "../../fsm/fsm.ts";
import { diagnostic, diagnosticError } from "../../logging/index.ts";
import type { HostContext } from "../context.ts";
import type { ExecutionContext, HostToolNotification } from "../host.ts";
import { PermissionResponseSchema, ToolLocationSchema, type ToolLocation } from "../ports.ts";

/**
 * Asks the permission port about each tool call of a completion, in order, and records the
 * validated inputs and decisions as a grant that the matching `run_tools` batch must present.
 */
export function requestPermission(
  host: HostContext,
  turnId: ActorId,
  command: Extract<TurnCommand, { type: "request_permission" }>,
  context: ExecutionContext,
): void {
  const grant = {
    batchId: command.batch.id,
    approved: false,
    inputs: new Map<string, unknown>(),
    invalidInputs: new Map<string, Failure>(),
    pending: [] as HostToolNotification[],
    remembered: new Map<string, string>(),
  };
  host.grants.set(command.child.id, grant);
  host.spawn(
    command.child,
    {
      failureContext: {
        operation: {
          id: command.child.id,
          kind: command.child.kind,
          sessionId: host.sessionId,
          turnId,
        },
      },
      input: null,
      parseInput: z.null().parse,
      run: async (_, signal) => {
        if (!host.requestPermission) throw new Error("Missing permission request binding");
        const decisions: PermissionDecisions[number][] = [];
        for (const call of command.completion.calls) {
          let phase = "validate_input";
          try {
            signal.throwIfAborted();
            const tool = host.tools.get(call.name)!;
            const identity = {
              ...(host.sessionId ? { sessionId: host.sessionId } : {}),
              turnId,
              batchId: command.batch.id,
              callId: call.id,
              toolCallId: ref("tool", `${command.batch.id}/${call.id}`).id,
              name: call.name,
            };
            const display = {
              ...identity,
              sessionUpdate: "tool_call" as const,
              title: call.name,
              name: call.name,
              kind: tool.kind ?? "other",
              status: "pending" as const,
              rawInput: call.args,
            };
            grant.pending.push(display);
            host.notifyTool(display);
            signal.throwIfAborted();
            const input = await tool.parseInput(call.args);
            signal.throwIfAborted();
            grant.inputs.set(call.id, input);
            let locations: readonly ToolLocation[] | undefined;
            if (tool.locations) {
              try {
                locations = z
                  .array(ToolLocationSchema)
                  .parse(tool.locations(structuredClone(input)));
              } catch (error) {
                diagnostic("host", "warning", "tool.locations_failed", {
                  ...identity,
                  toolName: call.name,
                  error: diagnosticError(error),
                  childId: identity.toolCallId,
                });
              }
            }
            if (locations)
              host.notifyTool({ ...identity, sessionUpdate: "tool_call_update", locations });
            signal.throwIfAborted();
            const permissionStartedAt = performance.now();
            const permissionContext = {
              ...identity,
              childId: command.child.id,
              requestId: `${command.child.id}/${call.id}`,
              toolName: call.name,
              locations,
            };
            const rememberedGrant =
              host.remembered.get(call.name) ?? grant.remembered.get(call.name);
            if (rememberedGrant) {
              const approval = {
                scope: "live-session-tool" as const,
                source: "remembered" as const,
                grantId: rememberedGrant,
              };
              decisions.push({ callId: call.id, decision: "allow_once", approval });
              diagnostic("host", "info", "permission.reused", {
                ...permissionContext,
                ...approval,
                reason: "User previously approved this tool for all arguments in this live session",
              });
              continue;
            }
            diagnostic("host", "info", "permission.waiting", {
              ...permissionContext,
              reason: "Tool execution requires user approval; batch execution is blocked",
            });
            phase = "await_permission";
            const response = PermissionResponseSchema.parse(
              await host.requestPermission(
                freeze({
                  ...(host.sessionId ? { sessionId: host.sessionId } : {}),
                  turnId,
                  requestId: `${command.child.id}/${call.id}`,
                  toolCall: {
                    toolCallId: identity.toolCallId,
                    title: call.name,
                    name: call.name,
                    kind: tool.kind ?? "other",
                    status: "pending",
                    rawInput: structuredClone(call.args),
                    ...(locations ? { locations } : {}),
                  },
                  options: [
                    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                    {
                      optionId: "allow-session",
                      name: `Allow ${call.name} for all arguments until session closes`,
                      kind: "allow_always",
                    },
                    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
                  ],
                }),
                signal,
              ),
            );
            signal.throwIfAborted();
            const decision =
              response.outcome.outcome === "cancelled"
                ? "cancelled"
                : response.outcome.optionId === "allow-once" ||
                    response.outcome.optionId === "allow-session"
                  ? "allow_once"
                  : "reject_once";
            diagnostic("host", "info", "permission.decided", {
              ...permissionContext,
              decision,
              durationMs: Math.round(performance.now() - permissionStartedAt),
            });
            if (decision === "reject_once") {
              diagnostic("host", "warning", "permission.refused", {
                ...permissionContext,
                operation: "tool_execution",
                outcome: "blocked",
                decision,
                reasonCode: "permission_refused",
                reason:
                  "User refused permission for a model-requested tool; no tools in this batch will run",
                toolKind: tool.kind ?? "other",
                rawInput: call.args,
                blockedCallCount: command.completion.calls.length,
                durationMs: Math.round(performance.now() - permissionStartedAt),
              });
            }
            const approval =
              response.outcome.outcome === "selected" &&
              response.outcome.optionId === "allow-session"
                ? {
                    scope: "live-session-tool" as const,
                    source: "user" as const,
                    grantId: permissionContext.requestId,
                  }
                : undefined;
            if (approval) grant.remembered.set(call.name, approval.grantId);
            decisions.push({ callId: call.id, decision, ...(approval ? { approval } : {}) });
            if (decision !== "allow_once") break;
          } catch (error) {
            const invalidInput = phase === "validate_input" && !signal.aborted;
            const detail = failure(error, {
              classification: invalidInput ? "invalid_input" : "execution",
              phase,
              operation: {
                id: invalidInput ? `${command.batch.id}/${call.id}` : command.child.id,
                kind: invalidInput ? "tool" : "permission",
                sessionId: host.sessionId,
                turnId,
                callId: call.id,
                toolName: call.name,
              },
            });
            if (!invalidInput || context.toolFailure !== "return-error-and-continue") throw detail;
            grant.invalidInputs.set(call.id, detail);
            decisions.push({ callId: call.id, decision: "invalid_input", error: detail });
            diagnostic("host", "warning", "tool.input_rejected", {
              sessionId: host.sessionId,
              turnId,
              toolCallId: detail.operation?.id,
              toolName: call.name,
              callId: call.id,
              error: detail,
              consequence:
                "Tool will not execute or request approval; validation error will be committed as a tool result for the model to correct",
            });
          }
        }
        return decisions;
      },
      parseOutput: PermissionDecisionsSchema.parse,
    },
    (result) => {
      if (result.kind !== "succeeded")
        host.revoke(
          command.child.id,
          result.kind === "failed" ? result.error.message : "Tool permission request cancelled",
        );
      else if (result.value.some((entry) => entry.decision === "reject_once"))
        host.revoke(command.child.id, "Tool permission rejected by the user");
      else if (result.value.some((entry) => entry.decision === "cancelled"))
        host.revoke(command.child.id, "Tool permission request cancelled");
      else grant.approved = true;
      host.post(turnId, { type: "permission_settled", child: command.child, result });
    },
  );
}

import { failure } from "../../agent/types.ts";
import { diagnostic, diagnosticError } from "../../logging/index.ts";
import type { SessionCommand } from "../session-fsm.ts";
import { appendOperation, loadOperation } from "../session-operation.ts";
import type { TerminalResult } from "../session-runtime.ts";
import { executeConversationCommand } from "./conversation-effects.ts";
import type { SessionInstance } from "./instance.ts";

/** The session actor command of type `K`. */
type Command<K extends SessionCommand["type"]> = Extract<SessionCommand, { type: K }>;

function append(ctx: SessionInstance, command: Command<"append">) {
  const actor = appendOperation(ctx.configured.port, command.request);
  ctx.storage.add(actor);
  void actor.start();
  void actor.result.then((result) => {
    ctx.storage.delete(actor);
    return ctx.send({ type: "appended", appendId: command.request.appendId, result });
  });
}

function load(ctx: SessionInstance, command: Command<"load">) {
  const { sessionId } = ctx;
  diagnostic("session", "warning", "append.reconciling", {
    sessionId,
    appendId: command.appendId,
  });
  const actor = loadOperation(ctx.configured.port, sessionId);
  ctx.storage.add(actor);
  void actor.start();
  void actor.result.then((result) => {
    ctx.storage.delete(actor);
    return ctx.send({ type: "loaded", appendId: command.appendId, result });
  });
}

/** Settles waiters and runs the conversation commands of a committed submission, in that order. */
function releaseCommitted(ctx: SessionInstance, command: Command<"dispatch">) {
  const { sessionId } = ctx;
  const previousPolicy = ctx.dispatchBoundary.policy;
  ctx.dispatchBoundary = command.durable;
  const terminal = command.durable.records.at(-1)?.body;
  const newBodies = command.durable.records
    .filter((record) => record.appendId === command.submission.appendId)
    .map((record) => record.body);
  for (const body of newBodies)
    if (body.kind === "dequeued") {
      const waiting = ctx.queuedWaiters.get(body.inputId);
      if (waiting) {
        ctx.queuedWaiters.delete(body.inputId);
        const turnId =
          terminal?.kind === "terminal" ? terminal.turnId : command.durable.conversation.turnId;
        ctx.waiters.set(turnId, [...(ctx.waiters.get(turnId) ?? []), waiting]);
      }
    }
  for (const body of newBodies) {
    if (body.kind === "policy") {
      const toolsChanged = Object.entries(body.policy.tools).some(([agent, tools]) => {
        const previous = previousPolicy?.tools[agent] ?? [];
        return (
          tools.some((tool) => !previous.includes(tool)) ||
          previous.some((tool) => !tools.includes(tool))
        );
      });
      if (body.patch.permissions !== undefined || toolsChanged)
        ctx.host.resetPermissions(
          body.patch.permissions !== undefined
            ? "Permission mode explicitly committed; remembered tool approvals revoked"
            : "Allowed tool scope changed; remembered tool approvals revoked",
          { policyVersion: body.policy.version, appendId: command.submission.appendId },
        );
      diagnostic("session", "info", "policy.committed", {
        sessionId,
        appendId: command.submission.appendId,
        requestId: command.submission.id,
        revision: command.durable.revision,
        policy: body.policy,
      });
    }
    if (body.kind === "configuration" && ctx.adoption.plan) {
      diagnostic("session", "info", "session.registry.adopted", {
        sessionId,
        appendId: command.submission.appendId,
        requestId: command.submission.id,
        revision: command.durable.revision,
        differences: ctx.adoption.plan.differences,
        ...(body.agent ? { agentId: body.agent } : {}),
        ...(body.policy ? { policyVersion: body.policy.version } : {}),
        message: "Live tool/agent registry journaled; later prompts validate against it",
      });
      ctx.adoption.plan = undefined;
    }
  }
  const admission = ctx.admissions.get(command.submission.id);
  if (admission) {
    ctx.admissions.delete(command.submission.id);
    const queued = newBodies.find((body) => body.kind === "queued");
    if (queued?.kind === "queued") ctx.queuedWaiters.set(queued.inputId, admission);
    else {
      const turnId =
        terminal?.kind === "terminal" ? terminal.turnId : command.durable.conversation.turnId;
      ctx.waiters.set(turnId, [...(ctx.waiters.get(turnId) ?? []), admission]);
    }
  }
  if (command.submission.input.kind === "tool") {
    diagnostic("session", "debug", "tool.receipt_committed", {
      sessionId,
      turnId: command.submission.input.turnId,
      batchId: command.submission.input.batchId,
      callId: command.submission.input.callId,
      appendId: command.submission.appendId,
      requestId: command.submission.id,
      revision: command.durable.revision,
      reason: "Individual tool result is durable; releasing batch gate",
    });
  }
  // Forward a committed individual result before processing a queued cancellation.
  ctx.afterCommit.get(command.submission.id)?.();
  ctx.afterCommit.delete(command.submission.id);
  if (terminal?.kind === "terminal") {
    const input = command.submission.input;
    const trigger =
      input.kind === "event" && input.event.type === "child" ? input.event.event : undefined;
    diagnostic(
      "session",
      terminal.record.outcome.kind === "failed" ? "warning" : "info",
      "turn.settled",
      {
        sessionId,
        turnId: terminal.turnId,
        operation: "agent_turn",
        agentId: terminal.record.agent,
        message: `Agent turn ${terminal.record.outcome.kind}${terminal.record.outcome.kind === "failed" ? `: ${terminal.record.outcome.error.message}` : ""}`,
        ...(trigger
          ? {
              trigger: trigger.type,
              childId: trigger.child.id,
              childOperation: trigger.child.kind,
            }
          : { trigger: input.kind === "event" ? input.event.type : input.kind }),
        outcome: terminal.record.outcome.kind,
        revision: command.durable.revision,
        appendId: command.submission.appendId,
        requestId: command.submission.id,
        stepLimit: command.durable.conversation.allowance,
        ...(terminal.record.outcome.kind === "failed"
          ? {
              reason: terminal.record.outcome.error.message,
              error: diagnosticError(terminal.record.outcome.error),
            }
          : {}),
        ...(terminal.record.outcome.kind === "exhausted"
          ? { reason: "Turn step allowance exhausted; user continuation required" }
          : {}),
      },
    );
    for (const settle of ctx.waiters.get(terminal.turnId) ?? [])
      settle({ kind: "terminal", turnId: terminal.turnId, record: terminal.record });
    ctx.waiters.delete(terminal.turnId);
  }
  for (const effect of command.commands) {
    try {
      executeConversationCommand(ctx, effect);
    } catch (error) {
      diagnostic("session", "error", "dispatch.failed", {
        sessionId,
        appendId: command.submission.appendId,
        operation: effect.type,
        error: diagnosticError(error),
        ...(effect.type === "turn"
          ? { turnId: effect.turnId, childId: effect.command.child.id }
          : {}),
      });
      if (effect.type === "turn")
        ctx.post(effect.turnId, {
          type: "failed",
          child: effect.command.child,
          error: failure(error),
        });
      else {
        const reply = ctx.branchReplies.get(effect.requestId);
        ctx.branchReplies.delete(effect.requestId);
        reply?.reject(error);
      }
    }
  }
}

function reply(ctx: SessionInstance, command: Command<"reply">) {
  const { sessionId } = ctx;
  diagnostic(
    "session",
    command.result.kind === "failed" ? "error" : "debug",
    "submission.receipt",
    {
      sessionId,
      requestId: command.id,
      outcome: command.result.kind,
      ...(command.result.kind === "accepted"
        ? {
            appendId: command.result.receipt.appendId,
            revision: command.result.receipt.revision,
          }
        : {}),
      ...(command.result.kind === "failed"
        ? { reason: command.result.message, error: command.result.error }
        : {}),
    },
  );
  ctx.receipts.get(command.id)?.(command.result);
  ctx.receipts.delete(command.id);
  ctx.afterCommit.delete(command.id);
  const settle = ctx.admissions.get(command.id);
  if (settle) {
    settle({
      kind: "failed",
      message:
        command.result.kind === "failed" ? command.result.message : `Input ${command.result.kind}`,
      error:
        command.result.kind === "failed"
          ? command.result.error
          : failure(`Input ${command.result.kind}`, {
              classification: "admission",
              operation: {
                id: command.id,
                kind: "admission",
                sessionId,
                turnId: ctx.actor.snapshot.durable.conversation.turnId,
              },
              phase: "admission",
              details: { outcome: command.result.kind },
            }),
    });
    ctx.admissions.delete(command.id);
  }
}

function drain(ctx: SessionInstance) {
  void ctx.send({ type: "drain" });
}

function stop(ctx: SessionInstance) {
  const { sessionId } = ctx;
  diagnostic("session", "info", "session.stopped", {
    sessionId,
    status: ctx.actor.snapshot.status,
  });
  ctx.host.close();
  for (const actor of ctx.storage) void actor.cancel();
  const result: TerminalResult =
    ctx.actor.snapshot.status === "closed"
      ? { kind: "closed", message: "Session closed" }
      : {
          kind: "failed",
          message:
            ctx.actor.snapshot.status === "failed"
              ? ctx.actor.snapshot.error.message
              : "Session stopped",
          error:
            ctx.actor.snapshot.status === "failed"
              ? ctx.actor.snapshot.error
              : failure("Session stopped", {
                  classification: "interrupted",
                  operation: { id: sessionId, kind: "admission", sessionId },
                  phase: "stop",
                }),
        };
  for (const settle of ctx.admissions.values()) settle(result);
  ctx.admissions.clear();
  for (const group of ctx.waiters.values()) for (const settle of group) settle(result);
  ctx.waiters.clear();
  for (const settle of ctx.queuedWaiters.values()) settle(result);
  ctx.queuedWaiters.clear();
  for (const reply of ctx.branchReplies.values())
    reply.reject(result.kind === "failed" ? result.error : new Error(result.message));
  ctx.branchReplies.clear();
}

/** Handler for each command type the session actor emits. */
const sessionCommandHandlers: {
  [K in SessionCommand["type"]]: (ctx: SessionInstance, command: Command<K>) => void;
} = { append, load, dispatch: releaseCommitted, reply, drain, stop };

/** Runs one session actor command; a synchronous throw makes the actor close the session. */
export function executeSessionCommand<K extends SessionCommand["type"]>(
  ctx: SessionInstance,
  command: Command<K>,
): undefined {
  sessionCommandHandlers[command.type](ctx, command);
  return undefined;
}

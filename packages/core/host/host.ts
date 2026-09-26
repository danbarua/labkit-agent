import { z } from "zod";

import type { ConversationCommand } from "../agent/agent-conversation.ts";
import type { TurnEvent } from "../agent/agent-fsm.ts";
import type { PreparedModel } from "../agent/agent.ts";
import type { BlobResolver } from "../agent/content.ts";
import type { PromptInput } from "../agent/prompt.ts";
import {
  toolBatchMachine,
  type BatchCommand,
  type BatchEvent,
  type BatchState,
} from "../agent/tool-batch.ts";
import { failure, type ActorId, type Result, type ToolCall } from "../agent/types.ts";
import { Actor, freeze } from "../fsm/fsm.ts";
import { diagnostic, diagnosticError } from "../logging/index.ts";
import { effectiveToolResult, type Policy } from "../policy/policy.ts";
import type { Continuation, StreamDelta } from "../providers/types.ts";
import { hostCommands, type HostCommandHandler } from "./commands/index.ts";
import { createHostContext } from "./context.ts";
import {
  copyRegistries,
  ToolLocationSchema,
  type ExecutionBindings,
  type ToolKind,
  type ToolLocation,
} from "./ports.ts";

/**
 * The raw result of one tool call, reported through `createHost`'s `tool` sink before its tool
 * batch may use it. The batch counts it only after the runtime passes this same object to
 * `releaseTool`; a session does so after the result's append receipt commits.
 */
export type HostToolOutcome = Readonly<{
  turnId: ActorId;
  batchId: ActorId;
  /** The provider's call ID, unique only within its tool batch. */
  callId: ToolCall["id"];
  /** Raw result, before the configuration's `toolFailure` handling (applied on release). */
  result: Result<string>;
}>;
/**
 * A display update about one tool call, for UI cards. Non-authoritative display data. toolCallId is
 * the child ID, not the provider's batch-local call ID: the tool operation's ID,
 * `${batchId}/${callId}`.
 *
 * - `tool_call` announces the call once: while its permission is being asked, or when its tool
 *   batch starts if no approval was asked.
 * - `tool_call_update` reports display locations, a status change, or the output. `failed` covers
 *   execution failure, cancellation and a refused or cancelled permission request.
 */
export type HostToolNotification = Readonly<
  {
    sessionId?: string;
    turnId: ActorId;
    batchId: ActorId;
    callId: ToolCall["id"];
    toolCallId: ActorId;
  } & (
    | {
        sessionUpdate: "tool_call";
        title: string;
        name: string;
        kind: ToolKind;
        status: "pending";
        rawInput: unknown;
      }
    | {
        sessionUpdate: "tool_call_update";
        name?: string;
        status?: "pending" | "in_progress" | "completed" | "failed";
        locations?: readonly ToolLocation[];
        /**
         * On `completed`, the tool's output text; on `failed`, `{ error }` with the failure
         * message.
         */
        rawOutput?: unknown;
      }
  )
>;

/**
 * Observer for {@link HostToolNotification}s. Best-effort: exceptions and pending promises are
 * ignored and cannot block execution. Not called after the host closes.
 */
export type ToolUpdateSink = (notification: HostToolNotification) => unknown;

/**
 * A display update about one step's completion stream, sent only when the prepared request enables
 * `stream`. `completion` opens the stream with status `pending`. `completion_update` carries a
 * status change, or a text/thinking delta while the status is `in_progress`. Partial output is
 * display only; the step's answer is the validated response in the turn's `model_settled` event.
 */
export type HostStreamNotification = Readonly<
  {
    sessionId?: string;
    turnId: ActorId;
    /** ID of the completion operation for this step. */
    completionId: ActorId;
    /** The turn's operation counter when this step started; not a step number. */
    generation: number;
    sessionUpdate: "completion" | "completion_update";
    /**
     * `completed` after the response validates; `failed` on failure or cancellation (including
     * barge-in), with `error`.
     */
    status?: "pending" | "in_progress" | "completed" | "failed";
    error?: string;
  } & StreamDelta
>;

/**
 * Observer for {@link HostStreamNotification}s. Best-effort: exceptions and pending promises are
 * ignored and cannot block execution. Not called after the host closes.
 */
export type StreamUpdateSink = (notification: HostStreamNotification) => unknown;

/**
 * Per-dispatch settings a runtime passes with each turn command: the configuration the turn runs
 * with, plus prompt projection and storage callbacks. The host freezes a copy at dispatch, so
 * later changes do not affect operations already dispatched.
 */
export type ExecutionContext = Readonly<{
  /**
   * `ask`: every tool batch goes through a permission request before it runs. `off` or omitted:
   * tools run without one.
   */
  permissions?: "off" | "ask";
  /** Configuration revision; only labels permission logs. */
  policyVersion?: number;
  /**
   * Completion deadline in ms, measured from spawn. Omitted means none. Expiry cancels with
   * classification `timeout`.
   */
  completionTimeoutMs?: number;
  /**
   * Per-tool-call deadline in ms, measured from spawn. Omitted means none. Expiry cancels with
   * classification `timeout`.
   */
  toolTimeoutMs?: number;
  /** The turn's prompt input. Required for `prepare_model` and `prepare_handoff`. */
  prompt?: PromptInput;
  /**
   * Loads the blobs a request references. Preparation calls it to check that attachments load. The
   * completion calls it with `includeContinuations` and passes the resolver to the completion port.
   * Omitted: no resolver is passed.
   */
  loadBlobs?: (
    request: PreparedModel,
    signal: AbortSignal,
    includeContinuations?: boolean,
  ) => Promise<BlobResolver>;
  /**
   * Stores a provider continuation payload. The completion awaits it before it can succeed, and a
   * rejection fails the step. Omitted: the payload is kept inline in the returned continuation.
   */
  storeContinuation?: (
    entry: { provider: string; owner: Continuation["owner"]; payload: unknown },
    signal: AbortSignal,
  ) => Promise<Continuation>;
  /**
   * Stored continuations. Those owned by an assistant message in the prepared request, for the same
   * provider, are attached to it.
   */
  continuations?: readonly Continuation[];
  /** Tool names a completion may call. Omitted: the agent's tools. */
  allowedTools?: readonly string[];
  /**
   * Tool-failure handling. Under `return-error-and-continue`, invalid input is recorded instead of
   * failing the permission request, and a failed tool result is converted on release.
   */
  toolFailure?: Policy["toolFailure"];
  /**
   * Model settings from the configuration. `model` overrides the agent's model. The other fields,
   * and the agent's successors, are applied only when `provider` is set.
   */
  provider?: Pick<
    Policy,
    "provider" | "model" | "thinking" | "thinkingBudgetTokens" | "stream" | "maxOutputTokens"
  >;
  /**
   * Prompt projection: builds the step's messages from the turn's prompt input at the step
   * boundary. The result is validated as chat messages.
   */
  projectPrompt: (input: PromptInput, signal: AbortSignal) => unknown | Promise<unknown>;
  /**
   * Builds the messages carried to the successor agent at a handoff. Omitted: the last user message
   * and the last message.
   */
  projectHandoff?: (
    input: PromptInput & { from: string; to: string },
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
}>;

/**
 * Creates the host that runs a turn's child operations (child: an operation the turn spawned, not a
 * child session): prompt preparation, completions, handoff preparation, permission requests and
 * tool batches. An execution adapter, not another state machine or persistence gate. Outcomes
 * return through `sinks`; none is delivered after `close`.
 *
 * @param bindings - Registries and ports, validated and copied by {@link copyRegistries}.
 *   `sessionId` labels notifications and logs.
 * @throws The errors of {@link copyRegistries}.
 */
export function createHost(
  bindings: ExecutionBindings & { sessionId?: string },
  sinks: {
    /**
     * Receives each child operation's outcome as a {@link TurnEvent} for the named turn:
     * `prepared`, `model_settled`, `handoff_prepared`, `permission_settled` or `batch_settled`.
     */
    turn: (turnId: ActorId, event: TurnEvent) => void;
    /**
     * Receives each tool call's raw outcome. Its tool batch waits until the runtime passes the same
     * object to `releaseTool`.
     */
    tool: (outcome: HostToolOutcome) => void;
    toolUpdate?: ToolUpdateSink;
    streamUpdate?: StreamUpdateSink;
  },
) {
  const ctx = createHostContext(bindings, sinks);
  const dispatch = (
    effect: Extract<ConversationCommand, { type: "turn" }>,
    context: ExecutionContext,
  ): undefined => {
    if (ctx.closed) throw new Error("Host closed");
    context = freeze({
      ...context,
      prompt: context.prompt ? structuredClone(context.prompt) : undefined,
      allowedTools: context.allowedTools?.slice(),
    });
    const { turnId, command } = effect;
    diagnostic("host", "debug", "command.dispatched", {
      sessionId: bindings.sessionId,
      turnId,
      childId: command.child.id,
      operation: command.type,
      provider: context.provider?.provider,
      model: context.provider?.model,
      thinking: context.provider?.thinking,
      thinkingBudgetTokens: context.provider?.thinkingBudgetTokens,
      stream: context.provider?.stream,
      maxOutputTokens: context.provider?.maxOutputTokens,
      ...("turn" in command
        ? { generation: command.turn.generation, stepsRemaining: command.turn.steps }
        : {}),
    });
    switch (command.type) {
      case "cancel":
      case "prepare_model":
      case "complete":
      case "prepare_handoff":
      case "request_permission":
        (hostCommands[command.type] as HostCommandHandler<typeof command.type>)(
          ctx,
          turnId,
          command as never,
          context,
        );
        return undefined;
      case "run_tools": {
        const grant = command.permission ? ctx.grants.get(command.permission.id) : undefined;
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
          ctx.remembered.set(toolName, grantId);
          diagnostic("host", "info", "permission.granted", {
            sessionId: bindings.sessionId,
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
        if (command.permission) ctx.grants.delete(command.permission.id);
        let batch: Actor<BatchState, BatchEvent, BatchCommand>;
        const runBatchCommand = (batchCommand: BatchCommand): undefined => {
          switch (batchCommand.type) {
            case "spawn_tool": {
              const tool = ctx.tools.get(batchCommand.call.name)!;
              const identity = {
                ...(bindings.sessionId ? { sessionId: bindings.sessionId } : {}),
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
                ctx.notifyTool({
                  ...identity,
                  sessionUpdate: "tool_call",
                  title: batchCommand.call.name,
                  name: batchCommand.call.name,
                  kind: tool.kind ?? "other",
                  status: "pending",
                  rawInput: batchCommand.call.args,
                });
              if (ctx.closed) break;
              let status = "pending";

              ctx.spawn(
                batchCommand.child,
                {
                  input: batchCommand.call.args,
                  timeoutMs: context.toolTimeoutMs,
                  failureContext: {
                    operation: {
                      id: batchCommand.child.id,
                      kind: "tool",
                      sessionId: bindings.sessionId,
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
                    if (!ctx.closed && status === "pending" && tool.locations) {
                      try {
                        const locations = z
                          .array(ToolLocationSchema)
                          .parse(tool.locations(structuredClone(input)));
                        diagnostic("host", "debug", "tool.locations_resolved", {
                          ...identity,
                          toolName: batchCommand.call.name,
                          locations,
                        });
                        ctx.notifyTool({
                          ...identity,
                          sessionUpdate: "tool_call_update",
                          locations,
                        });
                      } catch (error) {
                        diagnostic("host", "warning", "tool.locations_failed", {
                          sessionId: bindings.sessionId,
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
                    return typeof parsed.data === "string"
                      ? parsed.data
                      : JSON.stringify(parsed.data);
                  },
                },
                (result) => {
                  const outcome: HostToolOutcome = {
                    turnId,
                    batchId: command.child.id,
                    callId: batchCommand.call.id,
                    result,
                  };
                  ctx.pendingTools.set(`${outcome.batchId}/${outcome.callId}`, {
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
                  sinks.tool(outcome);
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
                  ctx.notifyTool({
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
              ctx.cancel(batchCommand.child, batchCommand.reason);
              break;
            case "notify":
              ctx.children.delete(command.child.id);
              for (const [key, pending] of ctx.pendingTools)
                if (pending.outcome.batchId === command.child.id) ctx.pendingTools.delete(key);
              ctx.post(turnId, {
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
        ctx.children.set(command.child.id, {
          ref: command.child,
          actor: {
            get snapshot() {
              return batch.snapshot;
            },
            cancel: () => batch.send({ type: "cancel" }),
          },
        });
        void batch.send({ type: "start" });
        break;
      }
    }
    return undefined;
  };

  return {
    /**
     * Starts the host side of one turn command: spawns the child operation it names, or, for
     * `cancel`, cancels an active one. Returns once the operation is spawned; its outcome arrives
     * later through `sinks.turn`.
     *
     * @throws When the host is closed; when `prepare_model` or `prepare_handoff` has no
     *   `context.prompt`; when `run_tools` names a permission request that did not approve this
     *   batch.
     */
    dispatch,
    /**
     * Forgets all remembered `allow-session` grants, so later calls of those tools ask again. Call
     * it after committing an explicit permission mode or a changed tool scope; dispatch never
     * infers this from a configuration change. Grants from a settled permission request whose tool
     * batch has not started yet are installed when it starts. `reason` and `correlation` only label
     * the log.
     */
    resetPermissions(reason: string, correlation: { policyVersion: number; appendId: string }) {
      diagnostic("host", "info", "permission.grants_cleared", {
        sessionId: bindings.sessionId,
        reason,
        ...correlation,
        toolNames: [...ctx.remembered.keys()],
      });
      ctx.remembered.clear();
    },
    /**
     * Lets one tool call's outcome count toward its tool batch. Pass the exact object received by
     * `sinks.tool`; other objects, repeats, outcomes of a settled batch, and calls after `close`
     * are ignored. The configured `toolFailure` handling is applied here: under
     * `return-error-and-continue`, a failure other than a timeout becomes a successful result
     * carrying the error.
     */
    releaseTool(outcome: HostToolOutcome) {
      const key = `${outcome.batchId}/${outcome.callId}`;
      const pending = ctx.pendingTools.get(key);
      if (!pending || pending.outcome !== outcome) return;
      ctx.pendingTools.delete(key);
      diagnostic("host", "debug", "tool.released", {
        sessionId: bindings.sessionId,
        turnId: outcome.turnId,
        batchId: outcome.batchId,
        callId: outcome.callId,
      });
      void pending.batch.send({
        type: "tool_settled",
        callId: outcome.callId,
        result: effectiveToolResult(
          outcome.result,
          pending.toolFailure ? { toolFailure: pending.toolFailure } : undefined,
        ),
      });
    },
    /**
     * Cancels every active child operation and drops pending tool releases, permission grants and
     * remembered `allow-session` grants. Afterwards no sink is called and `dispatch` throws. Does
     * not wait for operations to stop.
     */
    close() {
      diagnostic("host", "debug", "host.closed", {
        sessionId: bindings.sessionId,
        activeChildren: ctx.children.size,
        pendingToolReceipts: ctx.pendingTools.size,
        pendingGrants: ctx.grants.size,
      });
      ctx.closed = true;
      for (const { actor } of ctx.children.values()) void actor.cancel();
      ctx.pendingTools.clear();
      ctx.grants.clear();
      ctx.remembered.clear();
    },
    /**
     * Frozen list of active child operations with their current states, for diagnostics and runtime
     * snapshots. Includes each running tool call as well as its tool batch. An operation leaves the
     * list when it settles; a tool batch leaves when it reports `batch_settled`.
     */
    get snapshot() {
      return freeze(
        [...ctx.children.values()].map(({ ref, actor }) => ({ ref, state: actor.snapshot })),
      );
    },
  };
}

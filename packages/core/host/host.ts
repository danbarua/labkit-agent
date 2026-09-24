import { z } from "zod";

import type { ConversationCommand } from "../agent/agent-conversation.ts";
import { admittedCompletionSchema, type TurnEvent } from "../agent/agent-fsm.ts";
import { PreparedModelSchema, type PreparedModel } from "../agent/agent.ts";
import type { BlobResolver } from "../agent/content.ts";
import {
  createOperationActor,
  type Operation,
  type OperationState,
} from "../agent/operation-actor.ts";
import { PermissionDecisionsSchema, type PermissionDecisions } from "../agent/permissions.ts";
import type { PromptInput } from "../agent/prompt.ts";
import {
  toolBatchMachine,
  type BatchCommand,
  type BatchEvent,
  type BatchState,
} from "../agent/tool-batch.ts";
import {
  failure,
  MessagesSchema,
  ref,
  ToolNameSchema,
  type ActorId,
  type ChildRef,
  type Result,
  type ToolCall,
} from "../agent/types.ts";
import { Actor, freeze } from "../fsm/fsm.ts";
import { diagnostic } from "../logging/index.ts";
import { effectiveToolResult, type Policy } from "../policy/policy.ts";
import {
  ContinuationSchema,
  matchingContinuations,
  StreamDeltaSchema,
  type Continuation,
  type StreamDelta,
} from "../providers/types.ts";
import { notify } from "./notifications.ts";
import {
  copyRegistries,
  PermissionResponseSchema,
  ToolLocationSchema,
  type ExecutionBindings,
  type ToolKind,
  type ToolLocation,
} from "./ports.ts";

export type HostToolOutcome = Readonly<{
  turnId: ActorId;
  batchId: ActorId;
  callId: ToolCall["id"];
  result: Result<string>;
}>;
/** Non-authoritative display data. toolCallId is the child ID, not the provider's batch-local call ID. */
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
        status?: "pending" | "in_progress" | "completed" | "failed";
        locations?: readonly ToolLocation[];
        rawOutput?: unknown;
      }
  )
>;
export type ToolUpdateSink = (notification: HostToolNotification) => unknown;

export type HostStreamNotification = Readonly<
  {
    sessionId?: string;
    turnId: ActorId;
    completionId: ActorId;
    generation: number;
    sessionUpdate: "completion" | "completion_update";
    status?: "pending" | "in_progress" | "completed" | "failed";
    error?: string;
  } & StreamDelta
>;
export type StreamUpdateSink = (notification: HostStreamNotification) => unknown;

export type ExecutionContext = Readonly<{
  permissions?: "off" | "ask";
  prompt?: PromptInput;
  loadBlobs?: (
    request: PreparedModel,
    signal: AbortSignal,
    includeContinuations?: boolean,
  ) => Promise<BlobResolver>;
  storeContinuation?: (
    entry: { provider: string; owner: Continuation["owner"]; payload: unknown },
    signal: AbortSignal,
  ) => Promise<Continuation>;
  continuations?: readonly Continuation[];
  allowedTools?: readonly string[];
  toolFailure?: Policy["toolFailure"];
  provider?: Pick<Policy, "provider" | "model" | "thinking" | "stream" | "maxOutputTokens">;
  projectPrompt: (input: PromptInput, signal: AbortSignal) => unknown | Promise<unknown>;
  projectHandoff?: (
    input: PromptInput & { from: string; to: string },
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
}>;
type Child = {
  readonly snapshot: OperationState<unknown> | BatchState;
  cancel(): Promise<unknown>;
};
/** An execution adapter, not another state machine or persistence gate. */
export function createHost(
  bindings: ExecutionBindings & { sessionId?: string },
  sinks: {
    turn: (turnId: ActorId, event: TurnEvent) => void;
    tool: (outcome: HostToolOutcome) => void;
    toolUpdate?: ToolUpdateSink;
    streamUpdate?: StreamUpdateSink;
  },
) {
  const { agents, tools } = copyRegistries(bindings);
  const children = new Map<ActorId, { ref: ChildRef; actor: Child }>();
  const pendingTools = new Map<
    string,
    {
      outcome: HostToolOutcome;
      toolFailure?: Policy["toolFailure"];
      batch: Actor<BatchState, BatchEvent, BatchCommand>;
    }
  >();
  const requestPermission = bindings.requestPermission;
  const grants = new Map<
    ActorId,
    {
      batchId: ActorId;
      approved: boolean;
      inputs: Map<string, unknown>;
      pending: HostToolNotification[];
    }
  >();
  const revoke = (id: ActorId) => {
    const grant = grants.get(id);
    grants.delete(id);
    for (const { sessionId, turnId, batchId, callId, toolCallId } of grant?.pending ?? [])
      notifyTool({
        ...(sessionId ? { sessionId } : {}),
        turnId,
        batchId,
        callId,
        toolCallId,
        sessionUpdate: "tool_call_update",
        status: "failed",
        rawOutput: { error: "Tool permission not granted or cancelled" },
      });
  };
  let closed = false;
  const toolUpdate = sinks.toolUpdate;
  const streamUpdate = sinks.streamUpdate;
  const notifyTool = (notification: HostToolNotification) => {
    if (closed || !toolUpdate) return;
    notify(toolUpdate, notification);
  };
  const post: typeof sinks.turn = (turnId, event) => {
    if (!closed) sinks.turn(turnId, event);
  };
  function spawn<I, O>(
    child: ChildRef,
    operation: Operation<I, O>,
    settled: (result: Result<O>) => void,
    observe?: (state: OperationState<O>) => unknown,
  ) {
    const actor = createOperationActor(
      child,
      operation,
      (result) => {
        children.delete(child.id);
        diagnostic(
          child.kind === "completion" ? "provider" : "host",
          result.kind === "failed" ? "warning" : "debug",
          "child.settled",
          {
            sessionId: bindings.sessionId,
            childId: child.id,
            operation: child.kind,
            outcome: result.kind,
          },
        );
        if (!closed) settled(result);
      },
      observe,
    );
    diagnostic(child.kind === "completion" ? "provider" : "host", "debug", "child.started", {
      sessionId: bindings.sessionId,
      childId: child.id,
      operation: child.kind,
    });
    children.set(child.id, { ref: child, actor });
    void actor.start();
  }
  const cancel = (child: ChildRef) => {
    revoke(child.id);
    diagnostic("host", "debug", "child.cancellation_requested", {
      sessionId: bindings.sessionId,
      childId: child.id,
      operation: child.kind,
    });
    void children.get(child.id)?.actor.cancel();
  };
  const dispatch = (
    effect: Extract<ConversationCommand, { type: "turn" }>,
    context: ExecutionContext,
  ): undefined => {
    if (closed) throw new Error("Host closed");
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
    });
    switch (command.type) {
      case "cancel":
        cancel(command.child);
        break;
      case "prepare_model": {
        const prompt = context.prompt;
        if (!prompt) throw new Error("Host prepare_model requires prompt context");
        const agent = prompt.agent;
        spawn(
          command.child,
          {
            input: null,
            parseInput: z.null().parse,
            run: async (_, signal) => {
              const prepared = PreparedModelSchema.parse({
                model: context.provider?.model ?? agent.model,
                ...(context.provider?.provider
                  ? {
                      provider: context.provider.provider,
                      thinking: context.provider.thinking,
                      stream: context.provider.stream,
                      maxOutputTokens: context.provider.maxOutputTokens,
                      successors: agent.successors ?? [...agents.keys()],
                    }
                  : {}),
                messages: await context.projectPrompt(prompt, signal),
                tools: agent.tools.map((name) => ({
                  type: "function",
                  function: {
                    name,
                    description: tools.get(ToolNameSchema.parse(name))!.description,
                    parameters: tools.get(ToolNameSchema.parse(name))!.parameters,
                  },
                })),
              });
              await context.loadBlobs?.(prepared, signal);
              return prepared;
            },
            parseOutput: (raw) => {
              const prepared = PreparedModelSchema.parse(raw);
              const continuations = matchingContinuations(
                prepared.messages,
                context.continuations ?? [],
                prepared.provider,
              );
              return PreparedModelSchema.parse({
                ...prepared,
                ...(continuations.length ? { continuations } : {}),
              });
            },
          },
          (result) => post(turnId, { type: "prepared", child: command.child, result }),
        );
        break;
      }
      case "complete": {
        const identity = {
          ...(bindings.sessionId ? { sessionId: bindings.sessionId } : {}),
          turnId,
          completionId: command.child.id,
          generation: command.turn.generation,
        };
        let status = "pending";
        const notifyStream = (fields: Omit<HostStreamNotification, keyof typeof identity>) => {
          if (!closed && command.request.stream) notify(streamUpdate, { ...identity, ...fields });
        };
        notifyStream({ sessionUpdate: "completion", status: "pending" });
        if (closed) break;
        const admitted = admittedCompletionSchema(
          new Set(
            command.request.successors ??
              agents.get(command.turn.agent)!.successors ??
              agents.keys(),
          ),
          new Set(context.allowedTools ?? agents.get(command.turn.agent)!.tools),
        );
        spawn(
          command.child,
          {
            input: command.request,
            parseInput: PreparedModelSchema.parseAsync,
            run: async (request, signal) => {
              const blobs = await context.loadBlobs?.(request, signal, true);
              signal.throwIfAborted();
              const raw = await bindings.complete(request, signal, blobs, (delta) => {
                const parsed = StreamDeltaSchema.safeParse(delta);
                if (parsed.success && !signal.aborted && status === "in_progress")
                  notifyStream({ ...parsed.data, sessionUpdate: "completion_update" });
              });
              signal.throwIfAborted();
              const wrapped = raw !== null && typeof raw === "object" && "completion" in raw;
              const output = wrapped
                ? z
                    .strictObject({
                      completion: z.unknown(),
                      continuationPayload: z.unknown().optional(),
                    })
                    .parse(raw)
                : { completion: raw };
              const completion = await admitted.parseAsync(output.completion);
              const continuation =
                output.continuationPayload === undefined
                  ? undefined
                  : await (
                      context.storeContinuation ?? ((entry) => ContinuationSchema.parse(entry))
                    )(
                      {
                        provider: z.string().parse(command.request.provider),
                        owner: { turnId, generation: command.turn.generation },
                        payload: output.continuationPayload,
                      },
                      signal,
                    );
              signal.throwIfAborted();
              return { completion, continuation };
            },
            parseOutput: z.strictObject({
              completion: admitted,
              continuation: ContinuationSchema.optional(),
            }).parseAsync,
          },
          (result) =>
            post(turnId, {
              type: "model_settled",
              child: command.child,
              result:
                result.kind === "succeeded"
                  ? { kind: "succeeded", value: result.value.completion }
                  : result,
              ...(result.kind === "succeeded" &&
              result.value.completion.kind === "tools" &&
              context.permissions === "ask"
                ? { permissionRequired: true as const }
                : {}),
              ...(result.kind === "succeeded" && result.value.continuation
                ? { continuation: result.value.continuation }
                : {}),
            }),
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
            status = next;
            notifyStream({
              sessionUpdate: "completion_update",
              status: next,
              ...(state.status === "failed"
                ? { error: state.error.message }
                : state.status === "cancelled"
                  ? { error: "Completion cancelled" }
                  : {}),
            });
          },
        );
        break;
      }
      case "prepare_handoff": {
        const prompt = context.prompt;
        if (!prompt) throw new Error("Host prepare_handoff requires prompt context");
        spawn(
          command.child,
          {
            input: null,
            parseInput: z.null().parse,
            run: (_, signal) =>
              context.projectHandoff
                ? context.projectHandoff(
                    { ...prompt, from: command.from, to: command.turn.agent },
                    signal,
                  )
                : [
                    command.turn.messages.findLast((message) => message.role === "user"),
                    command.turn.messages.at(-1),
                  ].filter((message) => message !== undefined),
            parseOutput: MessagesSchema.parseAsync,
          },
          (result) => post(turnId, { type: "handoff_prepared", child: command.child, result }),
        );
        break;
      }
      case "request_permission": {
        const grant = {
          batchId: command.batch.id,
          approved: false,
          inputs: new Map<string, unknown>(),
          pending: [] as HostToolNotification[],
        };
        grants.set(command.child.id, grant);
        spawn(
          command.child,
          {
            input: null,
            parseInput: z.null().parse,
            run: async (_, signal) => {
              if (!requestPermission) throw new Error("Missing permission request binding");
              const decisions: PermissionDecisions[number][] = [];
              for (const call of command.completion.calls) {
                signal.throwIfAborted();
                const tool = tools.get(call.name)!;
                const identity = {
                  ...(bindings.sessionId ? { sessionId: bindings.sessionId } : {}),
                  turnId,
                  batchId: command.batch.id,
                  callId: call.id,
                  toolCallId: ref("tool", `${command.batch.id}/${call.id}`).id,
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
                notifyTool(display);
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
                  } catch {
                    diagnostic("host", "warning", "tool.locations_failed", {
                      childId: identity.toolCallId,
                    });
                  }
                }
                if (locations)
                  notifyTool({ ...identity, sessionUpdate: "tool_call_update", locations });
                signal.throwIfAborted();
                const response = PermissionResponseSchema.parse(
                  await requestPermission(
                    freeze({
                      ...(bindings.sessionId ? { sessionId: bindings.sessionId } : {}),
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
                    : response.outcome.optionId === "allow-once"
                      ? "allow_once"
                      : "reject_once";
                decisions.push({ callId: call.id, decision });
                if (decision !== "allow_once") break;
              }
              return decisions;
            },
            parseOutput: PermissionDecisionsSchema.parse,
          },
          (result) => {
            if (
              result.kind !== "succeeded" ||
              result.value.some((entry) => entry.decision !== "allow_once")
            )
              revoke(command.child.id);
            else grant.approved = true;
            post(turnId, { type: "permission_settled", child: command.child, result });
          },
        );
        break;
      }
      case "run_tools": {
        const grant = command.permission ? grants.get(command.permission.id) : undefined;
        if (
          command.permission &&
          (!grant?.approved ||
            grant.batchId !== command.child.id ||
            command.completion.calls.some((call) => !grant.inputs.has(call.id)))
        )
          throw new Error("Missing tool permission grant");
        if (command.permission) grants.delete(command.permission.id);
        let batch: Actor<BatchState, BatchEvent, BatchCommand>;
        const runBatchCommand = (batchCommand: BatchCommand): undefined => {
          switch (batchCommand.type) {
            case "spawn_tool": {
              const tool = tools.get(batchCommand.call.name)!;
              const identity = {
                ...(bindings.sessionId ? { sessionId: bindings.sessionId } : {}),
                turnId,
                batchId: command.child.id,
                callId: batchCommand.call.id,
                toolCallId: batchCommand.child.id,
              };
              if (!grant)
                notifyTool({
                  ...identity,
                  sessionUpdate: "tool_call",
                  title: batchCommand.call.name,
                  name: batchCommand.call.name,
                  kind: tool.kind ?? "other",
                  status: "pending",
                  rawInput: batchCommand.call.args,
                });
              if (closed) break;
              let status = "pending";

              spawn(
                batchCommand.child,
                {
                  input: batchCommand.call.args,
                  parseInput: async (raw) => {
                    if (grant) return grant.inputs.get(batchCommand.call.id);
                    const input = await tool.parseInput(raw);
                    if (!closed && status === "pending" && toolUpdate && tool.locations) {
                      try {
                        const locations = z
                          .array(ToolLocationSchema)
                          .parse(tool.locations(structuredClone(input)));
                        notifyTool({ ...identity, sessionUpdate: "tool_call_update", locations });
                      } catch {
                        diagnostic("host", "warning", "tool.locations_failed", {
                          sessionId: bindings.sessionId,
                          childId: batchCommand.child.id,
                        });
                      }
                    }
                    return input;
                  },
                  run: tool.run,
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
                  pendingTools.set(`${outcome.batchId}/${outcome.callId}`, {
                    outcome,
                    batch,
                    toolFailure: context.toolFailure,
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
                  status = next;
                  notifyTool({
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
              cancel(batchCommand.child);
              break;
            case "notify":
              children.delete(command.child.id);
              for (const [key, pending] of pendingTools)
                if (pending.outcome.batchId === command.child.id) pendingTools.delete(key);
              post(turnId, {
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
        children.set(command.child.id, {
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
    dispatch,
    releaseTool(outcome: HostToolOutcome) {
      const key = `${outcome.batchId}/${outcome.callId}`;
      const pending = pendingTools.get(key);
      if (!pending || pending.outcome !== outcome) return;
      pendingTools.delete(key);
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
    close() {
      diagnostic("host", "debug", "host.closed", { sessionId: bindings.sessionId });
      closed = true;
      for (const { actor } of children.values()) void actor.cancel();
      pendingTools.clear();
      grants.clear();
    },
    get snapshot() {
      return freeze(
        [...children.values()].map(({ ref, actor }) => ({ ref, state: actor.snapshot })),
      );
    },
  };
}

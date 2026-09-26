import { z } from "zod";

import { admittedCompletionSchema } from "../../agent/agent-fsm.ts";
import type { TurnCommand } from "../../agent/agent-fsm.ts";
import { PreparedModelSchema } from "../../agent/agent.ts";
import type { ActorId } from "../../agent/types.ts";
import { diagnostic } from "../../logging/index.ts";
import {
  ContinuationSchema,
  matchingContinuations,
  StreamDeltaSchema,
} from "../../providers/types.ts";
import { CompletionUsageSchema } from "../../providers/usage.ts";
import type { HostContext } from "../context.ts";
import type { ExecutionContext, HostStreamNotification } from "../host.ts";
import { notify } from "../notifications.ts";

/**
 * Prepares the next step's prompt and model configuration.
 * Extracted from the prepare_model case in host dispatch.
 */
export function prepareModel(
  host: HostContext,
  turnId: ActorId,
  command: Extract<TurnCommand, { type: "prepare_model" }>,
  context: ExecutionContext,
): void {
  const prompt = context.prompt;
  if (!prompt) throw new Error("Host prepare_model requires prompt context");
  const agent = prompt.agent;
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
        const prepared = PreparedModelSchema.parse({
          model: context.provider?.model ?? agent.model,
          ...(context.provider?.provider
            ? {
                provider: context.provider.provider,
                thinking: context.provider.thinking,
                thinkingBudgetTokens: context.provider.thinkingBudgetTokens,
                stream: context.provider.stream,
                maxOutputTokens: context.provider.maxOutputTokens,
                successors: agent.successors ?? [...host.agents.keys()],
              }
            : {}),
          messages: await context.projectPrompt(prompt, signal),
          tools: agent.tools.map((name) => ({
            type: "function",
            function: {
              name,
              description: host.tools.get(name)!.description,
              parameters: host.tools.get(name)!.parameters,
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
    (result) => host.post(turnId, { type: "prepared", child: command.child, result }),
  );
}

/**
 * Completes the step's LLM call with the prepared request.
 * Extracted from the complete case in host dispatch.
 */
export function completeModel(
  host: HostContext,
  turnId: ActorId,
  command: Extract<TurnCommand, { type: "complete" }>,
  context: ExecutionContext,
): void {
  const identity = {
    ...(host.sessionId ? { sessionId: host.sessionId } : {}),
    turnId,
    completionId: command.child.id,
    generation: command.turn.generation,
  };
  let status = "pending";

  const notifyStream = (fields: Omit<HostStreamNotification, keyof typeof identity>) => {
    if (!host.closed && command.request.stream)
      notify(host.streamUpdate, { ...identity, ...fields });
  };

  notifyStream({ sessionUpdate: "completion", status: "pending" });
  if (host.closed) return;

  const admitted = admittedCompletionSchema(
    new Set(
      command.request.successors ??
        host.agents.get(command.turn.agent)!.successors ??
        host.agents.keys(),
    ),
    new Set(context.allowedTools ?? host.agents.get(command.turn.agent)!.tools),
  );

  host.spawn(
    command.child,
    {
      input: command.request,
      timeoutMs: context.completionTimeoutMs,
      failureContext: {
        operation: {
          id: command.child.id,
          kind: "completion",
          sessionId: host.sessionId,
          turnId,
        },
      },
      parseInput: PreparedModelSchema.parseAsync,
      run: async (request, signal) => {
        const blobs = await context.loadBlobs?.(request, signal, true);
        signal.throwIfAborted();
        diagnostic("provider", "info", "completion.system_prompt", {
          sessionId: host.sessionId,
          turnId,
          childId: command.child.id,
          agentId: command.turn.agent,
          provider: request.provider,
          model: request.model,
          message: "System instructions supplied to this completion, in order",
          systemMessages: request.messages.filter((message) => message.role === "system"),
        });
        const raw = await host.complete(
          request,
          signal,
          blobs,
          (delta) => {
            const parsed = StreamDeltaSchema.safeParse(delta);
            if (parsed.success && !signal.aborted && status === "in_progress")
              notifyStream({ ...parsed.data, sessionUpdate: "completion_update" });
          },
          {
            sessionId: host.sessionId,
            turnId,
            childId: command.child.id,
            generation: command.turn.generation,
          },
        );
        signal.throwIfAborted();
        const wrapped = raw !== null && typeof raw === "object" && "completion" in raw;
        const output = wrapped
          ? z
              .strictObject({
                completion: z.unknown(),
                continuationPayload: z.unknown().optional(),
                usage: CompletionUsageSchema.optional(),
              })
              .parse(raw)
          : { completion: raw };
        const completion = await admitted.parseAsync(output.completion);
        const continuation =
          output.continuationPayload === undefined
            ? undefined
            : await (context.storeContinuation ?? ((entry) => ContinuationSchema.parse(entry)))(
                {
                  provider: z.string().parse(command.request.provider),
                  owner: { turnId, generation: command.turn.generation },
                  payload: output.continuationPayload,
                },
                signal,
              );
        signal.throwIfAborted();
        if (output.usage)
          diagnostic("provider", "info", "completion.usage.received", {
            sessionId: host.sessionId,
            turnId,
            childId: command.child.id,
            model: request.model,
            usage: output.usage,
            message: "Completion response usage validated; awaiting runtime settlement",
          });
        return { completion, continuation, usage: output.usage };
      },
      parseOutput: z.strictObject({
        completion: admitted,
        continuation: ContinuationSchema.optional(),
        usage: CompletionUsageSchema.optional(),
      }).parseAsync,
    },
    (result) =>
      host.post(turnId, {
        type: "model_settled",
        child: command.child,
        ...(result.kind === "succeeded" && result.value.usage ? { usage: result.value.usage } : {}),
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
}

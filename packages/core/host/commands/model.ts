import { z } from "zod";

import { admittedCompletionSchema } from "../../agent/agent-fsm.ts";
import type { TurnCommand } from "../../agent/agent-fsm.ts";
import { PreparedModelSchema } from "../../agent/agent.ts";
import { CompletionSchema, type ActorId } from "../../agent/types.ts";
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
 * Projects the step's prompt and makes its LLM call as one host operation: preparation failures
 * (an unreadable attachment, a projection error) and completion failures both settle as
 * `model_settled`, so the turn machine never sees the prompt that produced a request, only its
 * output.
 */
export function completeModel(
  host: HostContext,
  turnId: ActorId,
  command: Extract<TurnCommand, { type: "complete" }>,
  context: ExecutionContext,
): void {
  const prompt = context.prompt;
  if (!prompt) throw new Error("Host complete requires prompt context");
  const agent = prompt.agent;
  const model = context.provider?.model ?? agent.model;
  const provider = context.provider?.provider;
  if (host.closed) return;
  const identity = {
    ...(host.sessionId ? { sessionId: host.sessionId } : {}),
    turnId,
    completionId: command.child.id,
    generation: command.turn.generation,
  };
  let status = "pending";
  let stream = false;
  const notifyStream = (fields: Omit<HostStreamNotification, keyof typeof identity>) => {
    if (!host.closed && stream) notify(host.streamUpdate, { ...identity, ...fields });
  };

  host.spawn(
    command.child,
    {
      failureContext: {
        operation: {
          id: command.child.id,
          kind: "completion",
          sessionId: host.sessionId,
          turnId,
        },
      },
      timeoutMs: context.completionTimeoutMs,
      input: null,
      parseInput: z.null().parse,
      run: async (_, signal) => {
        const projected = await context.projectPrompt(prompt, signal);
        for (const pointer of projected.pointers)
          diagnostic("prompt", "debug", "prompt.media.pointer", {
            sessionId: host.sessionId,
            turnId,
            childId: command.child.id,
            provider: prompt.target?.provider,
            model: prompt.target?.model,
            media: pointer.media,
            bytes: pointer.bytes,
            support: pointer.support,
            blobId: pointer.blobId,
          });
        const prepared = PreparedModelSchema.parse({
          model,
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
          messages: projected.messages,
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
        const continuations = matchingContinuations(
          prepared.messages,
          context.continuations ?? [],
          prepared.provider,
        );
        const request = PreparedModelSchema.parse({
          ...prepared,
          ...(continuations.length ? { continuations } : {}),
        });
        // Whether the step streams is known only once its request is projected, after the
        // operation already started running, so both opening statuses are published here, and
        // only for a step still live: a cancelled or timed-out step must not open a stream.
        signal.throwIfAborted();
        stream = !!request.stream;
        notifyStream({ sessionUpdate: "completion", status: "pending" });
        notifyStream({ sessionUpdate: "completion_update", status: "in_progress" });
        const admitted = admittedCompletionSchema(
          new Set(
            request.successors ??
              host.agents.get(command.turn.agent)!.successors ??
              host.agents.keys(),
          ),
          new Set(context.allowedTools ?? host.agents.get(command.turn.agent)!.tools),
        );
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
                  provider: z.string().parse(request.provider),
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
        completion: CompletionSchema.brand<"AdmittedCompletion">(),
        continuation: ContinuationSchema.optional(),
        usage: CompletionUsageSchema.optional(),
      }).parseAsync,
    },
    (result) =>
      host.post(turnId, {
        type: "model_settled",
        child: command.child,
        result:
          result.kind === "succeeded"
            ? { kind: "succeeded", value: result.value.completion }
            : result,
        model,
        ...(provider ? { provider } : {}),
        ...(result.kind === "succeeded" && result.value.usage ? { usage: result.value.usage } : {}),
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

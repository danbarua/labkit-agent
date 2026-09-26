import type { ConversationCommand } from "../../agent/agent-conversation.ts";
import { blobRefs } from "../../agent/content.ts";
import { projectPolicy } from "../../policy/policy.ts";
import {
  continuationBlobRefs,
  copyBranchBlobs,
  resolveRequestBlobs,
  storeContinuation,
} from "../blobs.ts";
import { toSeed } from "../session-log.ts";
import type { Seed } from "../types.ts";
import type { SessionInstance } from "./instance.ts";

/** The conversation command of type `K`. */
type Effect<K extends ConversationCommand["type"]> = Extract<ConversationCommand, { type: K }>;

async function initializeBranch(ctx: SessionInstance, seed: Seed) {
  const controller = new AbortController();
  const owned = { cancel: async () => controller.abort() };
  ctx.storage.add(owned);
  try {
    await copyBranchBlobs(
      ctx.configured.port,
      ctx.sessionId,
      seed.sessionId,
      [
        ...blobRefs([...seed.context, ...seed.log.flatMap((record) => record.messages)]),
        ...continuationBlobRefs(seed.continuations ?? []),
      ],
      controller.signal,
    );
    controller.signal.throwIfAborted();
    return await ctx.initializeChild(seed);
  } finally {
    ctx.storage.delete(owned);
  }
}

function publishBranchReply(ctx: SessionInstance, effect: Effect<"reply">) {
  const reply = ctx.branchReplies.get(effect.requestId);
  if (reply)
    void initializeBranch(ctx, toSeed(ctx.dispatchBoundary, effect.result.state)).then(
      (child) => {
        ctx.branchReplies.delete(effect.requestId);
        if (ctx.actor.snapshot.status === "closed" || ctx.actor.snapshot.status === "failed") {
          void child.close();
          reply.reject(new Error("Parent closed before branch publication"));
        } else reply.resolve(child);
      },
      (error) => {
        ctx.branchReplies.delete(effect.requestId);
        reply.reject(error);
      },
    );
}

function dispatchTurn(ctx: SessionInstance, effect: Effect<"turn">) {
  const { sessionId } = ctx;
  const durable = ctx.actor.snapshot.durable;
  const policy = durable.policy;
  const prompt = "turn" in effect.command ? ctx.promptInput(effect.command.turn) : undefined;
  ctx.host.dispatch(effect, {
    prompt,
    allowedTools: prompt?.agent.tools,
    toolFailure: policy?.toolFailure,
    permissions: policy?.permissions,
    policyVersion: policy?.version,
    completionTimeoutMs: policy?.completionTimeoutMs ?? undefined,
    toolTimeoutMs: policy?.toolTimeoutMs ?? undefined,
    provider: policy,
    continuations: durable.continuations,
    storeContinuation: (entry, signal) =>
      storeContinuation(ctx.configured.port, sessionId, entry, signal),
    loadBlobs: (request, signal, includeContinuations) =>
      resolveRequestBlobs(
        ctx.configured.port,
        sessionId,
        request,
        ctx.configured.providerMedia?.(request.provider ?? "", request.model) ?? [],
        signal,
        includeContinuations,
      ),
    projectPrompt: (value) =>
      projectPolicy(value, durable.systemInputs, policy, ctx.configured.resolvers),
    projectHandoff: (value) => ctx.configured.resolvers.handoffs.get(policy.handoff)!(value),
  });
}

/** Handler for each command type the conversation machine emits. */
const conversationEffects: {
  [K in ConversationCommand["type"]]: (ctx: SessionInstance, effect: Effect<K>) => void;
} = { reply: publishBranchReply, turn: dispatchTurn };

/** Runs one conversation command; a synchronous throw is reported by the caller. */
export function executeConversationCommand<K extends ConversationCommand["type"]>(
  ctx: SessionInstance,
  effect: Effect<K>,
): void {
  conversationEffects[effect.type](ctx, effect);
}

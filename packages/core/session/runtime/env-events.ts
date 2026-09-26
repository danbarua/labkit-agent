import type { z } from "zod";

import type { SessionRequest } from "../../agent/agent-conversation.ts";
import { ActorIdSchema, failure, SessionIdSchema } from "../../agent/types.ts";
import { diagnostic } from "../../logging/index.ts";
import { EnvEventSchema } from "../events.ts";
import { AppendIdSchema } from "../persistence.ts";
import { wireEvent } from "../session-log.ts";
import type { EnvCommandHandle, SessionRuntime, TerminalResult } from "../session-runtime.ts";
import { SystemVersionSchema, type SessionInput } from "../types.ts";
import type { SessionInstance } from "./instance.ts";

/** A validated public event. */
type ParsedEvent = z.output<typeof EnvEventSchema>;

/** The validated public event of type `K`. */
type Event<K extends ParsedEvent["type"]> = Extract<ParsedEvent, { type: K }>;

function branch(ctx: SessionInstance, request: SessionRequest) {
  let resolve!: (runtime: SessionRuntime) => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<SessionRuntime>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  ctx.branchReplies.set(request.id, { resolve, reject });
  const accepted = ctx.submit({
    kind: "event",
    event: wireEvent({ type: "request", request }),
    systemVersion: ctx.actor.snapshot.durable.systemVersion,
  });
  void accepted.then((receipt) => {
    if (receipt.kind !== "accepted") {
      ctx.branchReplies.delete(request.id);
      reject(new Error(`Branch ${receipt.kind}`));
    }
  });
  return { accepted, settled };
}

/**
 * Journal the live registry ahead of the first new work. That work queues behind this append in
 * the session actor, so its commit-time prompt checks run against the registry it actually uses.
 */
function adopt(ctx: SessionInstance) {
  const { sessionId } = ctx;
  if (!ctx.adoption.plan || ctx.adoption.submitted) return;
  ctx.adoption.submitted = true;
  const { body, differences } = ctx.adoption.plan;
  const revision = ctx.actor.snapshot.durable.revision;
  const appendId = AppendIdSchema.parse(`configuration/${sessionId}/${revision}`);
  void ctx.submit(body, undefined, undefined, appendId).then((receipt) => {
    if (receipt.kind === "accepted" || receipt.kind === "closed") return;
    diagnostic("session", "error", "session.registry.adoption_failed", {
      sessionId,
      appendId,
      revision,
      differences,
      outcome: receipt.kind,
      ...(receipt.kind === "failed"
        ? { reason: receipt.message, error: receipt.error }
        : { reason: `Registry adoption ${receipt.kind}` }),
      consequence: "submissions queued behind the adoption fail with this cause",
    });
  });
}

function user(ctx: SessionInstance, event: Event<"user">): EnvCommandHandle {
  let settle!: (result: TerminalResult) => void;
  const settled = new Promise<TerminalResult>((resolve) => {
    settle = resolve;
  });
  const accepted = ctx.submit(
    { kind: "event", event, systemVersion: ctx.actor.snapshot.durable.systemVersion },
    undefined,
    settle,
  );
  return { accepted, settled };
}

function branchEvent(ctx: SessionInstance, event: Event<"fork" | "compact">): EnvCommandHandle {
  const { sessionId } = ctx;
  const request = {
    id: ActorIdSchema.parse(ctx.configured.id()),
    sessionId: SessionIdSchema.parse(ctx.configured.id()),
  };
  const handle = branch(
    ctx,
    event.type === "fork"
      ? { ...request, kind: "fork" }
      : { ...request, kind: "compact", context: event.context },
  );
  return {
    accepted: handle.accepted,
    settled: handle.settled.then(
      (child) => ({ kind: "branch" as const, session: child }),
      (error) => {
        const cause = failure(error, {
          classification: "execution",
          operation: { id: request.id, kind: "branch", sessionId },
          phase: "publication",
        });
        return { kind: "failed" as const, message: cause.message, error: cause };
      },
    ),
  };
}

function close(ctx: SessionInstance): EnvCommandHandle {
  const accepted = ctx.send({ type: "close" }).then(() => ({
    kind: "close_acknowledged" as const,
  }));
  return {
    accepted,
    settled: accepted.then((receipt) => ({ kind: "acknowledged", receipt })),
  };
}

function submitAcknowledged(
  ctx: SessionInstance,
  event: Event<"system" | "policy" | "abort">,
): EnvCommandHandle {
  const input: SessionInput =
    event.type === "system"
      ? {
          kind: "system",
          inputs: event.inputs,
          version: SystemVersionSchema.parse(ctx.actor.snapshot.durable.systemVersion + 1),
        }
      : event.type === "policy"
        ? { kind: "policy", patch: event.patch }
        : { kind: "event", event, systemVersion: ctx.actor.snapshot.durable.systemVersion };
  const accepted = ctx.submit(input);
  return { accepted, settled: accepted.then((receipt) => ({ kind: "acknowledged", receipt })) };
}

/** Handler for each public event type. */
const envEventHandlers: {
  [K in ParsedEvent["type"]]: (ctx: SessionInstance, event: Event<K>) => EnvCommandHandle;
} = {
  user,
  fork: branchEvent,
  compact: branchEvent,
  close,
  system: submitAcknowledged,
  policy: submitAcknowledged,
  abort: submitAcknowledged,
};

function handleEvent<K extends ParsedEvent["type"]>(
  ctx: SessionInstance,
  event: Event<K>,
): EnvCommandHandle {
  return envEventHandlers[event.type](ctx, event);
}

/**
 * Validates and submits a public event. Every event except `abort` and `close` first submits a
 * pending registry adoption.
 * @throws when `raw` does not match {@link EnvEventSchema}.
 */
export function dispatchEvent(ctx: SessionInstance, raw: unknown): EnvCommandHandle {
  const { sessionId } = ctx;
  const event = EnvEventSchema.parse(raw);
  diagnostic("session", "debug", "event.received", { sessionId, operation: event.type });
  if (event.type !== "close" && event.type !== "abort") adopt(ctx);
  return handleEvent(ctx, event);
}

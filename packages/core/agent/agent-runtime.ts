import { z } from "zod";

import { Actor, freeze } from "../fsm/fsm.ts";
import { createHost, type ToolUpdateSink } from "../host/host.ts";
import { copyRegistries, type AgentDefinition, type Tool } from "../host/ports.ts";
import {
  decideConversation,
  initialConversation,
  type ConversationCommand,
  type ConversationEvent,
  type ConversationState,
  type SessionReply,
  type SessionRequest,
} from "./agent-conversation.ts";
import type { TurnEvent } from "./agent-fsm.ts";
import { createChatCompletion, type ChatCompletionRequest } from "./agent.ts";
import type { OperationState } from "./operation-actor.ts";
import { parseSessionContext, projectConversationPrompt, type PromptInput } from "./prompt.ts";
import type { BatchState } from "./tool-batch.ts";
import {
  ActorIdSchema,
  AgentIdSchema,
  failure,
  SessionIdSchema,
  StepsSchema,
  UserEventSchema,
  type ActorId,
  type ChildRef,
  type TurnData,
} from "./types.ts";

export { projectConversationPrompt } from "./prompt.ts";
export type { PromptInput } from "./prompt.ts";

export { defineTool } from "../host/ports.ts";

export type { Tool, AgentDefinition };
export type { HostToolNotification, ToolUpdateSink } from "../host/host.ts";
export type { ToolKind, ToolLocation } from "../host/ports.ts";
export type RuntimeOptions = {
  agent: string;
  agents: ReadonlyMap<string, AgentDefinition>;
  tools?: ReadonlyMap<string, Tool>;
  toolUpdate?: ToolUpdateSink;
  steps: number;
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Adapters return untrusted data; the completion actor parses and admits it. */
  complete?: (request: ChatCompletionRequest) => unknown | Promise<unknown>;
  projectPrompt?: (input: PromptInput, signal: AbortSignal) => unknown | Promise<unknown>;
  projectHandoff?: (
    input: PromptInput & { from: string; to: string },
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
};
export type ChildSnapshot = Readonly<{
  ref: ChildRef;
  state: OperationState<unknown> | BatchState;
}>;
export type RuntimeSnapshot = Readonly<{
  conversation: ConversationState;
  children: readonly ChildSnapshot[];
}>;
export type AgentRuntime = {
  readonly snapshot: RuntimeSnapshot;
  fire(event: unknown): Promise<RuntimeSnapshot>;
  /** Resolve at the next completed-turn boundary with an independent runtime. */
  fork(): Promise<AgentRuntime>;
  /** Fork with validated replacement messages, clearing inherited transcript/context. */
  compact(context: unknown): Promise<AgentRuntime>;
};

export function createAgentRuntime(options: RuntimeOptions): AgentRuntime {
  const agentId = AgentIdSchema.parse(options.agent);
  const steps = StepsSchema.parse(options.steps);
  const baseUrl = z.url({ protocol: /^https?$/ }).parse(options.baseUrl);
  const { agents, tools } = copyRegistries(options);
  if (!agents.has(agentId)) throw new Error(`Unknown agent: ${agentId}`);
  const apiKey = options.apiKey;
  const fetcher = options.fetch;
  const projectHandoff = options.projectHandoff;
  const toolUpdate = options.toolUpdate;
  const complete =
    options.complete ??
    ((request: ChatCompletionRequest) => createChatCompletion(request, fetcher));
  const project = options.projectPrompt ?? projectConversationPrompt;
  function build(initial: ConversationState): AgentRuntime {
    const replies = new Map<ActorId, (reply: SessionReply) => void>();

    let conversation: Actor<ConversationState, ConversationEvent, ConversationCommand>;
    const input = (turn: TurnData): PromptInput => ({
      context: conversation.snapshot.context,
      log: conversation.snapshot.log,
      turn,
      agent: agents.get(turn.agent)!,
    });
    const post = (turnId: ActorId, event: TurnEvent) => {
      // Only validated, typed child outcomes enter this private mailbox.
      void conversation.send({ type: "child", turnId, event });
    };
    const host = createHost(
      {
        agents,
        tools,
        sessionId: initial.sessionId,
        complete: (request, signal) => complete({ ...request, baseUrl, apiKey, signal }),
      },
      {
        turn: post,
        toolUpdate,
        tool: (outcome) => host.releaseTool(outcome),
      },
    );
    const execute = (effect: ConversationCommand): undefined => {
      if (effect.type === "reply") {
        const reply = replies.get(effect.requestId);
        replies.delete(effect.requestId);
        reply?.(effect.result);
      } else
        host.dispatch(effect, {
          prompt: "turn" in effect.command ? input(effect.command.turn) : undefined,
          projectPrompt: project,
          projectHandoff,
        });
      return undefined;
    };
    conversation = new Actor<ConversationState, ConversationEvent, ConversationCommand>(
      initial,
      decideConversation,
      execute,
      (command, error) => ({ type: "dispatch_failed", command, error: failure(error) }),
    );
    const snapshot = (): RuntimeSnapshot =>
      freeze({
        conversation: conversation.snapshot,
        children: host.snapshot,
      });
    const enqueue = (request: SessionRequest): Promise<SessionReply> =>
      new Promise((resolve, reject) => {
        replies.set(request.id, resolve);
        void conversation.send({ type: "request", request }).catch((error) => {
          replies.delete(request.id);
          reject(error);
        });
      });
    const requestId = () =>
      ActorIdSchema.parse(`${initial.sessionId}/request/${crypto.randomUUID()}`);
    const branch = async (request: SessionRequest): Promise<AgentRuntime> => {
      const reply = await enqueue(request);
      return build(reply.state);
    };
    return {
      get snapshot() {
        return snapshot();
      },
      async fire(raw) {
        await conversation.send(UserEventSchema.parse(raw));
        return snapshot();
      },
      fork: () =>
        branch({
          kind: "fork",
          id: requestId(),
          sessionId: SessionIdSchema.parse(crypto.randomUUID()),
        }),
      async compact(raw) {
        const context = parseSessionContext(raw);
        return branch({
          kind: "compact",
          id: requestId(),
          sessionId: SessionIdSchema.parse(crypto.randomUUID()),
          context,
        });
      },
    };
  }
  return build(initialConversation(agentId, steps));
}

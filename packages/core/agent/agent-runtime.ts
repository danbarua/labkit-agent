import { z } from "zod";

import { Actor, freeze } from "../fsm/fsm.ts";
import { createHost, type StreamUpdateSink, type ToolUpdateSink } from "../host/host.ts";
import {
  copyRegistries,
  type AgentDefinition,
  type PermissionPort,
  type Tool,
} from "../host/ports.ts";
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
export type {
  HostToolNotification,
  ToolUpdateSink,
  HostStreamNotification,
  StreamUpdateSink,
} from "../host/host.ts";
export type { PermissionPort, PermissionRequest, ToolKind, ToolLocation } from "../host/ports.ts";
/** Configuration for {@link createAgentRuntime}. The agent and tool maps are copied at creation. */
export type RuntimeOptions = {
  /** Id of the agent that runs the first turn; must be a key of `agents`. */
  agent: string;
  agents: ReadonlyMap<string, AgentDefinition>;
  tools?: ReadonlyMap<string, Tool>;
  toolUpdate?: ToolUpdateSink;
  streamUpdate?: StreamUpdateSink;
  /** When set, tool calls ask this port for permission; when omitted, permissions are off. */
  requestPermission?: PermissionPort;
  /** Step allowance of each turn (LLM calls per turn). */
  steps: number;
  /** http(s) base URL of the chat completions endpoint. */
  baseUrl: string;
  apiKey?: string;
  /** Fetch used by the default completion adapter. */
  fetch?: typeof fetch;
  /** Adapters return untrusted data; the completion actor parses and admits it. */
  complete?: (request: ChatCompletionRequest) => unknown | Promise<unknown>;
  /** Prompt projection for each step; defaults to {@link projectConversationPrompt}. */
  projectPrompt?: (input: PromptInput, signal: AbortSignal) => unknown | Promise<unknown>;
  /** Builds the successor agent's context on a handoff. */
  projectHandoff?: (
    input: PromptInput & { from: string; to: string },
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
};
/** Snapshot of one live child operation of a turn (not a child session): an operation or a tool batch. */
export type ChildSnapshot = Readonly<{
  ref: ChildRef;
  state: OperationState<unknown> | BatchState;
}>;
/** Frozen view of the conversation state and its live child operations. */
export type RuntimeSnapshot = Readonly<{
  conversation: ConversationState;
  children: readonly ChildSnapshot[];
}>;
/** An in-memory conversation driven by user events; turns run through the host in the background. */
export type AgentRuntime = {
  /** Current snapshot, rebuilt on each read. */
  readonly snapshot: RuntimeSnapshot;
  /**
   * Sends a user event (prompt text or abort) to the conversation.
   * Resolves once the event is decided and its commands are dispatched, not when the turn ends.
   * @throws Rejects when `event` fails {@link UserEventSchema} or the conversation refuses it (for
   * example user input while tools are pending).
   */
  fire(event: unknown): Promise<RuntimeSnapshot>;
  /**
   * Resolves at the next turn boundary with an independent runtime for a new session that inherits
   * this session's history. Resolves immediately when no turn is active.
   */
  fork(): Promise<AgentRuntime>;
  /**
   * Like {@link AgentRuntime.fork}, but the new session starts with an empty history and `context`
   * as its session context. "Replacement" here is compaction context, not barge-in.
   * @throws Rejects when `context` is not a valid session context.
   */
  compact(context: unknown): Promise<AgentRuntime>;
};

/**
 * Creates a runtime for a new root session with an idle first turn.
 * @throws When `agent` is not in `agents`, `steps` is not a valid step count or `baseUrl` is not
 * an http(s) URL.
 */
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
  const streamUpdate = options.streamUpdate;
  const requestPermission = options.requestPermission;
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
        requestPermission,
        complete: (request, signal) => complete({ ...request, baseUrl, apiKey, signal }),
      },
      {
        turn: post,
        toolUpdate,
        streamUpdate,
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
          permissions: requestPermission ? "ask" : "off",
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

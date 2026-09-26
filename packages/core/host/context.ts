import type { TurnEvent } from "../agent/agent-fsm.ts";
import { createOperationActor } from "../agent/operation-actor.ts";
import type { Operation, OperationState } from "../agent/operation-actor.ts";
import type { BatchCommand, BatchEvent, BatchState } from "../agent/tool-batch.ts";
import type { ActorId, AgentId, ChildRef, Failure, Result } from "../agent/types.ts";
import type { Actor } from "../fsm/fsm.ts";
import { diagnostic, diagnosticError } from "../logging/index.ts";
import type { Policy } from "../policy/policy.ts";
import type {
  HostToolNotification,
  HostToolOutcome,
  StreamUpdateSink,
  ToolUpdateSink,
} from "./host.ts";
import { notify } from "./notifications.ts";
import {
  copyRegistries,
  type AgentDefinition,
  type CompletionPort,
  type ExecutionBindings,
  type PermissionPort,
  type Tool,
} from "./ports.ts";

/**
 * The snapshot and cancel capability of a running child operation.
 */
export type Child = {
  readonly snapshot: OperationState<unknown> | BatchState;
  cancel(reason?: Failure): Promise<unknown>;
};

/**
 * A child operation and its lifecycle reference.
 */
export type HostChild = {
  readonly ref: ChildRef;
  readonly actor: Child;
};

/**
 * A pending tool release waiting for releaseTool to be called on it.
 */
export type PendingToolRelease = {
  outcome: HostToolOutcome;
  toolFailure?: Policy["toolFailure"];
  batch: Actor<BatchState, BatchEvent, BatchCommand>;
};

/**
 * A permission grant for one batch, tracking inputs, invalidInputs, and pending notifications.
 */
export type PermissionGrant = {
  batchId: ActorId;
  approved: boolean;
  inputs: Map<string, unknown>;
  invalidInputs: Map<string, Failure>;
  pending: HostToolNotification[];
  remembered: Map<string, string>;
};

/**
 * The shared execution context holding closure state for a host instance.
 */
export type HostContext = {
  closed: boolean;
  readonly sessionId: string | undefined;
  readonly complete: CompletionPort;
  readonly requestPermission: PermissionPort | undefined;
  readonly agents: Map<AgentId, AgentDefinition>;
  readonly tools: Map<string, Tool>;
  readonly children: Map<ActorId, HostChild>;
  readonly pendingTools: Map<string, PendingToolRelease>;
  readonly grants: Map<ActorId, PermissionGrant>;
  readonly remembered: Map<string, string>;
  readonly streamUpdate: StreamUpdateSink | undefined;
  readonly reportTool: (outcome: HostToolOutcome) => void;
  readonly post: (turnId: ActorId, event: TurnEvent) => void;
  readonly notifyTool: (notification: HostToolNotification) => void;
  readonly revoke: (id: ActorId, reason: string) => void;
  readonly spawn: <I, O>(
    child: ChildRef,
    operation: Operation<I, O>,
    settled: (result: Result<O>) => void,
    observe?: (state: OperationState<O>) => unknown,
  ) => void;
  readonly cancel: (child: ChildRef, reason?: Failure) => void;
};

/**
 * Creates the execution context for a host instance, returning an object with all closure state.
 */
export function createHostContext(
  bindings: ExecutionBindings & { sessionId?: string },
  sinks: {
    turn: (turnId: ActorId, event: TurnEvent) => void;
    tool: (outcome: HostToolOutcome) => void;
    toolUpdate?: ToolUpdateSink;
    streamUpdate?: StreamUpdateSink;
  },
): HostContext {
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
  const remembered = new Map<string, string>();

  const grants = new Map<
    ActorId,
    {
      batchId: ActorId;
      approved: boolean;
      inputs: Map<string, unknown>;
      invalidInputs: Map<string, Failure>;
      pending: HostToolNotification[];
      remembered: Map<string, string>;
    }
  >();

  const ctx: HostContext = {
    closed: false,
    sessionId: bindings.sessionId,
    complete: bindings.complete,
    requestPermission,
    agents,
    tools,
    children,
    pendingTools,
    grants,
    remembered,
    streamUpdate: sinks.streamUpdate,
    reportTool: (outcome: HostToolOutcome) => {
      sinks.tool(outcome);
    },
    post: (turnId: ActorId, event: TurnEvent) => {
      if (!ctx.closed) sinks.turn(turnId, event);
    },
    notifyTool: (notification: HostToolNotification) => {
      if (ctx.closed || !toolUpdate) return;
      notify(toolUpdate, notification);
    },
    revoke: (id: ActorId, reason: string) => {
      const grant = grants.get(id);
      grants.delete(id);
      for (const { sessionId, turnId, batchId, callId, toolCallId } of grant?.pending ?? [])
        ctx.notifyTool({
          ...(sessionId ? { sessionId } : {}),
          turnId,
          batchId,
          callId,
          toolCallId,
          sessionUpdate: "tool_call_update",
          status: "failed",
          rawOutput: { error: reason },
        });
    },
    spawn: <I, O>(
      child: ChildRef,
      operation: Operation<I, O>,
      settled: (result: Result<O>) => void,
      observe?: (state: OperationState<O>) => unknown,
    ) => {
      const startedAt = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const attempt = async <T>(
        phase: string,
        run: () => T | Promise<T>,
        signal?: AbortSignal,
      ): Promise<T> => {
        try {
          return await run();
        } catch (error) {
          diagnostic(
            child.kind === "completion" ? "provider" : "host",
            signal?.aborted ? "info" : "warning",
            signal?.aborted ? "child.cancelled" : "child.failed",
            {
              sessionId: bindings.sessionId,
              childId: child.id,
              phase,
              error: diagnosticError(error),
            },
          );
          throw error;
        }
      };
      const actor = createOperationActor(
        child,
        {
          ...operation,
          input: operation.input,
          parseInput: (input) => attempt("validate_input", () => operation.parseInput(input)),
          run: (input, signal) => attempt("run", () => operation.run(input, signal), signal),
          parseOutput: (output) => attempt("validate_output", () => operation.parseOutput(output)),
        },
        (result) => {
          if (timer !== undefined) clearTimeout(timer);
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
              durationMs: Math.round(performance.now() - startedAt),
              ...(result.kind === "failed" ? { error: diagnosticError(result.error) } : {}),
            },
          );
          if (!ctx.closed) settled(result);
        },
        observe,
      );
      diagnostic(child.kind === "completion" ? "provider" : "host", "debug", "child.started", {
        sessionId: bindings.sessionId,
        childId: child.id,
        operation: child.kind,
      });
      children.set(child.id, { ref: child, actor });
      if (operation.timeoutMs !== undefined) {
        const timeoutMs = operation.timeoutMs;
        timer = setTimeout(() => {
          const reason: Failure = {
            message: `${child.kind} operation ${child.id} exceeded its ${timeoutMs} ms deadline`,
            classification: "timeout",
            timeoutMs,
            phase: actor.snapshot.status,
            operation: {
              id: child.id,
              kind: child.kind,
              sessionId: bindings.sessionId,
              ...operation.failureContext?.operation,
            },
          };
          diagnostic("host", "warning", "child.timed_out", {
            ...reason,
            sessionId: bindings.sessionId,
            childId: child.id,
          });
          void actor.cancel(reason);
        }, timeoutMs);
      }
      void actor.start();
    },
    cancel: (child: ChildRef, reason?: Failure) => {
      ctx.revoke(child.id, reason?.message ?? "Tool permission request cancelled");
      diagnostic("host", "debug", "child.cancellation_requested", {
        sessionId: bindings.sessionId,
        childId: child.id,
        operation: child.kind,
        reason,
      });
      void children
        .get(child.id)
        ?.actor.cancel(reason ? { ...reason, classification: "cancelled" } : undefined);
    },
  };

  const toolUpdate = sinks.toolUpdate;

  return ctx;
}

import type { TurnCommand } from "../agent/agent-fsm.ts";
import type { MediaPointerEvent } from "../agent/prompt.ts";
import type { ActorId, AgentId, Failure, OperationKind, Result, Steps } from "../agent/types.ts";
import type { ToolKind, ToolLocation } from "../host/ports.ts";
import {
  diagnostic,
  type DiagnosticError,
  type DiagnosticFields,
  type LogLevel,
} from "../logging/index.ts";
import type { Policy } from "../policy/policy.ts";
import type { CompletionUsage } from "../providers/usage.ts";

/** Identity shared by every event raised while a permission request or a tool call is live. */
export type ToolIdentity = Readonly<{
  sessionId?: string;
  turnId?: ActorId;
  batchId?: ActorId;
  callId?: string;
  toolCallId?: string;
  name?: string;
}>;

/** `ToolIdentity` plus the fields every permission-decision event carries. */
export type PermissionContext = ToolIdentity &
  Readonly<{
    childId: ActorId;
    requestId: string;
    toolName: string;
    locations?: readonly ToolLocation[];
  }>;

/**
 * One effect: an interaction the runtime had with the outside world, or the lifecycle of an
 * operation boundary (a child operation, a tool call, a permission question, a provider HTTP
 * request or stream). This is a closed union: every member is one event this runtime can raise,
 * with a fully typed payload, so a subscriber narrowing on `type` gets typed fields, never an
 * untyped bag. Category and level are not part of the payload; they are a logging decision, made
 * by {@link diagnosticsSubscriber}'s table.
 *
 * Emitted only at operation boundaries: the host's child lifecycle, command dispatch, the tool
 * runner, permission decisions, and the provider transport around fetch. Pure decisions and the
 * journal fold never emit.
 */
export type EffectEvent =
  | Readonly<{
      type: "child.started";
      sessionId?: string;
      childId: ActorId;
      operation: OperationKind;
    }>
  | Readonly<{
      type: "child.failed";
      sessionId?: string;
      childId: ActorId;
      operation: OperationKind;
      phase: string;
      error: DiagnosticError;
    }>
  | Readonly<{
      type: "child.cancelled";
      sessionId?: string;
      childId: ActorId;
      operation: OperationKind;
      phase: string;
      error: DiagnosticError;
    }>
  | Readonly<{
      type: "child.settled";
      sessionId?: string;
      childId: ActorId;
      operation: OperationKind;
      outcome: Result<unknown>["kind"];
      durationMs: number;
      error?: DiagnosticError;
    }>
  | Readonly<{ type: "child.timed_out"; reason: Failure; sessionId?: string; childId: ActorId }>
  | Readonly<{
      type: "child.cancellation_requested";
      sessionId?: string;
      childId: ActorId;
      operation: OperationKind;
      reason?: Failure;
    }>
  | Readonly<{
      type: "command.dispatched";
      sessionId?: string;
      turnId: ActorId;
      childId: ActorId;
      operation: TurnCommand["type"];
      provider?: string;
      model?: string;
      thinking?: Policy["thinking"];
      thinkingBudgetTokens?: number | null;
      stream?: boolean;
      maxOutputTokens?: number;
      generation?: number;
      stepsRemaining?: Steps;
    }>
  | Readonly<{
      type: "permission.grants_cleared";
      sessionId?: string;
      reason: string;
      policyVersion: number;
      /** The append that applied the change, when a configuration record applied it. */
      appendId?: string;
      /** The selection that changed and restored the mode before it applied. */
      selectionId?: string;
      toolNames: readonly string[];
    }>
  | Readonly<{
      type: "tool.released";
      sessionId?: string;
      turnId: ActorId;
      batchId: ActorId;
      callId: string;
    }>
  | Readonly<{
      type: "host.closed";
      sessionId?: string;
      activeChildren: number;
      pendingToolReceipts: number;
      pendingGrants: number;
    }>
  | Readonly<{
      type: "completion.system_prompt";
      sessionId?: string;
      turnId: ActorId;
      childId: ActorId;
      agentId: AgentId;
      provider?: string;
      model?: string;
      systemMessages: readonly Readonly<{ role: "system"; content: string }>[];
    }>
  | Readonly<{
      type: "completion.usage.received";
      sessionId?: string;
      turnId: ActorId;
      childId: ActorId;
      model?: string;
      usage: CompletionUsage;
    }>
  | Readonly<{
      type: "prompt.media.pointer";
      sessionId?: string;
      turnId: ActorId;
      childId: ActorId;
      provider?: string;
      model?: string;
      /** The blob part the step's projection rendered as pointer text for this target. */
      pointer: MediaPointerEvent;
    }>
  | Readonly<
      ToolIdentity & {
        type: "tool.locations_failed";
        childId?: ActorId;
        toolName: string;
        error: DiagnosticError;
      }
    >
  | Readonly<
      PermissionContext & {
        type: "permission.reused";
        scope: "live-session-tool";
        source: "remembered";
        grantId: string;
      }
    >
  | Readonly<{ type: "permission.waiting" } & PermissionContext>
  | Readonly<
      PermissionContext & {
        type: "permission.decided";
        decision: "cancelled" | "allow_once" | "reject_once";
        durationMs: number;
      }
    >
  | Readonly<
      PermissionContext & {
        type: "permission.refused";
        toolKind: ToolKind;
        rawInput: unknown;
        durationMs: number;
      }
    >
  | Readonly<{
      type: "tool.input_rejected";
      sessionId?: string;
      turnId: ActorId;
      toolCallId?: string;
      toolName: string;
      callId: string;
      error: Failure;
    }>
  | Readonly<{
      type: "permission.granted";
      sessionId?: string;
      turnId: ActorId;
      childId: ActorId;
      toolName: string;
      grantId: string;
      policyVersion?: number;
    }>
  | Readonly<
      ToolIdentity & {
        type: "tool.admitted";
        toolName: string;
        kind: ToolKind;
        permission: "refused" | "not_requested_invalid_input" | "approved" | "not_required";
      }
    >
  | Readonly<
      ToolIdentity & {
        type: "tool.refused";
        toolName: string;
        permissionChildId?: ActorId;
      }
    >
  | Readonly<
      ToolIdentity & {
        type: "tool.locations_resolved";
        toolName: string;
        locations: readonly ToolLocation[];
      }
    >
  | Readonly<
      ToolIdentity & {
        type: "tool.awaiting_release";
        toolName: string;
        outcome: Result<unknown>["kind"];
      }
    >
  | Readonly<
      ToolIdentity & {
        type: "tool.status_changed";
        toolName: string;
        previousStatus: string;
        status: string;
        rawStatus: string;
        error?: DiagnosticError;
      }
    >
  | Readonly<{
      type: "provider.http.started";
      trace: ProviderTrace;
    }>
  | Readonly<{ type: "provider.http.received"; evidence: ProviderEvidence }>
  | Readonly<{ type: "provider.http.rejected"; evidence: ProviderEvidence; errorBody: string }>
  | Readonly<{ type: "provider.http.completed"; evidence: ProviderEvidence; durationMs: number }>
  | Readonly<{
      type: "provider.http.cancelled";
      trace: ProviderTrace;
      phase: string;
      durationMs: number;
      error: DiagnosticError;
    }>
  | Readonly<{
      type: "provider.http.failed";
      trace: ProviderTrace;
      phase: string;
      durationMs: number;
      error: DiagnosticError;
    }>
  | Readonly<{ type: "provider.stream.started"; context: ProviderStreamContext }>
  | Readonly<{
      type: "provider.stream.completed";
      context: ProviderStreamContext;
      bytes: number;
      frames: number;
      deltas: number;
      lastEvent?: string;
      usage: Readonly<Record<string, number>>;
      terminalEvidence: Readonly<Record<string, unknown>>;
      durationMs: number;
    }>
  | Readonly<{
      type: "provider.stream.cancelled";
      context: ProviderStreamContext;
      bytes: number;
      frames: number;
      deltas: number;
      lastEvent?: string;
      usage: Readonly<Record<string, number>>;
      terminalEvidence: Readonly<Record<string, unknown>>;
      bufferedCharacters: number;
      durationMs: number;
      error: DiagnosticError;
    }>
  | Readonly<{
      type: "provider.stream.failed";
      context: ProviderStreamContext;
      bytes: number;
      frames: number;
      deltas: number;
      lastEvent?: string;
      usage: Readonly<Record<string, number>>;
      terminalEvidence: Readonly<Record<string, unknown>>;
      bufferedCharacters: number;
      durationMs: number;
      error: DiagnosticError;
    }>
  | Readonly<{ type: "provider.completion.started"; trace: CompletionTrace }>
  | Readonly<{
      type: "provider.completion.completed";
      trace: CompletionTrace;
      terminalEvidence: Readonly<Record<string, unknown>>;
      durationMs: number;
      completionKind: string;
      continuation: boolean;
    }>
  | Readonly<{
      type: "provider.completion.cancelled";
      trace: CompletionTrace;
      terminalEvidence: Readonly<Record<string, unknown>>;
      phase: string;
      durationMs: number;
      error: DiagnosticError;
    }>
  | Readonly<{
      type: "provider.completion.failed";
      trace: CompletionTrace;
      terminalEvidence: Readonly<Record<string, unknown>>;
      phase: string;
      durationMs: number;
      error: DiagnosticError;
    }>
  | Readonly<{
      type: "provider.usage.invalid";
      trace: CompletionTrace;
      terminalEvidence: Readonly<Record<string, unknown>>;
      error: string;
    }>;

/** Correlation and request shape known before a provider HTTP call is dispatched. */
export type ProviderTrace = Readonly<{
  sessionId?: string;
  turnId?: string;
  childId?: string;
  generation?: number;
  requestId?: string;
  httpRequestId: string;
  provider?: string;
  model?: string;
  toolCallId?: string;
  endpoint: string;
  method: string;
  streaming: boolean;
}>;

/** {@link ProviderTrace} plus the response metadata known once headers arrive. */
export type ProviderEvidence = ProviderTrace &
  Readonly<{ httpStatus: number; providerRequestId: string | null; durationMs: number }>;

/**
 * What a stream assembler is actually given: normally the full {@link ProviderEvidence} of the
 * response that opened the stream, but a caller that assembles a stream without going through
 * `httpTransport` (for example a test fixture) may supply none of it.
 */
export type ProviderStreamContext = Partial<ProviderEvidence>;

/** Correlation and request shape for one `bindProviders(...).complete` call. */
export type CompletionTrace = Readonly<{
  sessionId?: string;
  turnId?: string;
  childId?: string;
  generation?: number;
  requestId?: string;
  httpRequestId: string;
  provider?: string;
  model?: string;
  toolCallId?: string;
  stream: boolean;
  thinking?: unknown;
  thinkingBudgetTokens?: number | null;
  maxOutputTokens?: number;
  messageCount: number;
  toolCount: number;
  profile?: string;
  wireModel?: string;
}>;

/**
 * Cross-cutting subscriber: logging, traffic capture, usage/cost accounting, auditing, hooks.
 * Adding one changes no core code; supply it through `ExecutionBindings.effects` (host-level
 * events) and `TransportBinding.effects` (provider transport events). Best-effort: a throwing
 * subscriber must not affect execution, so callers should combine subscribers with
 * {@link fanoutEffects} rather than let one exception drop the rest.
 */
export type EffectEmitter = (event: EffectEvent) => unknown;

/** An emitter that discards every event; the default when no subscriber is bound. */
export const noopEffects: EffectEmitter = () => {};

/**
 * Contains a subscriber's rejection so it never surfaces as an unhandled promise rejection. A
 * synchronous subscriber never returns a thenable, so this is a no-op for it; an async subscriber
 * that throws still runs to completion elsewhere, its rejection just never propagates here.
 */
function containRejection(result: unknown): void {
  if (result && typeof (result as PromiseLike<unknown>).then === "function")
    Promise.resolve(result).catch(() => {
      // Best-effort, like diagnostic(): an async subscriber's rejection never affects execution.
    });
}

/** Runs one subscriber for one event; its failure, sync or async, never affects execution. */
function callEmitter(emitter: EffectEmitter, event: EffectEvent): void {
  try {
    containRejection(emitter(event));
  } catch {
    // Best-effort, like diagnostic(): a subscriber failure never affects execution.
  }
}

/** Combines subscribers so each event reaches every one of them once, in order. */
export function fanoutEffects(...emitters: readonly (EffectEmitter | undefined)[]): EffectEmitter {
  const live = emitters.filter((emitter): emitter is EffectEmitter => !!emitter);
  if (live.length === 0) return noopEffects;
  if (live.length === 1) return (event) => callEmitter(live[0]!, event);
  return (event) => {
    for (const emitter of live) callEmitter(emitter, event);
  };
}

/** What the default subscriber logs for one event: category, level and the rendered fields. */
export type DiagnosticRecord = Readonly<{
  category: string;
  level: LogLevel;
  fields: DiagnosticFields;
}>;

/**
 * Category, level and rendered fields for every known event, keyed by `type`. A missing or
 * misspelled key is a compile error (`Record` requires every member of `EffectEvent["type"]`),
 * so adding a union member without a table entry never silently falls back to a default. This is
 * the only place a log level or category is chosen; events themselves carry only domain data.
 */
const diagnosticTable: {
  [K in EffectEvent["type"]]: (event: Extract<EffectEvent, { type: K }>) => DiagnosticRecord;
} = {
  "child.started": (e) => ({
    category: e.operation === "completion" ? "provider" : "host",
    level: "debug",
    fields: { sessionId: e.sessionId, childId: e.childId, operation: e.operation },
  }),
  "child.failed": (e) => ({
    category: e.operation === "completion" ? "provider" : "host",
    level: "warning",
    fields: { sessionId: e.sessionId, childId: e.childId, phase: e.phase, error: e.error },
  }),
  "child.cancelled": (e) => ({
    category: e.operation === "completion" ? "provider" : "host",
    level: "info",
    fields: { sessionId: e.sessionId, childId: e.childId, phase: e.phase, error: e.error },
  }),
  "child.settled": (e) => ({
    category: e.operation === "completion" ? "provider" : "host",
    level: e.outcome === "failed" ? "warning" : "debug",
    fields: {
      sessionId: e.sessionId,
      childId: e.childId,
      operation: e.operation,
      outcome: e.outcome,
      durationMs: e.durationMs,
      ...(e.error ? { error: e.error } : {}),
    },
  }),
  "child.timed_out": (e) => ({
    category: "host",
    level: "warning",
    fields: { ...e.reason, sessionId: e.sessionId, childId: e.childId },
  }),
  "child.cancellation_requested": (e) => ({
    category: "host",
    level: "debug",
    fields: {
      sessionId: e.sessionId,
      childId: e.childId,
      operation: e.operation,
      reason: e.reason,
    },
  }),
  "command.dispatched": (e) => ({
    category: "host",
    level: "debug",
    fields: {
      sessionId: e.sessionId,
      turnId: e.turnId,
      childId: e.childId,
      operation: e.operation,
      provider: e.provider,
      model: e.model,
      thinking: e.thinking,
      thinkingBudgetTokens: e.thinkingBudgetTokens,
      stream: e.stream,
      maxOutputTokens: e.maxOutputTokens,
      ...(e.generation !== undefined
        ? { generation: e.generation, stepsRemaining: e.stepsRemaining }
        : {}),
    },
  }),
  "permission.grants_cleared": (e) => ({
    category: "host",
    level: "info",
    fields: {
      sessionId: e.sessionId,
      reason: e.reason,
      policyVersion: e.policyVersion,
      ...(e.appendId !== undefined ? { appendId: e.appendId } : {}),
      ...(e.selectionId !== undefined ? { selectionId: e.selectionId } : {}),
      toolNames: e.toolNames,
    },
  }),
  "tool.released": (e) => ({
    category: "host",
    level: "debug",
    fields: { sessionId: e.sessionId, turnId: e.turnId, batchId: e.batchId, callId: e.callId },
  }),
  "host.closed": (e) => ({
    category: "host",
    level: "debug",
    fields: {
      sessionId: e.sessionId,
      activeChildren: e.activeChildren,
      pendingToolReceipts: e.pendingToolReceipts,
      pendingGrants: e.pendingGrants,
    },
  }),
  "completion.system_prompt": (e) => ({
    category: "provider",
    level: "debug",
    fields: {
      sessionId: e.sessionId,
      turnId: e.turnId,
      childId: e.childId,
      agentId: e.agentId,
      provider: e.provider,
      model: e.model,
      message: "System instructions supplied to this completion, in order",
      systemMessages: e.systemMessages,
    },
  }),
  "completion.usage.received": (e) => ({
    category: "provider",
    level: "info",
    fields: {
      sessionId: e.sessionId,
      turnId: e.turnId,
      childId: e.childId,
      model: e.model,
      usage: e.usage,
      message: "Completion response usage validated; awaiting runtime settlement",
    },
  }),
  "prompt.media.pointer": (e) => ({
    category: "prompt",
    level: "debug",
    fields: {
      sessionId: e.sessionId,
      turnId: e.turnId,
      childId: e.childId,
      provider: e.provider,
      model: e.model,
      media: e.pointer.media,
      bytes: e.pointer.bytes,
      support: e.pointer.support,
      blobId: e.pointer.blobId,
    },
  }),
  "tool.locations_failed": (e) => ({
    category: "host",
    level: "warning",
    fields: {
      ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
      ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
      ...(e.batchId !== undefined ? { batchId: e.batchId } : {}),
      ...(e.callId !== undefined ? { callId: e.callId } : {}),
      ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
      ...(e.name !== undefined ? { name: e.name } : {}),
      toolName: e.toolName,
      error: e.error,
      ...(e.childId !== undefined ? { childId: e.childId } : {}),
    },
  }),
  "permission.reused": (e) => ({
    category: "host",
    level: "info",
    fields: {
      ...toolIdentityFields(e),
      childId: e.childId,
      requestId: e.requestId,
      toolName: e.toolName,
      locations: e.locations,
      scope: e.scope,
      source: e.source,
      grantId: e.grantId,
      reason: "User previously approved this tool for all arguments in this live session",
    },
  }),
  "permission.waiting": (e) => ({
    category: "host",
    level: "info",
    fields: {
      ...toolIdentityFields(e),
      childId: e.childId,
      requestId: e.requestId,
      toolName: e.toolName,
      locations: e.locations,
      reason: "Tool execution requires user approval; batch execution is blocked",
    },
  }),
  "permission.decided": (e) => ({
    category: "host",
    level: "info",
    fields: {
      ...toolIdentityFields(e),
      childId: e.childId,
      requestId: e.requestId,
      toolName: e.toolName,
      locations: e.locations,
      decision: e.decision,
      durationMs: e.durationMs,
    },
  }),
  "permission.refused": (e) => ({
    category: "host",
    level: "warning",
    fields: {
      ...toolIdentityFields(e),
      childId: e.childId,
      requestId: e.requestId,
      toolName: e.toolName,
      locations: e.locations,
      operation: "tool_execution",
      outcome: "blocked",
      decision: "reject_once",
      reasonCode: "permission_refused",
      reason:
        "User refused permission for a model-requested tool; the model receives a permission-refused result for this call and the turn continues",
      toolKind: e.toolKind,
      rawInput: e.rawInput,
      durationMs: e.durationMs,
    },
  }),
  "tool.input_rejected": (e) => ({
    category: "host",
    level: "warning",
    fields: {
      sessionId: e.sessionId,
      turnId: e.turnId,
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      callId: e.callId,
      error: e.error,
      consequence:
        "Tool will not execute or request approval; validation error will be committed as a tool result for the model to correct",
    },
  }),
  "permission.granted": (e) => ({
    category: "host",
    level: "info",
    fields: {
      sessionId: e.sessionId,
      turnId: e.turnId,
      childId: e.childId,
      toolName: e.toolName,
      grantId: e.grantId,
      scope: "live-session-tool",
      policyVersion: e.policyVersion,
      reason:
        "User approved this tool for all arguments until this session closes, tool scope changes, or permissions are explicitly reset",
    },
  }),
  "tool.admitted": (e) => ({
    category: "host",
    level: "debug",
    fields: {
      ...toolIdentityFields(e),
      toolName: e.toolName,
      kind: e.kind,
      permission: e.permission,
    },
  }),
  "tool.refused": (e) => ({
    category: "host",
    level: "info",
    fields: {
      ...toolIdentityFields(e),
      toolName: e.toolName,
      permissionChildId: e.permissionChildId,
      reason:
        "Not run: user refused permission (see permission.refused); the model receives a permission-refused result",
    },
  }),
  "tool.locations_resolved": (e) => ({
    category: "host",
    level: "debug",
    fields: { ...toolIdentityFields(e), toolName: e.toolName, locations: e.locations },
  }),
  "tool.awaiting_release": (e) => ({
    category: "host",
    level: "debug",
    fields: {
      ...toolIdentityFields(e),
      toolName: e.toolName,
      outcome: e.outcome,
      reason: "Result reported; awaiting caller release (session journal receipt when durable)",
    },
  }),
  "tool.status_changed": (e) => ({
    category: "host",
    level: e.rawStatus === "failed" ? "warning" : "debug",
    fields: {
      ...toolIdentityFields(e),
      toolName: e.toolName,
      previousStatus: e.previousStatus,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
    },
  }),
  "provider.http.started": (e) => ({ category: "provider", level: "debug", fields: e.trace }),
  "provider.http.received": (e) => ({ category: "provider", level: "debug", fields: e.evidence }),
  "provider.http.rejected": (e) => ({
    category: "provider",
    level: "warning",
    fields: { ...e.evidence, errorBody: e.errorBody },
  }),
  "provider.http.completed": (e) => ({
    category: "provider",
    level: "debug",
    fields: { ...e.evidence, durationMs: e.durationMs },
  }),
  "provider.http.cancelled": (e) => ({
    category: "provider",
    level: "info",
    fields: { ...e.trace, phase: e.phase, durationMs: e.durationMs, error: e.error },
  }),
  "provider.http.failed": (e) => ({
    category: "provider",
    level: "warning",
    fields: { ...e.trace, phase: e.phase, durationMs: e.durationMs, error: e.error },
  }),
  "provider.stream.started": (e) => ({ category: "provider", level: "debug", fields: e.context }),
  "provider.stream.completed": (e) => ({
    category: "provider",
    level: "debug",
    fields: {
      ...e.context,
      bytes: e.bytes,
      frames: e.frames,
      deltas: e.deltas,
      lastEvent: e.lastEvent,
      usage: e.usage,
      ...e.terminalEvidence,
      durationMs: e.durationMs,
    },
  }),
  "provider.stream.cancelled": (e) => ({
    category: "provider",
    level: "info",
    fields: {
      ...e.context,
      bytes: e.bytes,
      frames: e.frames,
      deltas: e.deltas,
      lastEvent: e.lastEvent,
      usage: e.usage,
      ...e.terminalEvidence,
      bufferedCharacters: e.bufferedCharacters,
      durationMs: e.durationMs,
      error: e.error,
    },
  }),
  "provider.stream.failed": (e) => ({
    category: "provider",
    level: "warning",
    fields: {
      ...e.context,
      bytes: e.bytes,
      frames: e.frames,
      deltas: e.deltas,
      lastEvent: e.lastEvent,
      usage: e.usage,
      ...e.terminalEvidence,
      bufferedCharacters: e.bufferedCharacters,
      durationMs: e.durationMs,
      error: e.error,
    },
  }),
  "provider.completion.started": (e) => ({ category: "provider", level: "debug", fields: e.trace }),
  "provider.completion.completed": (e) => ({
    category: "provider",
    level: "info",
    fields: {
      ...e.trace,
      durationMs: e.durationMs,
      ...e.terminalEvidence,
      completionKind: e.completionKind,
      continuation: e.continuation,
    },
  }),
  "provider.completion.cancelled": (e) => ({
    category: "provider",
    level: "info",
    fields: {
      ...e.trace,
      ...e.terminalEvidence,
      phase: e.phase,
      durationMs: e.durationMs,
      error: e.error,
    },
  }),
  "provider.completion.failed": (e) => ({
    category: "provider",
    level: "warning",
    fields: {
      ...e.trace,
      ...e.terminalEvidence,
      phase: e.phase,
      durationMs: e.durationMs,
      error: e.error,
    },
  }),
  "provider.usage.invalid": (e) => ({
    category: "provider",
    level: "warning",
    fields: {
      ...e.trace,
      ...e.terminalEvidence,
      error: e.error,
      message:
        "Provider returned invalid token accounting; completion remains usable, accounting is retained without normalized counts",
    },
  }),
};

/** Shared rendering for the `ToolIdentity`-based events, omitting keys that are truly absent. */
function toolIdentityFields(identity: ToolIdentity): DiagnosticFields {
  return {
    ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
    ...(identity.turnId !== undefined ? { turnId: identity.turnId } : {}),
    ...(identity.batchId !== undefined ? { batchId: identity.batchId } : {}),
    ...(identity.callId !== undefined ? { callId: identity.callId } : {}),
    ...(identity.toolCallId !== undefined ? { toolCallId: identity.toolCallId } : {}),
    ...(identity.name !== undefined ? { name: identity.name } : {}),
  };
}

/**
 * Category, level and rendered fields for one event, looked up in {@link diagnosticTable}. This is
 * the only place a log level or category is chosen; events themselves carry only domain data.
 * Exported so a test can prove the table stays exhaustive over every {@link EffectEvent} member
 * without duplicating it: `diagnosticTable`'s own type already fails to compile if a case is
 * missing, and calling this for a representative instance of every member proves it also runs.
 */
export function resolveDiagnostic(event: EffectEvent): DiagnosticRecord {
  return (diagnosticTable[event.type] as (event: EffectEvent) => DiagnosticRecord)(event);
}

/**
 * The default subscriber: produces the same `diagnostic()` records the runtime always has, from
 * the emitted events, via {@link resolveDiagnostic}. Logging is a consumer of effects, not a
 * second emission path.
 */
export function diagnosticsSubscriber(): EffectEmitter {
  return (event) => {
    const record = resolveDiagnostic(event);
    diagnostic(record.category, record.level, event.type, record.fields);
  };
}

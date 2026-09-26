import type { AgentDefinition, Tool } from "../agent/agent-runtime.ts";
import type { ActorId, Failure, TurnRecord } from "../agent/types.ts";
import type { StreamUpdateSink, ToolUpdateSink } from "../host/host.ts";
import type { CompletionPort, PermissionPort } from "../host/ports.ts";
import type { Policy, PolicyPatch, PolicyResolvers } from "../policy/policy.ts";
import type { ProviderBindings, ResolvedModel } from "../providers/transport.ts";
import type { EnvEvent, EnvEventSchema } from "./events.ts";
import type { SessionPersistence } from "./persistence.ts";
import { createSession, restoreSession, SessionNotFoundError } from "./runtime/open.ts";
import type { CommandReceipt, SessionState } from "./session-fsm.ts";
import type { LastCompletionUsage } from "./session-log.ts";

export { createSession, restoreSession, SessionNotFoundError };

export { defineTool } from "../host/ports.ts";

export type { Tool, AgentDefinition };

export type {
  HostToolNotification,
  ToolUpdateSink,
  HostStreamNotification,
  StreamUpdateSink,
} from "../host/host.ts";

export type { PermissionPort, PermissionRequest, ToolKind, ToolLocation } from "../host/ports.ts";

/**
 * What a session may do: its agents, step allowance, standing instructions and starting policy.
 * The agents and the parameter schemas of the bound tools form the registry that is journaled.
 */
export type SessionConfiguration = Readonly<{
  /**
   * Agent the first turn runs as; must be a key of `agents`. On restore it is the agent a
   * conversation switches to when its saved current agent is no longer registered.
   */
  agent: string;
  /** Agent definitions by ID. Journaled as part of the registry. */
  agents: ReadonlyMap<string, AgentDefinition>;
  /** Model steps each turn may use. A `policy.steps` value overrides it. */
  steps: number;
  /**
   * Standing session instructions for a new session ("system" here means these instructions, not a
   * system notice). Ignored by {@link restoreSession}, which keeps the journaled ones; change them
   * with {@link SessionRuntime.updateSystem}.
   */
  systemInputs?: readonly string[];
  /**
   * Patch applied to the default policy of a new session. On restore it supplies the defaults a
   * saved setting falls back to when the live bindings reject it, and the tool permissions of agents
   * the saved policy does not list.
   */
  policy?: PolicyPatch;
}>;

/**
 * How a session does its work: completion, tools, permission UI and observers. Bindings are never
 * journaled; they are captured when the session is created or restored, and mutating the original
 * maps later does not reconfigure an open session.
 */
export type SessionBindings = Readonly<{
  /** A single completion port. Supply exactly one of `complete` and `providers`. */
  complete?: CompletionPort;
  /**
   * Provider registry that resolves `policy.provider`/`policy.model` to a wire model and profile.
   * Supply exactly one of `complete` and `providers`; a new provider-bound session needs a
   * `policy.provider`.
   */
  providers?: ProviderBindings;
  /** Tool implementations by name. Their parameter schemas are journaled as part of the registry. */
  tools?: ReadonlyMap<string, Tool>;
  /**
   * Policy packs, prompt projections and handoff projections, replacing the built-in set (built-in
   * packs apply when `packs` is omitted). Its provider and permission fields are ignored; they are
   * derived from `providers` and `requestPermission`.
   */
  policies?: PolicyResolvers;
  /**
   * Generates request IDs (which become append IDs), the session ID when `sessionId` is omitted,
   * and fork/compaction request and child session IDs. Defaults to `crypto.randomUUID`.
   */
  id?: () => string;
  /**
   * Called with every new session snapshot, including uncommitted `pending` states. Its return
   * value, thrown errors and rejections are ignored; observation cannot change execution.
   */
  observe?: (snapshot: SessionState) => unknown;
  /** Display-only tool progress; not a permission request and not a durable result. */
  toolUpdate?: ToolUpdateSink;
  /** Display-only progress of a completion (status and stream deltas); not committed history. */
  streamUpdate?: StreamUpdateSink;
  /** Asks the user to approve tool calls. Required for `permissions: "ask"`. */
  requestPermission?: PermissionPort;
}>;

/** Everything {@link createSession} and {@link restoreSession} need to open a session. */
export type SessionOptions = Readonly<{
  /** Journal and blob store. The session never closes it; its lifetime belongs to the caller. */
  persistence: SessionPersistence;
  configuration: SessionConfiguration;
  bindings: SessionBindings;
  /**
   * ID for a new session; generated with `bindings.id` when omitted. {@link restoreSession} ignores
   * it and uses its own argument.
   */
  sessionId?: string;
}>;

/**
 * How a turn submitted by user input ended, as seen by the caller of {@link SessionRuntime.input}.
 * Only `terminal` means a turn outcome was committed.
 */
export type TerminalResult =
  /**
   * The turn's terminal record committed. `record.outcome` may still be failed, aborted or
   * exhausted; `turnId` is the turn the input started, joined or was queued for.
   */
  | Readonly<{ kind: "terminal"; turnId: ActorId; record: TurnRecord }>
  /**
   * No outcome was committed for this input: its input receipt was not `accepted`, or the session
   * failed, for example on a storage error, before the turn ended. A `failed` receipt passes on its
   * own error; other receipt kinds, including `closed` for input submitted after close, become an
   * `admission` failure named after the receipt kind.
   */
  | Readonly<{ kind: "failed"; message: string; error: Failure }>
  /** The session was closed before the turn ended. */
  | Readonly<{ kind: "closed"; message: string }>;

/**
 * Result of the `accepted` promise of a {@link SessionRuntime.dispatch} handle: the input receipt,
 * or `close_acknowledged` once a `close` event has been processed.
 *
 * Input receipt kinds: `accepted` means the event's records committed to the journal at
 * `receipt.revision`; `busy` means a system or policy change arrived while a turn was active or
 * staged, or queued inputs were waiting; `failed` means staging rejected the event (for example the
 * mid-turn input policy refused it) or the session has failed, with the structured `error`;
 * `closed` means the session was closed. `ignored` is reserved for internal records whose target no
 * longer exists and is not returned for the public events.
 */
export type EnvReceipt = CommandReceipt | Readonly<{ kind: "close_acknowledged" }>;

/**
 * Result of the `settled` promise of a {@link SessionRuntime.dispatch} handle. The variant depends
 * on the event type.
 */
export type EnvSettlement =
  /** For `user` events: how the turn the input started, joined or was queued for ended. */
  | TerminalResult
  /**
   * For `fork` and `compact`: the child session (not a child operation) was published, i.e. its
   * blobs were copied and its creation record committed. The caller owns closing it.
   */
  | Readonly<{ kind: "branch"; session: SessionRuntime }>
  /**
   * For `system`, `policy`, `abort` and `close`: the same receipt as `accepted`. Nothing further is
   * awaited; for `abort`, the aborted turn's terminal record may commit later.
   */
  | Readonly<{ kind: "acknowledged"; receipt: EnvReceipt }>;

/**
 * The two observations of a dispatched event. `accepted` resolves with the input receipt once the
 * event's journal append commits or the event is refused; `settled` resolves later with the
 * event's end result ({@link EnvSettlement}). Failures are reported as result kinds; inspect the
 * discriminant rather than relying on resolution.
 */
export type EnvCommandHandle = Readonly<{
  accepted: Promise<EnvReceipt>;
  settled: Promise<EnvSettlement>;
}>;

/**
 * Relationship between the persisted tool/agent registry and the live bindings. Any difference is
 * journaled as a `configuration` record ahead of the next new work; history is never rewritten.
 */
export type SessionRegistry =
  /** The journaled registry and policy are the ones the session runs with. */
  | Readonly<{ kind: "current" }>
  /**
   * A restored session whose saved registry, policy or current agent differs from the live
   * bindings. The first `user`, `system`, `policy`, `fork` or `compact` event commits a
   * `configuration` record before that work is staged; this state lasts until that record commits
   * (and for good when its append fails, since the session then fails). `differences` are readable
   * summaries such as `missing tools.read_file` or `changed policy.model`.
   */
  | Readonly<{ kind: "pending_adoption"; differences: readonly string[] }>;

/**
 * An open session: journals every input before running it and runs turns through the host. Created
 * by {@link createSession}, {@link restoreSession}, {@link SessionRuntime.fork} and
 * {@link SessionRuntime.compact}.
 *
 * Public events are validated synchronously: a malformed event makes `dispatch`, `fire`, `input`,
 * `updateSystem` and `updatePolicy` throw before anything is submitted. After that, outcomes are
 * reported through receipt and settlement kinds.
 */
export type SessionRuntime = {
  /**
   * Current state of the session actor. `durable` is committed state; `pending.next` (while
   * `committing` or `reconciling`) is a staged proposal waiting for storage and must not be treated
   * as committed. `closed` is final; `failed` can only move to `closed`.
   */
  readonly snapshot: SessionState;
  /**
   * Provider, model, wire model, profile and capabilities the next turn resolves to under
   * {@link SessionRuntime.policy}. Undefined when the policy names no provider or the session is
   * bound through `bindings.complete`.
   */
  readonly model?: ResolvedModel;
  /**
   * Usage accounting of the latest committed completion that reported it, with its turn and
   * operation IDs. It describes one observed response, not the current context size or a cumulative
   * cost, and is rebuilt on restore without calling the provider.
   */
  readonly lastCompletionUsage?: LastCompletionUsage;
  /** Whether the live registry has been journaled; see {@link SessionRegistry}. */
  readonly registry: SessionRegistry;
  /** Policy the next turn uses: a pending adoption's reconciled policy, else the durable one. */
  readonly policy?: Policy;
  /** Dispatches `event` and returns only its `accepted` promise. */
  fire(event: unknown): Promise<EnvReceipt>;
  /**
   * Submits a public event ({@link EnvEvent}) and returns its accepted and settled promises. Every
   * event except `abort` and `close` first triggers a pending registry adoption.
   * @throws when `event` does not match {@link EnvEventSchema}.
   */
  dispatch(event: unknown): EnvCommandHandle;
  /**
   * Submits user input: text, attachments already stored with `persistence.putBlob`, or both.
   * `accepted` resolves with the input receipt once the input is committed (or refused). `settled`
   * resolves when the turn the input started ends; with barge-in the input joins the active turn,
   * and a queued input settles when the turn it starts after dequeue ends.
   * @throws when the input has neither text nor attachments or is otherwise malformed.
   */
  input(input: string | Omit<Extract<EnvEvent, { type: "user" }>, "type">): {
    accepted: Promise<CommandReceipt>;
    settled: Promise<TerminalResult>;
  };
  /**
   * Replaces the standing session instructions (not a system notice) with a new system version,
   * committed to the journal and used from the next turn. Resolves with `busy` while a turn is
   * active or queued inputs are waiting.
   */
  updateSystem(inputs: readonly string[]): Promise<CommandReceipt>;
  /**
   * Commits a policy record that applies `patch` to the effective policy, validated against the live
   * bindings; the change applies from the next turn. Resolves with `busy` while a turn is active or
   * queued inputs are waiting, and `failed` when the patch is rejected. Committing a `permissions`
   * patch or a change of allowed tools revokes remembered `allow-session` approvals.
   * @throws when `patch` does not match the policy patch schema.
   */
  updatePolicy(patch: PolicyPatch): Promise<CommandReceipt>;
  /**
   * Creates an independent child session (not a child operation) with this session's history. The
   * request is journaled, then waits for the active turn's terminal record; resolves once the child
   * is published. The parent is unchanged and no live work moves to the child.
   * @throws (rejects) when the request is not accepted, publication fails, or the parent closes or
   * fails first.
   */
  fork(): Promise<SessionRuntime>;
  /**
   * Creates a child session whose context is `context` (complete tool exchanges only) and whose
   * turn log is empty; no model is asked to summarize. Otherwise behaves like
   * {@link SessionRuntime.fork}.
   * @throws synchronously when `context` is not valid session context.
   */
  compact(context: unknown): Promise<SessionRuntime>;
  /**
   * Closes the session: cancels running operations and storage calls, and settles every waiting
   * caller with `closed`. Later submissions receive `closed` receipts. The persistence store stays
   * open, and an append already dispatched may still commit; restore to learn its result.
   */
  close(): Promise<void>;
};

import { RequestError, type AgentApp } from "@agentclientprotocol/sdk";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

import { expandCommand } from "../commands.ts";
import { promptInput, requireAdvertisedContent } from "../prompt-input.ts";
import type { ConnectionGate } from "./connection.ts";
import type { AdapterCore } from "./core.ts";
import { awaitConfigurationQuiet } from "./session.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { SessionUpdates } from "./updates.ts";

/** Self-contained JSON-RPC message for a failed turn; the structured failure travels as `data`. */
function turnFailureMessage(error: {
  message: string;
  classification?: string;
  operation?: { kind: string; toolName?: string; callId?: string };
}) {
  const operation = error.operation;
  const call = operation?.callId ? ` (call ${operation.callId})` : "";
  const target = operation?.toolName
    ? ` in ${operation.kind === "permission" ? "the permission request for " : ""}tool ${operation.toolName}${call}`
    : operation
      ? ` in ${operation.kind}`
      : "";
  const reason = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
  const next =
    operation?.kind === "tool" || operation?.kind === "permission"
      ? " The session stays open; send another prompt to continue."
      : "";
  return `Agent turn failed${target}${error.classification ? ` [${error.classification}]` : ""}: ${reason}${next}`;
}

/** Registers session/prompt and session/cancel. */
export function registerPrompt(
  app: AgentApp,
  deps: Readonly<{
    core: AdapterCore;
    gate: Pick<ConnectionGate, "promptCapabilities">;
    registry: Pick<SessionRegistry, "lookup" | "isCurrent">;
    updates: Pick<SessionUpdates, "observe" | "refreshInfo" | "resetTurn">;
  }>,
): readonly string[] {
  const { core, gate, updates } = deps;
  const { connectionId } = core;
  const { lookup, isCurrent } = deps.registry;
  app
    .onRequest("session/prompt", async ({ params, client, signal }) => {
      const started = performance.now();
      const trace = {
        connectionId,
        rpcRequestId: String(client.requestId),
        sessionId: params.sessionId,
        method: "session/prompt",
      };
      diagnostic("acp", "info", "acp.prompt.received", { ...trace, count: params.prompt.length });
      const entry = lookup(params.sessionId);
      requireAdvertisedContent(params.prompt, gate.promptCapabilities(), trace);
      if (entry.busy) throw new RequestError(-32000, "Session already has an active prompt");
      await awaitConfigurationQuiet(entry, AbortSignal.any([signal, core.signal()]));
      if (!isCurrent(params.sessionId, entry) || !entry.acceptingUpdates)
        throw new RequestError(-32000, "Session closed");
      if (entry.busy) throw new RequestError(-32000, "Session already has an active prompt");
      entry.busy = true;
      let finishPrompt!: () => void;
      entry.promptDone = new Promise((resolve) => {
        finishPrompt = resolve;
      });
      const controller = new AbortController();
      entry.promptController = controller;
      entry.promptRpcRequestId = String(client.requestId);
      const promptSignal = AbortSignal.any([signal, controller.signal, core.signal()]);
      let admitted = false;
      let aborted = false;
      const abort = () => {
        aborted = true;
        if (admitted) void entry.runtime.fire({ type: "abort" });
      };
      promptSignal.addEventListener("abort", abort, { once: true });
      try {
        const input = await promptInput(
          expandCommand(params.prompt, entry.commands),
          entry.cwd,
          entry.persistence,
          entry.runtime.snapshot.durable.conversation.sessionId,
          promptSignal,
          entry.runtime.model?.capabilities.media ?? [],
          entry.additionalDirectories,
        );
        promptSignal.throwIfAborted();
        const turn = entry.runtime.input(input);
        admitted = true;
        if (promptSignal.aborted) abort();
        const receipt = await turn.accepted;
        if (receipt.kind === "failed")
          throw new RequestError(-32000, receipt.error.message, receipt.error);
        if (receipt.kind !== "accepted")
          throw new RequestError(-32000, `Prompt admission ${receipt.kind}`, receipt);
        diagnostic("acp", "info", "acp.prompt.admitted", {
          ...trace,
          revision: entry.runtime.snapshot.durable.revision,
          provider: entry.runtime.snapshot.durable.policy?.provider,
        });
        const result = await turn.settled;
        diagnostic(
          "acp",
          result.kind === "terminal" && result.record.outcome.kind === "failed"
            ? "warning"
            : "info",
          "acp.prompt.settled",
          {
            ...trace,
            ...(result.kind === "terminal"
              ? { turnId: result.turnId, outcome: result.record.outcome.kind }
              : { outcome: result.kind }),
            durationMs: performance.now() - started,
          },
        );
        updates.observe(entry, client, entry.runtime.snapshot);
        updates.refreshInfo(entry, client);
        await core.flushed();
        if (aborted || result.kind === "closed") return { stopReason: "cancelled" };
        if (result.kind !== "terminal")
          throw new RequestError(-32000, result.error.message, result.error);
        const outcome = result.record.outcome;
        if (outcome.kind === "failed") {
          if (outcome.error.providerStop?.category === "token_limit")
            return { stopReason: "max_tokens", _meta: { "labkit.dev/failure": outcome.error } };
          if (
            outcome.error.classification === "permission_refused" ||
            outcome.error.providerStop?.category === "refusal"
          )
            return { stopReason: "refusal", _meta: { "labkit.dev/failure": outcome.error } };
          throw new RequestError(-32000, turnFailureMessage(outcome.error), outcome.error);
        }
        return {
          stopReason:
            outcome.kind === "aborted"
              ? "cancelled"
              : outcome.kind === "exhausted"
                ? "max_turn_requests"
                : "end_turn",
        };
      } catch (error) {
        diagnostic(
          "acp",
          promptSignal.aborted ? "info" : "error",
          promptSignal.aborted ? "acp.prompt.cancelled" : "acp.prompt.failed",
          {
            ...trace,
            outcome: promptSignal.aborted ? "cancelled" : "failed",
            durationMs: performance.now() - started,
            error: diagnosticError(error),
          },
        );
        if (promptSignal.aborted) return { stopReason: "cancelled" };
        throw error;
      } finally {
        promptSignal.removeEventListener("abort", abort);
        controller.abort(); // Release pending elicitation UI after this prompt settles.
        entry.promptController = undefined;
        entry.promptRpcRequestId = undefined;
        entry.busy = false;
        finishPrompt();
        updates.resetTurn(entry);
      }
    })
    .onNotification("session/cancel", async ({ params }) => {
      diagnostic("acp", "info", "acp.prompt.cancel.requested", {
        connectionId,
        sessionId: params.sessionId,
      });
      const entry = lookup(params.sessionId, true);
      entry.promptController?.abort();
    });
  return ["session/prompt", "session/cancel"];
}

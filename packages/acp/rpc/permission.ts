import type { AgentContext } from "@agentclientprotocol/sdk";
import type { PermissionPort } from "@labkit-agent/core";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

import type { AdapterCore } from "./core.ts";
import type { Session } from "./session.ts";
import { locatedTitle } from "./updates.ts";

/** Why a client permission answer cannot be honored, or undefined when it names an offered choice. */
function permissionAnswerProblem(response: unknown, offered: readonly { optionId: string }[]) {
  const outcome: unknown =
    typeof response === "object" && response !== null && "outcome" in response
      ? response.outcome
      : undefined;
  if (typeof outcome !== "object" || outcome === null || !("outcome" in outcome))
    return "the result has no outcome object";
  if (outcome.outcome === "cancelled") return undefined;
  if (outcome.outcome !== "selected")
    return `outcome ${JSON.stringify(outcome.outcome)?.slice(0, 80)} is neither "selected" nor "cancelled"`;
  const optionId = "optionId" in outcome ? outcome.optionId : undefined;
  if (typeof optionId !== "string") return "a selected outcome must name an optionId";
  if (!offered.some((option) => option.optionId === optionId))
    return `optionId ${JSON.stringify(optionId.slice(0, 80))} was not offered`;
  return undefined;
}

/** Forwards a runtime permission request to the client as session/request_permission. */
export function forwardPermission(
  core: AdapterCore,
  entry: Pick<Session, "promptRpcRequestId">,
  client: AgentContext,
): PermissionPort {
  const { connectionId } = core;
  return async (request, permissionSignal) => {
    await core.flushed();
    if (permissionSignal.aborted || core.isClosing()) return { outcome: { outcome: "cancelled" } };
    const started = performance.now();
    const trace = {
      connectionId,
      rpcRequestId: entry.promptRpcRequestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCall.toolCallId,
      toolName: request.toolCall.title,
      paths: request.toolCall.locations?.map((location) => location.path),
      optionIds: request.options.map((option) => option.optionId),
    };
    diagnostic("acp", "info", "acp.permission.waiting", {
      ...trace,
      reason: "client_decision",
    });
    return new Promise((resolve, reject) => {
      const abort = () => {
        diagnostic("acp", "info", "acp.permission.cancelled", {
          ...trace,
          durationMs: performance.now() - started,
        });
        resolve({ outcome: { outcome: "cancelled" } });
      };
      permissionSignal.addEventListener("abort", abort, { once: true });
      const { locations, ...toolCall } = request.toolCall;
      void client
        .request(
          "session/request_permission",
          {
            sessionId: request.sessionId!,
            toolCall: {
              ...toolCall,
              // Some clients show only the title in their approval picker.
              // Use validated locations, never arbitrary tool argument contents.
              title: locatedTitle(toolCall.title, locations),
              ...(locations ? { locations: [...locations] } : {}),
            },
            options: [...request.options],
          },
          { cancellationSignal: permissionSignal },
        )
        .then(
          (response) => {
            const problem = permissionAnswerProblem(response, request.options);
            if (problem) {
              const reason = `The client answered session/request_permission for ${request.toolCall.title} with an invalid result: ${problem}`;
              diagnostic("acp", "warning", "acp.permission.invalid_response", {
                ...trace,
                reason,
                consequence: "Tool does not run; the turn fails",
                durationMs: performance.now() - started,
              });
              reject(
                new Error(
                  `${reason}. The tool did not run. Answer {"outcome":"cancelled"} or {"outcome":"selected","optionId":…} with one of: ${request.options.map((option) => option.optionId).join(", ")}.`,
                ),
              );
              return;
            }
            diagnostic("acp", "info", "acp.permission.resolved", {
              ...trace,
              response: response,
              durationMs: performance.now() - started,
            });
            resolve(response);
          },
          (error) => {
            diagnostic(
              "acp",
              permissionSignal.aborted ? "debug" : "error",
              "acp.permission.failed",
              {
                ...trace,
                durationMs: performance.now() - started,
                error: diagnosticError(error),
              },
            );
            reject(
              new Error(
                `The client failed session/request_permission for ${request.toolCall.title}: ${diagnosticError(error).message ?? "unknown client error"}. The tool did not run.`,
                { cause: error },
              ),
            );
          },
        )
        .finally(() => permissionSignal.removeEventListener("abort", abort));
    });
  };
}

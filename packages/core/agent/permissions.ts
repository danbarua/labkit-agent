import { z } from "zod";

import { FailureSchema, ToolCallIdSchema, type ToolCalls } from "./types.ts";

/**
 * Result of a permission request for one tool batch: one decision per tool call, in call order.
 * The list stops at the first refusal; see {@link validatePermissionDecisions}.
 *
 * - `allow_once`: the call may run. `approval` is set when a session-wide grant allowed it:
 *   `source: "user"` when the user just chose "allow for this session", `"remembered"` when an
 *   earlier grant for the same tool name was reused. `grantId` names that grant.
 * - `reject_once`: the user refused this call. No call in the batch runs and the turn fails
 *   with classification `permission_refused`.
 * - `cancelled`: the user dismissed the request. No call in the batch runs and the turn ends
 *   `aborted`.
 * - `invalid_input`: the call's arguments failed validation before approval was asked (only under
 *   the `return-error-and-continue` tool-failure setting). The call does not run; its tool
 *   operation fails with `error`, which the model receives as the call's result.
 */
export const PermissionDecisionsSchema = z
  .array(
    z.union([
      z
        .strictObject({
          callId: ToolCallIdSchema,
          decision: z.enum(["allow_once", "reject_once", "cancelled"]),
          approval: z
            .object({
              scope: z.literal("live-session-tool"),
              source: z.enum(["user", "remembered"]),
              grantId: z.string().min(1),
            })
            .readonly()
            .optional(),
        })
        .readonly(),
      z
        .strictObject({
          callId: ToolCallIdSchema,
          decision: z.literal("invalid_input"),
          error: FailureSchema,
        })
        .readonly(),
    ]),
  )
  .min(1)
  .readonly();
/** Per-call permission decisions for one tool batch. See {@link PermissionDecisionsSchema}. */
export type PermissionDecisions = z.infer<typeof PermissionDecisionsSchema>;

/**
 * Checks that permission decisions fit the batch's tool calls and returns them unchanged.
 * Ordered approvals, ending at the first refusal. No partial batch may execute.
 *
 * Entry `i` must name `calls[i]`. Every entry before the last is `allow_once` or
 * `invalid_input`; a list that ends with one of those covers every call.
 *
 * @throws Error when the decisions do not match the calls.
 */
export function validatePermissionDecisions(calls: ToolCalls, decisions: PermissionDecisions) {
  if (
    decisions.length > calls.length ||
    decisions.some(
      (entry, index) =>
        entry.callId !== calls[index]?.id ||
        (index < decisions.length - 1 &&
          entry.decision !== "allow_once" &&
          entry.decision !== "invalid_input"),
    ) ||
    (["allow_once", "invalid_input"].includes(decisions.at(-1)?.decision ?? "") &&
      decisions.length !== calls.length)
  )
    throw new Error("Permission decisions do not match admitted tool calls");
  return decisions;
}

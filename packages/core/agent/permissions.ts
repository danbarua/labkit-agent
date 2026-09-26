import { z } from "zod";

import { FailureSchema, ToolCallIdSchema, type ToolCalls } from "./types.ts";

/**
 * Result of a permission request for one tool batch: one decision per tool call, in call order.
 * A `cancelled` decision stops the list early (nothing after it is asked); every other outcome
 * covers every call. See {@link validatePermissionDecisions}.
 *
 * - `allow_once`: the call may run. `approval` is set when a session-wide grant allowed it:
 *   `source: "user"` when the user just chose "allow for this session", `"remembered"` when an
 *   earlier grant for the same tool name was reused. `grantId` names that grant.
 * - `reject_once`: the user refused this call. That call does not run; its tool operation fails
 *   with classification `permission_refused`, which becomes a "permission refused" tool result
 *   for the model. Other calls in the same batch are unaffected and the turn continues.
 * - `cancelled`: the user dismissed the request. No call in the batch runs, decisions for calls
 *   not yet asked about are omitted, and the turn ends `aborted`.
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
 *
 * Entry `i` must name `calls[i]`. A `cancelled` entry, if present, must be the last entry (no
 * call after it was asked about). Any other outcome must cover every call: the list's length must
 * equal `calls.length`.
 *
 * @throws Error when the decisions do not match the calls.
 */
export function validatePermissionDecisions(calls: ToolCalls, decisions: PermissionDecisions) {
  const cancelledIndex = decisions.findIndex((entry) => entry.decision === "cancelled");
  const stoppedEarly = cancelledIndex !== -1;
  if (
    (stoppedEarly && cancelledIndex !== decisions.length - 1) ||
    (!stoppedEarly && decisions.length !== calls.length) ||
    decisions.some((entry, index) => entry.callId !== calls[index]?.id)
  )
    throw new Error("Permission decisions do not match admitted tool calls");
  return decisions;
}

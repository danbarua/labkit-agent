import { z } from "zod";

import { ToolCallIdSchema, type ToolCalls } from "./types.ts";

export const PermissionDecisionsSchema = z
  .array(
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
  )
  .min(1)
  .readonly();
export type PermissionDecisions = z.infer<typeof PermissionDecisionsSchema>;

/** Ordered approvals, ending at the first refusal. No partial batch may execute. */
export function validatePermissionDecisions(calls: ToolCalls, decisions: PermissionDecisions) {
  if (
    decisions.length > calls.length ||
    decisions.some(
      (entry, index) =>
        entry.callId !== calls[index]?.id ||
        (index < decisions.length - 1 && entry.decision !== "allow_once"),
    ) ||
    (decisions.at(-1)?.decision === "allow_once" && decisions.length !== calls.length)
  )
    throw new Error("Permission decisions do not match admitted tool calls");
  return decisions;
}

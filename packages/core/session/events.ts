import { z } from "zod";

import { BlobRefSchema } from "../agent/content.ts";
import { parseSessionContext } from "../agent/prompt.ts";
import { MessagesSchema } from "../agent/types.ts";
import { PolicyPatchSchema } from "../policy/policy.ts";

/**
 * Schema of the public events a caller submits with `SessionRuntime.dispatch`:
 * - `user`: user input (text, stored attachment refs, or both). It starts a turn, joins the
 *   active turn by barge-in, is queued, or is refused, as the mid-turn input policy decides.
 * - `abort`: cancels the active turn, which ends `aborted`. Already queued inputs are kept.
 * - `system`: replaces the standing session instructions (not a system notice).
 * - `policy`: patches the configuration for the next turn.
 * - `fork` / `compact`: create a child session; `context` is the compacted child's replacement
 *   context and must hold complete tool exchanges.
 * - `close`: closes the session; nothing is journaled.
 */
export const EnvEventSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("user"),
      text: z.string().default(""),
      attachments: z
        .array(BlobRefSchema)
        .readonly()
        .transform((refs) => (refs.length ? refs : undefined))
        .optional(),
    })
    .refine(
      (event) => event.text.length > 0 || Boolean(event.attachments?.length),
      "User input requires text or attachments",
    ),
  z.strictObject({ type: z.literal("abort") }),
  z.strictObject({ type: z.literal("system"), inputs: z.array(z.string()).readonly() }),
  z.strictObject({ type: z.literal("policy"), patch: PolicyPatchSchema }),
  z.strictObject({ type: z.literal("fork") }),
  z.strictObject({
    type: z.literal("compact"),
    context: MessagesSchema.transform(parseSessionContext),
  }),
  z.strictObject({ type: z.literal("close") }),
]);
/** A public session event before validation (input shape of {@link EnvEventSchema}). */
export type EnvEvent = z.input<typeof EnvEventSchema>;

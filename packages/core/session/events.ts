import { z } from "zod";

import { parseSessionContext } from "../agent/prompt.ts";
import { MessagesSchema } from "../agent/types.ts";
import { PolicyPatchSchema } from "../policy/policy.ts";

export const EnvEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("user"), text: z.string() }),
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
export type EnvEvent = z.input<typeof EnvEventSchema>;

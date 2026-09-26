import { z } from "zod";

import { ChatMessageSchema } from "../agent/agent.ts";
import {
  projectConversationPrompt,
  projectMediaPointers,
  type PromptInput,
} from "../agent/prompt.ts";
import { freeze } from "../fsm/fsm.ts";

/**
 * Projects a step's prompt as chat messages: the agent's configured system prompt, then the
 * standing session instructions in order (not system notices), then the history of
 * {@link projectConversationPrompt}, target-aware (see {@link projectMediaPointers}). A handoff
 * step's packet comes from the policy's handoff resolver, so its prompt is `projectPolicy`'s, not
 * this one. The result is frozen.
 *
 * @throws Error when the history does not form a valid prompt, such as a tool result without its
 *   call.
 */
export function projectSessionPrompt(input: PromptInput, systemInputs: readonly string[]) {
  const projected = projectConversationPrompt({
    ...input,
    agent: { ...input.agent, systemPrompt: undefined },
  });
  const messages = input.target
    ? projectMediaPointers(projected, input.target).messages
    : projected;
  return freeze(
    z
      .array(ChatMessageSchema)
      .parse([
        ...(input.agent.systemPrompt
          ? [{ role: "system", content: input.agent.systemPrompt }]
          : []),
        ...systemInputs.map((content) => ({ role: "system", content })),
        ...messages,
      ]),
  );
}

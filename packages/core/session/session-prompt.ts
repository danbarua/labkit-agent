import { z } from "zod";

import { ChatMessageSchema } from "../agent/agent.ts";
import { projectConversationPrompt, type PromptInput } from "../agent/prompt.ts";
import { freeze } from "../fsm/fsm.ts";

/**
 * Projects a step's prompt as chat messages: the agent's configured system prompt, then the
 * standing session instructions in order (not system notices), then the history or handoff view
 * of {@link projectConversationPrompt}. The result is frozen.
 *
 * @throws Error when the history does not form a valid prompt, such as a tool result without its
 *   call.
 */
export function projectSessionPrompt(input: PromptInput, systemInputs: readonly string[]) {
  const messages = projectConversationPrompt({
    ...input,
    agent: { ...input.agent, systemPrompt: undefined },
  });
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

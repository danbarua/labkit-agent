import { z } from "zod";

import { ChatMessageSchema } from "../agent/agent.ts";
import { projectConversationPrompt, type PromptInput } from "../agent/prompt.ts";
import { freeze } from "../fsm/fsm.ts";

/** Configured system prompt, ordered session inputs, then the existing history/handoff view. */
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

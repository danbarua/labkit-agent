import { z } from "zod";

import type { TurnCommand } from "../../agent/agent-fsm.ts";
import { MessagesSchema, type ActorId } from "../../agent/types.ts";
import type { HostContext } from "../context.ts";
import type { ExecutionContext } from "../host.ts";

/**
 * Projects the messages the next agent receives on a handoff, using `context.projectHandoff` when
 * set and otherwise the last user message plus the final message.
 */
export function prepareHandoff(
  host: HostContext,
  turnId: ActorId,
  command: Extract<TurnCommand, { type: "prepare_handoff" }>,
  context: ExecutionContext,
): void {
  const prompt = context.prompt;
  if (!prompt) throw new Error("Host prepare_handoff requires prompt context");
  host.spawn(
    command.child,
    {
      failureContext: {
        operation: {
          id: command.child.id,
          kind: command.child.kind,
          sessionId: host.sessionId,
          turnId,
        },
      },
      input: null,
      parseInput: z.null().parse,
      run: (_, signal) =>
        context.projectHandoff
          ? context.projectHandoff(
              { ...prompt, from: command.from, to: command.turn.agent },
              signal,
            )
          : [
              command.turn.messages.findLast((message) => message.role === "user"),
              command.turn.messages.at(-1),
            ].filter((message) => message !== undefined),
      parseOutput: MessagesSchema.parseAsync,
    },
    (result) => host.post(turnId, { type: "handoff_prepared", child: command.child, result }),
  );
}

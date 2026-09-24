// Start here: ordinary usage through the package's public API. Dependencies are local doubles.
import { z } from "zod";

import { createSession, defineTool, restoreSession, type SessionOptions } from "../../index.ts";
import { deterministicIds } from "../test-support.ts";
import type { Scenario } from "./support.ts";

export const conversationUsage: Scenario = {
  name: "usage-conversation-and-restore",
  version: 2,
  group: "getting-started",
  baseline: "assertions",
  purpose:
    "Configure a session, distinguish durable admission from the final answer, and reopen the same saved conversation.",
  source: "packages/core/session/fixtures/usage.ts#conversationUsage",
  environment:
    "The assistant is named reviewer. A local completion double answers once. Persistence is process-local memory, shared across close and restore; this demonstrates the API, not disk crash durability.",
  dependencies: { completions: [] },
  async run(f) {
    let modelCalls = 0;
    const options: SessionOptions = {
      persistence: f.persistence,
      configuration: {
        agent: "reviewer",
        agents: new Map([
          [
            "reviewer",
            {
              model: "example-model",
              systemPrompt: "Answer the user's question.",
              tools: [],
              successors: [],
            },
          ],
        ]),
        steps: 4,
      },
      bindings: {
        id: deterministicIds(),
        tools: new Map(),
        complete: (request) => {
          modelCalls++;
          f.requests.push(request);
          return { kind: "answer", text: "The session retains committed conversation history." };
        },
      },
    };
    f.action("Create a reviewer session with explicit configuration and environment bindings.");
    const session = f.track("original", await createSession(options));
    const savedId = session.snapshot.durable.conversation.sessionId;

    f.action("Ask a question, then wait separately for admission and settlement.");
    const turn = session.input("What does a session retain?");
    const admission = await turn.accepted;
    f.record({ admission });
    f.check("The user message is durably admitted", admission.kind, "accepted");
    const answer = await turn.settled;
    f.record({ answer });
    f.check("The turn reaches a terminal result", answer.kind, "terminal");
    if (answer.kind !== "terminal") throw new Error("Expected a terminal answer");
    f.check("The assistant completes successfully", answer.record.outcome.kind, "completed");
    f.check(
      "The answer is in committed history",
      answer.record.messages.at(-1)?.text,
      "The session retains committed conversation history.",
    );
    const savedConversation = session.snapshot.durable.conversation.log;

    f.action("Close the runtime and reopen the saved session ID using the same persistence.");
    await session.close();
    const reopened = f.track("reopened", await restoreSession(options, savedId));
    f.check(
      "Reopening preserves the committed conversation",
      reopened.snapshot.durable.conversation.log,
      savedConversation,
    );
    f.check("Reopening does not call the model again", modelCalls, 1);
  },
};

// The two scenarios differ only in the host's permission response; the public API is identical.
function toolUsage(allow: boolean): Scenario {
  return {
    name: allow ? "usage-approve-tool" : "usage-deny-tool",
    version: 2,
    group: "getting-started",
    baseline: "assertions",
    purpose: allow
      ? "Define a typed tool, approve its invocation through the host permission port, and let the assistant use its result."
      : "Deny a requested tool through the host permission port and verify that its effect never runs.",
    source: "packages/core/session/fixtures/usage.ts#toolUsage",
    environment:
      "The assistant is named reviewer. The read_note tool reads a local in-memory note, not a real file. Provider and permission responses are deterministic doubles. The real runtime owns the tool loop and admission ordering.",
    dependencies: { completions: [] },
    async run(f) {
      const notes: Record<string, string> = {
        design: "Keep decisions pure; persist before releasing effects.",
      };
      let reads = 0;
      let modelCalls = 0;
      let permissions = 0;
      const options: SessionOptions = {
        persistence: f.persistence,
        configuration: {
          agent: "reviewer",
          agents: new Map([
            ["reviewer", { model: "example-model", tools: ["read_note"], successors: [] }],
          ]),
          steps: 4,
          policy: { permissions: "ask" },
        },
        bindings: {
          id: deterministicIds(),
          tools: new Map([
            [
              "read_note",
              defineTool({
                input: z.object({ name: z.string() }),
                kind: "read",
                run: ({ name }) => {
                  reads++;
                  return { body: notes[name] ?? "Note not found" };
                },
              }),
            ],
          ]),
          requestPermission: (request) => {
            permissions++;
            f.record({ permission: request });
            f.check("Permission is requested before the tool runs", reads, 0);
            return {
              outcome: { outcome: "selected", optionId: allow ? "allow-once" : "reject-once" },
            };
          },
          complete: (request) => {
            f.requests.push(request);
            modelCalls++;
            if (modelCalls === 1)
              return {
                kind: "tools",
                text: "I will read the design note.",
                calls: [{ id: "read-design", name: "read_note", args: { name: "design" } }],
              };
            f.check(
              "The follow-up model request includes the tool result",
              JSON.stringify(request.messages).includes(notes.design!),
              true,
            );
            return {
              kind: "answer",
              text: "The design keeps decisions pure and persists before releasing effects.",
            };
          },
        },
      };
      f.action(
        `Create a session whose host will ${allow ? "approve" : "deny"} the requested note read.`,
      );
      const session = f.track("review", await createSession(options));
      const turn = session.input("Summarize the design note.");
      f.check("The prompt is admitted", (await turn.accepted).kind, "accepted");
      const result = await turn.settled;
      f.record({ result });
      f.check("The turn settles", result.kind, "terminal");
      if (result.kind !== "terminal") throw new Error("Expected a terminal tool outcome");
      f.check("The host receives one permission request", permissions, 1);
      f.check(
        allow ? "The approved effect runs once" : "The denied effect never runs",
        reads,
        allow ? 1 : 0,
      );
      f.check("Only approved results are sent back to the model", modelCalls, allow ? 2 : 1);
      f.check(
        "The turn outcome reflects the permission choice",
        result.record.outcome.kind,
        allow ? "completed" : "failed",
      );
    },
  };
}

export const approveToolUsage = toolUsage(true);

export const denyToolUsage = toolUsage(false);

import { expect, test } from "@logtape/testing-bun/autoload";

import { BlobRefSchema, hashBlob } from "../agent/content.ts";
import { MessageSchema, type TurnRecord } from "../agent/types.ts";
import { createSession } from "./session-runtime.ts";
import { scriptedCompletion, testOptions } from "./test-support.ts";
import { projectConversation, projectMessage, projectTurn } from "./views.ts";

const bytes = new TextEncoder().encode("hello");
const ref = BlobRefSchema.parse({ id: hashBlob(bytes), media: "image/png", bytes: bytes.length });

test("projectMessage renders a user message's blob parts as blob:// refs", () => {
  const message = MessageSchema.parse({
    role: "user",
    text: "See attached",
    parts: [
      { type: "text", text: "See attached" },
      { type: "blob", ref },
    ],
  });
  expect(projectMessage(message)).toEqual({
    role: "user",
    text: "See attached",
    blobs: [
      {
        id: ref.id,
        media: "image/png",
        bytes: ref.bytes,
        uri: `blob://${ref.id}.png`,
      },
    ],
  });
});

test("projectMessage keeps an attachment's name and carries an assistant step's owner and calls", () => {
  const named = BlobRefSchema.parse({ ...ref, name: "diagram.png" });
  const message = MessageSchema.parse({
    role: "assistant",
    text: "Working on it",
    calls: [{ id: "c1", name: "search", args: { query: "x" } }],
    owner: { turnId: "session-1/turn/1", generation: 2 },
    parts: [
      { type: "text", text: "Working on it" },
      { type: "blob", ref: named },
    ],
  });
  expect(projectMessage(message)).toEqual({
    role: "assistant",
    text: "Working on it",
    blobs: [
      {
        id: named.id,
        media: "image/png",
        bytes: named.bytes,
        name: "diagram.png",
        uri: `blob://${named.id}.png`,
      },
    ],
    calls: [{ id: "c1", name: "search", args: { query: "x" } }],
    owner: { turnId: "session-1/turn/1", generation: 2 },
  });
});

test("projectMessage renders a tool result by its answered call id, with no blobs", () => {
  const message = MessageSchema.parse({ role: "tool", text: "42", callId: "c1" });
  expect(projectMessage(message)).toEqual({ role: "tool", text: "42", callId: "c1", blobs: [] });
});

test("projectTurn preserves the turn's agent, outcome and message order", () => {
  const turn: TurnRecord = {
    agent: "a" as TurnRecord["agent"],
    outcome: { kind: "completed" },
    messages: [
      MessageSchema.parse({ role: "user", text: "hi" }),
      MessageSchema.parse({ role: "assistant", text: "hello" }),
    ],
  };
  expect(projectTurn(turn)).toEqual({
    agent: "a",
    outcome: { kind: "completed" },
    messages: [
      { role: "user", text: "hi", blobs: [] },
      { role: "assistant", text: "hello", blobs: [] },
    ],
  });
});

test("projectConversation projects a folded session's context, log and live turn identically to its facts", async () => {
  const options = testOptions({
    complete: scriptedCompletion([
      {
        kind: "tools",
        text: "checking",
        calls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
      },
      { kind: "answer", text: "done" },
    ]),
  });
  const session = await createSession(options);
  const sessionId = session.snapshot.durable.conversation.sessionId;
  const result = await session.input({ text: "Look" }).settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");

  const view = projectConversation(session.snapshot.durable);
  expect(view.sessionId).toBe(sessionId);
  expect(view.context).toEqual([]);
  expect(view.live).toEqual([]);
  expect(view.log).toHaveLength(1);
  const [turn] = view.log;
  expect(turn!.agent).toBe("a");
  expect(turn!.outcome).toEqual({ kind: "completed" });
  expect(turn!.messages).toEqual([
    { role: "user", text: "Look", blobs: [] },
    {
      role: "assistant",
      text: "checking",
      blobs: [],
      calls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
    },
    { role: "tool", text: "hi", callId: "c1", blobs: [] },
    { role: "assistant", text: "done", blobs: [] },
  ]);

  const compacted = await session.compact([
    MessageSchema.parse({ role: "user", text: "carried over" }),
  ]);
  expect(projectConversation(compacted.snapshot.durable).context).toEqual([
    { role: "user", text: "carried over", blobs: [] },
  ]);
  expect(projectConversation(compacted.snapshot.durable).log).toEqual([]);
});

import { expect, test } from "bun:test";
import { projectConversationPrompt } from "./agent-runtime.ts";
import type { TurnRecord } from "./agent-conversation.ts";
import type { AgentMessage } from "./types.ts";
import { context } from "./test-support.ts";

const exchange = (): AgentMessage[] => [
  { role: "assistant", text: "searching", toolCalls: [
    { id: "a", name: "search", args: {} }, { id: "b", name: "search", args: {} },
  ] },
  { role: "tool", toolCallId: "a", text: "found" },
];
const project = (messages: AgentMessage[], completion: TurnRecord["completion"]) =>
  projectConversationPrompt({ log: [{ agent: "writer", messages, completion }], context: context(), agent: { model: "local" } });

test("missing results in completed history or the current turn raise errors", () => {
  expect(() => project(exchange(), "completed")).toThrow("logged turn 1: missing results for b");
  expect(() => projectConversationPrompt({
    log: [], context: { ...context(), messages: exchange() }, agent: { model: "local" },
  })).toThrow("current turn: missing results for b");
});

test("interrupted tails retain matched exchanges without altering the source transcript", () => {
  for (const completion of ["aborted", "failed", "exhausted"] as const) {
    const messages = exchange();
    const original = structuredClone(messages);
    const projected = project(messages, completion);
    expect(projected[0]!.tool_calls?.map(call => call.id)).toEqual(["a"]);
    expect(projected[1]).toEqual({ role: "tool", tool_call_id: "a", content: "found" });
    expect(messages).toEqual(original);
  }
});

test("interruption does not excuse missing results in an earlier exchange", () => {
  expect(() => project([...exchange(), { role: "assistant", text: "finished" }], "aborted"))
    .toThrow("missing results for b");
});

test("orphan, unmatched and duplicate results are never silently removed", () => {
  expect(() => project([{ role: "tool", toolCallId: "a", text: "orphan" }], "failed")).toThrow("orphan result a");
  for (const id of ["a", "unknown"]) {
    expect(() => project([...exchange(), { role: "tool", toolCallId: id, text: "bad" }], "failed"))
      .toThrow("duplicate or unmatched tool IDs");
  }
});

test("a handoff packet does not hide missing results in its source transcript", () => {
  expect(() => projectConversationPrompt({
    log: [], context: { ...context(), messages: exchange(), promptMessages: [{ role: "user", text: "summary" }] },
    agent: { model: "local" },
  })).toThrow("current turn: missing results for b");
});

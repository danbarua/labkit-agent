import { expect, test } from "bun:test";
import { projectConversationPrompt } from "./prompt.ts";
import { AgentIdSchema, MessagesSchema, type AgentMessage, type Outcome } from "./types.ts";
import { context as turnData } from "./test-support.ts";

const exchange = () => MessagesSchema.parse([
  { role: "assistant", text: "searching", calls: [
    { id: "a", name: "search", args: {} }, { id: "b", name: "search", args: {} },
  ] }, { role: "tool", callId: "a", text: "found" },
]);
const agent = { model: "local", tools: [] };
const project = (messages: readonly AgentMessage[], outcome: Outcome) => projectConversationPrompt({
  log: [{ agent: AgentIdSchema.parse("writer"), messages, outcome }], turn: turnData(), agent,
});

test("missing results in completed history or current turns raise errors", () => {
  expect(() => project(exchange(), { kind: "completed" })).toThrow("logged turn 1: missing results for b");
  expect(() => projectConversationPrompt({ log: [], turn: { ...turnData(), messages: exchange() }, agent }))
    .toThrow("current turn: missing results for b");
});

test("interrupted tails retain matched results without altering source records", () => {
  for (const outcome of [{ kind: "aborted" }, { kind: "exhausted" }, { kind: "failed", error: { message: "offline" } }] as const) {
    const messages = exchange();
    const projected = project(messages, outcome);
    const assistant = projected[0]!;
    expect(assistant.role === "assistant" && assistant.tool_calls?.map(call => call.id)).toEqual(["a"]);
    expect(projected[1]).toEqual({ role: "tool", tool_call_id: "a", content: "found" });
    const original = messages[0]!;
    expect(original.role === "assistant" && original.calls?.length).toBe(2);
  }
});

test("interruption does not excuse missing results in earlier exchanges", () => {
  expect(() => project([...exchange(), { role: "assistant", text: "finished" }], { kind: "aborted" })).toThrow("missing results for b");
});

test("orphan, unmatched and duplicate results raise projection errors", () => {
  expect(() => project(MessagesSchema.parse([{ role: "tool", callId: "a", text: "orphan" }]), { kind: "aborted" })).toThrow("orphan result a");
  for (const callId of ["a", "unknown"]) {
    expect(() => project(MessagesSchema.parse([...exchange(), { role: "tool", callId, text: "bad" }]), { kind: "aborted" })).toThrow("duplicate or unmatched");
  }
});

test("a handoff packet cannot conceal invalid source history", () => {
  expect(() => projectConversationPrompt({ log: [], turn: { ...turnData(), messages: exchange(),
    view: { kind: "handoff", messages: [{ role: "user", text: "summary" }] },
  }, agent })).toThrow("current turn: missing results for b");
});

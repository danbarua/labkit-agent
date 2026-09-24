import { describe, expect, test } from "@logtape/testing-bun/autoload";

import { CompletionSchema } from "../../agent/types.ts";
import { CompletionRequestSchema, type CompletionProfile } from "../types.ts";

export type ProfileVector = Readonly<{
  answer: unknown;
  calls: unknown;
  handoff: unknown;
  invalid: readonly unknown[];
  expectedBody: unknown;
}>;
export const request = CompletionRequestSchema.parse({
  model: "test-model",
  messages: [
    { role: "system", text: "Be concise" },
    { role: "user", text: "Find it" },
    { role: "assistant", text: "", calls: [{ id: "c1", name: "lookup", args: { query: "a" } }] },
    { role: "tool", callId: "c1", text: "found" },
  ],
  tools: [
    {
      name: "lookup",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
  successors: [],
});
export function profileContract(profile: CompletionProfile, vector: ProfileVector) {
  const response = (body: unknown) => ({ status: 200, headers: new Headers(), body });
  describe(profile.id, () => {
    test("encodes the full canonical transcript against the approved wire vector", () => {
      const before = JSON.stringify(request);
      expect(
        profile.encode({
          ...request,
          ...(profile.capabilities.outputTokens?.required ? { maxOutputTokens: 1024 } : {}),
        }).body,
      ).toEqual(vector.expectedBody);
      expect(JSON.stringify(request)).toBe(before);
    });
    test("decodes answer, ordered parallel calls, and reserved handoff", () => {
      expect(CompletionSchema.parse(profile.decode(response(vector.answer)).completion)).toEqual({
        kind: "answer",
        text: "done",
      });
      expect(
        CompletionSchema.parse(profile.decode(response(vector.calls)).completion),
      ).toMatchObject({
        kind: "tools",
        calls: [
          { id: "c1", name: "lookup", args: { query: "a" } },
          { id: "c2", name: "lookup", args: { query: "b" } },
        ],
      });
      expect(CompletionSchema.parse(profile.decode(response(vector.handoff)).completion)).toEqual(
        CompletionSchema.parse({ kind: "handoff", text: "", agent: "b" }),
      );
    });
    test("rejects malformed, incomplete, built-in-tool, and unsupported thinking responses", () => {
      for (const body of vector.invalid) expect(() => profile.decode(response(body))).toThrow();
      expect(() => profile.decode({ ...response(vector.answer), status: 503 })).toThrow();
    });
    test("rejects unsupported settings before any I/O and reserves the handoff name", () => {
      for (const patch of [
        { stream: true },
        { thinking: "adaptive" },
        { tools: [{ name: "handoff_to", parameters: {} }] },
      ])
        expect(() => profile.encode({ ...request, ...patch } as never)).toThrow();
    });
    test("rejects orphan and incomplete tool exchanges", () => {
      expect(() =>
        profile.encode({ ...request, messages: request.messages.slice(0, -1) }),
      ).toThrow();
      expect(() => profile.encode({ ...request, messages: [request.messages.at(-1)!] })).toThrow();
    });
  });
}

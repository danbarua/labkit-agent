import type { AgentContext } from "@agentclientprotocol/sdk";
import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";

import { clientElicitation, elicitationFormSchema } from "./client-elicitation.ts";

test("form schemas validate primitive constraints and titled single/multiple choices", () => {
  const { validate } = elicitationFormSchema({
    type: "object",
    properties: {
      name: { type: "string", minLength: 2, pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 1, maximum: 5 },
      enabled: { type: "boolean" },
      choice: {
        type: "string",
        oneOf: [
          { const: "a", title: "A" },
          { const: "b", title: "B" },
        ],
      },
      tags: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: "x", title: "X" },
            { const: "y", title: "Y" },
          ],
        },
      },
    },
    required: ["name", "count", "enabled", "choice", "tags"],
  });
  const good = { name: "ok", count: 2, enabled: true, choice: "b", tags: ["x"] };
  expect(validate(good)).toBe(true);
  for (const patch of [
    { count: 1.5 },
    { count: 6 },
    { name: "!" },
    { tags: ["x", "x"] },
    { tags: ["z"] },
    { choice: "c" },
    { enabled: "yes" },
    { extra: "unknown" },
  ])
    expect(validate({ ...good, ...patch })).toBe(false);
  expect(validate({})).toBe(false);
  expect(() => elicitationFormSchema({ properties: { nested: { type: "object" } } })).toThrow(
    "Unsupported",
  );
  expect(() => elicitationFormSchema({ required: ["missing"] })).toThrow("properties");
});

test("empty or null capability modes expose no elicitation port", () => {
  // No request is possible without an explicitly supported mode.
  const fake = {} as Parameters<typeof clientElicitation>[0];
  const signal = new AbortController().signal;
  for (const elicitation of [undefined, null, {}, { form: null, url: null }]) {
    const binding = clientElicitation(
      fake,
      { elicitation },
      () => "session",
      signal,
      () => signal,
    );
    expect(binding.port).toEqual({});
    binding.close();
  }
});

test("elicitation diagnostics retain scope and invalid response cause without answers", async () => {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  try {
    const client = {
      request: async () => ({ action: "accept", content: { choice: "PRIVATE_ANSWER" } }),
    } as unknown as AgentContext;
    const signal = new AbortController().signal;
    const binding = clientElicitation(
      client,
      { elicitation: { form: {} } },
      () => "form-session",
      signal,
      () => signal,
    );
    await expect(
      binding.port.form!(
        {
          message: "Choose",
          requestedSchema: { type: "object", properties: { choice: { type: "boolean" } } },
        },
        signal,
        { toolCallId: "form-tool" },
      ),
    ).rejects.toThrow("does not match");
    const records = emitted.mock.calls.map((call) => call[0].properties);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "elicitation.requested",
        sessionId: "form-session",
        toolCallId: "form-tool",
        timeoutMs: 120000,
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "elicitation.validation_failed",
        reason: expect.stringContaining("boolean"),
      }),
    );
    expect(JSON.stringify(records)).not.toContain("PRIVATE_ANSWER");
    binding.close();
  } finally {
    emitted.mockRestore();
  }
});

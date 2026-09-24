import { expect, test } from "bun:test";

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

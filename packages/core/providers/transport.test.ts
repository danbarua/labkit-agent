import { expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../agent/agent.ts";
import { deferred } from "../agent/test-support.ts";
import { openaiChat } from "./openai-chat.ts";
import { bindProviders, httpTransport } from "./transport.ts";

const prepared = PreparedModelSchema.parse({
  provider: openaiChat.id,
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  successors: ["b"],
});
test("bindings copy credentials and registries, issue one request, and keep secrets off domain values", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const headers = { Authorization: "Bearer SECRET" };
  const binding = {
    profile: openaiChat,
    transport: {
      baseUrl: "https://example.invalid/v1",
      headers,
      fetch: (async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ choices: [{ message: { content: "done" } }] });
      }) as typeof fetch,
    },
  };
  const registry = new Map([[openaiChat.id, binding]]);
  const port = bindProviders(registry);
  registry.clear();
  headers.Authorization = "changed";
  expect(await port.complete(prepared, new AbortController().signal)).toEqual({
    completion: { kind: "answer", text: "done" },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("https://example.invalid/v1/chat/completions");
  expect(requests[0]!.init?.headers).toMatchObject({ Authorization: "Bearer SECRET" });
  expect(JSON.stringify(prepared)).not.toContain("SECRET");
  expect(JSON.stringify(prepared)).not.toContain("baseUrl");
});
test("HTTP failure never retries or exposes provider body; invalid JSON fails", async () => {
  let calls = 0;
  const http = httpTransport({
    baseUrl: "https://example.invalid/v1",
    fetch: (async () => {
      calls++;
      return new Response("SECRET", { status: 503 });
    }) as unknown as typeof fetch,
  });
  await expect(
    http({ path: "/test", method: "POST", headers: {}, body: {} }, new AbortController().signal),
  ).rejects.toThrow("Completion HTTP failure (503)");
  expect(calls).toBe(1);
  const invalid = httpTransport({
    baseUrl: "https://example.invalid/v1",
    fetch: (async () => new Response("{")) as unknown as typeof fetch,
  });
  await expect(
    invalid({ path: "/test", method: "POST", headers: {}, body: {} }, new AbortController().signal),
  ).rejects.toThrow("not valid JSON");
});
test("cancellation reaches fetch and rejects a late response", async () => {
  const pending = deferred<Response>();
  let seen: AbortSignal | null | undefined;
  const http = httpTransport({
    baseUrl: "https://example.invalid",
    fetch: (async (_url, init) => {
      seen = init?.signal;
      return pending.promise;
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const result = http({ path: "/test", method: "POST", headers: {}, body: {} }, controller.signal);
  controller.abort();
  pending.resolve(Response.json({}));
  await expect(result).rejects.toThrow();
  expect(seen).toBe(controller.signal);
  expect(seen?.aborted).toBe(true);
});
test("unadvertised handoffs are rejected at the binding boundary", async () => {
  const port = bindProviders(
    new Map([
      [
        openaiChat.id,
        {
          profile: openaiChat,
          transport: {
            baseUrl: "https://example.invalid",
            fetch: (async () =>
              Response.json({
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          id: "h",
                          type: "function",
                          function: { name: "handoff_to", arguments: '{"agent":"c"}' },
                        },
                      ],
                    },
                  },
                ],
              })) as unknown as typeof fetch,
          },
        },
      ],
    ]),
  );
  await expect(port.complete(prepared, new AbortController().signal)).rejects.toThrow(
    "Unpermitted handoff",
  );
});

test("prepared domain input rejects transport resources and credentials", () => {
  for (const extra of [
    { baseUrl: "https://example.invalid" },
    { apiKey: "SECRET" },
    { signal: new AbortController().signal },
  ])
    expect(PreparedModelSchema.safeParse({ ...prepared, ...extra }).success).toBe(false);
});

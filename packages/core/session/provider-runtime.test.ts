import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { builtinResolvers } from "../policy/policy.ts";
import {
  anthropicMessages,
  googleGenerate,
  openaiChat,
  openaiResponses,
  type CompletionProfile,
} from "../providers/index.ts";
import type { SessionPersistence } from "./persistence.ts";
import { decodeRecord, journalJSONL, replay } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type SessionOptions,
} from "./session-runtime.ts";
import { deferred, deterministicIds, testOptions, until } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

function answer(profile: CompletionProfile, text = "done") {
  switch (profile.id) {
    case "openai-chat@1":
      return { choices: [{ message: { content: text } }] };
    case "openai-responses@1":
      return {
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      };
    case "anthropic-messages@1":
      return { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] };
    default:
      return {
        candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }],
      };
  }
}

function options(profile = openaiChat, calls: unknown[] = []): SessionOptions {
  return {
    configuration: {
      agent: "a",
      steps: 3,
      agents: new Map([
        ["a", { model: "default-model", tools: ["echo"], successors: ["b"] }],
        ["b", { model: "b-model", tools: [], successors: [] }],
      ]),
      policy: { provider: profile.id, stream: false, thinking: "off" },
    },
    bindings: {
      id: deterministicIds(),
      tools: new Map([
        ["echo", defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => text })],
      ]),
      providers: new Map(
        [openaiChat, openaiResponses, anthropicMessages, googleGenerate].map((p) => [
          p.id,
          {
            profile: p,
            transport: {
              baseUrl: "https://example.invalid/v1",
              headers: { Authorization: "Bearer SECRET" },
              fetch: (async (_url, init) => {
                calls.push(JSON.parse(String(init?.body)));
                return Response.json(answer(p));
              }) as typeof fetch,
            },
          },
        ]),
      ),
    },
    persistence: createMemoryPersistence(),
  };
}
for (const profile of [openaiChat, openaiResponses, anthropicMessages, googleGenerate]) {
  test(`${profile.id} session restores without effects and forks identical next requests`, async () => {
    const calls: unknown[] = [];
    const opts = options(profile, calls);
    const session = await createSession(opts);
    const result = await session.input("hello").settled;
    expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
    expect(session.snapshot.durable.records.every((record) => record.version === 1)).toBe(true);
    const before = calls.length;
    const restored = await restoreSession(opts, session.snapshot.durable.conversation.sessionId);
    expect(calls).toHaveLength(before);
    expect(restored.snapshot.durable).toEqual(session.snapshot.durable);
    const branch = await session.fork();
    await branch.input("next").settled;
    const branchedRequest = calls.at(-1);
    await restored.input("next").settled;
    expect(calls.at(-1)).toEqual(branchedRequest);
    expect(journalJSONL(session.snapshot.durable)).not.toContain("SECRET");
    expect(journalJSONL(session.snapshot.durable)).not.toContain("example.invalid");
    const compacted = await session.compact([]);
    await compacted.input("reset").settled;
    expect(JSON.stringify(calls.at(-1))).not.toContain("hello");
    await Promise.all([session.close(), restored.close(), branch.close(), compacted.close()]);
  });
}
test("provider and model patches commit at idle; missing bindings fail admission and restore", async () => {
  const calls: unknown[] = [];
  const opts = options(openaiChat, calls);
  const session = await createSession(opts);
  expect(
    (await session.updatePolicy({ provider: anthropicMessages.id, model: "override" })).kind,
  ).toBe("accepted");
  await session.input("hello").settled;
  expect(calls.at(-1)).toMatchObject({ model: "override", thinking: { type: "disabled" } });
  expect((await session.updatePolicy({ provider: "missing@1" })).kind).toBe("failed");
  const providers = new Map(opts.bindings.providers);
  providers.delete(anthropicMessages.id);
  await expect(
    restoreSession(
      { ...opts, bindings: { ...opts.bindings, providers } },
      session.snapshot.durable.conversation.sessionId,
    ),
  ).rejects.toThrow("provider binding");
  await session.close();
});
test("active completion sees frozen selection and a mid-turn policy change is busy", async () => {
  const opts = options();
  const pending = deferred<Response>();
  let body: unknown;
  const providers = new Map(opts.bindings.providers);
  providers.set(openaiChat.id, {
    profile: openaiChat,
    transport: {
      baseUrl: "https://example.invalid",
      fetch: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return pending.promise;
      }) as typeof fetch,
    },
  });
  const session = await createSession({ ...opts, bindings: { ...opts.bindings, providers } });
  const handle = session.input("hello");
  await until(() => body !== undefined);
  expect(await session.updatePolicy({ provider: anthropicMessages.id, model: "other" })).toEqual({
    kind: "busy",
  });
  expect(body).toMatchObject({ model: "default-model" });
  pending.resolve(Response.json(answer(openaiChat)));
  await handle.settled;
  await session.close();
});
test("rejected policy append never starts dependent work or changes durable selection", async () => {
  const opts = options();
  const backing = opts.persistence;
  let reject = false;
  const persistence: SessionPersistence = {
    lifetime: backing.lifetime,
    putBlob: backing.putBlob.bind(backing),
    getBlob: backing.getBlob.bind(backing),
    load: backing.load.bind(backing),
    append: (request, signal) =>
      reject
        ? Promise.resolve({ kind: "rejected", message: "offline" })
        : backing.append(request, signal),
  };
  const session = await createSession({ ...opts, persistence });
  reject = true;
  expect((await session.updatePolicy({ provider: anthropicMessages.id })).kind).toBe("failed");
  expect(session.snapshot.durable.policy?.provider).toBe(openaiChat.id);
  await session.close();
});
test("provider configuration changes retain format and reject tampering", async () => {
  const legacy = testOptions();
  const old = await createSession(legacy);
  await old.input("old history").settled;
  await old.close();
  const opts = options();
  // Legacy manifest remains exact: provider selection changes policy, not agent configuration.
  const restored = await restoreSession(
    {
      ...opts,
      persistence: legacy.persistence,
      configuration: { ...opts.configuration, agents: legacy.configuration.agents },
      bindings: { ...opts.bindings, tools: legacy.bindings.tools, id: legacy.bindings.id },
    },
    old.snapshot.durable.conversation.sessionId,
  );
  expect((await restored.updatePolicy({ provider: openaiResponses.id, model: "new" })).kind).toBe(
    "accepted",
  );
  const terminal = await restored.input("new turn").settled;
  expect(terminal.kind === "terminal" && terminal.record.outcome.kind).toBe("completed");
  expect(restored.snapshot.durable.records.map((record) => record.version)).toContain(1);
  expect(restored.snapshot.durable.records.map((record) => record.version)).toContain(1);
  expect(restored.snapshot.durable.records.at(-1)?.version).toBe(1);
  const loaded = await legacy.persistence.load(
    restored.snapshot.durable.conversation.sessionId,
    new AbortController().signal,
  );
  if (loaded.kind !== "loaded") throw new Error("missing journal");
  const resolvers = { ...builtinResolvers, providerIds: new Set(opts.bindings.providers?.keys()) };
  expect(replay(loaded.batches, resolvers)).toEqual(restored.snapshot.durable);
  const record = restored.snapshot.durable.records.find((r) => r.version === 1)!;
  expect(() => decodeRecord(JSON.stringify({ ...record, version: 2 }))).toThrow();
  const altered = loaded.batches.map((batch) => ({
    ...batch,
    records: batch.records.map((serialized) => {
      const entry = JSON.parse(serialized);
      if (entry.body.event?.event?.type === "prepared")
        entry.body.event.event.result.value.model = "tampered";
      return JSON.stringify(entry);
    }),
  }));
  expect(() => replay(altered, resolvers)).toThrow("model mismatch");
  await restored.close();
});
test("interrupted provider request recovers without invoking HTTP again", async () => {
  const opts = options();
  const pending = deferred<Response>();
  let calls = 0;
  const providers = new Map(opts.bindings.providers);
  providers.set(openaiChat.id, {
    profile: openaiChat,
    transport: {
      baseUrl: "https://example.invalid",
      fetch: (async () => {
        calls++;
        return pending.promise;
      }) as unknown as typeof fetch,
    },
  });
  const configured = { ...opts, bindings: { ...opts.bindings, providers } };
  const session = await createSession(configured);
  const handle = session.input("hello");
  await until(() => calls === 1);
  await session.close();
  await handle.settled;
  const restored = await restoreSession(
    configured,
    session.snapshot.durable.conversation.sessionId,
  );
  expect(calls).toBe(1);
  expect(
    restored.snapshot.durable.records.filter((record) => record.body.kind === "recovery"),
  ).toHaveLength(1);
  pending.resolve(Response.json(answer(openaiChat)));
  await restored.close();
});

function toolResponse(profile: CompletionProfile, name: string, args: unknown) {
  switch (profile.id) {
    case "openai-chat@1":
      return {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                { id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } },
              ],
            },
          },
        ],
      };
    case "openai-responses@1":
      return {
        status: "completed",
        output: [{ type: "function_call", call_id: "c1", name, arguments: JSON.stringify(args) }],
      };
    case "anthropic-messages@1":
      return {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "c1", name, input: args }],
      };
    default:
      return {
        candidates: [
          {
            finishReason: "STOP",
            content: { role: "model", parts: [{ functionCall: { id: "c1", name, args } }] },
          },
        ],
      };
  }
}
for (const profile of [openaiChat, openaiResponses, anthropicMessages, googleGenerate]) {
  test(`${profile.id} leaves tool execution and handoff with the existing turn machine`, async () => {
    const opts = options(profile);
    const bodies: unknown[] = [];
    let attempts = 0;
    let toolRuns = 0;
    const providers = new Map(opts.bindings.providers);
    providers.set(profile.id, {
      profile,
      transport: {
        baseUrl: "https://example.invalid/v1",
        fetch: (async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          const response =
            attempts++ === 0
              ? toolResponse(profile, "echo", { text: "result" })
              : attempts === 2
                ? toolResponse(profile, "handoff_to", { agent: "b" })
                : answer(profile);
          return Response.json(response);
        }) as typeof fetch,
      },
    });
    const session = await createSession({
      ...opts,
      bindings: {
        ...opts.bindings,
        providers,
        tools: new Map([
          [
            "echo",
            defineTool({
              input: z.object({ text: z.string() }),
              run: ({ text }) => {
                toolRuns++;
                return text;
              },
            }),
          ],
        ]),
      },
    });
    const terminal = await session.input("use tool then hand off").settled;
    expect(terminal.kind === "terminal" && terminal.record.outcome.kind).toBe("completed");
    expect(toolRuns).toBe(1);
    expect(attempts).toBe(3);
    expect(session.snapshot.durable.conversation.turn).toMatchObject({
      status: "idle",
      agent: "b",
    });
    expect(
      session.snapshot.durable.records.filter((record) => record.body.kind === "tool"),
    ).toHaveLength(1);
    expect(JSON.stringify(bodies[1])).toContain("result");
    expect(JSON.stringify(bodies[2])).not.toContain("handoff_to");
    await session.close();
  });
}
test("lost policy acknowledgement reconciles the same v3 selection exactly once", async () => {
  const opts = options();
  const backing = opts.persistence;
  let lost = false;
  const persistence: SessionPersistence = {
    lifetime: backing.lifetime,
    putBlob: backing.putBlob.bind(backing),
    getBlob: backing.getBlob.bind(backing),
    load: backing.load.bind(backing),
    async append(request, signal) {
      const result = await backing.append(request, signal);
      if (!lost && request.records.some((record) => JSON.parse(record).body.kind === "policy")) {
        lost = true;
        return { kind: "indeterminate", message: "Receipt lost" };
      }
      return result;
    },
  };
  const session = await createSession({ ...opts, persistence });
  expect((await session.updatePolicy({ provider: openaiResponses.id })).kind).toBe("accepted");
  expect(
    session.snapshot.durable.records.filter((record) => record.body.kind === "policy"),
  ).toHaveLength(1);
  expect(session.snapshot.durable.policy?.provider).toBe(openaiResponses.id);
  await session.close();
});

test("provider policy fields cannot be erased with non-JSON undefined patches", async () => {
  const session = await createSession(options());
  expect(() => session.updatePolicy({ provider: undefined })).toThrow("undefined");
  expect(session.snapshot.durable.policy?.provider).toBe(openaiChat.id);
  await session.close();
});

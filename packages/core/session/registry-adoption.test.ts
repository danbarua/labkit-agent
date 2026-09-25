import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { openaiChat } from "../providers/index.ts";
import type { SessionPersistence } from "./persistence.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type SessionOptions,
} from "./session-runtime.ts";
import { lostAcknowledgement, scriptedCompletion, testOptions } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

/** One agent on an OpenAI-chat binding whose models map offers only `models`. */
function providerOptions(
  persistence: SessionPersistence,
  models: readonly string[],
  policy: NonNullable<SessionOptions["configuration"]["policy"]>,
  bodies: { model: string; messages: unknown }[],
): SessionOptions {
  return {
    persistence,
    configuration: {
      agent: "reviewer",
      agents: new Map([["reviewer", { model: "sonnet", tools: ["echo"], successors: [] }]]),
      steps: 4,
      policy,
    },
    bindings: {
      id: () => crypto.randomUUID(),
      tools: new Map([["echo", echo]]),
      providers: new Map([
        [
          "anthropic",
          {
            profile: openaiChat,
            models: new Map(
              models.map((name) => [name, { wireModel: `wire-${name}`, profile: openaiChat }]),
            ),
            transport: {
              baseUrl: "https://scripted.invalid/v1",
              fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
                bodies.push(JSON.parse(String(init?.body)));
                const content = `answer ${bodies.length}`;
                return Response.json({
                  choices: [{ finish_reason: "stop", message: { content } }],
                });
              }) as typeof fetch,
            },
          },
        ],
      ]),
    },
  };
}

function observeLogs() {
  const records: { event: string; level: string; fields: Record<string, unknown> }[] = [];
  const logger = getLogger(["labkit", "session"]);
  const original = logger.emit.bind(logger);
  const spy = spyOn(logger, "emit").mockImplementation((record) => {
    records.push({
      event: String(record.rawMessage),
      level: record.level,
      fields: record.properties,
    });
    original(record);
  });
  return { records, close: () => spy.mockRestore() };
}

/** Records every attempted append ID; `reject` fails matching appends before storage. */
function recording(port: SessionPersistence, reject?: (appendId: string) => boolean) {
  const appends: string[] = [];
  const persistence: SessionPersistence = {
    lifetime: port.lifetime,
    putBlob: port.putBlob.bind(port),
    getBlob: port.getBlob.bind(port),
    load: port.load.bind(port),
    async append(request, signal) {
      appends.push(request.appendId);
      if (reject?.(request.appendId))
        return {
          kind: "rejected",
          message: "Disk quota exceeded",
          error: { message: "Disk quota exceeded", details: { code: "EDQUOT" } },
        };
      return port.append(request, signal);
    },
  };
  return { persistence, appends };
}

const echo = defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => text });

const widenedEcho = defineTool({
  input: z.object({ text: z.string(), line: z.number().int().optional() }),
  run: ({ text }) => text,
});

test("widened and added tools are journaled before the first new turn and replay cleanly", async () => {
  const port = createMemoryPersistence();
  const original = testOptions({
    persistence: port,
    complete: scriptedCompletion([
      { kind: "tools", text: "Echo", calls: [{ id: "c1", name: "echo", args: { text: "x" } }] },
      { kind: "answer", text: "Done" },
    ]),
  });
  const session = await createSession(original);
  await session.input("First").settled;
  await session.close();
  const sessionId = session.snapshot.durable.conversation.sessionId;
  const persistedRevision = session.snapshot.durable.revision;

  const capture = observeLogs();
  try {
    const requests: { tools?: unknown; messages: unknown }[] = [];
    const { persistence, appends } = recording(port);
    const live = testOptions({
      persistence,
      id: () => crypto.randomUUID(),
      tools: new Map([
        ["echo", widenedEcho],
        ["extra", echo],
      ]),
      complete: scriptedCompletion([{ kind: "answer", text: "Again" }], requests),
    });
    const restored = await restoreSession(live, sessionId);
    const differences = [
      "changed tools.echo.parameters: added properties line",
      "added tools.extra",
    ];
    expect(restored.registry).toEqual({ kind: "pending_adoption", differences });
    expect(restored.snapshot.durable.revision).toBe(persistedRevision);
    expect(appends).toEqual([]);

    const turn = restored.input("Second");
    expect((await turn.accepted).kind).toBe("accepted");
    expect(await turn.settled).toMatchObject({ record: { outcome: { kind: "completed" } } });
    const adoptionId = `configuration/${sessionId}/${persistedRevision}`;
    expect(appends[0]).toBe(adoptionId);
    const records = restored.snapshot.durable.records.slice(persistedRevision);
    expect(records[0]).toMatchObject({
      appendId: adoptionId,
      revision: persistedRevision + 1,
      body: { kind: "configuration" },
    });
    expect(records[0]!.body).not.toHaveProperty("policy");
    expect(records[0]!.body).not.toHaveProperty("agent");
    expect(records[1]?.body).toMatchObject({ kind: "event", event: { type: "user" } });
    expect(restored.registry).toEqual({ kind: "current" });
    expect(JSON.stringify(requests[0]!.tools)).toContain('"line"');

    const adopted = capture.records.find((record) => record.event === "session.registry.adopted");
    expect(adopted).toMatchObject({
      level: "info",
      fields: { sessionId, appendId: adoptionId, revision: persistedRevision + 1, differences },
    });
    expect(
      capture.records.find((record) => record.event === "session.registry.mismatch"),
    ).toMatchObject({
      level: "info",
      fields: { differences, adoption: "pending", revision: persistedRevision },
    });
    expect(
      capture.records.find((record) => record.event === "session.registry.reconciled")?.fields,
    ).toMatchObject({
      reconciliation: "tool_registry",
      removedTools: [],
      addedTools: ["extra"],
      changedTools: ["echo"],
    });
    expect(
      capture.records.find((record) => record.event === "session.restored")?.fields.registry,
    ).toBe("pending_adoption");
    expect(capture.records.filter((record) => ["warning", "error"].includes(record.level))).toEqual(
      [],
    );

    await restored.close();
    const again = await restoreSession(live, sessionId);
    expect(again.registry).toEqual({ kind: "current" });
    expect(again.snapshot.durable).toEqual(restored.snapshot.durable);
    expect(
      capture.records.filter((record) => record.event === "session.restored").at(-1)?.fields
        .registry,
    ).toBe("current");
    await again.close();
  } finally {
    capture.close();
  }
});

test("a removed tool and current agent are reconciled while history is projected verbatim", async () => {
  const port = createMemoryPersistence();
  const gone = defineTool({ input: z.object({ path: z.string() }), run: () => "GONE_RESULT" });
  const original = testOptions({
    persistence: port,
    agents: new Map([
      ["a", { model: "model-a", systemPrompt: "Agent A", tools: ["echo", "gone"] }],
      ["b", { model: "model-b", systemPrompt: "Agent B", tools: ["echo"] }],
    ]),
    tools: new Map([
      ["echo", echo],
      ["gone", gone],
    ]),
    complete: scriptedCompletion([
      { kind: "tools", text: "Reading", calls: [{ id: "g1", name: "gone", args: { path: "x" } }] },
      { kind: "answer", text: "Read it" },
    ]),
  });
  const session = await createSession(original);
  await session.input("Read x").settled;
  await session.close();
  const sessionId = session.snapshot.durable.conversation.sessionId;
  const history = session.snapshot.durable.conversation.log;
  const persistedRevision = session.snapshot.durable.revision;

  const capture = observeLogs();
  try {
    const requests: {
      model: string;
      tools?: { function: { name: string } }[];
      messages: unknown;
    }[] = [];
    const live = testOptions({
      persistence: port,
      id: () => crypto.randomUUID(),
      agent: "b",
      agents: new Map([["b", { model: "model-b", systemPrompt: "Agent B", tools: ["echo"] }]]),
      tools: new Map([["echo", echo]]),
      complete: scriptedCompletion([{ kind: "answer", text: "Continued" }], requests),
    });
    const restored = await restoreSession(live, sessionId);
    expect(restored.registry).toEqual({
      kind: "pending_adoption",
      differences: ["missing agents.a", "missing tools.gone"],
    });
    expect(restored.snapshot.durable.revision).toBe(persistedRevision);
    const switched = capture.records.find(
      (record) =>
        record.event === "session.registry.reconciled" &&
        record.fields.reconciliation === "agent_switched",
    );
    expect(switched).toMatchObject({
      level: "warning",
      fields: {
        sessionId,
        previousAgent: "a",
        nextAgent: "b",
        consequence: "conversation continues with agent b",
      },
    });

    const result = await restored.input("Continue").settled;
    expect(result).toMatchObject({ record: { agent: "b", outcome: { kind: "completed" } } });
    const adoption = restored.snapshot.durable.records[persistedRevision]!.body;
    expect(adoption).toMatchObject({
      kind: "configuration",
      agent: "b",
      policy: { version: 1, tools: { b: ["echo"] } },
    });
    expect(restored.registry).toEqual({ kind: "current" });

    // Stored history is a record of facts: the removed tool's call and result are sent verbatim.
    const request = requests[0]!;
    expect(request.model).toBe("model-b");
    expect(request.tools?.map((tool) => tool.function.name)).toEqual(["echo"]);
    const projected = JSON.stringify(request.messages);
    expect(projected).toContain('"name":"gone"');
    expect(projected).toContain('"id":"g1"');
    expect(projected).toContain("GONE_RESULT");
    expect(projected).toContain("Read x");
    expect([...restored.snapshot.durable.conversation.log.slice(0, history.length)]).toEqual([
      ...history,
    ]);

    await restored.close();
    const again = await restoreSession(live, sessionId);
    expect(again.registry).toEqual({ kind: "current" });
    expect(again.snapshot.durable).toEqual(restored.snapshot.durable);
    await again.close();
  } finally {
    capture.close();
  }
});

test("a rejected adoption append fails the dependent input with its storage cause", async () => {
  const port = createMemoryPersistence();
  const session = await createSession(testOptions({ persistence: port }));
  await session.close();
  const sessionId = session.snapshot.durable.conversation.sessionId;
  const capture = observeLogs();
  try {
    let completions = 0;
    const { persistence, appends } = recording(port, (appendId) =>
      appendId.startsWith("configuration/"),
    );
    const restored = await restoreSession(
      testOptions({
        persistence,
        tools: new Map([
          ["echo", defineTool({ input: z.object({ path: z.string() }), run: ({ path }) => path })],
        ]),
        complete: () => {
          completions++;
          return { kind: "answer", text: "never" };
        },
      }),
      sessionId,
    );
    const turn = restored.input("Hello");
    const receipt = await turn.accepted;
    const settled = await turn.settled;
    expect(receipt).toMatchObject({
      kind: "failed",
      error: {
        message: "Disk quota exceeded",
        classification: "persistence",
        operation: { id: `configuration/${sessionId}/1`, kind: "append" },
        details: { originalDetails: { code: "EDQUOT" } },
      },
    });
    expect(settled).toMatchObject({
      kind: "failed",
      error: receipt.kind === "failed" ? receipt.error : {},
    });
    expect(appends).toEqual([`configuration/${sessionId}/1`]);
    expect(completions).toBe(0);
    expect(restored.snapshot.durable.revision).toBe(session.snapshot.durable.revision);
    expect(restored.registry.kind).toBe("pending_adoption");
    const failed = capture.records.find(
      (record) => record.event === "session.registry.adoption_failed",
    );
    expect(failed).toMatchObject({
      level: "error",
      fields: {
        sessionId,
        appendId: `configuration/${sessionId}/1`,
        differences: [
          "changed tools.echo.parameters: added properties path; removed properties text; required added path; required removed text",
        ],
        outcome: "failed",
        reason: "Disk quota exceeded",
        error: { message: "Disk quota exceeded", operation: { kind: "append" } },
      },
    });
    await restored.close();
  } finally {
    capture.close();
  }
});

test("an adoption whose acknowledgement is lost reconciles before releasing the turn", async () => {
  const port = createMemoryPersistence();
  const session = await createSession(testOptions({ persistence: port }));
  await session.close();
  const sessionId = session.snapshot.durable.conversation.sessionId;
  const restored = await restoreSession(
    testOptions({
      persistence: lostAcknowledgement(port, (records) =>
        records.some((record) => record.includes('"kind":"configuration"')),
      ),
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }).describe("Echo text"),
            run: ({ text }) => text,
          }),
        ],
      ]),
    }),
    sessionId,
  );
  expect(restored.registry).toEqual({
    kind: "pending_adoption",
    differences: ["changed tools.echo.parameters (other schema keywords)"],
  });
  expect(await restored.input("Hello").settled).toMatchObject({
    record: { outcome: { kind: "completed" } },
  });
  expect(
    restored.snapshot.durable.records.filter((record) => record.body.kind === "configuration"),
  ).toHaveLength(1);
  expect(restored.registry).toEqual({ kind: "current" });
  await restored.close();
});

test("a saved model that is no longer bound replays and the next turn adopts the live model", async () => {
  const port = createMemoryPersistence();
  const bodies: { model: string; messages: unknown }[] = [];
  const saved = providerOptions(
    port,
    ["sonnet", "opus"],
    {
      provider: "anthropic",
      model: "sonnet",
      maxOutputTokens: 16384,
      toolFailure: "return-error-and-continue",
    },
    bodies,
  );
  const session = await createSession(saved);
  await session.input("First question").settled;
  await session.close();
  const sessionId = session.snapshot.durable.conversation.sessionId;
  const persistedRevision = session.snapshot.durable.revision;

  const capture = observeLogs();
  try {
    // The live binding offers only "opus"; the saved records name "sonnet".
    const live = providerOptions(
      port,
      ["opus"],
      { provider: "anthropic", model: "opus", maxOutputTokens: 16384 },
      bodies,
    );
    const restored = await restoreSession(live, sessionId);
    expect(restored.registry).toEqual({
      kind: "pending_adoption",
      differences: ["changed policy.model"],
    });
    expect(restored.snapshot.durable.revision).toBe(persistedRevision);
    expect(restored.snapshot.durable.policy).toMatchObject({ model: "sonnet", version: 0 });
    expect(restored.policy).toMatchObject({
      provider: "anthropic",
      model: "opus",
      version: 1,
      maxOutputTokens: 16384,
      toolFailure: "return-error-and-continue",
    });
    expect(restored.model).toMatchObject({ model: "opus", wireModel: "wire-opus" });
    const reconciled = capture.records.find(
      (record) =>
        record.event === "session.registry.reconciled" && record.fields.reconciliation === "policy",
    );
    expect(reconciled).toMatchObject({
      level: "warning",
      fields: {
        sessionId,
        revision: persistedRevision,
        policyVersion: 1,
        changedFields: ["model"],
        previous: { model: "sonnet" },
        next: { model: "opus" },
        reason: expect.stringContaining("Unknown model sonnet for anthropic"),
        consequence: "next turn uses anthropic/opus",
      },
    });

    expect(await restored.input("Second question").settled).toMatchObject({
      record: { outcome: { kind: "completed" } },
    });
    const adoption = restored.snapshot.durable.records[persistedRevision]!;
    expect(String(adoption.appendId)).toBe(`configuration/${sessionId}/${persistedRevision}`);
    expect(adoption.body).toMatchObject({ kind: "configuration", policy: restored.policy });
    expect(restored.registry).toEqual({ kind: "current" });
    const request = bodies.at(-1)!;
    expect(request.model).toBe("wire-opus");
    const projected = JSON.stringify(request.messages);
    expect(projected).toContain("First question");
    expect(projected).toContain("answer 1");
    expect(projected).toContain("Second question");
    expect(
      capture.records.find((record) => record.event === "session.registry.adopted")?.fields,
    ).toMatchObject({ policyVersion: 1, differences: ["changed policy.model"] });

    await restored.close();
    const again = await restoreSession(live, sessionId);
    expect(again.registry).toEqual({ kind: "current" });
    expect(again.snapshot.durable).toEqual(restored.snapshot.durable);
    await again.close();
    expect(
      capture.records
        .filter((record) => ["warning", "error"].includes(record.level))
        .map((record) => record.event),
    ).toEqual(["session.registry.reconciled"]);
  } finally {
    capture.close();
  }
});

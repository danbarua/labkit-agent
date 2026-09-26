import { expect, test } from "@logtape/testing-bun/autoload";

import { deferred, until } from "../core/agent/test-support.ts";
import type { AcpOptions } from "./adapter.ts";
import { answer } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("commands are discovered on new/load and expand once before journal admission while retaining attachments", async () => {
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const commands = [
    {
      name: "review",
      description: "Review contents",
      input: { hint: "focus" },
      prompt: "REVIEW_TEMPLATE_ORIGINAL",
    },
  ];
  let requestText = "";
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const base = setup();
  const options: AcpOptions = {
    ...base.options,
    promptCapabilities: { embeddedContext: true },
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        commands,
        configuration: {
          ...original.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
        },
        bindings: {
          ...original.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://provider.invalid",
                  fetch: (async (_url, init) => {
                    requestText = String(init?.body);
                    return Response.json({ choices: [{ message: { content: "Done" } }] });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  };
  let h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    expect(
      h.updates().find((message) => message.update.sessionUpdate === "available_commands_update")
        ?.update,
    ).toEqual({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Review contents", input: { hint: "focus" } },
      ],
    });
    commands[0]!.prompt = "REVIEW_TEMPLATE_REVISED";
    const response = await h.request("session/prompt", {
      sessionId: id,
      prompt: [
        { type: "text", text: "/review invariants" },
        {
          type: "resource",
          resource: {
            uri: "untitled:design.md",
            mimeType: "text/markdown",
            text: "draft contents",
          },
        },
      ],
    });
    expect(response.result.stopReason).toBe("end_turn");
    expect(requestText).toContain("REVIEW_TEMPLATE_ORIGINAL");
    expect(requestText).not.toContain("REVIEW_TEMPLATE_REVISED");
    expect(requestText).toContain("invariants");
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    if (journal.kind !== "loaded") throw new Error("Missing journal");
    const records = journal.batches.flatMap((batch) =>
      batch.records.map((record) => JSON.parse(record)),
    );
    const admitted = records.find(
      (record) => record.body.kind === "event" && record.body.event.type === "user",
    ).body.event;
    expect(admitted.text).toContain("REVIEW_TEMPLATE_ORIGINAL");
    expect(admitted.attachments).toHaveLength(1);
    expect(JSON.stringify(journal)).not.toContain("draft contents");
    await h.close();
    h = harness(options);
    await h.initialize();
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    expect(
      h.updates().some((message) => message.update.sessionUpdate === "available_commands_update"),
    ).toBe(true);
    const replay = JSON.stringify(
      h.updates().filter((message) => message.update.sessionUpdate === "user_message_chunk"),
    );
    expect(replay).toContain("REVIEW_TEMPLATE_ORIGINAL");
    expect(replay).not.toContain("REVIEW_TEMPLATE_REVISED");
  } finally {
    await h.close();
  }
});

test("live command catalogs update and clear without changing admitted prompts or leaking after close", async () => {
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-commands/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    const pending = deferred<unknown>();
    let admittedText = "";
    let publish: NonNullable<Parameters<AcpOptions["sessionOptions"]>[0]["publishCommands"]>;
    const base = setup({
      complete: (request) => {
        admittedText = request.messages.at(-1)!.content;
        return pending.promise;
      },
    });
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => {
        publish = context.publishCommands!;
        publish([{ name: "review", description: "Staged", prompt: "Initial instructions" }]);
        return base.options.sessionOptions(context);
      },
    });
    try {
      await h.initialize();
      const sessionId = await h.newSession();
      const catalogs = () =>
        h
          .updates()
          .filter((message) => message.update.sessionUpdate === "available_commands_update");
      expect(catalogs()).toHaveLength(1);
      const turn = await h.start("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/review this" }],
      });
      await until(() => admittedText !== "");
      publish!([{ name: "review", description: "Changed", prompt: "Replacement instructions" }]);
      await until(() => catalogs().length === 2);
      expect(admittedText).toContain("Initial instructions");
      expect(admittedText).not.toContain("Replacement instructions");
      expect(() =>
        publish!([{ name: "INVALID COMMAND", description: "bad", prompt: "bad" }]),
      ).toThrow();
      expect(catalogs()).toHaveLength(2);
      pending.resolve(answer);
      expect((await h.response(turn)).result.stopReason).toBe("end_turn");
      await h.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/review again" }],
      });
      expect(admittedText).toContain("Replacement instructions");
      publish!([]);
      await until(() => catalogs().length === 3);
      expect(catalogs().at(-1)!.update).toMatchObject({ availableCommands: [] });
      await h.request("session/close", { sessionId });
      expect(() => publish!([])).toThrow("closed ACP session");
      expect(catalogs()).toHaveLength(3);
    } finally {
      pending.resolve(answer);
      await h.close();
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const updated = records.filter((record) => record.event === "acp.commands.updated");
  expect(updated.map((record) => record.count)).toEqual([1, 0]);
  expect(updated[0]).toMatchObject({ level: "info", names: ["review"] });
  expect(updated[0].sessionId).toBeString();
  expect(records.filter((record) => record.event === "acp.commands.rejected")).toHaveLength(2);
});

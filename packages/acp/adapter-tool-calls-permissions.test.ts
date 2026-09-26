import { defineTool } from "@labkit-agent/core";
import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { deferred, until } from "../core/agent/test-support.ts";
import type { AcpOptions } from "./adapter.ts";
import { answer, prompt, tools } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("permission response correlation and both durable gates precede tool execution", async () => {
  const intent = deferred<void>();
  const approval = deferred<void>();
  let waitingIntent = false;
  let waitingApproval = false;
  let ran = 0;
  let completions = 0;
  const { options, persistence } = setup({
    complete: () => (++completions === 1 ? tools : answer),
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          kind: "read",
          locations: () => [{ path: "/tmp/DESIGN.md", line: 3 }],
          run: () => {
            ran++;
            return "contents";
          },
        }),
      ],
    ]),
  });
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => ({
      ...(await original(context)),
      persistence: {
        ...persistence,
        append: async (request, signal) => {
          if (
            request.records.some((raw) => JSON.parse(raw).body.event?.event?.permissionRequired)
          ) {
            waitingIntent = true;
            await intent.promise;
          }
          if (
            request.records.some(
              (raw) => JSON.parse(raw).body.event?.event?.type === "permission_settled",
            )
          ) {
            waitingApproval = true;
            await approval.promise;
          }
          return persistence.append(request, signal);
        },
      },
    }),
  });
  await h.initialize();
  const id = await h.newSession();
  const requestId = await h.start("session/prompt", prompt(id));
  await until(() => waitingIntent);
  expect(h.messages.some((m) => m.method === "session/request_permission")).toBe(false);
  intent.resolve();
  await until(() => h.messages.some((m) => m.method === "session/request_permission"));
  const permission = h.messages.find((m) => m.method === "session/request_permission")!;
  expect(permission.params.toolCall).toMatchObject({
    title: 'echo: "/tmp/DESIGN.md":3',
    locations: [{ path: "/tmp/DESIGN.md", line: 3 }],
    status: "pending",
  });
  expect(permission.params).not.toHaveProperty("turnId");
  expect(permission.params.options.map((o: any) => o.kind)).toEqual([
    "allow_once",
    "allow_always",
    "reject_once",
  ]);
  expect(ran).toBe(0);
  await h.send({
    jsonrpc: "2.0",
    id: "wrong-id",
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  await Bun.sleep(5);
  expect(ran).toBe(0);
  await h.send({
    jsonrpc: "2.0",
    id: permission.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  await until(() => waitingApproval);
  expect(ran).toBe(0);
  approval.resolve();
  expect((await h.response(requestId)).result).toEqual({ stopReason: "end_turn" });
  expect(ran).toBe(1);
  const updates = h.updates().map((m) => m.update);
  expect(
    updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u: any) => u.content.text),
  ).toEqual(["Reading", "Done"]);
  expect(
    updates
      .filter((u) => "toolCallId" in u && u.toolCallId === permission.params.toolCall.toolCallId)
      .map((u: any) => u.status)
      .filter(Boolean),
  ).toEqual(["pending", "pending", "in_progress", "completed"]);
  const cardUpdates = updates.filter(
    (u) =>
      u.sessionUpdate === "tool_call_update" &&
      u.toolCallId === permission.params.toolCall.toolCallId,
  );
  expect(cardUpdates[0]).toMatchObject({
    title: 'echo: "/tmp/DESIGN.md":3',
    status: "pending",
    locations: [{ path: "/tmp/DESIGN.md", line: 3 }],
  });
  expect(cardUpdates.at(-1)).toMatchObject({
    title: 'echo: "/tmp/DESIGN.md":3',
    status: "completed",
  });
  expect(h.messages.at(-1)?.id).toBe(requestId);
  await h.close();
});

for (const choice of ["reject-once", "bad-option", "cancelled"] as const)
  test(`${choice} permission never runs tools`, async () => {
    let ran = 0;
    const { options } = setup({
      complete: () => tools,
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }),
            run: () => {
              ran++;
              return "bad";
            },
          }),
        ],
      ]),
    });
    const h = harness(options);
    await h.initialize();
    const id = await h.newSession();
    const requestId = await h.start("session/prompt", prompt(id));
    await until(() => h.messages.some((m) => m.method === "session/request_permission"));
    const permission = h.messages.find((m) => m.method === "session/request_permission")!;
    await h.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: {
        outcome:
          choice === "cancelled"
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: choice },
      },
    });
    const response = await h.response(requestId);
    if (choice === "bad-option") expect(response.error?.code).toBe(-32000);
    else
      expect(response.result.stopReason).toBe(choice === "reject-once" ? "refusal" : "cancelled");
    expect(ran).toBe(0);
    await h.close();
  });

test("cancellation is processed while permission response is pending; late allow is ignored", async () => {
  let ran = 0;
  const { options } = setup({
    complete: () => tools,
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: () => {
            ran++;
            return "bad";
          },
        }),
      ],
    ]),
  });
  const h = harness(options);
  await h.initialize();
  const id = await h.newSession();
  const requestId = await h.start("session/prompt", prompt(id));
  await until(() => h.messages.some((m) => m.method === "session/request_permission"));
  const permission = h.messages.find((m) => m.method === "session/request_permission")!;
  expect((await h.request("session/prompt", prompt(id))).error?.message).toContain("active prompt");
  await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
  expect((await h.response(requestId)).result).toEqual({ stopReason: "cancelled" });
  const count = h.updates().length;
  await h.send({
    jsonrpc: "2.0",
    id: permission.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  await Bun.sleep(5);
  expect(ran).toBe(0);
  expect(h.updates()).toHaveLength(count);
  await h.close();
});

test("load keeps raw failed tool status under tolerant policy and never repeats permission", async () => {
  let completions = 0;
  const { options } = setup({
    complete: () => (++completions === 1 ? tools : answer),
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: () => {
            throw new Error("read failed");
          },
        }),
      ],
    ]),
  });
  const original = options.sessionOptions;
  const config: AcpOptions = {
    ...options,
    sessionOptions: async (context) => {
      const base = await original(context);
      return {
        ...base,
        configuration: {
          ...base.configuration,
          policy: { toolFailure: "return-error-and-continue" },
        },
      };
    },
  };
  const h = harness(config);
  await h.initialize();
  const id = await h.newSession();
  const requestId = await h.start("session/prompt", prompt(id));
  await until(() => h.messages.some((m) => m.method === "session/request_permission"));
  const permission = h.messages.find((m) => m.method === "session/request_permission")!;
  await h.send({
    jsonrpc: "2.0",
    id: permission.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  expect((await h.response(requestId)).result.stopReason).toBe("end_turn");
  await h.close();
  const loaded = harness(config);
  await loaded.initialize();
  await loaded.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] });
  expect(
    loaded
      .updates()
      .some((m) => m.update.sessionUpdate === "tool_call_update" && m.update.status === "failed"),
  ).toBe(true);
  expect(loaded.messages.some((m) => m.method === "session/request_permission")).toBe(false);
  expect(completions).toBe(2);
  await loaded.close();
});

test("interrupted permission recovers on load with no effects or repeated request", async () => {
  let completions = 0;
  let ran = 0;
  const { options } = setup({
    complete: () => {
      completions++;
      return tools;
    },
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: () => {
            ran++;
            return "bad";
          },
        }),
      ],
    ]),
  });
  const h = harness(options);
  await h.initialize();
  const id = await h.newSession();
  await h.start("session/prompt", prompt(id));
  await until(() => h.messages.some((m) => m.method === "session/request_permission"));
  await h.disconnect();
  const loaded = harness(options);
  await loaded.initialize();
  expect(
    (await loaded.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).result,
  ).toEqual({});
  expect(completions).toBe(1);
  expect(ran).toBe(0);
  expect(loaded.messages.some((m) => m.method === "session/request_permission")).toBe(false);
  expect(
    loaded
      .updates()
      .some((m) => m.update.sessionUpdate === "tool_call_update" && m.update.status === "failed"),
  ).toBe(true);
  await loaded.close();
});

test("named tool content renders rich blocks and diffs from saved results without repeating effects", async () => {
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-tool-content/${crypto.randomUUID()}`;
  const content = [
    {
      type: "content",
      content: {
        type: "text",
        text: "Observed result",
        annotations: { audience: ["user"], priority: 1 },
        _meta: { "example.org/id": "text-1" },
      },
    },
    { type: "content", content: { type: "image", data: "AA==", mimeType: "image/png" } },
    { type: "content", content: { type: "audio", data: "AA==", mimeType: "audio/wav" } },
    {
      type: "content",
      content: {
        type: "resource",
        resource: { uri: "file:///tmp/report.txt", text: "Saved report", mimeType: "text/plain" },
      },
    },
    {
      type: "content",
      content: { type: "resource_link", uri: "file:///tmp/report.txt", name: "report.txt" },
    },
    { type: "diff", path: "/tmp/report.txt", oldText: "before", newText: "after" },
  ];
  let runs = 0;
  let completions = 0;
  const base = setup({
    complete: () => (++completions === 1 ? tools : answer),
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: () => {
            runs++;
            return { content };
          },
        }),
      ],
    ]),
  });
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      toolContent: new Map([["echo", ({ output }) => JSON.parse(output).content]]),
    }),
  };
  await withFixtureDiagnostics(directory, {}, async () => {
    let h = harness(options);
    try {
      await h.initialize();
      const sessionId = await h.newSession();
      const turn = await h.start("session/prompt", prompt(sessionId));
      await until(() =>
        h.messages.some((message) => message.method === "session/request_permission"),
      );
      const permission = h.messages.find(
        (message) => message.method === "session/request_permission",
      )!;
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: "allow-once" } },
      });
      expect((await h.response(turn)).result.stopReason).toBe("end_turn");

      const rendered = () =>
        h
          .updates()
          .map(({ update }) => update)
          .find(
            (update) =>
              update.sessionUpdate === "tool_call_update" && update.status === "completed",
          );

      expect(rendered()).toMatchObject({ content, rawOutput: JSON.stringify({ content }) });
      await h.close();
      h = harness(options);
      await h.initialize();
      expect(
        (await h.request("session/load", { cwd: "/tmp", sessionId, mcpServers: [] })).error,
      ).toBeUndefined();
      expect(rendered()).toMatchObject({ content, _meta: { "labkit.dev/reconstructed": true } });
      expect(h.messages.some((message) => message.method === "session/request_permission")).toBe(
        false,
      );
      expect(runs).toBe(1);
      expect(completions).toBe(2);
    } finally {
      await h.close();
    }
  });
  const logs = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const rendered = logs.filter((entry) => entry.event === "acp.tool_content.rendered");
  expect(rendered.map((entry) => entry.reconstructed)).toEqual([false, true]);
  expect(
    rendered.every((entry) => entry.sessionId && entry.toolCallId && entry.toolName === "echo"),
  ).toBe(true);
  expect(rendered[0].contentTypes).toEqual([
    "text",
    "image",
    "audio",
    "resource",
    "resource_link",
    "diff",
  ]);
  expect(logs.filter((entry) => ["warning", "error"].includes(entry.level))).toEqual([]);
  expect(JSON.stringify(logs)).not.toContain("Saved report");
});

test("invalid tool display preserves successful execution and explains the display failure", async () => {
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-tool-content-invalid/${crypto.randomUUID()}`;
  let completions = 0;
  const base = setup({ complete: () => (++completions === 1 ? tools : answer) });
  await withFixtureDiagnostics(directory, {}, async () => {
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => ({
        ...(await base.options.sessionOptions(context)),
        toolContent: new Map([
          ["echo", () => [{ type: "diff", path: "relative.txt", newText: "after" }]],
        ]),
      }),
    });
    try {
      await h.initialize();
      const sessionId = await h.newSession();
      const turn = await h.start("session/prompt", prompt(sessionId));
      await until(() =>
        h.messages.some((message) => message.method === "session/request_permission"),
      );
      const permission = h.messages.find(
        (message) => message.method === "session/request_permission",
      )!;
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: "allow-once" } },
      });
      expect((await h.response(turn)).result.stopReason).toBe("end_turn");
      const update = h
        .updates()
        .map(({ update }) => update)
        .find(
          (update) => update.sessionUpdate === "tool_call_update" && update.status === "completed",
        );
      expect(update).toMatchObject({ rawOutput: "contents" });
      expect(JSON.stringify(update)).toContain("Diff path must be absolute");
      expect(completions).toBe(2);
    } finally {
      await h.close();
    }
  });
  const logs = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const warnings = logs.filter((entry) => ["warning", "error"].includes(entry.level));
  expect(warnings).toHaveLength(1);
  expect(warnings[0].event).toBe("acp.tool_content.failed");
  expect(warnings[0].reason).toContain("execution result is unchanged");
  expect(warnings[0].error.message).toContain("Diff path must be absolute");
  expect(warnings[0].sessionId).toBeTruthy();
  expect(warnings[0].toolCallId).toBeTruthy();
  expect(warnings[0].toolName).toBe("echo");
});

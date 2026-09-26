import { expect, test } from "@logtape/testing-bun/autoload";

import { until } from "../core/agent/test-support.ts";
import { answer, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";
import type { Message as HarnessMessage } from "./testing/harness.ts";

type Message = HarnessMessage;
for (const scenario of [
  "success",
  "reject",
  "cancel",
  "late_create",
  "failed_exit",
  "oversize",
  "release_error",
  "unsupported",
] as const) {
  test(`client terminal ${scenario} preserves permission, cancellation, and release`, async () => {
    const { terminalTool } = await import("./client-terminal.ts");
    let completions = 0;
    const base = setup({
      complete: (request) => {
        if (scenario === "unsupported") return answer;
        if (++completions === 1)
          return {
            kind: "tools",
            text: "Run checks",
            calls: [{ id: "cmd", name: "run_command", args: { command: "bun", args: ["test"] } }],
          };
        expect(JSON.stringify(request.messages)).toContain("test output");
        if (scenario === "failed_exit")
          expect(JSON.stringify(request.messages)).toMatch(/exitCode\\?":2/);
        return answer;
      },
    });
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        expect(Boolean(context.terminal)).toBe(scenario !== "unsupported");
        const tools = context.terminal
          ? new Map([["run_command", terminalTool(context.terminal, context.cwd)]])
          : new Map();
        return {
          ...original,
          configuration: {
            ...original.configuration,
            agents: new Map([["a", { model: "m", tools: [...tools.keys()] }]]),
          },
          bindings: { ...original.bindings, tools },
        };
      },
    });
    const next = async (method: string) => {
      await until(() => h.messages.some((message) => message.method === method));
      return h.messages.find((message) => message.method === method)!;
    };
    const reply = (request: Message, result: unknown) =>
      h.send({ jsonrpc: "2.0", id: request.id, result });
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { terminal: scenario !== "unsupported" },
      });
      const id = await h.newSession();
      const turn = await h.start("session/prompt", prompt(id));
      if (scenario === "unsupported") {
        expect((await h.response(turn)).result.stopReason).toBe("end_turn");
        expect(h.messages.some((message) => message.method?.startsWith("terminal/"))).toBe(false);
        return;
      }
      const permission = await next("session/request_permission");
      expect(permission.params.toolCall.kind).toBe("execute");
      expect(h.messages.some((message) => message.method === "terminal/create")).toBe(false);
      const option = permission.params.options.find(
        (value: any) => value.kind === (scenario === "reject" ? "reject_once" : "allow_once"),
      );
      await reply(permission, { outcome: { outcome: "selected", optionId: option.optionId } });
      if (scenario === "reject") {
        expect((await h.response(turn)).result.stopReason).toBe("refusal");
        expect(h.messages.some((message) => message.method?.startsWith("terminal/"))).toBe(false);
        return;
      }
      const create = await next("terminal/create");
      expect(create.params).toEqual({
        sessionId: id,
        command: "bun",
        args: ["test"],
        cwd: "/tmp",
        outputByteLimit: 256 * 1024,
      });
      if (scenario === "late_create") {
        await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
        expect((await h.response(turn)).result.stopReason).toBe("cancelled");
      }
      await reply(create, { terminalId: "terminal-one" });
      if (scenario === "cancel" || scenario === "late_create") {
        if (scenario === "cancel") {
          await next("terminal/wait_for_exit");
          await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
        }
        await reply(await next("terminal/kill"), {});
      } else {
        await reply(await next("terminal/wait_for_exit"), {
          exitCode: scenario === "failed_exit" ? 2 : 0,
        });
        await reply(await next("terminal/output"), {
          output: scenario === "oversize" ? "x".repeat(256 * 1024 + 1) : "test output",
          truncated: false,
        });
      }
      const release = await next("terminal/release");
      expect(release.params).toEqual({ sessionId: id, terminalId: "terminal-one" });
      if (scenario === "release_error")
        await h.send({
          jsonrpc: "2.0",
          id: release.id,
          error: { code: -32000, message: "Release failed" },
        });
      else await reply(release, {});
      const response = await h.response(turn);
      if (scenario === "oversize" || scenario === "release_error")
        expect(response.error?.code).toBe(-32000);
      else {
        expect(response.error).toBeUndefined();
        expect(response.result.stopReason).toBe(
          scenario === "cancel" || scenario === "late_create" ? "cancelled" : "end_turn",
        );
      }
      expect(h.messages.filter((message) => message.method === "terminal/release")).toHaveLength(1);
      if (scenario === "cancel" || scenario === "late_create") expect(completions).toBe(1);
      if (scenario === "late_create")
        expect(
          h
            .updates()
            .some(
              (message) =>
                message.update.sessionUpdate === "tool_call_update" &&
                message.update.content?.some((content) => content.type === "terminal"),
            ),
        ).toBe(false);
    } finally {
      await h.close();
    }
  });
}

test("parallel terminal IDs stay attached to their own tool cards through final output", async () => {
  const { terminalTool } = await import("./client-terminal.ts");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  let completions = 0;
  const base = setup({
    complete: () =>
      ++completions === 1
        ? {
            kind: "tools",
            text: "Two commands",
            calls: [
              { id: "first", name: "run_command", args: { command: "bun", args: ["first"] } },
              { id: "second", name: "run_command", args: { command: "bun", args: ["second"] } },
            ],
          }
        : answer,
  });
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        configuration: {
          ...original.configuration,
          agents: new Map([["a", { model: "m", tools: ["run_command"] }]]),
        },
        bindings: {
          ...original.bindings,
          tools: new Map([["run_command", terminalTool(context.terminal!, context.cwd)]]),
        },
      };
    },
  });
  const requests = (method: string) => h.messages.filter((message) => message.method === method);
  const reply = (request: Message, result: unknown) =>
    h.send({ jsonrpc: "2.0", id: request.id, result });
  try {
    await h.request("initialize", { protocolVersion: 1, clientCapabilities: { terminal: true } });
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    for (let i = 0; i < 2; i++) {
      await until(() => requests("session/request_permission").length > i);
      const permission = requests("session/request_permission")[i]!;
      const allow = permission.params.options.find((value: any) => value.kind === "allow_once");
      await reply(permission, { outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    await until(() => requests("terminal/create").length === 2);
    for (const create of requests("terminal/create").toReversed())
      await reply(create, { terminalId: `ephemeral-terminal-${create.params.args[0]}` });
    await until(() => requests("terminal/wait_for_exit").length === 2);
    for (const label of ["first", "second"]) {
      const toolCall = h
        .updates()
        .find(
          (message) =>
            message.update.sessionUpdate === "tool_call" &&
            (message.update.rawInput as any).args[0] === label,
        )!.update;
      if (toolCall.sessionUpdate !== "tool_call") throw new Error("Missing tool call");
      expect(
        h
          .updates()
          .some(
            (message) =>
              message.update.sessionUpdate === "tool_call_update" &&
              message.update.toolCallId === toolCall.toolCallId &&
              message.update.content?.some(
                (content) =>
                  content.type === "terminal" &&
                  content.terminalId === `ephemeral-terminal-${label}`,
              ),
          ),
      ).toBe(true);
    }
    for (const wait of requests("terminal/wait_for_exit")) await reply(wait, { exitCode: 0 });
    await until(() => requests("terminal/output").length === 2);
    for (const output of requests("terminal/output"))
      await reply(output, { output: "completed", truncated: false });
    await until(() => requests("terminal/release").length === 2);
    for (const release of requests("terminal/release")) await reply(release, {});
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    for (const label of ["first", "second"]) {
      const toolCall = h
        .updates()
        .find(
          (message) =>
            message.update.sessionUpdate === "tool_call" &&
            (message.update.rawInput as any).args[0] === label,
        )!.update;
      if (toolCall.sessionUpdate !== "tool_call") throw new Error("Missing tool call");
      const settled = h
        .updates()
        .find(
          (message) =>
            message.update.sessionUpdate === "tool_call_update" &&
            message.update.toolCallId === toolCall.toolCallId &&
            message.update.status === "completed",
        )!.update;
      expect(settled).toMatchObject({
        content: [
          { type: "terminal", terminalId: `ephemeral-terminal-${label}` },
          { type: "content", content: { type: "text" } },
        ],
      });
    }
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(journal)).not.toContain("ephemeral-terminal-");
  } finally {
    await h.close();
  }
});

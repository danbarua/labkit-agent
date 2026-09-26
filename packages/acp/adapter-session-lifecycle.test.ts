import { defineTool } from "@labkit-agent/core";
import type { CompletionPortRequest, SessionOptions } from "@labkit-agent/core";
import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { deferred, until } from "../core/agent/test-support.ts";
import { withFixtureDiagnostics } from "../core/logging/fixture-capture.ts";
import type { AcpOptions } from "./adapter.ts";
import { workspaceAgent } from "./examples/vscode-workspace.ts";
import { answer, configurable, offline, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("load replays committed history before response, never starts providers or permissions", async () => {
  let completions = 0;
  const { options } = setup({
    complete: () => {
      completions++;
      return answer;
    },
  });
  const first = harness(options);
  await first.initialize();
  const id = await first.newSession();
  await first.request("session/prompt", prompt(id));
  await first.close();
  const second = harness(options);
  await second.initialize();
  expect(
    (await second.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).result,
  ).toEqual({});
  expect(second.updates().map((m) => m.update.sessionUpdate)).toEqual([
    "user_message_chunk",
    "agent_message_chunk",
  ]);
  expect(completions).toBe(1);
  expect(second.messages.at(-1)?.result).toEqual({});
  expect(
    (await second.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error
      ?.message,
  ).toContain("already loaded");
  await second.request("session/close", { sessionId: id });
  expect((await second.request("session/prompt", prompt(id))).error).toBeDefined();
  await second.close();
});

test("resume advertises durable support and restores without replay; list is gated and read-only", async () => {
  let completions = 0;
  const base = setup({
    complete: () => {
      completions++;
      return answer;
    },
  });
  const listRequests: unknown[] = [];
  const options: AcpOptions = {
    ...base.options,
    listSessions: (params, signal) => {
      signal.throwIfAborted();
      listRequests.push(params);
      return { sessions: [] };
    },
  };
  let h = harness(options);
  try {
    expect((await h.request("session/list", {})).error?.code).toBe(-32002);
    expect((await h.initialize()).result.agentCapabilities.sessionCapabilities).toMatchObject({
      list: {},
      resume: {},
    });
    expect((await h.request("session/list", { cwd: "relative" })).error?.code).toBe(-32602);
    expect((await h.request("session/list", {})).result).toEqual({ sessions: [] });
    expect(listRequests).toHaveLength(1);
    const id = await h.newSession();
    await h.request("session/prompt", prompt(id));
    await h.close();
    h = harness(options);
    await h.initialize();
    expect((await h.request("session/resume", { sessionId: id, cwd: "/tmp" })).result).toEqual({});
    expect(h.updates()).toHaveLength(0);
    expect(completions).toBe(1);
    expect((await h.request("session/resume", { sessionId: id, cwd: "/tmp" })).error?.code).toBe(
      -32602,
    );
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    expect(completions).toBe(2);
  } finally {
    await h.close();
  }
  const unsupported = harness({ ...base.options, loadSession: false });
  try {
    const capabilities = (await unsupported.initialize()).result.agentCapabilities
      .sessionCapabilities;
    expect(capabilities.list).toBeUndefined();
    expect(capabilities.resume).toBeUndefined();
    expect((await unsupported.request("session/list", {})).error?.code).toBe(-32601);
    expect(
      (await unsupported.request("session/resume", { sessionId: "none", cwd: "/tmp" })).error?.code,
    ).toBe(-32601);
  } finally {
    await unsupported.close();
  }
});

test("ACP fork copies attachment history into an independent restorable child without provider replay", async () => {
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const base = setup();
  const bodies: string[] = [];
  const options: AcpOptions = {
    ...base.options,
    promptCapabilities: { embeddedContext: true },
    forkSession: true,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
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
                    bodies.push(String(init?.body));
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
    expect((await h.initialize()).result.agentCapabilities.sessionCapabilities.fork).toEqual({});
    const parent = await h.newSession();
    expect(
      (
        await h.request("session/prompt", {
          sessionId: parent,
          prompt: [
            { type: "text", text: "parent question" },
            {
              type: "resource",
              resource: { uri: "urn:design", text: "inherited design contents" },
            },
          ],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    const fork = await h.request("session/fork", { sessionId: parent, cwd: "/tmp" });
    expect(fork.error).toBeUndefined();
    const child = fork.result.sessionId;
    expect(child).not.toBe(parent);
    expect(bodies).toHaveLength(1);
    expect(
      (
        await h.request("session/prompt", {
          sessionId: child,
          prompt: [{ type: "text", text: "child-only question" }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(bodies[1]).toContain("parent question");
    expect(bodies[1]).toContain("inherited design contents");
    expect(
      (
        await h.request("session/prompt", {
          sessionId: parent,
          prompt: [{ type: "text", text: "parent followup" }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(bodies[2]).not.toContain("child-only question");
    const loaded = await base.persistence.load(
      SessionIdSchema.parse(child),
      new AbortController().signal,
    );
    if (loaded.kind !== "loaded") throw new Error("Missing child");
    const seed = JSON.parse(loaded.batches[0]!.records[0]!).body.seed;
    expect(JSON.stringify(seed)).toContain(parent);
    expect(JSON.stringify(loaded)).not.toContain("inherited design contents");
    await h.close();
    h = harness(options);
    await h.initialize();
    expect(
      (await h.request("session/load", { sessionId: child, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    expect(bodies).toHaveLength(3);
    expect((await h.request("session/prompt", prompt(child))).result.stopReason).toBe("end_turn");
    expect(bodies[3]).toContain("inherited design contents");
    expect(bodies[3]).toContain("child-only question");
  } finally {
    await h.close();
  }
});

test("ACP fork waits for child creation receipt and inherits committed configuration", async () => {
  const base = configurable();
  const gate = deferred<void>();
  let parent = "";
  let childAppend = false;
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        append: async (request, signal) => {
          if (parent && request.sessionId !== parent && request.expectedRevision === 0) {
            childAppend = true;
            await gate.promise;
          }
          return base.persistence.append(request, signal);
        },
      },
    }),
  });
  try {
    await h.initialize();
    parent = await h.newSession();
    expect(
      (
        await h.request("session/set_config_option", {
          sessionId: parent,
          configId: "model",
          value: "m2",
        })
      ).error,
    ).toBeUndefined();
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    await until(() => childAppend);
    expect(h.messages.some((message) => message.id === fork && !message.method)).toBe(false);
    gate.resolve();
    const response = await h.response(fork);
    expect(response.error).toBeUndefined();
    expect(
      response.result.configOptions.find((option: any) => option.id === "model").currentValue,
    ).toBe("m2");
    expect(
      (await h.request("session/prompt", prompt(response.result.sessionId))).result.stopReason,
    ).toBe("end_turn");
    expect(base.requests.at(-1)?.model).toBe("m2");
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("ACP fork waits for a running turn and rejects workspace or MCP changes before forking", async () => {
  const gate = deferred<unknown>();
  let started = false;
  const base = setup({
    complete: () => {
      started = true;
      return gate.promise;
    },
  });
  const h = harness({ ...base.options, forkSession: true });
  try {
    await h.initialize();
    const parent = await h.newSession();
    for (const params of [
      { cwd: "/other" },
      { cwd: "/tmp", additionalDirectories: ["/other"] },
      { cwd: "/tmp", mcpServers: [{ name: "x", command: "missing", args: [], env: [] }] },
    ])
      expect((await h.request("session/fork", { sessionId: parent, ...params })).error?.code).toBe(
        -32602,
      );
    const turn = await h.start("session/prompt", prompt(parent));
    await until(() => started);
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    expect(h.messages.some((message) => message.id === fork && !message.method)).toBe(false);
    gate.resolve(answer);
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    expect((await h.response(fork)).error).toBeUndefined();
  } finally {
    gate.resolve(answer);
    await h.close();
  }
});

test("cancelling a queued fork creates no child after the active turn settles", async () => {
  const gate = deferred<unknown>();
  let started = false;
  let parent = "";
  let childCreates = 0;
  const base = setup({
    complete: () => {
      started = true;
      return gate.promise;
    },
  });
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        append: async (request, signal) => {
          if (parent && request.sessionId !== parent) childCreates++;
          return base.persistence.append(request, signal);
        },
      },
    }),
  });
  try {
    await h.initialize();
    parent = await h.newSession();
    const turn = await h.start("session/prompt", prompt(parent));
    await until(() => started);
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: fork } });
    expect((await h.response(fork)).error).toBeDefined();
    gate.resolve(answer);
    await h.response(turn);
    expect((await h.request("session/prompt", prompt(parent))).result.stopReason).toBe("end_turn");
    expect(childCreates).toBe(0);
  } finally {
    gate.resolve(answer);
    await h.close();
  }
});

test("rejected child creation returns no fork and leaves the parent usable", async () => {
  const base = setup();
  let parent = "";
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        append: async (request, signal) =>
          parent && request.sessionId !== parent
            ? { kind: "rejected", message: "Child storage unavailable" }
            : base.persistence.append(request, signal),
      },
    }),
  });
  try {
    await h.initialize();
    parent = await h.newSession();
    const fork = await h.request("session/fork", { sessionId: parent, cwd: "/tmp" });
    expect(fork.error).toBeDefined();
    expect(fork.result).toBeUndefined();
    expect((await h.request("session/prompt", prompt(parent))).result.stopReason).toBe("end_turn");
  } finally {
    await h.close();
  }
});

test("saved sessions fork without loading or replaying the parent into the client", async () => {
  const base = setup();
  let runs = 0;
  const options: AcpOptions = {
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        commands: [{ name: "review", description: "Review", prompt: "Review" }],
        bindings: {
          ...original.bindings,
          complete: () => {
            runs++;
            return answer;
          },
        },
      };
    },
  };
  let h = harness(options);
  try {
    await h.initialize();
    const parent = await h.newSession();
    expect((await h.request("session/prompt", prompt(parent))).result.stopReason).toBe("end_turn");
    await h.close();
    h = harness(options);
    await h.initialize();
    const fork = await h.request("session/fork", { sessionId: parent, cwd: "/tmp" });
    expect(fork.error).toBeUndefined();
    expect(fork.result.sessionId).not.toBe(parent);
    expect(runs).toBe(1);
    expect(h.updates().some((message) => message.sessionId === parent)).toBe(false);
    expect(
      h.updates().every((message) => message.update.sessionUpdate === "available_commands_update"),
    ).toBe(true);
    expect((await h.request("session/prompt", prompt(parent))).error?.code).toBe(-32602);
    expect(
      (await h.request("session/prompt", prompt(fork.result.sessionId))).result.stopReason,
    ).toBe("end_turn");
    expect(
      (await h.request("session/load", { sessionId: parent, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    expect(runs).toBe(2);
  } finally {
    await h.close();
  }
});

test("a privately restored fork parent is unavailable to concurrent requests and is released after publication", async () => {
  const base = setup();
  let parent = "";
  let entered = false;
  const gate = deferred<void>();
  const options: AcpOptions = {
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        append: async (request, signal) => {
          if (parent && request.sessionId !== parent && request.expectedRevision === 0) {
            entered = true;
            await gate.promise;
          }
          return base.persistence.append(request, signal);
        },
      },
    }),
  };
  let h = harness(options);
  try {
    await h.initialize();
    parent = await h.newSession();
    await h.close();
    h = harness(options);
    await h.initialize();
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    await until(() => entered);
    expect((await h.request("session/prompt", prompt(parent))).error?.code).toBe(-32602);
    expect((await h.request("session/fork", { sessionId: parent, cwd: "/tmp" })).error?.code).toBe(
      -32602,
    );
    expect(
      (await h.request("session/load", { sessionId: parent, cwd: "/tmp", mcpServers: [] })).error
        ?.code,
    ).toBe(-32602);
    gate.resolve();
    expect((await h.response(fork)).error).toBeUndefined();
    expect(
      (await h.request("session/load", { sessionId: parent, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("cancelling private parent setup returns promptly and cannot later expose that runtime", async () => {
  const base = setup();
  const seed = harness(base.options);
  await seed.initialize();
  const parent = await seed.newSession();
  await seed.close();
  const gate = deferred<void>();
  let entered = false;
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => {
      entered = true;
      await gate.promise;
      return base.options.sessionOptions(context);
    },
  });
  try {
    await h.initialize();
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    await until(() => entered);
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: fork } });
    expect((await h.response(fork)).error).toBeDefined();
    gate.resolve();
    expect((await h.request("session/prompt", prompt(parent))).error?.code).toBe(-32602);
    expect(h.updates()).toHaveLength(0);
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("ACP deletion closes active work, holds its response until persistence completes, and blocks concurrent reopen", async () => {
  const completion = deferred<unknown>();
  const deletion = deferred<void>();
  let entered = false;
  let completionSignal: AbortSignal | undefined;
  let deleted: { sessionId: string; cwd?: string } | undefined;
  const base = setup({
    complete: (_request, signal) => {
      completionSignal = signal;
      return completion.promise;
    },
  });
  const h = harness({
    ...base.options,
    deleteSession: async (params) => {
      deleted = params;
      entered = true;
      await deletion.promise;
    },
  });
  try {
    expect((await h.initialize()).result.agentCapabilities.sessionCapabilities.delete).toEqual({});
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    await until(() => !!completionSignal);
    const remove = await h.start("session/delete", { sessionId: id });
    await until(() => entered);
    expect(completionSignal!.aborted).toBe(true);
    expect(deleted).toEqual({ sessionId: id, cwd: "/tmp" });
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    expect(h.messages.some((message) => message.id === remove && !message.method)).toBe(false);
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error?.code,
    ).toBe(-32602);
    expect((await h.request("session/delete", { sessionId: id })).error?.code).toBe(-32602);
    deletion.resolve();
    expect((await h.response(remove)).result).toEqual({});
    expect((await h.request("session/prompt", prompt(id))).error?.code).toBe(-32602);
  } finally {
    completion.resolve(answer);
    deletion.resolve();
    await h.close();
  }
});

test("ACP workspace deletion removes saved sessions and rejects load and fork", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workspaceDirectory } = await import("./workspace-directory.ts");
  const { workspacePersistence } = await import("./workspace-persistence.ts");
  const cwd = mkdtempSync(join(tmpdir(), "labkit-acp-delete-"));
  const directory = workspaceDirectory(cwd);
  const store = workspacePersistence(cwd);
  const base = setup();
  const options: AcpOptions = {
    ...base.options,
    forkSession: true,
    listSessions: (params, signal) => directory.list(params, signal),
    deleteSession: (params, signal) => directory.deleteSession(params, signal),
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: store,
    }),
  };
  let h = harness(options);
  try {
    await h.initialize();
    const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    await h.close();
    h = harness(options);
    await h.initialize();
    expect((await h.request("session/list", {})).result.sessions).toHaveLength(1);
    expect((await h.request("session/delete", { sessionId: id })).result).toEqual({});
    expect((await h.request("session/list", {})).result.sessions).toHaveLength(0);
    expect(
      (await h.request("session/load", { sessionId: id, cwd, mcpServers: [] })).error,
    ).toBeDefined();
    expect((await h.request("session/fork", { sessionId: id, cwd })).error).toBeDefined();
    expect((await h.request("session/delete", { sessionId: id })).result).toEqual({});
  } finally {
    await h.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancelled deletion keeps its lifecycle lock until the persistence hook settles", async () => {
  const base = setup();
  const gate = deferred<void>();
  let entered = false;
  const h = harness({
    ...base.options,
    deleteSession: async () => {
      entered = true;
      await gate.promise;
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const remove = await h.start("session/delete", { sessionId: id });
    await until(() => entered);
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: remove } });
    expect((await h.response(remove)).error).toBeDefined();
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error?.code,
    ).toBe(-32602);
    gate.reject(new Error("Deletion did not commit"));
    // A later unrelated round-trip allows the already-settled hook cleanup to run.
    await h.request("unknown", {});
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("workspace session info notifications match persisted titles and timestamps", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workspacePersistence } = await import("./workspace-persistence.ts");
  const { workspaceDirectory } = await import("./workspace-directory.ts");
  const cwd = mkdtempSync(join(tmpdir(), "labkit-info-"));
  const store = workspacePersistence(cwd);
  const directory = workspaceDirectory(cwd);
  const base = setup();
  const h = harness({
    ...base.options,
    sessionInfo: (params, signal) => directory.info(params, signal),
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: store,
    }),
  });
  try {
    await h.initialize();
    const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    await until(() =>
      h.updates().some((message) => message.update.sessionUpdate === "session_info_update"),
    );
    expect(
      h.updates().find((message) => message.update.sessionUpdate === "session_info_update")!.update,
    ).toMatchObject({ title: null });
    expect(
      (
        await h.request("session/prompt", {
          sessionId: id,
          prompt: [{ type: "text", text: "  Review\nworkspace metadata  " }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    await until(() =>
      h
        .updates()
        .some(
          (message) =>
            message.update.sessionUpdate === "session_info_update" &&
            message.update.title === "Review workspace metadata",
        ),
    );
    const last = h
      .updates()
      .filter((message) => message.update.sessionUpdate === "session_info_update")
      .at(-1)!.update;
    const metadata = directory.list({}, new AbortController().signal).sessions[0]!;
    expect(last).toEqual({
      sessionUpdate: "session_info_update",
      title: metadata.title!,
      updatedAt: metadata.updatedAt!,
    });
  } finally {
    await h.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stale and closed-session metadata replies cannot overwrite current session info", async () => {
  const first = deferred<{ title: string }>();
  const last = deferred<{ title: string }>();
  let reads = 0;
  const base = setup();
  const h = harness({
    ...base.options,
    sessionInfo: () =>
      ++reads === 1 ? first.promise : reads === 2 ? { title: "current" } : last.promise,
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    await until(() =>
      h
        .updates()
        .some(
          (message) =>
            message.update.sessionUpdate === "session_info_update" &&
            message.update.title === "current",
        ),
    );
    first.resolve({ title: "stale" });
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    await h.request("session/close", { sessionId: id });
    last.resolve({ title: "closed" });
    await h.request("unknown", {});
    expect(
      h
        .updates()
        .filter((message) => message.update.sessionUpdate === "session_info_update")
        .map((message) => message.update),
    ).toEqual([{ sessionUpdate: "session_info_update", title: "current" }]);
  } finally {
    first.resolve({ title: "stale" });
    last.resolve({ title: "closed" });
    await h.close();
  }
});

test("throwing, rejected, pending, and malformed metadata callbacks do not fail or hold prompts", async () => {
  for (const sessionInfo of [
    () => {
      throw new Error("Metadata failed");
    },
    () => Promise.reject(new Error("Metadata failed")),
    () => new Promise<undefined>(() => {}),
    () => ({ updatedAt: "not a timestamp" }),
  ]) {
    const h = harness({ ...setup().options, sessionInfo });
    try {
      await h.initialize();
      const id = await h.newSession();
      expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
      expect(
        h.updates().some((message) => message.update.sessionUpdate === "session_info_update"),
      ).toBe(false);
    } finally {
      await h.close();
    }
  }
});

test("workspace roots survive listing restart, replace on load/resume, and fork independently", async () => {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "labkit-acp-roots-")));
  const cwd = join(root, "primary");
  const a = join(root, "a");
  const b = join(root, "b");
  for (const path of [cwd, a, b]) mkdirSync(path);
  const make = () =>
    workspaceAgent({ ANTHROPIC_API_KEY: "fixture" }, undefined, { fetch: offline });
  let h = harness(make());
  try {
    expect(
      (await h.initialize()).result.agentCapabilities.sessionCapabilities.additionalDirectories,
    ).toEqual({});
    expect(
      (await h.request("session/new", { cwd, mcpServers: [], additionalDirectories: ["relative"] }))
        .error?.code,
    ).toBe(-32602);
    const opened = await h.request("session/new", {
      cwd,
      mcpServers: [],
      additionalDirectories: [a],
    });
    expect(opened.error).toBeUndefined();
    const id = opened.result.sessionId;
    const rows = async () =>
      (await h.request("session/list", { cwd })).result.sessions as {
        sessionId: string;
        additionalDirectories?: string[];
      }[];
    expect((await rows())[0]?.additionalDirectories).toEqual([a]);
    await h.close();
    h = harness(make());
    await h.initialize();
    expect((await rows())[0]?.additionalDirectories).toEqual([a]);
    expect(
      (
        await h.request("session/load", {
          sessionId: id,
          cwd,
          mcpServers: [],
          additionalDirectories: [b],
        })
      ).error,
    ).toBeUndefined();
    expect((await rows())[0]?.additionalDirectories).toEqual([b]);
    const fork = await h.request("session/fork", {
      sessionId: id,
      cwd,
      additionalDirectories: [a],
    });
    expect(fork.error).toBeUndefined();
    expect((await rows()).find((row) => row.sessionId === id)?.additionalDirectories).toEqual([b]);
    expect(
      (await rows()).find((row) => row.sessionId === fork.result.sessionId)?.additionalDirectories,
    ).toEqual([a]);
    await h.request("session/close", { sessionId: id });
    expect(
      (await h.request("session/resume", { sessionId: id, cwd, mcpServers: [] })).error,
    ).toBeUndefined();
    expect(
      (await rows()).find((row) => row.sessionId === id)?.additionalDirectories,
    ).toBeUndefined();
    await h.request("session/close", { sessionId: id });
    const savedFork = await h.request("session/fork", {
      sessionId: id,
      cwd,
      mcpServers: [],
      additionalDirectories: [b],
    });
    expect(savedFork.error).toBeUndefined();
    expect(
      (await rows()).find((row) => row.sessionId === id)?.additionalDirectories,
    ).toBeUndefined();
    expect(
      (await rows()).find((row) => row.sessionId === savedFork.result.sessionId)
        ?.additionalDirectories,
    ).toEqual([b]);
    expect(existsSync(join(cwd, ".labkit/sessions/store.sqlite"))).toBe(true);
    expect(existsSync(join(a, ".labkit"))).toBe(false);
    expect(existsSync(join(b, ".labkit"))).toBe(false);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle publication waits for metadata and failed or cancelled hooks cannot publish", async () => {
  const base = setup();
  const gate = deferred<void>();
  let entered = false;
  let id: string | undefined;
  let fail = false;
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      onReady: async (sessionId) => {
        id = sessionId;
        entered = true;
        await gate.promise;
        if (fail) throw new Error("metadata failed");
      },
    }),
  });
  try {
    await h.initialize();
    const open = await h.start("session/new", { cwd: "/tmp", mcpServers: [] });
    await until(() => entered);
    expect(h.messages.some((message) => message.id === open && !message.method)).toBe(false);
    expect((await h.request("session/prompt", prompt(id!))).error).toBeDefined();
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error?.code,
    ).toBe(-32602);
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: open } });
    expect((await h.response(open)).error).toBeDefined();
    gate.resolve();
    fail = true;
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error?.code,
    ).toBe(-32603);
    fail = false;
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    expect((await h.request("session/prompt", prompt(id!))).result.stopReason).toBe("end_turn");
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("a reopened session adopts a changed tool manifest and prompts with its prior history", async () => {
  const directory = `.session-artifacts/acp-registry-adoption/${crypto.randomUUID()}`;
  const requests: CompletionPortRequest[] = [];
  const base = setup({
    complete: (request) => {
      requests.push(request);
      return requests.length === 1
        ? { kind: "tools", text: "Checking", calls: [{ id: "one", name: "extra", args: {} }] }
        : answer;
    },
  });
  const factory =
    (tools: NonNullable<SessionOptions["bindings"]["tools"]>): AcpOptions["sessionOptions"] =>
    async (context) => {
      const options = await base.options.sessionOptions(context);
      return {
        ...options,
        configuration: {
          ...options.configuration,
          agents: new Map([["a", { model: "m", tools: [...tools.keys()], successors: [] }]]),
          policy: { permissions: "off" },
        },
        bindings: { ...options.bindings, tools },
      };
    };
  const original = factory(
    new Map([
      ["echo", defineTool({ input: z.object({ text: z.string() }), run: () => "echoed" })],
      ["extra", defineTool({ input: z.object({}), run: () => "extra result" })],
    ]),
  );
  const widened = z.object({ text: z.string(), limit: z.number().int().optional() });
  const changed = factory(new Map([["echo", defineTool({ input: widened, run: () => "echoed" })]]));
  let sessionId = "";
  await withFixtureDiagnostics(directory, {}, async () => {
    let h = harness({ ...base.options, sessionOptions: original });
    try {
      await h.initialize();
      sessionId = await h.newSession();
      expect((await h.request("session/prompt", prompt(sessionId))).result.stopReason).toBe(
        "end_turn",
      );
      await h.close();
      h = harness({ ...base.options, sessionOptions: changed });
      await h.initialize();
      expect(
        (await h.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] })).error,
      ).toBeUndefined();
      expect(h.updates().map(({ update }) => update.sessionUpdate)).toEqual([
        "user_message_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
        "agent_message_chunk",
      ]);
      expect(
        h.updates().find(({ update }) => update.sessionUpdate === "tool_call_update")?.update,
      ).toMatchObject({ status: "completed", rawOutput: "extra result" });
      expect(requests).toHaveLength(2);
      expect((await h.request("session/prompt", prompt(sessionId))).result.stopReason).toBe(
        "end_turn",
      );
      expect(requests).toHaveLength(3);
      const next = requests[2]!;
      expect(next.messages.map(({ role, content }) => [role, content])).toEqual([
        ["user", "Go"],
        ["assistant", "Checking"],
        ["tool", "extra result"],
        ["assistant", "Done"],
        ["user", "Go"],
      ]);
      // History for the removed tool is projected exactly as before the manifest change.
      expect(next.messages.slice(0, 3)).toEqual([...requests[1]!.messages]);
      expect(next.messages[1]).toMatchObject({
        tool_calls: [{ id: "one", function: { name: "extra" } }],
      });
      expect(next.messages[2]).toMatchObject({ role: "tool", tool_call_id: "one" });
      expect(next.tools?.map((tool) => tool.function.name)).toEqual(["echo"]);
      expect(next.tools?.[0]?.function.parameters).toMatchObject({
        properties: { limit: { type: "integer" } },
      });
      await h.close();
      h = harness({ ...base.options, sessionOptions: changed });
      await h.initialize();
      expect(
        (await h.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] })).error,
      ).toBeUndefined();
    } finally {
      await h.close();
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const pending = records.filter((record) => record.event === "acp.session.registry_pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ level: "info", sessionId, method: "session/load" });
  expect(pending[0].connectionId).toBeString();
  expect(pending[0].rpcRequestId).toBeString();
  expect(pending[0].differences).toContain("missing tools.extra");
  expect(pending[0].differences).toContain("changed tools.echo.parameters: added properties limit");
  expect(
    records
      .filter(
        (record) =>
          record.event === "acp.session.open.completed" && record.method === "session/load",
      )
      .map((record) => record.registry),
  ).toEqual(["pending_adoption", "current"]);
  expect(records.filter((record) => record.event === "session.registry.adopted")).toHaveLength(1);
  expect(records.filter((record) => ["warning", "error"].includes(record.level))).toEqual([]);
});

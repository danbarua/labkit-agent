import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { client, type SessionNotification } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";

import { deferred } from "../core/agent/test-support.ts";
import { acpHttpHandler, serveAcpHttp } from "./http.ts";
import { setup } from "./testing/harness.ts";

type LogRecord = Readonly<{ level: string; event: string; [field: string]: unknown }>;

type Diagnostics = Readonly<{
  records(event?: string): LogRecord[];
  /** Resolves with the first record, already emitted or later, that matches. */
  next(event: string, match: (record: LogRecord) => boolean): Promise<LogRecord>;
  restore(): void;
}>;

const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const endpoint = "http://acp.test/acp";
const authorization = { Authorization: `Bearer ${token}` };

/** Captures every `labkit.acp` diagnostic with its level. */
function diagnostics(): Diagnostics {
  const logger = getLogger(["labkit", "acp"]);
  const emit = logger.emit.bind(logger);
  const records: LogRecord[] = [];
  const waiters = new Set<{ match: (record: LogRecord) => boolean; found: () => void }>();
  const spy = spyOn(logger, "emit").mockImplementation((record) => {
    const flat = { level: record.level, ...record.properties } as LogRecord;
    records.push(flat);
    for (const waiter of waiters) if (waiter.match(flat)) waiter.found();
    emit(record);
  });
  return {
    records: (event) => records.filter((record) => !event || record.event === event),
    async next(event, match) {
      const matches = (record: LogRecord) => record.event === event && match(record);

      if (!records.some(matches)) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const waiter = { match: matches, found: resolve };
        waiters.add(waiter);
        await promise;
        waiters.delete(waiter);
      }
      return records.find(matches)!;
    },
    restore: () => spy.mockRestore(),
  };
}

/**
 * An SDK client app over the SDK's Streamable HTTP client stream. `fetchRequest` is the handler's
 * fetch (in process) or the global fetch; `httpConnectionIds` lists each `Acp-Connection-Id` the
 * host answered with. `close` sends DELETE.
 */
function httpClient(
  fetchRequest: (request: Request) => Promise<Response>,
  url = endpoint,
  headers: Record<string, string> = authorization,
) {
  const updates: SessionNotification[] = [];
  const httpConnectionIds: string[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchRequest(new Request(input, init));
    const opened = response.headers.get("Acp-Connection-Id");
    if (opened) httpConnectionIds.push(opened);
    return response;
  }) as typeof globalThis.fetch;

  const connection = client()
    .onNotification("session/update", ({ params }) => {
      updates.push(params);
    })
    .connect(createHttpStream(url, { fetch: transport, headers }));
  const { agent } = connection;
  return {
    agent,
    updates,
    httpConnectionIds,
    initialize: () => agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} }),
    newSession: async (cwd = "/tmp") =>
      (await agent.request("session/new", { cwd, mcpServers: [] })).sessionId,
    prompt: (sessionId: string) =>
      agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Go" }] }),
    close: () => {
      connection.close();
      return connection.closed;
    },
  };
}

/** The adapter connection ID the HTTP host logged for each connection, in opening order. */
const adapterIds = (logs: Diagnostics) =>
  logs.records("acp.http.connection.opened").map((record) => record.connectionId as string);

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: number; message: string; data?: unknown };
  }
  throw new Error("Expected the request to fail");
}

test("Streamable HTTP serves initialize, session/new and a prompt, and logs both connection IDs", async () => {
  const logs = diagnostics();
  const handler = acpHttpHandler(setup().options, { token });
  const a = httpClient(handler.fetch);
  try {
    expect((await a.initialize()).protocolVersion).toBe(1);
    const sessionId = await a.newSession();
    expect((await a.prompt(sessionId)).stopReason).toBe("end_turn");
    expect(
      a.updates.some(
        (update) =>
          update.sessionId === sessionId &&
          update.update.sessionUpdate === "agent_message_chunk" &&
          update.update.content.type === "text" &&
          update.update.content.text === "Hello 🌍",
      ),
    ).toBe(true);
    const [opened] = logs.records("acp.http.connection.opened");
    expect(opened).toMatchObject({
      level: "info",
      connectionId: expect.any(String),
      httpConnectionId: a.httpConnectionIds[0],
    });
    // The HTTP ID joins transport logs; the adapter ID joins the session logs of that connection.
    expect(logs.records("acp.connection.opened")).toContainEqual(
      expect.objectContaining({ connectionId: opened!.connectionId }),
    );
    expect(logs.records("acp.session.open.completed")).toContainEqual(
      expect.objectContaining({ connectionId: opened!.connectionId, sessionId }),
    );
    expect(logs.records("acp.http.request")).toContainEqual(
      expect.objectContaining({
        level: "debug",
        method: "POST",
        httpConnectionId: a.httpConnectionIds[0],
        status: 202,
        durationMs: expect.any(Number),
      }),
    );
    expect(logs.records().filter((record) => record.level === "warning")).toEqual([]);
  } finally {
    await a.close();
    await handler.close();
    logs.restore();
  }
});

test("requests without the bearer token or with a wrong one get 401 and a warning that never contains a token", async () => {
  const logs = diagnostics();
  const handler = acpHttpHandler(setup().options, { token });
  const wrong = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  try {
    for (const [headers, reason] of [
      [{}, "missing_token"],
      [{ Authorization: `Basic ${token}` }, "missing_token"],
      [{ Authorization: `Bearer ${wrong}` }, "bad_token"],
    ] as const) {
      const response = await handler.fetch(
        new Request(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: initialize,
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(logs.records("acp.http.rejected").at(-1)).toMatchObject({
        level: "warning",
        method: "POST",
        path: "/acp",
        reason,
        consequence: expect.stringContaining("401"),
      });
    }
    // The SDK client sees the refusal as a failed initialize.
    const b = httpClient(handler.fetch, endpoint, { Authorization: `Bearer ${wrong}` });
    expect((await rejection(b.initialize())).message).toContain("401");
    expect(logs.records("acp.connection.opened")).toEqual([]);
    const text = JSON.stringify(logs.records());
    expect(text).not.toContain(token);
    expect(text).not.toContain(wrong);
    // The explanation survives credential redaction intact.
    expect(text).not.toContain("REDACTED");
  } finally {
    await handler.close();
    logs.restore();
  }
});

test("the HTTP host refuses to start without loadSession or with a short token", () => {
  const { options } = setup();
  expect(() => acpHttpHandler({ ...options, loadSession: false }, { token })).toThrow(
    /loadSession: true.*session\/load/,
  );
  expect(() => acpHttpHandler(options, { token: "x".repeat(31) })).toThrow(
    /at least 32 characters; set LABKIT_ACP_HTTP_TOKEN/,
  );
});

test("DELETE closes the connection's sessions and a new connection's session/load replays them", async () => {
  const logs = diagnostics();
  const handler = acpHttpHandler(setup().options, { token });
  const a = httpClient(handler.fetch);
  const b = httpClient(handler.fetch);
  try {
    await a.initialize();
    const sessionId = await a.newSession();
    expect((await a.prompt(sessionId)).stopReason).toBe("end_turn");
    const [first] = adapterIds(logs);
    await a.close();
    expect(
      await logs.next("acp.connection.closing", (record) => record.connectionId === first),
    ).toMatchObject({ connectionId: first, count: 1 });
    expect(
      await logs.next("acp.http.connection.closed", (record) => record.connectionId === first),
    ).toMatchObject({ level: "info", httpConnectionId: a.httpConnectionIds[0] });
    await b.initialize();
    await b.agent.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] });
    const replayed = b.updates
      .filter((update) => update.sessionId === sessionId)
      .map((update) => update.update);
    expect(replayed).toContainEqual(
      expect.objectContaining({
        sessionUpdate: "user_message_chunk",
        content: expect.objectContaining({ text: "Go" }),
      }),
    );
    expect(replayed).toContainEqual(
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: expect.objectContaining({ text: "Hello 🌍" }),
      }),
    );
    // Nobody held the session any more, so loading it took nothing over.
    expect(logs.records("acp.session.taken_over")).toEqual([]);
  } finally {
    await b.close();
    await handler.close();
    logs.restore();
  }
});

test("session/load from a second connection takes the session over and the first connection's next prompt names it", async () => {
  const logs = diagnostics();
  const handler = acpHttpHandler(setup().options, { token });
  const a = httpClient(handler.fetch);
  const b = httpClient(handler.fetch);
  try {
    await a.initialize();
    const sessionId = await a.newSession();
    expect((await a.prompt(sessionId)).stopReason).toBe("end_turn");
    await b.initialize();
    const [first, second] = adapterIds(logs);
    await b.agent.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] });
    expect(logs.records("acp.session.taken_over")).toEqual([
      expect.objectContaining({
        level: "info",
        sessionId,
        connectionId: second,
        previousConnectionId: first,
        method: "session/load",
        promptCancelled: false,
      }),
    ]);
    const refused = await rejection(a.prompt(sessionId));
    expect(refused.code).toBe(-32602);
    expect(refused.message).toContain(`connection ${second} took it over with session/load`);
    expect(refused.message).toContain("send session/load to continue");
    expect(logs.records("acp.session.not_open")).toContainEqual(
      expect.objectContaining({
        level: "warning",
        connectionId: first,
        sessionId,
        takenOverBy: second,
        takeoverMethod: "session/load",
      }),
    );
    expect((await b.prompt(sessionId)).stopReason).toBe("end_turn");
    // The first connection gets the session back the same way.
    await a.agent.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] });
    expect((await a.prompt(sessionId)).stopReason).toBe("end_turn");
    expect(logs.records("acp.session.taken_over").at(-1)).toMatchObject({
      connectionId: first,
      previousConnectionId: second,
    });
  } finally {
    await a.close();
    await b.close();
    await handler.close();
    logs.restore();
  }
});

test("a takeover during a running prompt ends that prompt cancelled and logs a warning", async () => {
  const logs = diagnostics();
  const started = deferred<void>();
  let calls = 0;
  const { options } = setup({
    complete: (_request, signal) => {
      if (++calls > 1) return { kind: "answer", text: "Hello 🌍" };
      started.resolve();
      const { promise, reject } = Promise.withResolvers<never>();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      return promise;
    },
  });
  const handler = acpHttpHandler(options, { token });
  const a = httpClient(handler.fetch);
  const b = httpClient(handler.fetch);
  try {
    await a.initialize();
    const sessionId = await a.newSession();
    const running = a.prompt(sessionId);
    await started.promise;
    await b.initialize();
    const [first, second] = adapterIds(logs);
    await b.agent.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] });
    expect((await running).stopReason).toBe("cancelled");
    const warnings = logs.records().filter((record) => record.level === "warning");
    expect(warnings).toEqual([
      expect.objectContaining({
        event: "acp.session.taken_over",
        sessionId,
        connectionId: second,
        previousConnectionId: first,
        method: "session/load",
        promptCancelled: true,
        consequence: expect.stringContaining("ended with stop reason cancelled"),
      }),
    ]);
    expect((await b.prompt(sessionId)).stopReason).toBe("end_turn");
  } finally {
    await a.close();
    await b.close();
    await handler.close();
    logs.restore();
  }
});

test("a claim while another connection is still restoring the session aborts that restore", async () => {
  const logs = diagnostics();
  const base = setup();
  const restoring = deferred<void>();
  let holdNextLoad = false;
  const handler = acpHttpHandler(
    {
      ...base.options,
      sessionOptions: async (context) => {
        if (holdNextLoad && context.sessionId) {
          holdNextLoad = false;
          restoring.resolve();
          const { promise, reject } = Promise.withResolvers<never>();
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
          await promise;
        }
        return base.options.sessionOptions(context);
      },
    },
    { token },
  );
  const a = httpClient(handler.fetch);
  const b = httpClient(handler.fetch);
  try {
    await a.initialize();
    const sessionId = await a.newSession();
    await a.agent.request("session/close", { sessionId });
    holdNextLoad = true;
    const load = { sessionId, cwd: "/tmp", mcpServers: [] };
    const restore = rejection(a.agent.request("session/load", load));
    await restoring.promise;
    await b.initialize();
    const [first, second] = adapterIds(logs);
    await b.agent.request("session/load", load);
    const refused = await restore;
    expect(refused.code).toBe(-32602);
    expect(refused.message).toContain(`connection ${second} took it over with session/load`);
    expect(logs.records("acp.session.open.cancelled")).toContainEqual(
      expect.objectContaining({ connectionId: first, sessionId, method: "session/load" }),
    );
    expect(logs.records("acp.session.taken_over")).toEqual([
      expect.objectContaining({
        level: "info",
        connectionId: second,
        previousConnectionId: first,
        promptCancelled: false,
      }),
    ]);
    expect((await b.prompt(sessionId)).stopReason).toBe("end_turn");
  } finally {
    await a.close();
    await b.close();
    await handler.close();
    logs.restore();
  }
});

test("concurrent loads from two connections take the session over one after the other", async () => {
  const logs = diagnostics();
  const handler = acpHttpHandler(setup().options, { token });
  const clients = [httpClient(handler.fetch), httpClient(handler.fetch), httpClient(handler.fetch)];
  try {
    for (const connection of clients) await connection.initialize();
    const [a, b, c] = clients as [(typeof clients)[0], (typeof clients)[0], (typeof clients)[0]];
    const sessionId = await a.newSession();
    const byConnection = new Map(adapterIds(logs).map((id, index) => [id, clients[index]!]));
    const load = { sessionId, cwd: "/tmp", mcpServers: [] };
    // Either load may fail: a later claim aborts a restore still in progress.
    await Promise.allSettled([
      b.agent.request("session/load", load),
      c.agent.request("session/load", load),
    ]);
    const [first, second] = logs.records("acp.session.taken_over");
    expect(logs.records("acp.session.taken_over")).toHaveLength(2);
    expect(first).toMatchObject({ previousConnectionId: adapterIds(logs)[0] });
    expect(second).toMatchObject({ previousConnectionId: first!.connectionId });
    const winner = byConnection.get(second!.connectionId as string)!;
    const loser = byConnection.get(first!.connectionId as string)!;
    expect([b, c]).toContain(winner);
    expect([b, c]).toContain(loser);
    expect(winner).not.toBe(loser);
    expect((await winner.prompt(sessionId)).stopReason).toBe("end_turn");
    expect((await rejection(loser.prompt(sessionId))).message).toContain(
      `connection ${second!.connectionId} took it over`,
    );
    expect((await rejection(a.prompt(sessionId))).message).toContain(
      `connection ${first!.connectionId} took it over`,
    );
  } finally {
    for (const connection of clients) await connection.close();
    await handler.close();
    logs.restore();
  }
});

test("session/delete from another connection closes the live session before deleting it", async () => {
  const logs = diagnostics();
  const base = setup();
  const deleted: { sessionId: string; cwd?: string; closedFirst: boolean }[] = [];
  const handler = acpHttpHandler(
    {
      ...base.options,
      deleteSession: (params) => {
        deleted.push({
          ...params,
          closedFirst: logs
            .records("acp.session.taken_over")
            .some((record) => record.sessionId === params.sessionId),
        });
      },
    },
    { token },
  );
  const a = httpClient(handler.fetch);
  const b = httpClient(handler.fetch);
  try {
    await a.initialize();
    const sessionId = await a.newSession();
    await b.initialize();
    const [first, second] = adapterIds(logs);
    expect(await b.agent.request("session/delete", { sessionId })).toEqual({});
    expect(deleted).toEqual([{ sessionId, cwd: "/tmp", closedFirst: true }]);
    expect(logs.records("acp.session.taken_over")).toEqual([
      expect.objectContaining({
        connectionId: second,
        previousConnectionId: first,
        method: "session/delete",
      }),
    ]);
    const refused = await rejection(a.prompt(sessionId));
    expect(refused.code).toBe(-32602);
    expect(refused.message).toContain(`connection ${second} deleted it with session/delete`);
  } finally {
    await a.close();
    await b.close();
    await handler.close();
    logs.restore();
  }
});

test("session/fork from another connection closes the live parent before forking it", async () => {
  const logs = diagnostics();
  const handler = acpHttpHandler({ ...setup().options, forkSession: true }, { token });
  const a = httpClient(handler.fetch);
  const b = httpClient(handler.fetch);
  try {
    await a.initialize();
    const parent = await a.newSession();
    expect((await a.prompt(parent)).stopReason).toBe("end_turn");
    await b.initialize();
    const [first, second] = adapterIds(logs);
    const { sessionId: child } = await b.agent.request("session/fork", {
      sessionId: parent,
      cwd: "/tmp",
    });
    expect(child).not.toBe(parent);
    expect(logs.records("acp.session.taken_over")).toEqual([
      expect.objectContaining({
        sessionId: parent,
        connectionId: second,
        previousConnectionId: first,
        method: "session/fork",
        promptCancelled: false,
      }),
    ]);
    expect(logs.records("acp.fork.committed")).toContainEqual(
      expect.objectContaining({ connectionId: second, parentSessionId: parent, sessionId: child }),
    );
    const refused = await rejection(a.prompt(parent));
    expect(refused.message).toContain(`connection ${second} took it over with session/fork`);
    expect((await b.prompt(child)).stopReason).toBe("end_turn");
    // The fork released the parent: loading it again on the first connection takes nothing over.
    await a.agent.request("session/load", { sessionId: parent, cwd: "/tmp", mcpServers: [] });
    expect((await a.prompt(parent)).stopReason).toBe("end_turn");
    expect(logs.records("acp.session.taken_over")).toHaveLength(1);
  } finally {
    await a.close();
    await b.close();
    await handler.close();
    logs.restore();
  }
});

test("a malformed JSON POST gets 400 and the connection keeps serving", async () => {
  const logs = diagnostics();
  const handler = acpHttpHandler(setup().options, { token });
  const a = httpClient(handler.fetch);
  try {
    await a.initialize();
    const sessionId = await a.newSession();
    const response = await handler.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          ...authorization,
          "Content-Type": "application/json",
          "Acp-Connection-Id": a.httpConnectionIds[0]!,
        },
        body: '{"jsonrpc":"2.0","id":9,"method":"session/prompt"',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid JSON");
    expect(logs.records("acp.http.request")).toContainEqual(
      expect.objectContaining({
        method: "POST",
        httpConnectionId: a.httpConnectionIds[0],
        status: 400,
        reason: "Invalid JSON",
      }),
    );
    expect((await a.prompt(sessionId)).stopReason).toBe("end_turn");
  } finally {
    await a.close();
    await handler.close();
    logs.restore();
  }
});

test("serveAcpHttp binds 127.0.0.1, answers a real fetch round trip and closes live sessions on stop", async () => {
  const logs = diagnostics();
  const server = serveAcpHttp(setup().options, { port: 0, token });
  const a = httpClient(fetch, server.url);
  try {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/acp`);
    expect(logs.records("acp.http.listening")).toEqual([
      expect.objectContaining({ level: "info", host: "127.0.0.1", port: server.port }),
    ]);
    const unauthorized = await fetch(server.url, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect((await fetch(new URL("/other", server.url), { headers: authorization })).status).toBe(
      404,
    );
    await a.initialize();
    const sessionId = await a.newSession();
    expect((await a.prompt(sessionId)).stopReason).toBe("end_turn");
    const [connectionId] = adapterIds(logs);
    await server.close();
    expect(logs.records("acp.connection.closing")).toContainEqual(
      expect.objectContaining({ connectionId, count: 1 }),
    );
    expect(logs.records("acp.http.stopped")).toEqual([
      expect.objectContaining({ host: "127.0.0.1", port: server.port }),
    ]);
  } finally {
    await a.close();
    await server.close();
    logs.restore();
  }
});

const cli = new URL(
  process.env.LABKIT_ACP_TEST_BUILT ? "./dist/cli.js" : "./cli.ts",
  import.meta.url,
).pathname;

/** A launcher config with memory persistence and a scripted answer naming the session cwd. */
async function launcherFixture() {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "labkit-acp-http-")));
  const config = join(directory, "config.ts");
  const memory = new URL("../core/session/testing/memory-persistence.ts", import.meta.url).href;
  await Bun.write(
    config,
    `import { createMemoryPersistence } from ${JSON.stringify(memory)};
    const persistence = createMemoryPersistence();
    export default { loadSession: true, sessionOptions: ({ cwd }) => ({ persistence,
      configuration: { agent: "a", agents: new Map([["a", { model: "m" }]]), steps: 2 },
      bindings: { complete: () => ({ kind: "answer", text: "hello from " + cwd }) },
    }) };`,
  );
  const logs = join(directory, "logs");
  const records = () =>
    readdirSync(logs)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => readFileSync(join(logs, name), "utf8").trim().split("\n"))
      .map((line) => JSON.parse(line) as LogRecord);

  const launch = (env: Record<string, string>) =>
    Bun.spawn([process.execPath, cli, "--config", config, "--http", "0"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LABKIT_ACP_LOG_DIR: logs, ...env },
    });

  return { directory, records, launch };
}

/** Reads stderr until the launcher prints its endpoint. */
async function endpointOf(stderr: ReadableStream<Uint8Array>) {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const match = /Labkit ACP HTTP endpoint: (\S+)/.exec(text);
    if (match) {
      reader.releaseLock();
      return match[1]!;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`The launcher exited without printing its endpoint: ${text}`);
    text += decoder.decode(value, { stream: true });
  }
}

test("the CLI serves --http until SIGTERM with stdout empty, and exits 1 without a token", async () => {
  const fixture = await launcherFixture();
  const child = fixture.launch({ LABKIT_ACP_HTTP_TOKEN: token });
  try {
    const url = await endpointOf(child.stderr);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/acp$/);
    const a = httpClient(fetch, url);
    await a.initialize();
    const sessionId = await a.newSession(fixture.directory);
    expect((await a.prompt(sessionId)).stopReason).toBe("end_turn");
    expect(a.updates).toContainEqual(
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: expect.objectContaining({ text: `hello from ${fixture.directory}` }),
        }),
      }),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await a.close();
    expect(await new Response(child.stdout).text()).toBe("");
    const records = fixture.records();
    const events = records.map((record) => record.event);
    for (const event of [
      "launcher.started",
      "acp.http.listening",
      "acp.http.connection.opened",
      "http.shutdown_requested",
      "acp.connection.closing",
      "acp.http.stopped",
      "launcher.stopped",
    ])
      expect(events).toContain(event);
    expect(records.find((record) => record.event === "launcher.started")).toMatchObject({
      transport: "http",
      port: "0",
    });
    expect(records.find((record) => record.event === "launcher.stopped")).toMatchObject({
      exitCode: 0,
    });
    expect(JSON.stringify(records)).not.toContain(token);

    const refused = fixture.launch({ LABKIT_ACP_HTTP_TOKEN: "" });
    expect(await refused.exited).toBe(1);
    expect(await new Response(refused.stdout).text()).toBe("");
    const stderr = await new Response(refused.stderr).text();
    expect(stderr).toContain("Labkit ACP HTTP host refused to start");
    expect(stderr).toContain("set LABKIT_ACP_HTTP_TOKEN");
    expect(fixture.records()).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "launcher.failed",
        error: expect.objectContaining({
          message: expect.stringContaining("LABKIT_ACP_HTTP_TOKEN"),
        }),
      }),
    );
  } finally {
    child.kill();
    await child.exited;
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 30_000);

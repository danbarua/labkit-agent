import { expect, test } from "@logtape/testing-bun/autoload";

import { deferred, until } from "../core/agent/test-support.ts";
import { answer, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("ACP authentication gates session access, negotiates terminal methods, and logout releases active work", async () => {
  let authenticated = false;
  let factoryCalls = 0;
  let logoutCalls = 0;
  let completionSignal: AbortSignal | undefined;
  const blocked = deferred<unknown>();
  const base = setup({
    complete: (_request, signal) => {
      completionSignal = signal;
      return blocked.promise;
    },
  });
  const h = harness({
    ...base.options,
    listSessions: () => ({ sessions: [] }),
    auth: {
      methods: [
        { id: "login", name: "Sign in" },
        { type: "terminal", id: "interactive", name: "Terminal login", args: ["--login"] },
      ],
      isAuthenticated: () => authenticated,
      authenticate: (method) => {
        expect(method).toBe("login");
        authenticated = true;
      },
      logout: () => {
        logoutCalls++;
        authenticated = false;
      },
    },
    sessionOptions: (context) => {
      factoryCalls++;
      return base.options.sessionOptions(context);
    },
  });
  try {
    expect((await h.request("authenticate", { methodId: "login" })).error?.code).toBe(-32600);
    const init = await h.initialize();
    expect(init.result.authMethods).toEqual([{ id: "login", name: "Sign in" }]);
    expect(init.result.agentCapabilities.auth).toEqual({ logout: {} });
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
    expect((await h.request("session/list", {})).error?.code).toBe(-32000);
    expect(factoryCalls).toBe(0);
    expect((await h.request("authenticate", { methodId: "unknown" })).error?.code).toBe(-32602);
    expect((await h.request("authenticate", { methodId: "interactive" })).error?.code).toBe(-32602);
    expect((await h.request("authenticate", { methodId: "login" })).result).toEqual({});
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    await until(() => !!completionSignal);
    expect((await h.request("logout", {})).result).toEqual({});
    expect(completionSignal!.aborted).toBe(true);
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    expect(logoutCalls).toBe(1);
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
    expect((await h.request("authenticate", { methodId: "login" })).result).toEqual({});
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const saved = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(saved)).not.toContain("Sign in");
  } finally {
    blocked.resolve(answer);
    await h.close();
  }
});

test("cancelled authentication cannot grant late access or overlap another credential change", async () => {
  let authenticated = false;
  let calls = 0;
  const gate = deferred<void>();
  const h = harness({
    ...setup().options,
    auth: {
      methods: [{ id: "login", name: "Sign in" }],
      isAuthenticated: () => authenticated,
      authenticate: async () => {
        if (++calls === 1) await gate.promise;
        authenticated = true;
      },
    },
  });
  try {
    await h.initialize();
    const login = await h.start("authenticate", { methodId: "login" });
    await until(() => calls === 1);
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: login } });
    expect((await h.response(login)).error).toBeDefined();
    expect((await h.request("authenticate", { methodId: "login" })).error).toBeDefined();
    expect(calls).toBe(1);
    gate.resolve();
    await until(() => authenticated);
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
    expect((await h.request("authenticate", { methodId: "login" })).result).toEqual({});
    expect(typeof (await h.newSession())).toBe("string");
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("logout cancels an opening factory and terminal login is advertised only to capable clients", async () => {
  let authenticated = true;
  const gate = deferred<void>();
  let entered = false;
  let factorySignal: AbortSignal | undefined;
  const base = setup();
  const h = harness({
    ...base.options,
    auth: {
      methods: [{ type: "terminal", id: "interactive", name: "Terminal", args: ["--login"] }],
      isAuthenticated: () => authenticated,
      logout: () => {
        authenticated = false;
      },
    },
    sessionOptions: async (context) => {
      entered = true;
      factorySignal = context.signal;
      await gate.promise;
      return base.options.sessionOptions(context);
    },
  });
  try {
    const init = await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });
    expect(init.result.authMethods).toHaveLength(1);
    expect(init.result.authMethods[0].type).toBe("terminal");
    expect((await h.request("authenticate", { methodId: "interactive" })).error).toBeDefined();
    const open = await h.start("session/new", { cwd: "/tmp", mcpServers: [] });
    await until(() => entered);
    expect((await h.request("logout", {})).result).toEqual({});
    expect(factorySignal!.aborted).toBe(true);
    gate.resolve();
    expect((await h.response(open)).error).toBeDefined();
    expect(h.updates()).toEqual([]);
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("expired credentials still permit cancellation and close; disconnect aborts pending authentication", async () => {
  let authenticated = true;
  let completionSignal: AbortSignal | undefined;
  let loginSignal: AbortSignal | undefined;
  const completion = deferred<unknown>();
  const login = deferred<void>();
  const h = harness({
    ...setup({
      complete: (_request, signal) => {
        completionSignal = signal;
        return completion.promise;
      },
    }).options,
    auth: {
      methods: [{ id: "login", name: "Login" }],
      isAuthenticated: () => authenticated,
      authenticate: async (_id, signal) => {
        loginSignal = signal;
        await login.promise;
      },
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    await until(() => !!completionSignal);
    authenticated = false;
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    expect((await h.request("session/close", { sessionId: id })).result).toEqual({});
    await h.start("authenticate", { methodId: "login" });
    await until(() => !!loginSignal);
    await h.close();
    expect(loginSignal!.aborted).toBe(true);
  } finally {
    completion.resolve(answer);
    login.resolve();
    await h.close();
  }
});

/** ACP v1 capability gating: every advertised lifecycle method works through the real handler. */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import protocolSchema from "@agentclientprotocol/sdk/schema/schema.json";
import { expect, test } from "@logtape/testing-bun/autoload";
import { Ajv2020 } from "ajv/dist/2020.js";

import { withFixtureDiagnostics } from "../core/logging/fixture-capture.ts";
import { workspaceAgent } from "./examples/vscode-workspace.ts";
import type { AcpAuth, AcpOptions } from "./index.ts";
import { harness, setup, type Message } from "./testing/harness.ts";

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

/** Validate against the SDK 1.5.0 v1 JSON schema; the SDK does not export its zod schemas. */
function conforms(definition: keyof typeof protocolSchema.$defs, value: unknown) {
  const validate = ajv.compile({
    $defs: protocolSchema.$defs,
    $ref: `#/$defs/${definition}`,
  });
  expect({ definition, valid: validate(value), errors: validate.errors ?? null }).toEqual({
    definition,
    valid: true,
    errors: null,
  });
}

/** A successful response frame whose result satisfies the named SDK response schema. */
function ok(frame: Message, definition: keyof typeof protocolSchema.$defs) {
  expect(frame.error).toBeUndefined();
  conforms(definition, frame.result);
  return frame.result;
}

/** An error frame that satisfies the SDK error schema. */
function failed(frame: Message) {
  expect(frame.result).toBeUndefined();
  conforms("Error", frame.error);
  return frame.error!;
}

// Keep workspace launcher tests off any real local model server.
const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

type Log = Record<string, unknown>;

async function captured(callback: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "labkit-acp-capabilities-logs-"));
  try {
    await withFixtureDiagnostics(directory, {}, callback);
    return (await Bun.file(join(directory, "diagnostics.jsonl")).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Log);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function workspace() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "labkit-acp-capabilities-")));
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

/**
 * The VS Code workspace launcher (real SQLite store, listing, deletion, roots), with its provider
 * replaced by a scripted completion that records every model request.
 */
function launcher(requests: string[] = []): AcpOptions {
  const base = workspaceAgent({ ANTHROPIC_API_KEY: "fixture" }, undefined, { fetch: offline });
  return {
    ...base,
    sessionOptions: async (context) => {
      const options = await base.sessionOptions(context);
      return {
        ...options,
        config: undefined,
        configuration: {
          ...options.configuration,
          policy: {
            permissions: options.configuration.policy!.permissions,
            toolFailure: options.configuration.policy!.toolFailure,
          },
        },
        bindings: {
          ...options.bindings,
          providers: undefined,
          complete: (request) => {
            requests.push(JSON.stringify(request));
            return { kind: "answer", text: "Survey plan ready" };
          },
        },
      };
    },
  };
}

const say = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

/** Auth is configured and the client never authenticated. */
const denied: AcpAuth = { methods: [], isAuthenticated: () => false };

const conditional = [
  ["session/load", "agentCapabilities.loadSession"],
  ["session/resume", "agentCapabilities.sessionCapabilities.resume"],
  ["session/fork", "agentCapabilities.sessionCapabilities.fork"],
  ["session/delete", "agentCapabilities.sessionCapabilities.delete"],
  ["session/list", "agentCapabilities.sessionCapabilities.list"],
  ["logout", "agentCapabilities.auth.logout"],
] as const;

const valid: Record<(typeof conditional)[number][0], unknown> = {
  "session/load": { sessionId: "saved", cwd: "/tmp", mcpServers: [] },
  "session/resume": { sessionId: "saved", cwd: "/tmp" },
  "session/fork": { sessionId: "saved", cwd: "/tmp" },
  "session/delete": { sessionId: "saved" },
  "session/list": {},
  logout: {},
};

test("unadvertised lifecycle methods answer -32601 before initialization, params and auth", async () => {
  const logs = await captured(async () => {
    const h = harness({ ...setup().options, loadSession: false, auth: denied });
    try {
      // Before initialize, with malformed params: the gate precedes every other check.
      for (const [method, capability] of conditional) {
        const error = failed(await h.request(method, { malformed: true }));
        expect(error.code).toBe(-32601);
        expect(error.message).toContain(method);
        expect(error.message).toContain(`does not advertise ${capability}`);
        expect(error.data).toEqual({ method, capability });
      }
      const initialized = ok(await h.initialize(), "InitializeResponse");
      expect(initialized.agentCapabilities.loadSession).toBe(false);
      expect(initialized.agentCapabilities.auth).toBeUndefined();
      expect(initialized.agentCapabilities.sessionCapabilities).toEqual({ close: {} });
      // Auth is configured and this client is not authenticated: advertised methods refuse on auth.
      expect(failed(await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).code).toBe(
        -32000,
      );
      for (const [method] of conditional)
        expect(failed(await h.request(method, valid[method])).code).toBe(-32601);
      // Unstable and unknown methods are not advertised either.
      for (const method of ["session/set_model", "session/frobnicate"])
        expect(failed(await h.request(method, { sessionId: "saved" })).code).toBe(-32601);
    } finally {
      await h.close();
    }
  });
  const refusals = logs.filter((log) => log.event === "acp.method.not_advertised");
  expect(refusals).toHaveLength(conditional.length * 2);
  for (const [method, capability] of conditional)
    expect(refusals.filter((log) => log.method === method)).toEqual([
      expect.objectContaining({
        level: "warning",
        connectionId: expect.any(String),
        rpcRequestId: expect.any(String),
        method,
        capability,
      }),
      expect.objectContaining({ method, capability }),
    ]);
});

test("advertised lifecycle methods reach auth: an unauthenticated client gets auth_required", async () => {
  const h = harness({ ...launcher(), auth: denied });
  try {
    await h.initialize();
    for (const [method] of conditional.filter(([method]) => method !== "logout"))
      expect(failed(await h.request(method, valid[method])).code).toBe(-32000);
  } finally {
    await h.close();
  }
});

test("workspace launcher: list, close, load, resume, fork and delete work end to end", async () => {
  const { cwd, cleanup } = await workspace();
  const requests: string[] = [];
  let id = "";
  let child = "";
  const logs = await captured(async () => {
    let h = harness(launcher(requests));
    try {
      const capabilities = ok(await h.initialize(), "InitializeResponse").agentCapabilities;
      expect(capabilities.loadSession).toBe(true);
      expect(capabilities.sessionCapabilities).toEqual({
        close: {},
        resume: {},
        fork: {},
        delete: {},
        additionalDirectories: {},
        list: {},
      });
      id = ok(
        await h.request("session/new", { cwd, mcpServers: [] }),
        "NewSessionResponse",
      ).sessionId;
      expect(
        ok(await h.request("session/prompt", say(id, "Plan the survey")), "PromptResponse")
          .stopReason,
      ).toBe("end_turn");

      // list: cwd, title from the first prompt, and an ISO update time.
      const listed = ok(await h.request("session/list", { cwd }), "ListSessionsResponse");
      expect(listed.sessions).toEqual([
        { sessionId: id, cwd, title: "Plan the survey", updatedAt: expect.any(String) },
      ]);
      expect(Number.isNaN(Date.parse(listed.sessions[0].updatedAt))).toBe(false);

      // close: the runtime is gone; a later prompt gets an explicit refusal.
      expect(
        ok(await h.request("session/close", { sessionId: id }), "CloseSessionResponse"),
      ).toEqual({});
      const closed = failed(await h.request("session/prompt", say(id, "Anything else?")));
      expect(closed.code).toBe(-32602);
      expect(closed.message).toContain(`Session ${id} is not open on this connection`);
      expect(closed.message).toContain("session/load or session/resume");

      // load from a fresh connection replays the saved history.
      await h.close();
      h = harness(launcher(requests));
      await h.initialize();
      ok(
        await h.request("session/load", { sessionId: id, cwd, mcpServers: [] }),
        "LoadSessionResponse",
      );
      const replayed = h.updates().filter((update) => update.sessionId === id);
      for (const update of replayed) conforms("SessionNotification", update);
      expect(replayed.map(({ update }) => update)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "Plan the survey" },
          }),
          expect.objectContaining({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Survey plan ready" },
          }),
        ]),
      );
      await h.request("session/close", { sessionId: id });

      // resume: no replay, and the next prompt continues the saved history.
      const before = h.updates().length;
      expect(
        ok(await h.request("session/resume", { sessionId: id, cwd }), "ResumeSessionResponse"),
      ).not.toHaveProperty("sessionId");
      expect(
        h
          .updates()
          .slice(before)
          .filter((update) => update.update.sessionUpdate.endsWith("chunk")),
      ).toEqual([]);
      const calls = requests.length;
      expect(
        ok(await h.request("session/prompt", say(id, "Add a control site")), "PromptResponse")
          .stopReason,
      ).toBe("end_turn");
      expect(requests).toHaveLength(calls + 1);
      expect(requests.at(-1)).toContain("Plan the survey");
      expect(requests.at(-1)).toContain("Add a control site");

      // fork: a new session id carrying the parent's history.
      child = ok(
        await h.request("session/fork", { sessionId: id, cwd }),
        "ForkSessionResponse",
      ).sessionId;
      expect(child).not.toBe(id);
      await h.request("session/prompt", say(child, "Only the child sees this"));
      expect(requests.at(-1)).toContain("Plan the survey");
      expect(requests.at(-1)).toContain("Add a control site");
      const sessions = ok(
        await h.request("session/list", { cwd }),
        "ListSessionsResponse",
      ).sessions;
      expect(sessions.map((row: { sessionId: string }) => row.sessionId).sort()).toEqual(
        [id, child].sort(),
      );

      // delete: gone from list, and load of it fails with an explicit error.
      expect(
        ok(await h.request("session/delete", { sessionId: child }), "DeleteSessionResponse"),
      ).toEqual({});
      expect(ok(await h.request("session/list", { cwd }), "ListSessionsResponse").sessions).toEqual(
        [expect.objectContaining({ sessionId: id })],
      );
      const missing = failed(
        await h.request("session/load", { sessionId: child, cwd, mcpServers: [] }),
      );
      expect(missing.code).toBe(-32002);
      expect(missing.message).toContain(`Session ${child} has no saved history`);
      expect(missing.data).toEqual({ sessionId: child });
    } finally {
      await h.close();
      await cleanup();
    }
  });
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "acp.session.not_open",
      level: "warning",
      connectionId: expect.any(String),
      sessionId: id,
    }),
  );
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "acp.session.open.failed",
      method: "session/load",
      sessionId: child,
      rpcRequestId: expect.any(String),
      error: expect.objectContaining({ name: "SessionNotFoundError" }),
    }),
  );
});

test("advertised logout clears access, closes live sessions and keeps them loadable", async () => {
  let authenticated = true;
  const auth: AcpAuth = {
    methods: [{ id: "login", name: "Log in" }],
    isAuthenticated: () => authenticated,
    authenticate: () => {
      authenticated = true;
    },
    logout: () => {
      authenticated = false;
    },
  };
  const h = harness({ ...setup().options, auth });
  try {
    const initialized = ok(await h.initialize(), "InitializeResponse");
    expect(initialized.agentCapabilities.auth).toEqual({ logout: {} });
    const id = await h.newSession();
    expect((await h.request("session/prompt", say(id, "Before logout"))).result.stopReason).toBe(
      "end_turn",
    );
    expect(ok(await h.request("logout", {}), "LogoutResponse")).toEqual({});
    expect(authenticated).toBe(false);
    expect(failed(await h.request("session/prompt", say(id, "After logout"))).code).toBe(-32000);
    ok(await h.request("authenticate", { methodId: "login" }), "AuthenticateResponse");
    // Logout closed the runtime; the journal stays saved.
    expect(failed(await h.request("session/prompt", say(id, "After login"))).message).toContain(
      "is not open on this connection",
    );
    ok(
      await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] }),
      "LoadSessionResponse",
    );
    expect(
      h
        .updates()
        .some(
          ({ sessionId, update }) =>
            sessionId === id &&
            update.sessionUpdate === "user_message_chunk" &&
            update.content.type === "text" &&
            update.content.text === "Before logout",
        ),
    ).toBe(true);
  } finally {
    await h.close();
  }
});

test("additionalDirectories is refused with invalid_params on new, load, resume and fork when not advertised", async () => {
  const roots = { additionalDirectories: ["/var"] };
  const logs = await captured(async () => {
    const h = harness({ ...setup().options, forkSession: true });
    try {
      const initialized = ok(await h.initialize(), "InitializeResponse");
      expect(
        initialized.agentCapabilities.sessionCapabilities.additionalDirectories,
      ).toBeUndefined();
      // An empty list is the same as omitting it.
      const id: string = ok(
        await h.request("session/new", { cwd: "/tmp", mcpServers: [], additionalDirectories: [] }),
        "NewSessionResponse",
      ).sessionId;
      await h.request("session/prompt", say(id, "Saved turn"));
      await h.request("session/close", { sessionId: id });
      for (const [method, params] of [
        ["session/new", { cwd: "/tmp", mcpServers: [], ...roots }],
        ["session/load", { sessionId: id, cwd: "/tmp", mcpServers: [], ...roots }],
        ["session/resume", { sessionId: id, cwd: "/tmp", ...roots }],
        ["session/fork", { sessionId: id, cwd: "/tmp", ...roots }],
      ] as const) {
        const error = failed(await h.request(method, params));
        expect(error.code).toBe(-32602);
        expect(error.message).toContain(
          "does not advertise sessionCapabilities.additionalDirectories",
        );
        expect(error.message).toContain("resend without additionalDirectories");
      }
      // The refused requests left nothing half-open: the saved session still resumes.
      ok(
        await h.request("session/resume", { sessionId: id, cwd: "/tmp" }),
        "ResumeSessionResponse",
      );
    } finally {
      await h.close();
    }
  });
  expect(
    logs
      .filter((log) => log.event === "acp.session.additional_directories.refused")
      .map(({ level, method, count, reason }) => ({ level, method, count, reason })),
  ).toEqual(
    ["session/new", "session/load", "session/resume", "session/fork"].map((method) => ({
      level: "warning",
      method,
      count: 1,
      reason: "sessionCapabilities.additionalDirectories is not advertised",
    })),
  );
});

test("initialize responses conform to the SDK 1.5.0 InitializeResponse schema", async () => {
  const minimal: AcpOptions = { sessionOptions: setup().options.sessionOptions };
  for (const options of [
    minimal,
    workspaceAgent({ ANTHROPIC_API_KEY: "fixture" }, undefined, { fetch: offline }),
  ]) {
    const h = harness(options);
    try {
      ok(await h.initialize(), "InitializeResponse");
    } finally {
      await h.close();
    }
  }
});

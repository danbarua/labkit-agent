import { createSession, restoreSession } from "../session-runtime.ts";
import { until } from "../test-support.ts";
import type { Scenario } from "./support.ts";

export const toolsV1: Scenario = {
  name: "tools",
  version: 1,
  group: "tools",
  purpose:
    "Let the assistant request two parallel echo tools and use their committed results to answer.",
  source: "packages/core/session/fixtures/tools.ts#toolsV1",
  dependencies: {
    completions: [
      {
        kind: "tools",
        text: "Checking",
        calls: [
          {
            id: "c1",
            name: "echo",
            args: {
              text: "one",
            },
          },
          {
            id: "c2",
            name: "echo",
            args: {
              text: "two",
            },
          },
        ],
      },
      {
        kind: "answer",
        text: "Checked",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Run tools' to root.");
    const turn1 = root.input("Run tools");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
  },
};

export const toolErrorContinueV2: Scenario = {
  name: "tool-error-continue",
  version: 2,
  group: "tools",
  purpose:
    "Under the tolerant policy, return a failed tool result to the model and let it produce a final answer.",
  source: "packages/core/session/fixtures/tools.ts#toolErrorContinueV2",
  dependencies: {
    format: 2,
    policy: {
      id: "tolerant@1",
    },
    completions: [
      {
        kind: "tools",
        text: "Work",
        calls: [
          {
            id: "bad",
            name: "echo",
            args: {
              text: "error:broken",
            },
          },
          {
            id: "ok",
            name: "echo",
            args: {
              text: "ok",
            },
          },
        ],
      },
      {
        kind: "answer",
        text: "Recovered",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Go' to root.");
    const turn1 = root.input("Go");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore2 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore2,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
  },
};

export const abortToolsOnUserV2: Scenario = {
  name: "abort-tools-on-user",
  version: 2,
  group: "tools",
  purpose:
    "Under the interruption policy, a new user message cancels active tools and starts a new turn.",
  source: "packages/core/session/fixtures/tools.ts#abortToolsOnUserV2",
  dependencies: {
    format: 2,
    policy: {
      admission: "abort-tools-on-user",
    },
    completions: [
      {
        kind: "tools",
        text: "Work",
        calls: [
          {
            id: "fast",
            name: "echo",
            args: {
              text: "fast",
            },
          },
          {
            id: "slow",
            name: "echo",
            args: {
              text: "defer:slow",
            },
          },
        ],
      },
      {
        kind: "answer",
        text: "New turn",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Old' to root.");
    const turn1 = root.input("Old");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    f.action("Wait for 1 partial before the next action.");
    await until(() => root.snapshot.durable.partial.length === 1);
    f.action("Submit 'New' to root.");
    const turn3 = root.input("New");
    const admission3 = await turn3.accepted;
    f.record({ op: "input", session: "root", accepted: admission3 });
    f.check("Input admission is accepted", admission3.kind, "accepted");
    const result3 = await turn3.settled;
    f.record({ session: "root", terminal: result3 });
    f.action("Release deferred slow work.");
    await f.release("slow", "late");
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore5 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore5,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["aborted", "completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["aborted", "completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
  },
};

export const permissionAllowBatchV2: Scenario = {
  name: "permission-allow-batch",
  version: 2,
  group: "tools",
  purpose: "Request approval for both tools before running the approved batch and answering.",
  source: "packages/core/session/fixtures/tools.ts#permissionAllowBatchV2",
  dependencies: {
    format: 2,
    policy: {
      permissions: "ask",
    },
    permissions: [
      {
        outcome: {
          outcome: "selected",
          optionId: "allow-once",
        },
      },
      {
        outcome: {
          outcome: "selected",
          optionId: "allow-once",
        },
      },
    ],
    completions: [
      {
        kind: "tools",
        text: "Read files",
        calls: [
          {
            id: "one",
            name: "echo",
            args: {
              text: "one",
            },
          },
          {
            id: "two",
            name: "echo",
            args: {
              text: "two",
            },
          },
        ],
      },
      {
        kind: "answer",
        text: "Read both",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Go' to root.");
    const turn1 = root.input("Go");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore2 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore2,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
    f.check("Approved tools execute exactly once", f.toolRuns.length, 2);
  },
};

export const permissionRejectBatchV2: Scenario = {
  name: "permission-reject-batch",
  version: 2,
  group: "tools",
  purpose: "Reject one tool permission and fail the whole batch without executing either tool.",
  source: "packages/core/session/fixtures/tools.ts#permissionRejectBatchV2",
  dependencies: {
    format: 2,
    policy: {
      permissions: "ask",
    },
    permissions: [
      {
        outcome: {
          outcome: "selected",
          optionId: "allow-once",
        },
      },
      {
        outcome: {
          outcome: "selected",
          optionId: "reject-once",
        },
      },
    ],
    completions: [
      {
        kind: "tools",
        text: "Read files",
        calls: [
          {
            id: "one",
            name: "echo",
            args: {
              text: "one",
            },
          },
          {
            id: "two",
            name: "echo",
            args: {
              text: "two",
            },
          },
        ],
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Go' to root.");
    const turn1 = root.input("Go");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore2 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore2,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["failed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["failed"],
    );
    f.check("Provider request count", f.requests.length, 1);
    f.check("No tool executes without batch approval", f.toolRuns.length, 0);
  },
};

export const permissionCancelBatchV2: Scenario = {
  name: "permission-cancel-batch",
  version: 2,
  group: "tools",
  purpose: "Cancel the permission interaction and finish without executing tools.",
  source: "packages/core/session/fixtures/tools.ts#permissionCancelBatchV2",
  dependencies: {
    format: 2,
    policy: {
      permissions: "ask",
    },
    permissions: [
      {
        outcome: {
          outcome: "cancelled",
        },
      },
    ],
    completions: [
      {
        kind: "tools",
        text: "Read files",
        calls: [
          {
            id: "one",
            name: "echo",
            args: {
              text: "one",
            },
          },
          {
            id: "two",
            name: "echo",
            args: {
              text: "two",
            },
          },
        ],
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Go' to root.");
    const turn1 = root.input("Go");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["aborted"],
    );
    f.check("Provider request count", f.requests.length, 1);
    f.check("No tool executes without batch approval", f.toolRuns.length, 0);
  },
};

export const partialCancellationLateResultV1: Scenario = {
  name: "partial-cancellation-late-result",
  version: 1,
  group: "tools",
  purpose:
    "Cancel a tool batch after one result commits; a late second result must not change the cancelled turn.",
  source: "packages/core/session/fixtures/tools.ts#partialCancellationLateResultV1",
  dependencies: {
    completions: [
      {
        kind: "tools",
        text: "Working",
        calls: [
          {
            id: "fast",
            name: "echo",
            args: {
              text: "fast",
            },
          },
          {
            id: "slow",
            name: "echo",
            args: {
              text: "defer:slow",
            },
          },
        ],
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Go' to root.");
    const turn1 = root.input("Go");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    f.action("Wait for 1 partial before the next action.");
    await until(() => root.snapshot.durable.partial.length === 1);
    f.action("Abort the active turn in root.");
    await root.fire({ type: "abort" });
    f.record({ session: "root", terminal: await turn1.settled });
    f.action("Release deferred slow work.");
    await f.release("slow", "late");
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore5 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore5,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["aborted"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["aborted"],
    );
    f.check("Provider request count", f.requests.length, 1);
    f.check(
      "A late tool result never enters committed history",
      JSON.stringify(root.snapshot.durable.conversation.log).includes("late"),
      false,
    );
  },
};

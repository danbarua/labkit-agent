import { createSession, restoreSession } from "../session-runtime.ts";
import { until } from "../test-support.ts";
import type { Scenario } from "./support.ts";

export const failureV1: Scenario = {
  name: "failure",
  version: 1,
  group: "persistence",
  purpose:
    "Persist a transport failure as a failed turn and recover that outcome without retrying the model.",
  source: "packages/core/session/fixtures/persistence.ts#failureV1",
  dependencies: {
    completions: [
      {
        error: "Scripted transport failure",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Help' to root.");
    const turn1 = root.input("Help");
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
  },
};

export const interruptedRecoveryV1: Scenario = {
  name: "interrupted-recovery",
  version: 1,
  group: "persistence",
  purpose:
    "Reopen an interrupted tool batch, retaining its committed result and recording recovery only once.",
  source: "packages/core/session/fixtures/persistence.ts#interruptedRecoveryV1",
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
    f.action("Close root; in-flight work is cancelled, not resumed.");
    await root.close();
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore4 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore4,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.action("Restore restored as twice from its journal, without model work.");
    const requestsBeforeRestore5 = f.requests.length;
    const twice = f.track(
      "twice",
      await restoreSession(f.restoreOptions(), restored.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore5,
    );
    f.check(
      "Restore keeps the session identity",
      twice.snapshot.durable.conversation.sessionId,
      restored.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["failed"],
    );
    f.check(
      "twice terminal outcomes",
      twice.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["failed"],
    );
    f.check("Provider request count", f.requests.length, 1);
    f.check(
      "Recovery is committed exactly once even after reopening twice",
      twice.snapshot.durable.records.filter(({ body }) => body.kind === "recovery").length,
      1,
    );
  },
};

export const interruptedCompletionV1: Scenario = {
  name: "interrupted-completion",
  version: 1,
  group: "persistence",
  purpose:
    "Close during model work and recover a failed terminal turn without resuming external work.",
  source: "packages/core/session/fixtures/persistence.ts#interruptedCompletionV1",
  dependencies: {
    completions: [
      {
        defer: "answer",
        value: {
          kind: "answer",
          text: "Unobserved",
        },
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
    f.action("Wait for 1 requests before the next action.");
    await until(() => f.requests.length === 1);
    f.action("Close root; in-flight work is cancelled, not resumed.");
    await root.close();
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore4 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore4,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["failed"],
    );
    f.check("Provider request count", f.requests.length, 1);
  },
};

export const rejectedAppendV1: Scenario = {
  name: "rejected-append",
  version: 1,
  group: "persistence",
  purpose: "Reject the user-input append; do not admit a turn or call the provider.",
  source: "packages/core/session/fixtures/persistence.ts#rejectedAppendV1",
  dependencies: {
    fault: "reject-input",
    completions: [],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Not accepted' to root.");
    const turn1 = root.input("Not accepted");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is failed", admission1.kind, "failed");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
    );
    f.check("Provider request count", f.requests.length, 0);
  },
};

export const lostAcknowledgementV1: Scenario = {
  name: "lost-acknowledgement",
  version: 1,
  group: "persistence",
  purpose:
    "Lose the acknowledgement of a committed input; reconcile storage and run the model only once.",
  source: "packages/core/session/fixtures/persistence.ts#lostAcknowledgementV1",
  dependencies: {
    fault: "lose-input",
    completions: [
      {
        kind: "answer",
        text: "Only once",
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
    f.check("Provider request count", f.requests.length, 1);
    f.check(
      "Receipt reconciliation does not duplicate the committed turn",
      root.snapshot.durable.conversation.log.length,
      1,
    );
  },
};

export const lostRecoveryAcknowledgementV1: Scenario = {
  name: "lost-recovery-acknowledgement",
  version: 1,
  group: "persistence",
  purpose:
    "Lose the recovery append acknowledgement; reconcile without duplicating the recovered terminal turn.",
  source: "packages/core/session/fixtures/persistence.ts#lostRecoveryAcknowledgementV1",
  dependencies: {
    fault: "lose-recovery",
    completions: [
      {
        defer: "answer",
        value: {
          kind: "answer",
          text: "Unobserved",
        },
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
    f.action("Wait for 1 requests before the next action.");
    await until(() => f.requests.length === 1);
    f.action("Close root; in-flight work is cancelled, not resumed.");
    await root.close();
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore4 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore4,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["failed"],
    );
    f.check("Provider request count", f.requests.length, 1);
  },
};

export const queueRecoveryV2: Scenario = {
  name: "queue-recovery",
  version: 2,
  group: "persistence",
  purpose:
    "Recover an interrupted turn with queued input without silently executing either during restore.",
  source: "packages/core/session/fixtures/persistence.ts#queueRecoveryV2",
  dependencies: {
    format: 2,
    policy: {
      id: "queued@1",
    },
    completions: [
      {
        defer: "first",
        value: {
          kind: "answer",
          text: "Unobserved",
        },
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'First' to root.");
    const turn1 = root.input("First");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    f.action("Wait for 1 requests before the next action.");
    await until(() => f.requests.length === 1);
    f.action("Submit 'Queued' to root.");
    const turn3 = root.input("Queued");
    const admission3 = await turn3.accepted;
    f.record({ op: "input", session: "root", accepted: admission3 });
    f.check("Input admission is accepted", admission3.kind, "accepted");
    f.action("Close root; in-flight work is cancelled, not resumed.");
    await root.close();
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
      [],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["failed"],
    );
    f.check("Provider request count", f.requests.length, 1);
  },
};

export const lostAcknowledgementV2: Scenario = {
  name: "lost-acknowledgement",
  version: 2,
  group: "persistence",
  purpose:
    "Lose the acknowledgement of a committed input; reconcile storage and run the model only once.",
  source: "packages/core/session/fixtures/persistence.ts#lostAcknowledgementV2",
  dependencies: {
    format: 2,
    fault: "lose-input",
    completions: [
      {
        kind: "answer",
        text: "Once",
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
    f.check("Provider request count", f.requests.length, 1);
    f.check(
      "Receipt reconciliation does not duplicate the committed turn",
      root.snapshot.durable.conversation.log.length,
      1,
    );
  },
};

export const permissionInterruptedRecoveryV2: Scenario = {
  name: "permission-interrupted-recovery",
  version: 2,
  group: "persistence",
  purpose: "Close while permission is pending; restore without asking again or running tools.",
  source: "packages/core/session/fixtures/persistence.ts#permissionInterruptedRecoveryV2",
  dependencies: {
    format: 2,
    policy: {
      permissions: "ask",
    },
    permissions: [
      {
        defer: "permission",
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
    f.action("Wait for 1 permissions before the next action.");
    await until(() => f.permissionCount === 1);
    f.action("Close root; in-flight work is cancelled, not resumed.");
    await root.close();
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore4 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore4,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
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

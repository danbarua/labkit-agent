import { createSession, restoreSession } from "../session-runtime.ts";
import { until } from "../test-support.ts";
import type { Scenario } from "./support.ts";

export const plainConversationV1: Scenario = {
  name: "plain-conversation",
  version: 1,
  group: "conversation",
  purpose: "Send two messages, then reopen the saved session without calling the model again.",
  source: "packages/core/session/fixtures/conversation.ts#plainConversationV1",
  dependencies: {
    completions: [
      {
        kind: "answer",
        text: "Hello",
      },
      {
        kind: "answer",
        text: "Again",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Hi' to root.");
    const turn1 = root.input("Hi");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.action("Submit 'Continue' to root.");
    const turn2 = root.input("Continue");
    const admission2 = await turn2.accepted;
    f.record({ op: "input", session: "root", accepted: admission2 });
    f.check("Input admission is accepted", admission2.kind, "accepted");
    const result2 = await turn2.settled;
    f.record({ session: "root", terminal: result2 });
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore3 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore3,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
    f.check(
      "Restoration preserves both messages and answers",
      restored.snapshot.durable.conversation.log,
      root.snapshot.durable.conversation.log,
    );
  },
};

export const systemChangesV1: Scenario = {
  name: "system-changes",
  version: 1,
  group: "conversation",
  purpose:
    "Commit shared instructions before submitting a user message; restore the same instruction version.",
  source: "packages/core/session/fixtures/conversation.ts#systemChangesV1",
  dependencies: {
    completions: [
      {
        kind: "answer",
        text: "Brief",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Update root system; expect accepted.");
    const receipt1 = await root.updateSystem(["First", "Second"]);
    f.check("System update admission", receipt1.kind, "accepted");
    f.record({ op: "system", session: "root", receipt: receipt1 });
    f.action("Submit 'Hi' to root.");
    const turn2 = root.input("Hi");
    const admission2 = await turn2.accepted;
    f.record({ op: "input", session: "root", accepted: admission2 });
    f.check("Input admission is accepted", admission2.kind, "accepted");
    const result2 = await turn2.settled;
    f.record({ session: "root", terminal: result2 });
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore3 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore3,
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
  },
};

export const handoffV1: Scenario = {
  name: "handoff",
  version: 1,
  group: "conversation",
  purpose:
    "Delegate from the primary assistant to a specialist while preserving shared instructions.",
  source: "packages/core/session/fixtures/conversation.ts#handoffV1",
  dependencies: {
    completions: [
      {
        kind: "handoff",
        agent: "b",
        text: "Delegate",
      },
      {
        kind: "answer",
        text: "From B",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Update root system; expect accepted.");
    const receipt1 = await root.updateSystem(["Shared instruction"]);
    f.check("System update admission", receipt1.kind, "accepted");
    f.record({ op: "system", session: "root", receipt: receipt1 });
    f.action("Submit 'Help' to root.");
    const turn2 = root.input("Help");
    const admission2 = await turn2.accepted;
    f.record({ op: "input", session: "root", accepted: admission2 });
    f.check("Input admission is accepted", admission2.kind, "accepted");
    const result2 = await turn2.settled;
    f.record({ session: "root", terminal: result2 });
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore3 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore3,
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

export const exhaustionV1: Scenario = {
  name: "exhaustion",
  version: 1,
  group: "conversation",
  purpose:
    "Stop at the configured model-step allowance instead of executing an unbounded handoff loop.",
  source: "packages/core/session/fixtures/conversation.ts#exhaustionV1",
  dependencies: {
    allowance: 1,
    completions: [
      {
        kind: "handoff",
        agent: "b",
        text: "Delegate",
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
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["exhausted"],
    );
    f.check("Provider request count", f.requests.length, 1);
  },
};

export const bargeInV1: Scenario = {
  name: "barge-in",
  version: 1,
  group: "conversation",
  purpose:
    "Replace in-flight model work with a new user message; ignore the old model result when it arrives.",
  source: "packages/core/session/fixtures/conversation.ts#bargeInV1",
  dependencies: {
    completions: [
      {
        defer: "old",
        value: {
          kind: "answer",
          text: "Late",
        },
      },
      {
        kind: "answer",
        text: "New",
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
    f.action("Submit 'Second' to root.");
    const turn3 = root.input("Second");
    const admission3 = await turn3.accepted;
    f.record({ op: "input", session: "root", accepted: admission3 });
    f.check("Input admission is accepted", admission3.kind, "accepted");
    const result3 = await turn3.settled;
    f.record({ session: "root", terminal: result3 });
    f.action("Release deferred old work.");
    await f.release("old");
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
    f.check(
      "The late answer is absent from committed history",
      JSON.stringify(root.snapshot.durable.conversation.log).includes("Late"),
      false,
    );
  },
};

export const policyPermissionsAllowanceV2: Scenario = {
  name: "policy-permissions-allowance",
  version: 2,
  group: "conversation",
  purpose:
    "Change tool visibility and step allowance at committed boundaries; zero allowance starts no model work.",
  source: "packages/core/session/fixtures/conversation.ts#policyPermissionsAllowanceV2",
  dependencies: {
    format: 2,
    completions: [
      {
        kind: "answer",
        text: "Restricted",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Update root policy; expect accepted.");
    const receipt1 = await root.updatePolicy({
      steps: 1,
      tools: {
        a: [],
      },
    });
    f.check("Policy update admission", receipt1.kind, "accepted");
    f.record({ op: "policy", session: "root", receipt: receipt1 });
    f.action("Submit 'Go' to root.");
    const turn2 = root.input("Go");
    const admission2 = await turn2.accepted;
    f.record({ op: "input", session: "root", accepted: admission2 });
    f.check("Input admission is accepted", admission2.kind, "accepted");
    const result2 = await turn2.settled;
    f.record({ session: "root", terminal: result2 });
    f.action("Update root policy; expect accepted.");
    const receipt3 = await root.updatePolicy({
      steps: 0,
    });
    f.check("Policy update admission", receipt3.kind, "accepted");
    f.record({ op: "policy", session: "root", receipt: receipt3 });
    f.action("Submit 'No allowance' to root.");
    const turn4 = root.input("No allowance");
    const admission4 = await turn4.accepted;
    f.record({ op: "input", session: "root", accepted: admission4 });
    f.check("Input admission is accepted", admission4.kind, "accepted");
    const result4 = await turn4.settled;
    f.record({ session: "root", terminal: result4 });
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
      ["completed", "exhausted"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "exhausted"],
    );
    f.check("Provider request count", f.requests.length, 1);
  },
};

export const queueUserV2: Scenario = {
  name: "queue-user",
  version: 2,
  group: "conversation",
  purpose:
    "Queue a second user input while the first model call is pending; reject a policy change across that queue.",
  source: "packages/core/session/fixtures/conversation.ts#queueUserV2",
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
          text: "First",
        },
      },
      {
        kind: "answer",
        text: "Second",
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
    f.action("Submit 'Second' to root.");
    const turn3 = root.input("Second");
    const admission3 = await turn3.accepted;
    f.record({ op: "input", session: "root", accepted: admission3 });
    f.check("Input admission is accepted", admission3.kind, "accepted");
    f.action("Update root policy; expect busy.");
    const receipt4 = await root.updatePolicy({
      steps: 9,
    });
    f.check("Policy update admission", receipt4.kind, "busy");
    f.record({ op: "policy", session: "root", receipt: receipt4 });
    f.action("Release deferred first work.");
    await f.release("first");
    f.action("Settle the active turn in root.");
    f.record({ session: "root", terminal: await turn3.settled });
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore7 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore7,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
  },
};

export const legacyUpgradeV2: Scenario = {
  name: "legacy-upgrade",
  version: 2,
  group: "conversation",
  purpose:
    "Upgrade a legacy session through a policy update while retaining its existing conversation.",
  source: "packages/core/session/fixtures/conversation.ts#legacyUpgradeV2",
  dependencies: {
    completions: [
      {
        kind: "answer",
        text: "Legacy",
      },
      {
        kind: "answer",
        text: "Version two",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Before' to root.");
    const turn1 = root.input("Before");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.action("Update root policy; expect accepted.");
    const receipt2 = await root.updatePolicy({
      id: "strict@1",
      steps: 2,
    });
    f.check("Policy update admission", receipt2.kind, "accepted");
    f.record({ op: "policy", session: "root", receipt: receipt2 });
    f.action("Submit 'After' to root.");
    const turn3 = root.input("After");
    const admission3 = await turn3.accepted;
    f.record({ op: "input", session: "root", accepted: admission3 });
    f.check("Input admission is accepted", admission3.kind, "accepted");
    const result3 = await turn3.settled;
    f.record({ session: "root", terminal: result3 });
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
      ["completed", "completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
  },
};

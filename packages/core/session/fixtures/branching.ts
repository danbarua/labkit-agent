import { createSession, restoreSession } from "../session-runtime.ts";
import { until } from "../test-support.ts";
import type { Scenario } from "./support.ts";

export const forkV1: Scenario = {
  name: "fork",
  version: 1,
  group: "branching",
  purpose:
    "Create an independent child with inherited conversation context, then change only its instructions.",
  source: "packages/core/session/fixtures/branching.ts#forkV1",
  dependencies: {
    completions: [
      {
        kind: "answer",
        text: "Shared",
      },
      {
        kind: "answer",
        text: "Child",
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
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.action("Fork root into child.");
    const child = f.track("child", await root.fork());
    f.action("Update child system; expect accepted.");
    const receipt3 = await child.updateSystem(["Independent"]);
    f.check("System update admission", receipt3.kind, "accepted");
    f.record({ op: "system", session: "child", receipt: receipt3 });
    f.action("Submit 'Branch' to child.");
    const turn4 = child.input("Branch");
    const admission4 = await turn4.accepted;
    f.record({ op: "input", session: "child", accepted: admission4 });
    f.check("Input admission is accepted", admission4.kind, "accepted");
    const result4 = await turn4.settled;
    f.record({ session: "child", terminal: result4 });
    f.action("Restore child as restored from its journal, without model work.");
    const requestsBeforeRestore5 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), child.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore5,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      child.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check(
      "child terminal outcomes",
      child.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
    f.check(
      "Changing child instructions leaves the parent unchanged",
      root.snapshot.durable.systemInputs,
      [],
    );
    f.check("The child owns its new instructions", child.snapshot.durable.systemInputs, [
      "Independent",
    ]);
  },
};

export const activeTurnForkV1: Scenario = {
  name: "active-turn-fork",
  version: 1,
  group: "branching",
  purpose:
    "Request a fork during an active turn; capture that terminal boundary, excluding the next parent input.",
  source: "packages/core/session/fixtures/branching.ts#activeTurnForkV1",
  dependencies: {
    completions: [
      {
        defer: "answer",
        value: {
          kind: "answer",
          text: "Boundary",
        },
      },
      {
        kind: "answer",
        text: "Parent next",
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
    f.action("Fork root into child.");
    const childPending = root.fork();
    await until(() => root.snapshot.durable.conversation.pending.length > 0);
    f.action("Update root system; expect busy.");
    const receipt4 = await root.updateSystem(["Busy"]);
    f.check("System update admission", receipt4.kind, "busy");
    f.record({ op: "system", session: "root", receipt: receipt4 });
    f.action("Release deferred answer work.");
    await f.release("answer");
    f.action("Settle the active turn in root.");
    f.record({ session: "root", terminal: await turn1.settled });
    f.action("Submit 'Next' to root.");
    const turn7 = root.input("Next");
    const admission7 = await turn7.accepted;
    f.record({ op: "input", session: "root", accepted: admission7 });
    f.check("Input admission is accepted", admission7.kind, "accepted");
    const result7 = await turn7.settled;
    f.record({ session: "root", terminal: result7 });
    f.action("Wait for the queued child branch to publish.");
    const child = f.track("child", await childPending);
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check(
      "child terminal outcomes",
      child.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check("Provider request count", f.requests.length, 2);
    f.check(
      "The queued child excludes the next parent input",
      JSON.stringify(child.snapshot.durable.conversation.log).includes("Next"),
      false,
    );
    f.check(
      "The child captures the completed boundary answer",
      JSON.stringify(child.snapshot.durable.conversation.log).includes("Boundary"),
      true,
    );
  },
};

export const successiveCompactionEmptyResetV1: Scenario = {
  name: "successive-compaction-empty-reset",
  version: 1,
  group: "branching",
  purpose:
    "Replace context through successive child sessions; an empty replacement deliberately resets context.",
  source: "packages/core/session/fixtures/branching.ts#successiveCompactionEmptyResetV1",
  dependencies: {
    completions: [
      {
        kind: "answer",
        text: "Source",
      },
      {
        kind: "answer",
        text: "After compaction",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Original' to root.");
    const turn1 = root.input("Original");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.action("Compact root into compact1.");
    const compact1 = f.track(
      "compact1",
      await root.compact([
        {
          role: "user",
          text: "Summary one",
        },
      ]),
    );
    f.action("Submit 'More' to compact1.");
    const turn3 = compact1.input("More");
    const admission3 = await turn3.accepted;
    f.record({ op: "input", session: "compact1", accepted: admission3 });
    f.check("Input admission is accepted", admission3.kind, "accepted");
    const result3 = await turn3.settled;
    f.record({ session: "compact1", terminal: result3 });
    f.action("Compact compact1 into compact2.");
    const compact2 = f.track(
      "compact2",
      await compact1.compact([
        {
          role: "user",
          text: "Summary two",
        },
      ]),
    );
    f.action("Compact compact2 into reset.");
    const reset = f.track("reset", await compact2.compact([]));
    f.action("Restore reset as restored from its journal, without model work.");
    const requestsBeforeRestore6 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), reset.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore6,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      reset.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check(
      "compact1 terminal outcomes",
      compact1.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check(
      "compact2 terminal outcomes",
      compact2.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
    );
    f.check(
      "reset terminal outcomes",
      reset.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
    );
    f.check("Provider request count", f.requests.length, 2);
    f.check(
      "An empty replacement explicitly clears inherited context",
      reset.snapshot.durable.conversation.context,
      [],
    );
  },
};

export const invalidContextV1: Scenario = {
  name: "invalid-context",
  version: 1,
  group: "branching",
  purpose: "Reject an orphan tool result as compaction context before publishing a child session.",
  source: "packages/core/session/fixtures/branching.ts#invalidContextV1",
  dependencies: {
    completions: [],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Attempt compaction with an orphan tool result.");
    let rejected = false;
    let rejectionReason = "";
    try {
      await root.compact([
        {
          role: "tool",
          callId: "orphan",
          text: "Invalid",
        },
      ]);
    } catch (error) {
      rejected = true;
      rejectionReason = error instanceof Error ? error.message : String(error);
    }
    f.check("Orphan tool context is rejected", rejected, true);
    f.check(
      "The rejection identifies the orphan tool result",
      rejectionReason.includes("orphan"),
      true,
    );
    f.record({ op: "invalid-context", rejected });
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      [],
    );
    f.check("Provider request count", f.requests.length, 0);
  },
};

export const contextPolicyForkV2: Scenario = {
  name: "context-policy-fork",
  version: 2,
  group: "branching",
  purpose:
    "Carry committed policy and instructions into a compacted child, including a subsequent agent handoff.",
  source: "packages/core/session/fixtures/branching.ts#contextPolicyForkV2",
  dependencies: {
    format: 2,
    completions: [
      {
        kind: "answer",
        text: "Ancestor",
      },
      {
        kind: "handoff",
        agent: "b",
        text: "Delegate",
      },
      {
        kind: "answer",
        text: "Child answer",
      },
    ],
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Earlier' to root.");
    const turn1 = root.input("Earlier");
    const admission1 = await turn1.accepted;
    f.record({ op: "input", session: "root", accepted: admission1 });
    f.check("Input admission is accepted", admission1.kind, "accepted");
    const result1 = await turn1.settled;
    f.record({ session: "root", terminal: result1 });
    f.action("Update root policy; expect accepted.");
    const receipt2 = await root.updatePolicy({
      project: "context-only@1",
    });
    f.check("Policy update admission", receipt2.kind, "accepted");
    f.record({ op: "policy", session: "root", receipt: receipt2 });
    f.action("Update root system; expect accepted.");
    const receipt3 = await root.updateSystem(["Shared instruction"]);
    f.check("System update admission", receipt3.kind, "accepted");
    f.record({ op: "system", session: "root", receipt: receipt3 });
    f.action("Compact root into child.");
    const child = f.track(
      "child",
      await root.compact([
        {
          role: "user",
          text: "Summary",
        },
      ]),
    );
    f.action("Submit 'Continue' to child.");
    const turn5 = child.input("Continue");
    const admission5 = await turn5.accepted;
    f.record({ op: "input", session: "child", accepted: admission5 });
    f.check("Input admission is accepted", admission5.kind, "accepted");
    const result5 = await turn5.settled;
    f.record({ session: "child", terminal: result5 });
    f.action("Restore child as restored from its journal, without model work.");
    const requestsBeforeRestore6 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), child.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore6,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      child.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check(
      "child terminal outcomes",
      child.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check("Provider request count", f.requests.length, 3);
  },
};

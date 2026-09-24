import { createSession, restoreSession } from "../session-runtime.ts";
import type { Scenario } from "./support.ts";
import {
  googleThinkingParallelToolsV2Responses,
  markdownAttachmentRestoreForkCompactV2Responses,
  responsesThinkingToolsV2Responses,
  streamAnthropicMessages3V2Responses,
  streamGoogleGenerate3V2Responses,
  streamOpenaiChat2V2Responses,
  streamOpenaiResponses3V2Responses,
  streamTruncatedV2Responses,
  thinkingContinuationBranchesSwitchV2Responses,
  thinkingParityProviderSwitchV2Responses,
} from "./wire-responses.ts";

export const thinkingContinuationBranchesSwitchV2: Scenario = {
  name: "thinking-continuation-branches-switch",
  version: 2,
  group: "providers",
  purpose:
    "Replay owned thinking through tool loops and fork; remove it after compaction or provider switch.",
  source: "packages/core/session/fixtures/providers.ts#thinkingContinuationBranchesSwitchV2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "anthropic-messages@2",
      thinking: "budget",
      maxOutputTokens: 2048,
    },
    completions: thinkingContinuationBranchesSwitchV2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Think and use tools twice' to root.");
    const turn1 = root.input("Think and use tools twice");
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
    f.action("Fork root into fork.");
    const fork = f.track("fork", await root.fork());
    f.action("Submit 'Continue inherited context' to fork.");
    const turn4 = fork.input("Continue inherited context");
    const admission4 = await turn4.accepted;
    f.record({ op: "input", session: "fork", accepted: admission4 });
    f.check("Input admission is accepted", admission4.kind, "accepted");
    const result4 = await turn4.settled;
    f.record({ session: "fork", terminal: result4 });
    f.action("Compact root into compact.");
    const compact = f.track("compact", await root.compact([]));
    f.action("Submit 'Fresh context' to compact.");
    const turn6 = compact.input("Fresh context");
    const admission6 = await turn6.accepted;
    f.record({ op: "input", session: "compact", accepted: admission6 });
    f.check("Input admission is accepted", admission6.kind, "accepted");
    const result6 = await turn6.settled;
    f.record({ session: "compact", terminal: result6 });
    f.action("Update root policy; expect accepted.");
    const receipt7 = await root.updatePolicy({
      provider: "google-generate@1",
      thinking: "off",
    });
    f.check("Policy update admission", receipt7.kind, "accepted");
    f.record({ op: "policy", session: "root", receipt: receipt7 });
    f.action("Submit 'Switch provider' to root.");
    const turn8 = root.input("Switch provider");
    const admission8 = await turn8.accepted;
    f.record({ op: "input", session: "root", accepted: admission8 });
    f.check("Input admission is accepted", admission8.kind, "accepted");
    const result8 = await turn8.settled;
    f.record({ session: "root", terminal: result8 });
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check(
      "fork terminal outcomes",
      fork.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check(
      "compact terminal outcomes",
      compact.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check("Provider request count", f.requests.length, 6);
    f.check(
      "The fork request includes inherited signed thinking",
      JSON.stringify(f.requests[3]).includes("signature-0"),
      true,
    );
    f.check(
      "The compacted request drops old signed thinking",
      JSON.stringify(f.requests[4]).includes("signature-0"),
      false,
    );
    f.check(
      "A provider switch drops foreign signed thinking",
      JSON.stringify(f.requests[5]).includes("signature-0"),
      false,
    );
  },
};

export const markdownAttachmentRestoreForkCompactV2: Scenario = {
  name: "markdown-attachment-restore-fork-compact",
  version: 2,
  group: "providers",
  purpose:
    "Attach a stored Markdown document; reuse its bytes in restored, forked, and replacement contexts.",
  source: "packages/core/session/fixtures/providers.ts#markdownAttachmentRestoreForkCompactV2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "openai-chat@1",
    },
    completions: markdownAttachmentRestoreForkCompactV2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    const design = await f.persistence.putBlob(
      root.snapshot.durable.conversation.sessionId,
      new TextEncoder().encode("# DESIGN\nPinned fixture review document."),
      {
        media: "text/markdown",
        name: "DESIGN.md",
      },
      new AbortController().signal,
    );
    f.action("Submit 'Review this' to root.");
    const turn1 = root.input({ text: "Review this", attachments: [design] });
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
    f.action("Fork root into fork.");
    const fork = f.track("fork", await root.fork());
    f.action("Submit 'Review again' to fork.");
    const turn4 = fork.input("Review again");
    const admission4 = await turn4.accepted;
    f.record({ op: "input", session: "fork", accepted: admission4 });
    f.check("Input admission is accepted", admission4.kind, "accepted");
    const result4 = await turn4.settled;
    f.record({ session: "fork", terminal: result4 });
    f.action("Compact root into compact.");
    const compact = f.track(
      "compact",
      await root.compact([
        {
          role: "user",
          text: "",
          parts: [
            {
              type: "blob",
              ref: {
                id: "b13b3392f0140b08d909e5d982bafba3bf4a188ae3ecd4db2d4116300126c833",
                media: "text/markdown",
                bytes: 40,
                name: "DESIGN.md",
              },
            },
          ],
        },
      ]),
    );
    f.action("Submit 'Review replacement context' to compact.");
    const turn6 = compact.input("Review replacement context");
    const admission6 = await turn6.accepted;
    f.record({ op: "input", session: "compact", accepted: admission6 });
    f.check("Input admission is accepted", admission6.kind, "accepted");
    const result6 = await turn6.settled;
    f.record({ session: "compact", terminal: result6 });
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
    f.check(
      "fork terminal outcomes",
      fork.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed"],
    );
    f.check(
      "compact terminal outcomes",
      compact.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed"],
    );
    f.check("Provider request count", f.requests.length, 3);
  },
};

export const googleThinkingParallelToolsV2: Scenario = {
  name: "google-thinking-parallel-tools",
  version: 2,
  group: "providers",
  purpose:
    "Round-trip Google thought signatures through two rounds of parallel tools and idle restore.",
  source: "packages/core/session/fixtures/providers.ts#googleThinkingParallelToolsV2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "google-generate@2",
      thinking: "budget",
    },
    completions: googleThinkingParallelToolsV2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Think and use tools twice' to root.");
    const turn1 = root.input("Think and use tools twice");
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
    f.check("Provider request count", f.requests.length, 3);
    f.check(
      "The second request echoes the first tool signature",
      JSON.stringify(f.requests[1]).includes("call-sig-0-0"),
      true,
    );
    f.check(
      "The third request preserves the second owner signature",
      JSON.stringify(f.requests[2]).includes("call-sig-1-0"),
      true,
    );
  },
};

export const responsesThinkingToolsV2: Scenario = {
  name: "responses-thinking-tools",
  version: 2,
  group: "providers",
  purpose:
    "Round-trip stateless Responses encrypted reasoning through two tool rounds and idle restore.",
  source: "packages/core/session/fixtures/providers.ts#responsesThinkingToolsV2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "openai-responses@2",
      thinking: "high",
    },
    completions: responsesThinkingToolsV2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Think and use tools twice' to root.");
    const turn1 = root.input("Think and use tools twice");
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
    f.check("Provider request count", f.requests.length, 3);
    f.check(
      "The second request echoes encrypted reasoning bytes",
      JSON.stringify(f.requests[1]).includes("encrypted-0"),
      true,
    );
    f.check(
      "The third request preserves the second reasoning owner",
      JSON.stringify(f.requests[2]).includes("encrypted-1"),
      true,
    );
  },
};

export const thinkingParityProviderSwitchV2: Scenario = {
  name: "thinking-parity-provider-switch",
  version: 2,
  group: "providers",
  purpose:
    "Switch between Google and Responses; inject only continuations belonging to the selected provider.",
  source: "packages/core/session/fixtures/providers.ts#thinkingParityProviderSwitchV2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "google-generate@2",
      thinking: "budget",
    },
    completions: thinkingParityProviderSwitchV2Responses,
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
    f.action("Update root policy; expect accepted.");
    const receipt2 = await root.updatePolicy({
      provider: "openai-responses@2",
      thinking: "high",
    });
    f.check("Policy update admission", receipt2.kind, "accepted");
    f.record({ op: "policy", session: "root", receipt: receipt2 });
    f.action("Submit 'Switch to Responses' to root.");
    const turn3 = root.input("Switch to Responses");
    const admission3 = await turn3.accepted;
    f.record({ op: "input", session: "root", accepted: admission3 });
    f.check("Input admission is accepted", admission3.kind, "accepted");
    const result3 = await turn3.settled;
    f.record({ session: "root", terminal: result3 });
    f.action("Update root policy; expect accepted.");
    const receipt4 = await root.updatePolicy({
      provider: "google-generate@2",
      thinking: "budget",
    });
    f.check("Policy update admission", receipt4.kind, "accepted");
    f.record({ op: "policy", session: "root", receipt: receipt4 });
    f.action("Submit 'Switch back to Google' to root.");
    const turn5 = root.input("Switch back to Google");
    const admission5 = await turn5.accepted;
    f.record({ op: "input", session: "root", accepted: admission5 });
    f.check("Input admission is accepted", admission5.kind, "accepted");
    const result5 = await turn5.settled;
    f.record({ session: "root", terminal: result5 });
    f.action("Restore root as restored from its journal, without model work.");
    const requestsBeforeRestore6 = f.requests.length;
    const restored = f.track(
      "restored",
      await restoreSession(f.restoreOptions(), root.snapshot.durable.conversation.sessionId),
    );
    f.check(
      "Provider request count is unchanged by restore",
      f.requests.length,
      requestsBeforeRestore6,
    );
    f.check(
      "Restore keeps the session identity",
      restored.snapshot.durable.conversation.sessionId,
      root.snapshot.durable.conversation.sessionId,
    );
    f.check(
      "root terminal outcomes",
      root.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed", "completed"],
    );
    f.check(
      "restored terminal outcomes",
      restored.snapshot.durable.conversation.log.map((turn) => turn.outcome.kind),
      ["completed", "completed", "completed"],
    );
    f.check("Provider request count", f.requests.length, 3);
    f.check(
      "Responses never receives a Google signature",
      JSON.stringify(f.requests[1]).includes("google-owned"),
      false,
    );
    f.check(
      "Switching back restores the Google-owned signature",
      JSON.stringify(f.requests[2]).includes("google-owned"),
      true,
    );
    f.check(
      "Google never receives Responses encrypted reasoning",
      JSON.stringify(f.requests[2]).includes("encrypted-0"),
      false,
    );
  },
};

export const streamOpenaiChat2V2: Scenario = {
  name: "stream-openai-chat-2",
  version: 2,
  group: "providers",
  purpose:
    "Assemble an OpenAI Chat stream into tool calls and a final answer before journaling completion.",
  source: "packages/core/session/fixtures/providers.ts#streamOpenaiChat2V2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "openai-chat@2",
      stream: true,
      thinking: "high",
      maxOutputTokens: 2048,
    },
    completions: streamOpenaiChat2V2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Stream and use tools' to root.");
    const turn1 = root.input("Stream and use tools");
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

export const streamAnthropicMessages3V2: Scenario = {
  name: "stream-anthropic-messages-3",
  version: 2,
  group: "providers",
  purpose:
    "Assemble an Anthropic stream with thinking and tools, preserving its continuation for the next request.",
  source: "packages/core/session/fixtures/providers.ts#streamAnthropicMessages3V2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "anthropic-messages@3",
      stream: true,
      thinking: "budget",
      maxOutputTokens: 2048,
    },
    completions: streamAnthropicMessages3V2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Stream and use tools' to root.");
    const turn1 = root.input("Stream and use tools");
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

export const streamGoogleGenerate3V2: Scenario = {
  name: "stream-google-generate-3",
  version: 2,
  group: "providers",
  purpose:
    "Assemble a Google stream with signed tool calls and a final answer before journaling completion.",
  source: "packages/core/session/fixtures/providers.ts#streamGoogleGenerate3V2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "google-generate@3",
      stream: true,
      thinking: "budget",
      maxOutputTokens: 2048,
    },
    completions: streamGoogleGenerate3V2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Stream and use tools' to root.");
    const turn1 = root.input("Stream and use tools");
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

export const streamOpenaiResponses3V2: Scenario = {
  name: "stream-openai-responses-3",
  version: 2,
  group: "providers",
  purpose:
    "Assemble a Responses stream with encrypted reasoning and tools before journaling completion.",
  source: "packages/core/session/fixtures/providers.ts#streamOpenaiResponses3V2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "openai-responses@3",
      stream: true,
      thinking: "high",
      maxOutputTokens: 2048,
    },
    completions: streamOpenaiResponses3V2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Stream and use tools' to root.");
    const turn1 = root.input("Stream and use tools");
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

export const streamTruncatedV2: Scenario = {
  name: "stream-truncated",
  version: 2,
  group: "providers",
  purpose:
    "Reject a stream missing its completion marker; never admit partial text or tools as a completion.",
  source: "packages/core/session/fixtures/providers.ts#streamTruncatedV2",
  dependencies: {
    format: 2,
    providerResponses: true,
    policy: {
      provider: "openai-chat@2",
      stream: true,
    },
    completions: streamTruncatedV2Responses,
  },
  async run(f) {
    f.action("Create the root session using deterministic test dependencies.");
    const root = f.track("root", await createSession(f.options));
    f.action("Submit 'Truncated' to root.");
    const turn1 = root.input("Truncated");
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
    f.check(
      "No partial assistant completion is committed",
      root.snapshot.durable.conversation.log
        .flatMap((turn) => turn.messages)
        .filter((message) => message.role === "assistant").length,
      0,
    );
  },
};

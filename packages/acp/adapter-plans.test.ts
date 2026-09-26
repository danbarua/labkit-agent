import { expect, test } from "@logtape/testing-bun/autoload";

import { until } from "../core/agent/test-support.ts";
import type { PlanEntries } from "./plan.ts";
import { answer, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("plan notifications replace the complete list, clear explicitly, and use the ordinary journaled tool path", async () => {
  const { planTool } = await import("./plan.ts");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const plans: PlanEntries[] = [
    [
      { content: "Inspect files", priority: "high", status: "in_progress" },
      { content: "Summarize", priority: "medium", status: "pending" },
    ],
    [{ content: "Inspect files", priority: "high", status: "completed" }],
    [],
  ];
  let calls = 0;
  const base = setup({
    complete: () =>
      calls < plans.length
        ? {
            kind: "tools",
            text: "Update plan",
            calls: [
              { id: `plan-${calls}`, name: "update_plan", args: { entries: plans[calls++] } },
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
          steps: 5,
          agents: new Map([["a", { model: "m", tools: ["update_plan"] }]]),
        },
        bindings: {
          ...original.bindings,
          tools: new Map([["update_plan", planTool(context.publishPlan!)]]),
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    for (let index = 0; index < plans.length; index++) {
      await until(
        () =>
          h.messages.filter((message) => message.method === "session/request_permission").length >
          index,
      );
      expect(h.updates().filter((message) => message.update.sessionUpdate === "plan")).toHaveLength(
        index,
      );
      const permission = h.messages.filter(
        (message) => message.method === "session/request_permission",
      )[index]!;
      expect(permission.params.toolCall.kind).toBe("think");
      const allow = permission.params.options.find((value: any) => value.kind === "allow_once");
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: allow.optionId } },
      });
    }
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    expect(
      h
        .updates()
        .filter((message) => message.update.sessionUpdate === "plan")
        .map((message) => message.update),
    ).toEqual(plans.map((entries) => ({ sessionUpdate: "plan", entries })));
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(journal)).toContain("Inspect files");
  } finally {
    await h.close();
  }
});

import { expect, test } from "bun:test";
import { createAgentMachine, type AgentContext, type AgentEvent } from "./agent-fsm.ts";

function context(): AgentContext {
	return {
		agent: "writer",
		messages: [],
		pendingTools: [],
		budget: { steps: 3, usd: 1 },
	};
}

async function fire(machine: ReturnType<typeof createAgentMachine>, event: AgentEvent) {
	return machine.fire(event.type, event);
}

test("builds the agent FSM with the fluent state-scoped builder", async () => {
	let started = 0;
	const machine = createAgentMachine(context(), {
		startCompletion: (ctx) => {
			started++;
			return ctx;
		},
	});

	await fire(machine, { type: "user", text: "hello" });

	expect(machine.snapshot.state).toBe("awaiting_model");
	expect(machine.snapshot.ctx.messages).toEqual([{ role: "user", text: "hello" }]);
	expect(started).toBe(1);
});

test("routes model tool calls and completes after all tools settle", async () => {
	const machine = createAgentMachine(context());

	await fire(machine, {
		type: "user",
		text: "hello",
	});
	await fire(machine, {
		type: "model_done",
		toolCalls: [{ id: "1", name: "search", args: {} }],
	});

	expect(machine.snapshot.state).toBe("executing_tools");
	await fire(machine, { type: "tool_done", id: "1", result: "ok" });

	expect(machine.snapshot.state).toBe("awaiting_model");
	expect(machine.snapshot.ctx.pendingTools).toEqual([]);
});

test("treats done as terminal while handoff remains resumable", async () => {
	const machine = createAgentMachine(context());

	await fire(machine, { type: "user", text: "hello" });
	await fire(machine, { type: "model_done", handoff: "reviewer" });

	expect(machine.snapshot.state).toBe("handed_off");
	await fire(machine, { type: "model_done" });

	expect(machine.snapshot.state).toBe("idle");

	const done = createAgentMachine(context());
	await fire(done, { type: "user", text: "hello" });
	await fire(done, { type: "model_done" });

	expect(done.snapshot.state).toBe("done");
	await expect(fire(done, { type: "user", text: "after completion" })).rejects.toThrow(
		"final state",
	);
});

test("finishes active work when it is aborted", async () => {
	const machine = createAgentMachine(context());

	await fire(machine, { type: "user", text: "hello" });
	await fire(machine, { type: "abort" });

	expect(machine.snapshot.state).toBe("done");
});

test("cancels HTTP once when aborting model work", async () => {
	let cancellations = 0;
	const machine = createAgentMachine(context(), {
		cancelHttp: (current) => {
			cancellations++;
			return current;
		},
	});

	await fire(machine, { type: "user", text: "hello" });
	await fire(machine, { type: "abort" });

	expect(cancellations).toBe(1);
});
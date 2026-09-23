import { expect, test } from "bun:test";
import { createAgentMachine, type AgentContext, type AgentMachine } from "./agent-fsm.ts";
import {
	createConversationMachine,
	type ConversationEvent,
} from "./agent-conversation.ts";

function context(): AgentContext {
	return {
		agent: "writer",
		messages: [],
		pendingTools: [],
		budget: { steps: 3, usd: 1 },
	};
}

function createChildFactory(calls: AgentContext[]) {
	return (nextContext: AgentContext): AgentMachine => {
		calls.push(nextContext);
		return createAgentMachine(nextContext);
	};
}

async function fireUser(
	parent: ReturnType<typeof createConversationMachine>,
	text: string,
) {
	return parent.fire({ type: "user", text });
}

async function fireAgent(
	parent: ReturnType<typeof createConversationMachine>,
	event: Extract<ConversationEvent, { type: "agent" }>["event"],
) {
	return parent.fire({ type: "agent", event });
}

test("records a completed turn and replaces the child machine", async () => {
	const factoryCalls: AgentContext[] = [];
	const initialContext = context();
	const parent = createConversationMachine(initialContext, {
		createAgentMachine: createChildFactory(factoryCalls),
	});

	await fireUser(parent, "first");
	await fireAgent(parent, { type: "model_done" });

	expect(parent.snapshot.log).toEqual([
		{
			agent: "writer",
			messages: [{ role: "user", text: "first" }],
			completion: "completed",
		},
	]);
	expect(parent.snapshot.child.snapshot.state).toBe("idle");
	expect(factoryCalls).toHaveLength(2);
});

test("forwards agent events and passes the updated context to the next child", async () => {
	const factoryCalls: AgentContext[] = [];
	const parent = createConversationMachine(context(), {
		createAgentMachine: createChildFactory(factoryCalls),
	});

	await fireUser(parent, "first");
	await fireAgent(parent, { type: "model_done" });

	const firstFactoryCall = factoryCalls[1] ?? (() => {
		throw new Error("expected a replacement factory call");
	})();
	expect(firstFactoryCall).toEqual({
		agent: "writer",
		messages: [],
		pendingTools: [],
		budget: { steps: 3, usd: 1 },
	});
	expect(parent.snapshot.agentContext).toEqual(firstFactoryCall);
});

test("appends a second ordered record without changing the first record", async () => {
	const factoryCalls: AgentContext[] = [];
	const parent = createConversationMachine(context(), {
		createAgentMachine: createChildFactory(factoryCalls),
	});

	await fireUser(parent, "first");
	await fireAgent(parent, { type: "model_done" });
	const firstSnapshot = parent.snapshot;
	const firstRecord = firstSnapshot.log[0] ?? (() => {
		throw new Error("expected a completed turn record");
	})();

	await fireUser(parent, "second");
	await fireAgent(parent, { type: "model_done" });

	expect(parent.snapshot.log).toEqual([
		{
			agent: "writer",
			messages: [{ role: "user", text: "first" }],
			completion: "completed",
		},
		{
			agent: "writer",
			messages: [{ role: "user", text: "second" }],
			completion: "completed",
		},
	]);
	expect(factoryCalls).toHaveLength(3);
	const preservedRecord = firstSnapshot.log[0] ?? (() => {
		throw new Error("expected the first turn record to remain");
	})();
	expect(preservedRecord).toBe(firstRecord);
	expect(firstRecord.messages).toEqual([{ role: "user", text: "first" }]);
});

test("records an aborted active turn", async () => {
	const parent = createConversationMachine(context());

	await fireUser(parent, "first");
	await fireAgent(parent, { type: "abort" });

	expect(parent.snapshot.log.at(-1)).toEqual({
		agent: "writer",
		messages: [{ role: "user", text: "first" }],
		completion: "aborted",
	});
});

test("clears pending tools when replacing an aborted child", async () => {
	const parent = createConversationMachine(context());

	await fireUser(parent, "first");
	await fireAgent(parent, {
		type: "model_done",
		toolCalls: [{ id: "1", name: "search", args: {} }],
	});
	await fireAgent(parent, { type: "abort" });

	expect(parent.snapshot.agentContext.pendingTools).toEqual([]);
});

test("allows the default child factory", () => {
	const parent = createConversationMachine(context());

	expect(parent.snapshot.child.snapshot.state).toBe("idle");
});
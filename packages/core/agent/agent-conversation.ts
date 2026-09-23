import {
	createAgentMachine,
	type AgentContext,
	type AgentEvent,
	type AgentMachine,
} from "./agent-fsm.ts";

export type ConversationEvent =
	| { type: "user"; text: string }
	| { type: "agent"; event: AgentEvent };

export type TurnRecord = Readonly<{
	agent: AgentContext["agent"];
	messages: ReadonlyArray<Readonly<AgentContext["messages"][number]>>;
	completion: "completed" | "aborted";
}>;

export type ConversationActions = {
	createAgentMachine: (nextContext: AgentContext) => AgentMachine;
};

export type ConversationSnapshot = Readonly<{
	child: AgentMachine;
	agentContext: AgentContext;
	log: ReadonlyArray<TurnRecord>;
}>;

export type ConversationMachine = {
	readonly snapshot: ConversationSnapshot;
	fire(event: ConversationEvent): Promise<ConversationSnapshot>;
};

function copyContext(context: AgentContext): AgentContext {
	return {
		...context,
		messages: context.messages.map((message) => ({ ...message })),
		pendingTools: context.pendingTools.map((tool) => ({ ...tool })),
		budget: { ...context.budget },
	};
}

function copyTurn(context: AgentContext, completion: TurnRecord["completion"]): TurnRecord {
	const messages = context.messages.map((message) => Object.freeze({ ...message }));
	return Object.freeze({
		agent: context.agent,
		messages: Object.freeze(messages),
		completion,
	});
}

export function createConversationMachine(
	initialContext: AgentContext,
	actions: Partial<ConversationActions> = {},
): ConversationMachine {
	const createChild = actions.createAgentMachine ?? ((nextContext: AgentContext) => createAgentMachine(nextContext));
	let child = createChild(copyContext(initialContext));
	let log: ReadonlyArray<TurnRecord> = Object.freeze([]);

	const snapshot = (): ConversationSnapshot => ({
		child,
		agentContext: child.snapshot.ctx,
		log,
	});

	return {
		get snapshot() {
			return snapshot();
		},
		async fire(event) {
			if (event.type === "user") {
				await child.fire("user", event);
			} else {
				await child.fire(event.event.type, event.event);
			}

			if (child.snapshot.state === "done") {
				const completion = event.type === "agent" && event.event.type === "abort" ? "aborted" : "completed";
				const nextContext = copyContext(child.snapshot.ctx);
				log = Object.freeze([...log, copyTurn(nextContext, completion)]);
				child = createChild({ ...nextContext, messages: [], pendingTools: [] });
			}

			return snapshot();
		},
	};
}

import { expect, test } from "bun:test";
import { configure } from "./fsm.ts";

type Context = {
	value: number;
	log: string[];
};

test("builds a state-scoped machine and runs lifecycle actions in order", async () => {
	const machine = configure<Context>("idle")
		.state("idle", (state) =>
			state
				.on("start", "running", undefined, (ctx) => ({
					...ctx,
					log: [...ctx.log, "effect"],
				}))
				.onExit((ctx) => ({ ...ctx, log: [...ctx.log, "idle-exit"] })),
		)
		.state("running", (state) =>
			state
				.on("finish", "done")
				.onEntry((ctx) => ({ ...ctx, log: [...ctx.log, "running-entry"] })),
		)
		.final("done")
		.build({ value: 1, log: [] });

	await machine.fire("start");
	await machine.fire("finish");

	expect(machine.snapshot).toEqual({
		state: "done",
		ctx: { value: 1, log: ["idle-exit", "effect", "running-entry"] },
	});
});

test("evaluates guards in order and resolves dynamic targets", async () => {
	const machine = configure<Context>("ready")
		.state("ready", (state) =>
			state
				.on("route", "blocked", () => false)
				.onDynamic("route", (ctx, event: { target: "approved" | "blocked" }) =>
					event.target,
				),
		)
		.final("approved")
		.final("blocked")
		.build({ value: 0, log: [] });

	await machine.fire("route", { target: "approved" });

	expect(machine.snapshot.state).toBe("approved");
});

test("awaits asynchronous guards and actions", async () => {
	const machine = configure<Context>("idle")
		.state("idle", (state) =>
			state.on(
				"start",
				"done",
				async (ctx) => ctx.value === 1,
				async (ctx) => ({ ...ctx, log: [...ctx.log, "effect"] }),
			),
		)
		.final("done", (state) =>
			state.onEntry(async (ctx) => ({ ...ctx, log: [...ctx.log, "entry"] })),
		)
		.build({ value: 1, log: [] });

	await machine.fire("start");

	expect(machine.snapshot.ctx.log).toEqual(["effect", "entry"]);
});

test("rejects firing from a final state", async () => {
	const machine = configure<Context>("done")
		.final("done")
		.build({ value: 0, log: [] });

	await expect(machine.fire("again")).rejects.toThrow("final state");
});

test("validates the initial state and transition targets", () => {
	 expect(() => configure<Context>("missing").state("idle").build({ value: 0, log: [] })).toThrow(
		"Initial state \"missing\" is not declared",
	);

	expect(() =>
		configure<Context>("idle")
			.state("idle", (state) => state.on("start", "missing"))
			.build({ value: 0, log: [] }),
	).toThrow('Transition from "idle" on "start" targets undeclared state "missing"');
});

test("rejects duplicate states and outgoing transitions from final states", () => {
	expect(() =>
		configure<Context>("idle").state("idle").state("idle").build({ value: 0, log: [] }),
	).toThrow('State "idle" is already declared');

	expect(() =>
		configure<Context>("idle")
			.state("idle", (state) => state.on("finish", "done"))
			.final("done", (state) => state.on("again", "idle"))
			.build({ value: 0, log: [] }),
	).toThrow('Final state "done" cannot have outgoing transitions');
});
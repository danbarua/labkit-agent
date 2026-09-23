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
				.on("start", "running", (ctx) => ({
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
				.onIf("route", "blocked", () => false)
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
			state.onIf(
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
test("serializes overlapping events and recovers after a rejected event", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const machine = configure<Context>("ready")
    .state("ready", state => state.internal("add", async ctx => {
      if (ctx.value === 0) await gate;
      return { ...ctx, value: ctx.value + 1 };
    }))
    .build({ value: 0, log: [] });
  const first = machine.fire("add");
  const illegal = machine.fire("missing");
  const second = machine.fire("add");
  const results = Promise.allSettled([first, illegal, second]);
  release();
  expect((await results).map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(machine.snapshot.ctx.value).toBe(2);
});

test("internal transitions skip lifecycle actions while self targets reenter", async () => {
  const machine = configure<Context>("ready")
    .state("ready", state => state
      .onEntry(ctx => ({ ...ctx, log: [...ctx.log, "entry"] }))
      .onExit(ctx => ({ ...ctx, log: [...ctx.log, "exit"] }))
      .internal("update", ctx => ({ ...ctx, log: [...ctx.log, "internal"] }))
      .on("restart", "ready", ctx => ({ ...ctx, log: [...ctx.log, "effect"] })))
    .build({ value: 0, log: [] });
  await machine.fire("update");
  expect(machine.snapshot.ctx.log).toEqual(["internal"]);
  await machine.fire("restart");
  expect(machine.snapshot.ctx.log).toEqual(["internal", "exit", "effect", "entry"]);
});

for (const failure of ["exit", "effect", "entry"] as const) {
  test(`a failed ${failure} rejects fire and preserves the documented partial snapshot`, async () => {
    const action = (step: typeof failure) => async (ctx: Context) => {
      if (step === failure) throw new Error(`${step} failed`);
      return { ...ctx, log: [...ctx.log, step] };
    };
    const machine = configure<Context>("source")
      .state("source", state => state.onExit(action("exit"))
        .on("go", "target", action("effect")).internal("inspect"))
      .state("target", state => state.onEntry(action("entry")).internal("inspect"))
      .build({ value: 0, log: [] });
    await expect(machine.fire("go")).rejects.toThrow(`${failure} failed`);
    const expected = {
      state: failure === "entry" ? "target" : "source",
      ctx: { value: 0, log: failure === "exit" ? [] : failure === "effect" ? ["exit"] : ["exit", "effect"] },
    };
    expect(machine.snapshot).toEqual(expected);
    expect(await machine.fire("inspect")).toEqual(expected);
  });
}

import { expect, test } from "bun:test";
import { z } from "zod";
import { createOperationActor } from "./operation-actor.ts";
import { ref, type Result } from "./types.ts";
import { deferred, until } from "./test-support.ts";

test("input validation, execution and output validation are distinct actor states", async () => {
  const input = deferred<string>(), operation = deferred<unknown>(), output = deferred<number>();
  const outcomes: Result<number>[] = [];
  const actor = createOperationActor(ref("completion", "test/request"), { input: "raw", parseInput: () => input.promise, run: () => operation.promise, parseOutput: () => output.promise }, result => outcomes.push(result));
  await actor.start();
  expect(actor.snapshot.status).toBe("validating_input");
  input.resolve("parsed");
  await until(() => actor.snapshot.status === "running");
  expect(actor.snapshot).toEqual({ status: "running", request: ref("completion", "test/request") });
  operation.resolve(42);
  await until(() => actor.snapshot.status === "validating_output");
  output.resolve(42);
  await until(() => actor.snapshot.status === "succeeded");
  expect(outcomes).toEqual([{ kind: "succeeded", value: 42 }]);
  await actor.cancel();
  expect(outcomes).toHaveLength(1);
});

for (const stage of ["input", "run", "output"] as const) {
  test(`${stage} failure becomes a terminal actor outcome`, async () => {
    const results: Result<string>[] = [];
    const actor = createOperationActor(ref("completion", "test/request"), {
      input: "input", parseInput: value => { if (stage === "input") throw new Error("invalid input"); return z.string().parse(value); },
      run: () => { if (stage === "run") throw new Error("I/O failed"); return "result"; },
      parseOutput: value => { if (stage === "output") throw new Error("invalid output"); return z.string().parse(value); },
    }, result => results.push(result));
    await actor.start();
    await until(() => actor.snapshot.status === "failed");
    expect(results[0]?.kind).toBe("failed");
    expect(actor.snapshot).not.toHaveProperty("value");
  });
}

test("cancellation during asynchronous validation prevents execution", async () => {
  const validation = deferred<string>();
  let executions = 0;
  const outcomes: Result<string>[] = [];
  const actor = createOperationActor(ref("completion", "test/request"), { input: "", parseInput: () => validation.promise,
    run: () => { executions++; return "ok"; }, parseOutput: z.string().parse,
  }, result => outcomes.push(result));
  await actor.start();
  await actor.cancel();
  validation.resolve("valid");
  await Bun.sleep(1);
  expect(executions).toBe(0);
  expect(outcomes).toEqual([{ kind: "cancelled" }]);
});

test("cancels actual work once and ignores a late adapter result", async () => {
  const response = deferred<string>();
  let signal!: AbortSignal, aborts = 0;
  const outcomes: Result<string>[] = [];
  const actor = createOperationActor(ref("completion", "test/request"), { input: "", parseInput: z.string().parse,
    run: (_, current) => { signal = current; signal.addEventListener("abort", () => aborts++); return response.promise; }, parseOutput: z.string().parse,
  }, result => outcomes.push(result));
  await actor.start();
  await until(() => Boolean(signal));
  await actor.cancel();
  await actor.cancel();
  response.resolve("too late");
  await Bun.sleep(1);
  expect(aborts).toBe(1);
  expect(outcomes).toEqual([{ kind: "cancelled" }]);
  expect(actor.snapshot).toEqual({ status: "cancelled" });
});

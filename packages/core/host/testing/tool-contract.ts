import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createOperationActor } from "../../agent/operation-actor.ts";
import { ref, type Result } from "../../agent/types.ts";
import { deferred, until } from "../../agent/test-support.ts";
import type { Tool } from "../ports.ts";

/** Factory supplies a tool accepting {text:string}; execution is always behind input validation. */
export function toolContract(name: string, factory: (run: Tool["run"]) => Tool) {
  describe(name, () => {
    function execute(tool: Tool, input: unknown) {
      const result = deferred<Result<unknown>>();
      const actor = createOperationActor(
        ref("tool", "contract/tool"),
        {
          input,
          parseInput: tool.parseInput,
          run: tool.run,
          parseOutput: (value) => z.json().parse(value),
        },
        result.resolve,
      );
      void actor.start();
      return { actor, result: result.promise };
    }
    test("invalid inputs never invoke execution", async () => {
      let calls = 0;
      const tool = factory(() => {
        calls++;
        return "done";
      });
      expect((await execute(tool, { text: 42 }).result).kind).toBe("failed");
      expect(calls).toBe(0);
      expect((await execute(tool, { text: "ok" }).result).kind).toBe("succeeded");
      expect(calls).toBe(1);
    });
    test("execution errors and non-JSON outputs are failed results", async () => {
      expect(
        (
          await execute(
            factory(() => {
              throw new Error("broken");
            }),
            { text: "ok" },
          ).result
        ).kind,
      ).toBe("failed");
      expect(
        (
          await execute(
            factory(() => Symbol("invalid")),
            { text: "ok" },
          ).result
        ).kind,
      ).toBe("failed");
    });
    test("independent tool cancellation cannot settle another operation", async () => {
      const pending = deferred<string>();
      const signals: AbortSignal[] = [];
      const tool = factory((_, signal) => {
        signals.push(signal);
        return pending.promise;
      });
      const first = execute(tool, { text: "a" });
      const second = execute(tool, { text: "b" });
      await until(() => signals.length === 2);
      await first.actor.cancel();
      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);
      pending.resolve("done");
      expect((await first.result).kind).toBe("cancelled");
      expect((await second.result).kind).toBe("succeeded");
    });
  });
}

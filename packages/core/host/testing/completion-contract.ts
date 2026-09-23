import { describe, expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../../agent/agent.ts";
import { createOperationActor } from "../../agent/operation-actor.ts";
import { deferred, until } from "../../agent/test-support.ts";
import { CompletionSchema, ref, type Result } from "../../agent/types.ts";
import type { CompletionPort } from "../ports.ts";

/** Factory binds a scripted completion source. Validation and cancellation are host guarantees. */
export function completionContract(
  name: string,
  factory: (source: CompletionPort) => CompletionPort,
) {
  describe(name, () => {
    const request = PreparedModelSchema.parse({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    });
    function execute(port: CompletionPort) {
      const result = deferred<Result<unknown>>();
      const actor = createOperationActor(
        ref("completion", "contract/completion"),
        {
          input: request,
          parseInput: PreparedModelSchema.parse,
          run: port,
          parseOutput: CompletionSchema.parse,
        },
        result.resolve,
      );
      void actor.start();
      return { actor, result: result.promise };
    }
    test("passes the validated request and signal; validates settled output", async () => {
      const operation = execute(
        factory((received, signal) => {
          expect(received).toEqual(request);
          expect(signal.aborted).toBe(false);
          return { kind: "answer", text: "done" };
        }),
      );
      expect(await operation.result).toMatchObject({
        kind: "succeeded",
        value: { kind: "answer", text: "done" },
      });
    });
    test("malformed output and thrown failures cannot become success", async () => {
      expect(await execute(factory(() => ({ invalid: true }))).result).toMatchObject({
        kind: "failed",
      });
      expect(
        await execute(
          factory(() => {
            throw new Error("offline");
          }),
        ).result,
      ).toMatchObject({ kind: "failed", error: { message: "offline" } });
    });
    test("cancellation signals the adapter and ignores a late success", async () => {
      const pending = deferred<unknown>();
      let signal: AbortSignal | undefined;
      const operation = execute(
        factory((_, supplied) => {
          signal = supplied;
          return pending.promise;
        }),
      );
      await until(() => Boolean(signal));
      await operation.actor.cancel();
      expect(signal!.aborted).toBe(true);
      expect(await operation.result).toEqual({ kind: "cancelled" });
      pending.resolve({ kind: "answer", text: "late" });
      await pending.promise;
      expect(operation.actor.snapshot.status).toBe("cancelled");
    });
  });
}

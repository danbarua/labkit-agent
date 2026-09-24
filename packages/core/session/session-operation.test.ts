import { expect, test } from "@logtape/testing-bun/autoload";

import { SessionIdSchema } from "../agent/types.ts";
import { AppendIdSchema, INITIAL_REVISION } from "./persistence.ts";
import { appendOperation, loadOperation } from "./session-operation.ts";
import { deferred, until } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

const sessionId = SessionIdSchema.parse("00000000-0000-4000-8000-000000000001");
const request = {
  sessionId,
  expectedRevision: INITIAL_REVISION,
  appendId: AppendIdSchema.parse("a"),
  records: ["one"],
};
test("append cancellation retains the actual committed outcome after a delayed receipt", async () => {
  const port = createMemoryPersistence();
  const release = deferred<void>();
  let invoked = false;
  const actor = appendOperation(
    {
      ...port,
      async append(request, signal) {
        const result = await port.append(request, signal);
        invoked = true;
        await release.promise;
        return result;
      },
    },
    request,
  );
  await actor.start();
  await until(() => invoked);
  await actor.cancel();
  expect(actor.snapshot.status).toBe("running");
  release.resolve();
  expect((await actor.result).kind).toBe("committed");
  expect(actor.snapshot.ref.kind).toBe("append");
});
test("thrown append errors are indeterminate; load failures remain typed", async () => {
  const port = createMemoryPersistence();
  const actor = appendOperation(
    {
      ...port,
      async append() {
        throw new Error("Lost connection");
      },
    },
    request,
  );
  await actor.start();
  expect(await actor.result).toMatchObject({
    kind: "indeterminate",
    message: "Lost connection",
    error: { operation: { kind: "append", id: "a" }, cause: { message: "Lost connection" } },
  });
  const load = loadOperation(
    {
      ...port,
      async load() {
        throw new Error("offline");
      },
    },
    sessionId,
  );
  await load.start();
  expect(await load.result).toMatchObject({
    kind: "failed",
    message: "offline",
    error: { operation: { kind: "load" }, cause: { message: "offline" } },
  });
});
test("cancel before start is known uncommitted only when the adapter certifies it", async () => {
  const actor = appendOperation(createMemoryPersistence(), request);
  await actor.cancel();
  await actor.start();
  expect((await actor.result).kind).toBe("rejected");
});

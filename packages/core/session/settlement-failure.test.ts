import { expect, test } from "@logtape/testing-bun/autoload";

import { failure } from "../agent/types.ts";
import { createProviderCapture } from "../environment/provider-capture.ts";
import { withFixtureDiagnostics } from "../logging/fixture-capture.ts";
import { createSession } from "./index.ts";
import { RevisionSchema } from "./persistence.ts";
import { testOptions } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

for (const mode of ["rejected", "conflict", "load-failure", "uncertain"] as const) {
  test(`public settlement preserves ${mode} storage identity and cause without journal inspection`, async () => {
    const capture = await createProviderCapture(".session-artifacts/settlement-failure");
    await withFixtureDiagnostics(capture.directory, { runId: capture.runId, mode }, async () => {
      const port = createMemoryPersistence();
      let completions = 0;
      let attempts = 0;
      let failedAppendId = "";
      const session = await createSession(
        testOptions({
          complete: () => {
            completions++;
            return { kind: "answer", text: "Unexpected" };
          },
          persistence: {
            ...port,
            async append(request, signal) {
              if (request.expectedRevision === 0) return port.append(request, signal);
              attempts++;
              failedAppendId = request.appendId;
              if (mode === "conflict")
                return { kind: "conflict", revision: RevisionSchema.parse(99) };
              const cause = Object.assign(
                new Error("Disk refused input journal append", {
                  cause: new Error("Volume quota exceeded"),
                }),
                { code: "EDQUOT", path: "/session-store/journal" },
              );
              if (mode === "rejected")
                return { kind: "rejected", message: cause.message, error: failure(cause) };
              throw cause;
            },
            async load(id, signal) {
              if (mode === "load-failure")
                throw Object.assign(new Error("Cannot read journal for reconciliation"), {
                  code: "EIO",
                });
              return port.load(id, signal);
            },
          },
        }),
      );
      try {
        const command = session.input("Start review");
        const receipt = await command.accepted;
        const result = await command.settled;
        expect(result.kind).toBe("failed");
        if (result.kind !== "failed") throw new Error("Expected failure");
        expect(receipt).toMatchObject({ kind: "failed", error: result.error });
        expect(result.error).toMatchObject({
          classification: "persistence",
          operation: {
            sessionId: session.snapshot.durable.conversation.sessionId,
            kind: mode === "load-failure" ? "load" : "append",
          },
        });
        if (mode === "load-failure") {
          expect(result.error.cause).toMatchObject({ code: "EIO" });
          expect(result.error.details).toMatchObject({
            appendId: failedAppendId,
            precedingFailure: { cause: { code: "EDQUOT" } },
          });
        } else {
          expect(result.error.operation?.id).toBe(failedAppendId);
          if (mode === "rejected")
            expect(result.error.cause).toMatchObject({
              code: "EDQUOT",
              cause: { message: "Volume quota exceeded" },
            });
          if (mode === "conflict")
            expect(result.error.details).toMatchObject({ observed: { actualRevision: 99 } });
          if (mode === "uncertain")
            expect(result.error.details).toMatchObject({
              attempts: 2,
              precedingFailure: { cause: { code: "EDQUOT" } },
            });
        }
        expect(completions).toBe(0);
        expect(attempts).toBe(mode === "uncertain" ? 2 : 1);
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        expect(await session.input("Cannot continue").settled).toMatchObject({
          error: result.error,
        });
        await Bun.write(`${capture.directory}/settlement.json`, JSON.stringify(result, null, 2));
      } finally {
        await session.close();
      }
    });
    const records = (await Bun.file(`${capture.directory}/diagnostics.jsonl`).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      records.some(
        (record) =>
          record.event === "submission.receipt" &&
          record.level === "error" &&
          record.error.operation,
      ),
    ).toBe(true);
  });
}

test("admission failure identifies the rejected input and leaves the session usable", async () => {
  const session = await createSession(testOptions());
  try {
    const receipt = await session.updatePolicy({ project: "missing@1" });
    expect(receipt).toMatchObject({
      kind: "failed",
      error: {
        classification: "admission",
        operation: { kind: "admission" },
        phase: "stage",
        details: { inputKind: "policy" },
      },
    });
    expect(session.snapshot.status).toBe("ready");
    expect(await session.input("Continue").settled).toMatchObject({ kind: "terminal" });
  } finally {
    await session.close();
  }
});

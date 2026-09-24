import { resolve } from "node:path";

import { expect, test } from "@logtape/testing-bun/autoload";

import { deferred } from "../session/test-support.ts";
import { createProviderCapture } from "./provider-capture.ts";

test("actual HTTP request and partial response survive SIGKILL without shutdown or flush", async () => {
  const partial = 'data: {"choices":[{"index":0,"delta":{"content":"partial evidence"}}]}\n\n';
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(partial));
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "x-request-id": "crashed-stream-request",
          },
        },
      );
    },
  });
  const ready = deferred<{ directory: string; runId: string; httpRequestId: string }>();
  const root = resolve(".session-artifacts/process-failure");
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "testing/capture-process.ts"),
      root,
      `http://127.0.0.1:${server.port}/v1`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      ipc(message) {
        ready.resolve(message);
      },
    },
  );
  const stderr = new Response(child.stderr).text();
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const evidence = await Promise.race([
      ready.promise,
      child.exited.then(async (code) => {
        throw new Error(
          `Capture child exited before retaining evidence (${code}): ${await stderr}`,
        );
      }),
    ]);
    child.kill("SIGKILL");
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(requests).toBe(1);
    const manifestText = await Bun.file(`${evidence.directory}/manifest.json`).text();
    const manifest = JSON.parse(manifestText);
    expect(manifest.runId).toBe(evidence.runId);
    expect(manifest.calls).toHaveLength(1);
    const call = manifest.calls[0];
    expect(call).toMatchObject({
      evidence: "actual_http",
      model: "crash-model",
      httpStatus: 200,
      providerRequestId: "crashed-stream-request",
      httpRequestId: evidence.httpRequestId,
    });
    expect(call.sessionId).toBeString();
    expect(call.turnId).toBeString();
    expect(call.childId).toBeString();
    expect(call.outcome).not.toBe("succeeded");
    expect(await Bun.file(`${evidence.directory}/${call.responseFile}`).text()).toBe(partial);
    const request = await Bun.file(`${evidence.directory}/${call.requestFile}`).text();
    expect(JSON.parse(request)).toMatchObject({ model: "crash-model", stream: true });
    expect(request).toContain("Retain this request");
    expect(manifestText + request + partial).not.toContain("CRASH_CAPTURE_SECRET");
    expect(await Bun.file(`${evidence.directory}/README.md`).text()).toContain(call.responseFile);
    const logs = await Bun.file(`${evidence.directory}/diagnostics.jsonl`).text();
    expect(logs).toContain(call.childId);
    expect(logs).not.toContain('"event":"turn.settled"');
    const nextRun = await createProviderCapture(root);
    expect(nextRun.directory).not.toBe(evidence.directory);
    expect(await Bun.file(`${evidence.directory}/manifest.json`).text()).toBe(manifestText);
    await Bun.write(
      `${evidence.directory}/process-outcome.json`,
      JSON.stringify(
        { signal: child.signalCode, requests, flushedOnShutdown: false, runId: evidence.runId },
        null,
        2,
      ),
    );
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    server.stop(true);
  }
}, 10000);

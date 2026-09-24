import { AsyncLocalStorage } from "node:async_hooks";

import { configure } from "@logtape/logtape";

import { withFixtureDiagnostics } from "../../logging/fixture-capture.ts";
import { openaiChatV2 } from "../../providers/index.ts";
import { createSession } from "../../session/index.ts";
import { createMemoryPersistence } from "../../session/testing/memory-persistence.ts";
import { createProviderCapture } from "../provider-capture.ts";

const [root, baseUrl] = process.argv.slice(2);
if (!root || !baseUrl) throw new Error("Capture process requires artifact root and local endpoint");
await configure({ contextLocalStorage: new AsyncLocalStorage(), sinks: {}, loggers: [] });
const run = await createProviderCapture(root);
await withFixtureDiagnostics(run.directory, { runId: run.runId }, async () => {
  const session = await createSession({
    persistence: createMemoryPersistence(),
    configuration: {
      agent: "reviewer",
      agents: new Map([["reviewer", { model: "crash-model" }]]),
      steps: 2,
      policy: { provider: "scripted-http", model: "crash-model", stream: true },
    },
    bindings: {
      providers: new Map([
        [
          "scripted-http",
          {
            profile: openaiChatV2,
            transport: {
              baseUrl,
              headers: { Authorization: "Bearer CRASH_CAPTURE_SECRET" },
              async capture(event) {
                await run.capture(event);
                if (
                  event.kind === "http_response" &&
                  typeof event.body === "string" &&
                  event.body.includes("partial evidence")
                ) {
                  process.send?.({
                    directory: run.directory,
                    runId: run.runId,
                    httpRequestId: event.httpRequestId,
                  });
                }
              },
            },
          },
        ],
      ]),
    },
  });
  await session.input("Retain this request if the process stops").settled;
  throw new Error(
    "The incomplete HTTP stream must remain active until the parent kills this process",
  );
});

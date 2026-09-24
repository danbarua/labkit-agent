import { z } from "zod";

import {
  createSession,
  defineTool,
  type CompletionPortRequest,
  type CompletionPortResponse,
} from "../index.ts";
import { createMemoryPersistence } from "../testing/memory-persistence.ts";

/** Executable scripted binding: these are port invocations, not HTTP requests. */
export async function completionBindingExample() {
  const requests: CompletionPortRequest[] = [];
  const responses: CompletionPortResponse[] = [];
  const session = await createSession({
    persistence: createMemoryPersistence(),
    configuration: {
      agent: "reviewer",
      agents: new Map([["reviewer", { model: "scripted", tools: ["extract"] }]]),
      steps: 3,
    },
    bindings: {
      tools: new Map([
        [
          "extract",
          defineTool({
            input: z.object({ document: z.string() }),
            run: ({ document }) => ({ claim: document }),
          }),
        ],
      ]),
      complete(request) {
        requests.push(request);
        const response: CompletionPortResponse =
          requests.length === 1
            ? {
                completion: {
                  kind: "tools",
                  text: "Extracting",
                  calls: [{ id: "call-1", name: "extract", args: { document: "A claim" } }],
                },
              }
            : { completion: { kind: "answer", text: "Reviewed the extracted claim" } };
        responses.push(response);
        return response;
      },
    },
  });
  try {
    const result = await session.input("Review the document").settled;
    return { evidence: "scripted_completion_port", requests, responses, result };
  } finally {
    await session.close();
  }
}

if (import.meta.main) console.log(JSON.stringify(await completionBindingExample(), null, 2));

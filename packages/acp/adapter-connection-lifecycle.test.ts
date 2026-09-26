import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { SessionOptions } from "@labkit-agent/core";
import { expect, test } from "@logtape/testing-bun/autoload";

import { deferred, until } from "../core/agent/test-support.ts";
import { connectAcp } from "./adapter.ts";
import { answer, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";
import type { Message as HarnessMessage } from "./testing/harness.ts";

type Message = HarnessMessage;
test("disconnect does not wait for an unresolved options factory and late resolution starts no session", async () => {
  const pending = deferred<SessionOptions>();
  let signal: AbortSignal | undefined;
  let appends = 0;
  const { options, persistence } = setup();
  const h = harness({
    sessionOptions: (context) => {
      signal = context.signal;
      return pending.promise;
    },
  });
  await h.initialize();
  await h.start("session/new", { cwd: "/tmp", mcpServers: [] });
  await until(() => !!signal);
  await h.disconnect();
  expect(signal?.aborted).toBe(true);
  const bound = await options.sessionOptions({ cwd: "/tmp", signal: new AbortController().signal });
  pending.resolve({
    ...bound,
    persistence: {
      ...persistence,
      append: (request, value) => {
        appends++;
        return persistence.append(request, value);
      },
    },
  });
  await Bun.sleep(5);
  expect(appends).toBe(0);
});

test("output failure closes owned runtimes and cancels pending provider work", async () => {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  const frames: Message[] = [];
  let failOutput = false;
  const output = new WritableStream<Uint8Array>({
    write(bytes) {
      if (failOutput) throw new Error("Broken stdout");
      frames.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
  });
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const { options } = setup({
    complete: (_, value) => {
      signal = value;
      return pending.promise;
    },
  });
  const h = connectAcp(ndJsonStream(output, input.readable), options);
  const send = (message: unknown) =>
    writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await until(() => frames.some((f) => f.id === 1));
  await send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/tmp", mcpServers: [] },
  });
  await until(() => frames.some((f) => f.id === 2));
  const id = frames.find((f) => f.id === 2)!.result.sessionId;
  await send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: prompt(id) });
  await until(() => !!signal);
  failOutput = true;
  // Force a response write while the provider is still running.
  await send({ jsonrpc: "2.0", id: 4, method: "unknown", params: {} });
  await h.closed;
  expect(signal?.aborted).toBe(true);
  pending.resolve(answer);
});

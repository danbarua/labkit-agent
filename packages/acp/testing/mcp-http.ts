/** Local HTTP/SSE peer for real SDK transport tests; no outbound network or provider calls. */
export function mcpHttpFixture(
  type: "http" | "sse",
  options: { unauthorized?: boolean; redirect?: string; hang?: boolean } = {},
) {
  const events: { method: string; authorized: boolean }[] = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let deleted = 0;
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encode = (event: string, value: string) =>
    new TextEncoder().encode(`event: ${event}\ndata: ${value}\n\n`);
  const message = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
  function reply(body: any) {
    if (body.method === "initialize")
      return message(body.id, {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "remote-fixture", version: "1" },
      });
    if (body.method === "tools/list")
      return message(body.id, {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          { name: "slow", inputSchema: { type: "object" } },
        ],
      });
    if (body.method === "tools/call" && body.params.name === "echo")
      return message(body.id, { content: [{ type: "text", text: body.params.arguments.text }] });
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const authorized =
        request.headers.get("Authorization") === "Bearer mcp-test-secret" &&
        request.headers.get("X-Trace") === "trace";
      if (options.redirect) return Response.redirect(options.redirect, 307);
      if (!authorized || options.unauthorized) {
        events.push({ method: request.method, authorized: false });
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.method === "DELETE") {
        events.push({ method: "DELETE", authorized });
        deleted++;
        for (const stream of streams) {
          try {
            stream.close();
          } catch {}
        }
        streams.clear();
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        events.push({ method: "GET", authorized });
        if (type === "http") return new Response(null, { status: 405 });
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream({
            start(value) {
              controller = value;
              streams.add(value);
              sse = value;
              if (!options.hang) value.enqueue(encode("endpoint", "/message"));
            },
            cancel() {
              streams.delete(controller);
            },
          }),
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
        );
      }
      const body = (await request.json()) as any;
      events.push({ method: body.method, authorized });
      const output = reply(body);
      if (type === "sse") {
        if (output) sse!.enqueue(encode("message", JSON.stringify(output)));
        return new Response(null, { status: 202 });
      }
      if (!output && body.id !== undefined) {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream({
            start(value) {
              controller = value;
              streams.add(value);
            },
            cancel() {
              streams.delete(controller);
            },
          }),
          { headers: { "Content-Type": "text/event-stream", "mcp-session-id": "fixture-session" } },
        );
      }
      return output
        ? Response.json(output, { headers: { "mcp-session-id": "fixture-session" } })
        : new Response(null, { status: 202 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/${type === "sse" ? "sse" : "mcp"}`,
    headers: [
      { name: "Authorization", value: "Bearer mcp-test-secret" },
      { name: "X-Trace", value: "trace" },
    ],
    events,
    get deleted() {
      return deleted;
    },
    get streams() {
      return streams.size;
    },
    async close() {
      for (const stream of streams) {
        try {
          stream.close();
        } catch {}
      }
      streams.clear();
      await server.stop(true);
    },
  };
}

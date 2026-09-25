// Real stdio fixture: no provider calls or user filesystem tools.
import { appendFileSync, writeFileSync } from "node:fs";

const log = (event: unknown) => {
  if (process.env.MCP_TEST_LOG)
    appendFileSync(process.env.MCP_TEST_LOG, `${JSON.stringify(event)}\n`);
};
if (process.env.MCP_TEST_PID) writeFileSync(process.env.MCP_TEST_PID, String(process.pid));
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id: unknown, value: unknown) => send({ jsonrpc: "2.0", id, result: value });
const schema = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1 },
    pair: {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      minItems: 2,
      maxItems: 2,
    },
  },
  required: ["text"],
  additionalProperties: false,
};
let buffer = "";
for await (const bytes of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(bytes);
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    log({ method: request.method, name: request.params?.name });
    if (request.id === "roots-check" && request.result)
      log({ method: "roots-result", roots: request.result.roots });
    if (request.method === "notifications/initialized")
      send({ jsonrpc: "2.0", id: "roots-check", method: "roots/list", params: {} });
    if (request.method === "initialize") {
      if (process.env.MCP_TEST_MODE !== "hang")
        result(request.id, {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
    } else if (request.method === "tools/list") {
      if (process.env.MCP_TEST_MODE === "repeat")
        result(request.id, { tools: [], nextCursor: "repeat" });
      else if (request.params?.cursor)
        result(request.id, {
          tools: [{ name: "slow", inputSchema: schema, annotations: { readOnlyHint: true } }],
        });
      else
        result(request.id, {
          tools: [
            {
              name: "echo",
              description: "Echo typed arguments",
              inputSchema: schema,
              annotations: { readOnlyHint: true },
            },
          ],
          nextCursor: "second",
        });
    } else if (request.method === "tools/call") {
      if (request.params.name === "slow") continue;
      if (request.params.arguments.text === "credential-error")
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32042,
            message: `Upstream rejected credential ${process.env.MCP_TEST_TOKEN}`,
            data: {
              status: 401,
              upstreamRequestId: "upstream-request-42",
              detail: `Credential ${process.env.MCP_TEST_TOKEN} expired`,
            },
          },
        });
      else if (request.params.arguments.text === "error")
        result(request.id, {
          isError: true,
          content: [{ type: "text", text: "fixture tool error" }],
        });
      // The process dies mid-call, as a crashed server would: the call fails at the transport.
      else if (request.params.arguments.text === "drop") process.exit(1);
      else if (request.params.arguments.text === "binary")
        result(request.id, { content: [{ type: "image", mimeType: "image/png", data: "AA==" }] });
      else
        result(request.id, {
          content: [{ type: "text", text: request.params.arguments.text }],
          structuredContent: {
            cwd: process.cwd(),
            tokenPresent: !!process.env.MCP_TEST_TOKEN,
            providerKeyPresent: !!process.env.ANTHROPIC_API_KEY,
          },
        });
    }
  }
}
log({ method: "closed" });

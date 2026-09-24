import { pathToFileURL } from "node:url";

import type { McpServer } from "@agentclientprotocol/sdk";
import type { Tool } from "@labkit-agent/core/host";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import { mcpTransport, validateMcpTransport } from "./mcp-transport.ts";
import { waitForBoundary } from "./session-config.ts";

const MAX_TOOLS = 256;
const MAX_BYTES = 256 * 1024;
class SchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const version = typeof schema.$schema === "string" ? schema.$schema : "";
    const Constructor = version.includes("draft-07")
      ? Ajv
      : version.includes("2019-09")
        ? Ajv2019
        : Ajv2020;
    const ajv = new Constructor({ strict: false, allErrors: true, validateSchema: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    return (input) =>
      validate(input)
        ? { valid: true, data: input as T, errorMessage: undefined }
        : { valid: false, data: undefined, errorMessage: ajv.errorsText(validate.errors) };
  }
}
export function mcpToolName(server: string, tool: string) {
  const slug = (value: string, length: number) =>
    value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, length);
  const hash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([server, tool]))
    .digest("hex")
    .slice(0, 12);
  return `mcp_${slug(server, 16)}_${slug(tool, 24)}_${hash}`;
}
/** Session-owned resources, registered before opening so disconnect can always stop child processes. */
export function mcpConnections(servers: readonly McpServer[], cwd: string) {
  if (servers.length > 32) throw new Error("At most 32 MCP servers are supported per session");
  const names = new Set<string>();
  for (const server of servers) {
    validateMcpTransport(server);
    if (!server.name.trim() || names.has(server.name))
      throw new Error("MCP server names must be nonempty and unique");
    names.add(server.name);
  }
  const clients: (() => Promise<void>)[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    closing ??= Promise.allSettled(clients.map((closeClient) => closeClient())).then(() => {});
    return closing;
  };
  return {
    close,
    async open(signal: AbortSignal): Promise<ReadonlyMap<string, Tool>> {
      const tools = new Map<string, Tool>();
      const abort = () => {
        void close();
      };
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      try {
        for (const server of [...servers].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
          signal.throwIfAborted();
          if (closed) throw new Error("MCP session closed");
          const validator = new SchemaValidator();
          const client = new Client(
            { name: "labkit-agent", version: "0.1.0" },
            { capabilities: { roots: { listChanged: false } }, jsonSchemaValidator: validator },
          );
          client.setRequestHandler(ListRootsRequestSchema, () => ({
            roots: [{ uri: pathToFileURL(cwd).href, name: "Workspace" }],
          }));
          // The SDK inherits only its safe baseline env for stdio. Remote headers stay transport-owned.
          const { transport, dispose } = mcpTransport(server, cwd);
          clients.push(async () => {
            try {
              await dispose?.();
            } finally {
              await client.close();
            }
          });
          try {
            const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
            await waitForBoundary(
              client.connect(transport, { signal: deadline, timeout: 15000 }),
              deadline,
            );
          } catch {
            throw new Error(`Failed to connect to MCP server ${server.name}`);
          }
          if (!client.getServerCapabilities()?.tools) continue;
          const catalog = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, {
              signal,
              timeout: 15000,
            });
            catalog.push(...page.tools);
            if (catalog.length > MAX_TOOLS) throw new Error("MCP tool catalog exceeds 256 tools");
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor))
              throw new Error("MCP tool catalog repeated a cursor");
            if (cursor) cursors.add(cursor);
            if (cursors.size > MAX_TOOLS) throw new Error("MCP tool catalog has too many pages");
          } while (cursor);
          for (const entry of catalog.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          )) {
            if (entry.execution?.taskSupport === "required")
              throw new Error("Task-only MCP tools are not supported");
            const name = mcpToolName(server.name, entry.name);
            if (tools.has(name)) throw new Error("Duplicate MCP tool name");
            if (Buffer.byteLength(JSON.stringify(entry.inputSchema)) > MAX_BYTES)
              throw new Error("MCP tool schema exceeds 256 KiB");
            const validate = validator.getValidator(entry.inputSchema as JsonSchemaType);
            tools.set(name, {
              description: `MCP ${server.name}/${entry.name}${entry.description ? `: ${entry.description}` : ""}`,
              kind: entry.annotations?.readOnlyHint === true ? "read" : "other",
              parameters: structuredClone(entry.inputSchema),
              async parseInput(raw) {
                const json = z.json().parse(raw);
                const result = validate(json);
                if (!result.valid)
                  throw new Error(`Invalid MCP tool arguments: ${result.errorMessage}`);
                return json;
              },
              async run(input, toolSignal) {
                toolSignal.throwIfAborted();
                if (closed) throw new Error("MCP session closed");
                const result = CallToolResultSchema.parse(
                  await client.callTool(
                    { name: entry.name, arguments: input as Record<string, unknown> },
                    undefined,
                    { signal: toolSignal, timeout: 60000 },
                  ),
                );
                if (result.isError)
                  throw new Error(
                    `MCP tool failed: ${result.content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text)
                      .join("\n")
                      .slice(0, 4096)}`,
                  );
                if (
                  result.content.some(
                    (block) =>
                      block.type === "image" ||
                      block.type === "audio" ||
                      (block.type === "resource" && !("text" in block.resource)),
                  )
                )
                  throw new Error("Binary MCP tool results are not supported");
                const output = {
                  content: result.content,
                  ...(result.structuredContent
                    ? { structuredContent: result.structuredContent }
                    : {}),
                };
                if (Buffer.byteLength(JSON.stringify(output)) > MAX_BYTES)
                  throw new Error("MCP tool result exceeds 256 KiB; narrow the request");
                return output;
              },
            });
          }
        }
        signal.throwIfAborted();
        if (closed) throw new Error("MCP session closed");
        return tools;
      } catch (error) {
        await close();
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

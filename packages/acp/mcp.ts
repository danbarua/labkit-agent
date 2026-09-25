import { pathToFileURL } from "node:url";

import type { McpServer } from "@agentclientprotocol/sdk";
import type { Tool } from "@labkit-agent/core/host";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  ErrorCode,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

import { diagnostic, diagnosticError } from "../core/logging/index.ts";
import type { ClientElicitation } from "./client-elicitation.ts";
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

/**
 * Opening an MCP server failed. The message names the server, the stage (connecting or loading its
 * tool catalog) and the sanitized cause, so a client can fix that server's configuration.
 */
export class McpOpenError extends Error {
  override readonly name = "McpOpenError";

  constructor(
    readonly serverName: string,
    readonly stage: "connect" | "catalog",
    cause: Error,
  ) {
    super(
      `${stage === "connect" ? "Failed to connect to" : "Failed to load tools from"} MCP server "${serverName}": ${cause.message.replace(/\.$/, "")}. Check that the server is running and its session configuration (command, URL or headers) is correct, then open the session again.`,
      { cause },
    );
  }
}

/** Session-owned resources, registered before opening so disconnect can always stop child processes. */
export function mcpConnections(
  servers: readonly McpServer[],
  cwd: string,
  additionalDirectories: readonly string[] = [],
  proxy?: (serverId: string) => Transport,
  elicitation: ClientElicitation = {},
  context: { sessionId?: string } = {},
) {
  if (servers.length > 32) throw new Error("At most 32 MCP servers are supported per session");
  const names = new Set<string>();
  for (const server of servers) {
    validateMcpTransport(server, !!proxy);
    if (!server.name.trim() || names.has(server.name))
      throw new Error("MCP server names must be nonempty and unique");
    names.add(server.name);
  }
  const secrets = servers.flatMap((server) =>
    !("type" in server)
      ? server.env
          .filter(({ name }) => /key|token|secret|auth|password/i.test(name))
          .map(({ value }) => value)
      : server.type === "acp"
        ? []
        : server.headers
            .filter(({ name }) => /key|token|secret|auth|cookie/i.test(name))
            .flatMap(({ value }) => [value, value.replace(/^(Bearer|Basic)\s+/i, "")]),
  );
  // Errors leave this credential-owning boundary for host diagnostics and journal outcomes.
  // Sanitize the thrown value as well as this module's own diagnostic record.
  const boundaryError = (error: unknown): Error => {
    const detail = diagnosticError(error, secrets);
    return Object.assign(
      new Error(typeof detail.message === "string" ? detail.message : JSON.stringify(detail)),
      detail,
    );
  };
  const clients: (() => Promise<void>)[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    closing ??= Promise.allSettled(clients.map((closeClient) => closeClient())).then((results) => {
      for (const result of results)
        if (result.status === "rejected")
          diagnostic("acp", "warning", "mcp.close.failed", {
            ...context,
            error: diagnosticError(result.reason, secrets),
          });
      diagnostic("acp", "debug", "mcp.closed", { ...context, count: clients.length });
    });
    return closing;
  };
  return {
    close,
    async open(signal: AbortSignal): Promise<ReadonlyMap<string, Tool>> {
      const started = performance.now();
      let serverName: string | undefined;
      let stage: "connect" | "catalog" = "connect";
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
          serverName = server.name;
          stage = "connect";
          diagnostic("acp", "debug", "mcp.connect.started", {
            ...context,
            serverName,
            transport: "type" in server ? server.type : "stdio",
            cwd,
            timeoutMs: 15000,
          });
          signal.throwIfAborted();
          if (closed) throw new Error("MCP session closed");
          const validator = new SchemaValidator();
          const client = new Client(
            { name: "labkit-agent", version: "0.1.0" },
            {
              capabilities: {
                roots: { listChanged: false },
                ...(elicitation.form || elicitation.url
                  ? {
                      elicitation: {
                        ...(elicitation.form ? { form: {} } : {}),
                        ...(elicitation.url ? { url: {} } : {}),
                      },
                    }
                  : {}),
              },
              jsonSchemaValidator: validator,
            },
          );
          const activeCalls = new Set<AbortSignal>();
          const urls = new Map<string, (() => Promise<void>) | undefined>();
          if (elicitation.form || elicitation.url)
            client.setRequestHandler(ElicitRequestSchema, async ({ params }, extra) => {
              if (!activeCalls.size)
                throw new Error("MCP elicitation requires an active tool call");
              const signal =
                activeCalls.size === 1
                  ? AbortSignal.any([extra.signal, [...activeCalls][0]!])
                  : extra.signal;
              if (params.mode !== "url") {
                if (!elicitation.form) throw new Error("Client does not support form elicitation");
                return elicitation.form(
                  { message: params.message, requestedSchema: params.requestedSchema },
                  signal,
                );
              }
              if (!elicitation.url) throw new Error("Client does not support URL elicitation");
              if (urls.has(params.elicitationId))
                throw new Error("Duplicate outstanding MCP elicitation ID");
              urls.set(params.elicitationId, undefined);
              try {
                const response = await elicitation.url(
                  { message: params.message, url: params.url },
                  signal,
                );
                if (response.action === "accept") {
                  const discard = () => {
                    if (urls.get(params.elicitationId) === complete)
                      urls.delete(params.elicitationId);
                    response.signal.removeEventListener("abort", discard);
                  };
                  const complete = async () => {
                    discard();
                    await response.complete();
                  };
                  urls.set(params.elicitationId, complete);
                  response.signal.addEventListener("abort", discard, { once: true });
                  if (response.signal.aborted) discard();
                } else urls.delete(params.elicitationId);
                return { action: response.action };
              } catch (error) {
                urls.delete(params.elicitationId);
                throw boundaryError(error);
              }
            });
          if (elicitation.url)
            client.setNotificationHandler(
              ElicitationCompleteNotificationSchema,
              async ({ params }) => {
                const complete = urls.get(params.elicitationId);
                urls.delete(params.elicitationId);
                await complete?.();
              },
            );
          client.setRequestHandler(ListRootsRequestSchema, () => ({
            roots: [cwd, ...additionalDirectories].map((path, index) => ({
              uri: pathToFileURL(path).href,
              name: index === 0 ? "Workspace" : `Workspace ${index + 1}`,
            })),
          }));
          // The SDK inherits only its safe baseline env for stdio. Remote headers stay transport-owned.
          const { transport, dispose } = mcpTransport(server, cwd, proxy);
          clients.push(async () => {
            urls.clear();
            try {
              await dispose?.();
            } finally {
              await client.close();
            }
          });
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
          await waitForBoundary(
            client.connect(transport, { signal: deadline, timeout: 15000 }),
            deadline,
          );
          diagnostic("acp", "debug", "mcp.connect.completed", { ...context, serverName });
          stage = "catalog";
          if (!client.getServerCapabilities()?.tools) {
            diagnostic("acp", "debug", "mcp.catalog.skipped", {
              ...context,
              serverName,
              reason: "Server does not advertise tools capability",
            });
            continue;
          }
          const catalog = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, {
              signal,
              timeout: 15000,
            });
            catalog.push(...page.tools);
            diagnostic("acp", "debug", "mcp.catalog.page", {
              ...context,
              serverName,
              count: page.tools.length,
              totalCount: catalog.length,
              hasNextPage: !!page.nextCursor,
            });
            if (catalog.length > MAX_TOOLS) throw new Error("MCP tool catalog exceeds 256 tools");
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor))
              throw new Error("MCP tool catalog repeated a cursor");
            if (cursor) cursors.add(cursor);
            if (cursors.size > MAX_TOOLS) throw new Error("MCP tool catalog has too many pages");
          } while (cursor);
          diagnostic("acp", "info", "mcp.catalog.loaded", {
            ...context,
            serverName,
            count: catalog.length,
          });
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
                try {
                  const json = z.json().parse(raw);
                  const result = validate(json);
                  if (!result.valid) {
                    throw new Error(`Invalid MCP tool arguments: ${result.errorMessage}`);
                  }
                  return json;
                } catch (error) {
                  const failure = boundaryError(error);
                  diagnostic("acp", "warning", "mcp.input.rejected", {
                    ...context,
                    serverName: server.name,
                    toolName: name,
                    error: diagnosticError(failure),
                  });
                  throw failure;
                }
              },
              async run(input, toolSignal, toolContext) {
                const callStarted = performance.now();
                const fields = {
                  ...context,
                  serverName: server.name,
                  toolName: name,
                  remoteToolName: entry.name,
                  toolCallId: toolContext?.toolCallId,
                };
                diagnostic("acp", "debug", "mcp.call.started", { ...fields, timeoutMs: 60000 });
                try {
                  toolSignal.throwIfAborted();
                  if (closed) throw new Error("MCP session closed");
                  activeCalls.add(toolSignal);
                  let rawResult: unknown;
                  try {
                    rawResult = await client.callTool(
                      { name: entry.name, arguments: input as Record<string, unknown> },
                      undefined,
                      { signal: toolSignal, timeout: 60000 },
                    );
                  } finally {
                    activeCalls.delete(toolSignal);
                  }
                  const result = CallToolResultSchema.parse(rawResult);
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
                  diagnostic("acp", "debug", "mcp.call.completed", {
                    ...fields,
                    durationMs: performance.now() - callStarted,
                    bytes: Buffer.byteLength(JSON.stringify(output)),
                    count: result.content.length,
                  });
                  return output;
                } catch (error) {
                  const timedOut =
                    error instanceof Error &&
                    (error.name === "TimeoutError" ||
                      ("code" in error && error.code === ErrorCode.RequestTimeout));
                  const cancelled = toolSignal.aborted && !timedOut;
                  diagnostic(
                    "acp",
                    cancelled ? "info" : "warning",
                    cancelled ? "mcp.call.cancelled" : "mcp.call.failed",
                    {
                      ...fields,
                      durationMs: performance.now() - callStarted,
                      timeoutMs: 60000,
                      outcome: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
                      error: diagnosticError(error, secrets),
                    },
                  );
                  throw boundaryError(error);
                }
              },
            });
          }
        }
        signal.throwIfAborted();
        if (closed) throw new Error("MCP session closed");
        return tools;
      } catch (error) {
        diagnostic(
          "acp",
          signal.aborted ? "info" : "warning",
          signal.aborted ? "mcp.open.cancelled" : "mcp.open.failed",
          {
            ...context,
            serverName,
            stage,
            durationMs: performance.now() - started,
            error: diagnosticError(error, secrets),
          },
        );
        await close();
        const failure = boundaryError(error);
        throw serverName && !signal.aborted
          ? new McpOpenError(serverName, stage, failure)
          : failure;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

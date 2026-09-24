import {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  MultiSelectItems,
  type AgentContext,
  type ClientCapabilities,
  type ElicitationRequestScope,
  type ElicitationSchema,
  type ElicitationSessionScope,
} from "@agentclientprotocol/sdk";
import type { ToolRunContext } from "@labkit-agent/core/host";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { waitForBoundary } from "./session-config.ts";

export type ElicitationResult =
  | { action: "accept"; content?: Record<string, string | number | boolean | string[]> }
  | { action: "decline" | "cancel" };
export type ClientElicitation = Readonly<{
  form?: (
    input: { message: string; requestedSchema: ElicitationSchema },
    signal: AbortSignal,
    context?: ToolRunContext,
  ) => Promise<ElicitationResult>;
  url?: (
    input: { message: string; url: string },
    signal: AbortSignal,
    context?: ToolRunContext,
  ) => Promise<{
    action: "accept" | "decline" | "cancel";
    complete: () => Promise<void>;
    signal: AbortSignal;
  }>;
}>;

const limit = (value: unknown) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 65536)
    throw new Error("Elicitation exceeds 64 KiB");
};
const fields = (value: object, keys: string[]) =>
  Object.fromEntries(
    Object.entries(value).filter(([key, value]) => keys.includes(key) && value != null),
  );
const annotations = ["title", "description", "default"];

/** Restrict schema compilation to the ACP flat primitive/enum subset; never compile caller refs. */
export function elicitationFormSchema(input: ElicitationSchema) {
  limit(input);
  if (
    !CreateElicitationRequest.isForm({
      mode: "form",
      message: "validate",
      sessionId: "validate",
      requestedSchema: input,
    })
  )
    throw new Error("Invalid elicitation form schema");
  const properties = Object.fromEntries(
    Object.entries(input.properties ?? {}).map(([name, property]) => {
      let schema: Record<string, unknown>;
      if (ElicitationPropertySchema.isString(property))
        schema = fields(property, [
          "type",
          ...annotations,
          "minLength",
          "maxLength",
          "pattern",
          "format",
          "enum",
          "oneOf",
        ]);
      else if (
        ElicitationPropertySchema.isNumber(property) ||
        ElicitationPropertySchema.isInteger(property)
      )
        schema = fields(property, ["type", ...annotations, "minimum", "maximum"]);
      else if (ElicitationPropertySchema.isBoolean(property))
        schema = fields(property, ["type", ...annotations]);
      else if (ElicitationPropertySchema.isArray(property)) {
        schema = fields(property, ["type", ...annotations, "minItems", "maxItems"]);
        schema.items = MultiSelectItems.isTitled(property.items)
          ? {
              anyOf: property.items.anyOf.map((option) =>
                fields(option, ["const", "title", "description"]),
              ),
            }
          : fields(property.items, ["type", "enum"]);
        schema.uniqueItems = true;
      } else throw new Error("Unsupported elicitation field type");
      if (ElicitationPropertySchema.isString(property) && property.oneOf)
        schema.oneOf = property.oneOf.map((option) =>
          fields(option, ["const", "title", "description"]),
        );
      return [name, schema];
    }),
  );
  if (
    Object.keys(properties).length > 128 ||
    input.required?.some((name) => !Object.hasOwn(properties, name))
  )
    throw new Error("Invalid elicitation form properties");
  const wire = {
    ...fields(input, ["title", "description"]),
    type: "object" as const,
    properties,
    ...(input.required ? { required: [...input.required] } : {}),
  };
  const ajv = new Ajv({ strict: false, allErrors: true, ownProperties: true });
  addFormats(ajv);
  const validate = ajv.compile({ ...wire, additionalProperties: false });
  return { wire: wire as ElicitationSchema, validate };
}

/** Scope and lifetime are bound by the adapter, not supplied by interaction arguments. */
function boundElicitation(
  client: AgentContext,
  capabilities: ClientCapabilities,
  scope: (context?: ToolRunContext) => ElicitationSessionScope | ElicitationRequestScope,
  connectionSignal: AbortSignal,
  operationSignal: () => AbortSignal,
) {
  const lifetime = new AbortController();
  const pending = new Set<string>();
  const request = async (params: CreateElicitationRequest, signal: AbortSignal) => {
    limit(params);
    if (
      (!CreateElicitationRequest.isForm(params) && !CreateElicitationRequest.isUrl(params)) ||
      !params.message.trim() ||
      params.message.length > 4096
    )
      throw new Error("Invalid elicitation request");
    const cancellation = AbortSignal.any([
      signal,
      lifetime.signal,
      operationSignal(),
      connectionSignal,
      AbortSignal.timeout(120000),
    ]);
    cancellation.throwIfAborted();
    const raw = await waitForBoundary(
      client.request("elicitation/create", params, { cancellationSignal: cancellation }),
      cancellation,
    );
    limit(raw);
    if (CreateElicitationResponse.isDecline(raw)) return { action: "decline" as const };
    if (CreateElicitationResponse.isCancel(raw)) return { action: "cancel" as const };
    if (!CreateElicitationResponse.isAccept(raw))
      throw new Error("Invalid elicitation response action or content");
    return { action: "accept" as const, ...(raw.content != null ? { content: raw.content } : {}) };
  };
  const reserve = () => {
    if (pending.size >= 32) throw new Error("Too many outstanding elicitations");
    const id = crypto.randomUUID();
    pending.add(id);
    return id;
  };
  const port: ClientElicitation = {
    ...(capabilities.elicitation?.form != null
      ? {
          form: async (
            input: { message: string; requestedSchema: ElicitationSchema },
            signal: AbortSignal,
            context?: ToolRunContext,
          ): Promise<ElicitationResult> => {
            const { wire, validate } = elicitationFormSchema(input.requestedSchema);
            const id = reserve();
            try {
              const response = await request(
                { ...scope(context), mode: "form", message: input.message, requestedSchema: wire },
                signal,
              );
              if (response.action === "accept" && !validate(response.content ?? {}))
                throw new Error("Elicitation response does not match the requested form");
              return response;
            } finally {
              pending.delete(id);
            }
          },
        }
      : {}),
    ...(capabilities.elicitation?.url != null
      ? {
          url: async (
            input: { message: string; url: string },
            signal: AbortSignal,
            context?: ToolRunContext,
          ) => {
            const url = new URL(input.url);
            if (
              url.username ||
              url.password ||
              !(
                url.protocol === "https:" ||
                (url.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
              )
            )
              throw new Error(
                "Elicitation URL must use HTTPS (HTTP is allowed only for loopback development)",
              );
            const id = reserve();
            const cancellation = AbortSignal.any([
              signal,
              lifetime.signal,
              connectionSignal,
              operationSignal(),
            ]);
            const discard = () => {
              pending.delete(id);
              cancellation.removeEventListener("abort", discard);
            };
            cancellation.addEventListener("abort", discard, { once: true });
            try {
              const response = await request(
                {
                  ...scope(context),
                  mode: "url",
                  message: input.message,
                  url: url.href,
                  elicitationId: id,
                },
                cancellation,
              );
              if (response.action !== "accept") discard();
              return {
                action: response.action,
                signal: cancellation,
                complete: async () => {
                  if (!pending.has(id) || cancellation.aborted) return;
                  scope();
                  discard();
                  await client.notify("elicitation/complete", { elicitationId: id });
                },
              };
            } catch (error) {
              discard();
              throw error;
            }
          },
        }
      : {}),
  };
  return {
    port,
    close: () => {
      lifetime.abort();
      pending.clear();
    },
  };
}

export function clientElicitation(
  client: AgentContext,
  capabilities: ClientCapabilities,
  session: () => string,
  connectionSignal: AbortSignal,
  operationSignal: () => AbortSignal,
) {
  return boundElicitation(
    client,
    capabilities,
    (context) => ({ sessionId: session(), ...(context ? { toolCallId: context.toolCallId } : {}) }),
    connectionSignal,
    operationSignal,
  );
}

export function requestElicitation(
  client: AgentContext,
  capabilities: ClientCapabilities,
  signal: AbortSignal,
  connectionSignal: AbortSignal,
) {
  const requestId = client.requestId;
  if (requestId === undefined || requestId === null)
    throw new Error("Elicitation requires an active ACP request");
  return boundElicitation(
    client,
    capabilities,
    () => ({ requestId }),
    connectionSignal,
    () => signal,
  );
}

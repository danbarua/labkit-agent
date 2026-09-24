import { isAbsolute } from "node:path";

import type { ToolCallContent } from "@agentclientprotocol/sdk";
import protocolSchema from "@agentclientprotocol/sdk/schema/schema.json";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import { ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

const validator = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

const validateContent = validator.compile<ToolCallContent[]>({
  $defs: protocolSchema.$defs,
  type: "array",
  items: { $ref: "#/$defs/ToolCallContent" },
});

export type AcpToolContentContext = Readonly<{
  toolName: string;
  /** The exact successful, validated tool result stored in the journal. */
  output: string;
}>;

/** Pure display projection. No tool execution, file reads, network calls or live terminal handles. */
export type AcpToolContent = (
  context: AcpToolContentContext,
) => readonly Exclude<ToolCallContent, { type: "terminal" }>[];

export function renderToolContent(
  binding: AcpToolContent | undefined,
  output: unknown,
  context: {
    sessionId?: string;
    toolCallId: string;
    toolName?: string;
    turnId?: string;
    batchId?: string;
    callId?: string;
    reconstructed: boolean;
  },
): ToolCallContent[] {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (!binding || !context.toolName || typeof output !== "string")
    return [{ type: "content", content: { type: "text", text } }];
  try {
    const content = z.json().parse(binding({ toolName: context.toolName, output }));
    if (!validateContent(content))
      throw new Error(`Invalid ACP tool content: ${validator.errorsText(validateContent.errors)}`, {
        cause: { issues: structuredClone(validateContent.errors) },
      });
    for (const item of content) {
      if (item.type === "terminal")
        throw new Error(
          "Tool renderers cannot create terminal handles; use the client terminal binding",
        );
      if (item.type === "diff" && !isAbsolute(item.path))
        throw new Error("Diff path must be absolute");
    }
    diagnostic("acp", "debug", "acp.tool_content.rendered", {
      ...context,
      contentTypes: content.map((item) =>
        item.type === "content" ? item.content.type : item.type,
      ),
      count: content.length,
      source: context.reconstructed ? "saved_tool_result" : "live_tool_result",
    });
    return content;
  } catch (error) {
    diagnostic("acp", "warning", "acp.tool_content.failed", {
      ...context,
      reason:
        "Tool display renderer failed; execution result is unchanged and raw output remains available",
      error: diagnosticError(error),
    });
    return [
      {
        type: "content",
        content: {
          type: "text",
          text: `Tool display failed: ${error instanceof Error ? error.message : String(error)}\n\nRaw tool output:\n${text}`,
        },
      },
    ];
  }
}

/** Bound only to discovered MCP tools, never inferred from arbitrary JSON output. */
export const mcpToolContent: AcpToolContent = ({ output }) => {
  const result = z.object({ content: z.array(ContentBlockSchema) }).parse(JSON.parse(output));
  return result.content.map((content) => ({ type: "content", content }));
};

import type { ToolCall } from "@agentclientprotocol/sdk";

/** Embedded in the webview: keep helpers local and escape all agent-provided values. */
export function renderToolDetails(tool: ToolCall): string {
  const escapeHtml = (value: unknown) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
    );

  const raw = (label: string, value: unknown) =>
    value == null
      ? ""
      : `<details class="acp-tool-raw"><summary>${label}</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;

  return (
    `<div class="acp-tool-identity">${tool.name == null ? "" : `<span class="acp-tool-name">${escapeHtml(tool.name)}</span> · `}<span class="acp-tool-kind">${escapeHtml(tool.kind ?? "other")}</span></div>` +
    (tool.locations ?? [])
      .map(
        (location, index) =>
          `<button type="button" class="acp-tool-location" data-location-index="${index}">${escapeHtml(location.path)}${location.line == null ? "" : `:${escapeHtml(location.line)}`}</button>`,
      )
      .join("") +
    raw("Input", tool.rawInput) +
    raw("Output", tool.rawOutput) +
    raw("Metadata", tool._meta)
  );
}

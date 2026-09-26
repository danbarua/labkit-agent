/** Runs in both the extension and its webview. Keep helpers inside this function. */
export function renderToolContent(
  content: unknown,
  terminals: Record<string, unknown> = {},
): string {
  const escapeHtml = (value: unknown) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character]!,
    );

  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

  const media = (block: Record<string, unknown>, type: "image" | "audio") => {
    const mime = typeof block.mimeType === "string" ? block.mimeType : "";
    const data = typeof block.data === "string" ? block.data : "";
    if (!mime.startsWith(`${type}/`) || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data))
      return `<p>Invalid ${type} content: cannot display the supplied media.</p>`;
    const src = `data:${escapeHtml(mime)};base64,${data}`;
    return type === "image"
      ? `<img alt="Tool result" src="${src}" style="max-width:100%">`
      : `<audio controls preload="none" src="${src}"></audio>`;
  };

  const block = (value: unknown): string => {
    const item = object(value);
    switch (item.type) {
      case "text":
        return `<pre class="acp-text">${escapeHtml(item.text)}</pre>`;
      case "image":
        return media(item, "image");
      case "audio":
        return media(item, "audio");
      case "resource": {
        const resource = object(item.resource);
        return `<details open><summary>${escapeHtml(resource.uri)}</summary><pre>${escapeHtml(resource.text ?? resource.blob)}</pre></details>`;
      }
      case "resource_link": {
        const uri = typeof item.uri === "string" ? item.uri : "";
        const label = escapeHtml(item.title ?? item.name ?? uri);
        return /^(https?:|file:)/i.test(uri)
          ? `<a href="${escapeHtml(uri)}">${label}</a>`
          : `<span>${label}: ${escapeHtml(uri)}</span>`;
      }
      default:
        return `<pre>Unrecognized content: ${escapeHtml(JSON.stringify(value))}</pre>`;
    }
  };

  if (!Array.isArray(content)) return "";
  return content
    .map((value) => {
      const item = object(value);
      if (item.type === "content") return block(item.content);
      if (item.type === "diff")
        return (
          `<details class="acp-diff" open><summary>${escapeHtml(item.path)}</summary>` +
          (item.oldText == null
            ? `<p>New file</p>`
            : `<div>Before</div><pre class="acp-diff-before">${escapeHtml(item.oldText)}</pre>`) +
          `<div>After</div><pre class="acp-diff-after">${escapeHtml(item.newText)}</pre></details>`
        );
      if (item.type === "terminal") {
        const terminal = object(terminals[String(item.terminalId)]);
        const status = object(terminal.exitStatus);
        const label = terminal.exitStatus
          ? `Exited: ${status.signal ?? status.exitCode ?? "unknown"}`
          : "Running";
        return `<details class="acp-terminal" open><summary>Terminal ${escapeHtml(item.terminalId)} — ${escapeHtml(terminal.output === undefined ? "Output not available" : label)}${terminal.released ? " (released)" : ""}</summary>${terminal.truncated ? "<p>Earlier output was truncated.</p>" : ""}<pre>${escapeHtml(terminal.output)}</pre></details>`;
      }
      return `<pre>Unrecognized tool content: ${escapeHtml(JSON.stringify(value))}</pre>`;
    })
    .join("");
}

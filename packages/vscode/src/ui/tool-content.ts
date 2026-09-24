/** Runs in both the extension and its webview. Keep helpers inside this function. */
export function renderToolContent(content: unknown): string {
  const escape = (value: unknown) =>
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
    const src = `data:${escape(mime)};base64,${data}`;
    return type === "image"
      ? `<img alt="Tool result" src="${src}" style="max-width:100%">`
      : `<audio controls preload="none" src="${src}"></audio>`;
  };

  const block = (value: unknown): string => {
    const item = object(value);
    switch (item.type) {
      case "text":
        return `<pre class="acp-text">${escape(item.text)}</pre>`;
      case "image":
        return media(item, "image");
      case "audio":
        return media(item, "audio");
      case "resource": {
        const resource = object(item.resource);
        return `<details open><summary>${escape(resource.uri)}</summary><pre>${escape(resource.text ?? resource.blob)}</pre></details>`;
      }
      case "resource_link": {
        const uri = typeof item.uri === "string" ? item.uri : "";
        const label = escape(item.title ?? item.name ?? uri);
        return /^(https?:|file:)/i.test(uri)
          ? `<a href="${escape(uri)}">${label}</a>`
          : `<span>${label}: ${escape(uri)}</span>`;
      }
      default:
        return `<pre>Unrecognized content: ${escape(JSON.stringify(value))}</pre>`;
    }
  };

  if (!Array.isArray(content)) return "";
  return content
    .map((value) => {
      const item = object(value);
      if (item.type === "content") return block(item.content);
      if (item.type === "diff")
        return (
          `<details class="acp-diff" open><summary>${escape(item.path)}</summary>` +
          (item.oldText == null
            ? `<p>New file</p>`
            : `<div>Before</div><pre class="acp-diff-before">${escape(item.oldText)}</pre>`) +
          `<div>After</div><pre class="acp-diff-after">${escape(item.newText)}</pre></details>`
        );
      if (item.type === "terminal") return `<p>Terminal: ${escape(item.terminalId)}</p>`;
      return `<pre>Unrecognized tool content: ${escape(JSON.stringify(value))}</pre>`;
    })
    .join("");
}

import type { AgentMessage } from "../../agent/types.ts";
import { encodeRecord } from "./codec.ts";
import type { JournalState } from "./state.ts";

/** The records as JSON Lines: one encoded record per line in revision order, newline-terminated. */
export function journalJSONL(state: JournalState): string {
  return `${state.records.map(encodeRecord).join("\n")}\n`;
}

/**
 * Renders the journal as a Markdown report for people: agent system prompts, standing instruction
 * history, context, turn log, any unfinished turn, permission decisions, recoveries and registry
 * adoptions. A readable view only; the journal remains the authoritative record.
 *
 * @param options.agentLabels Display names by agent ID.
 */
export function journalMarkdown(
  state: JournalState,
  options: { agentLabels?: Readonly<Record<string, string>> } = {},
): string {
  const c = state.conversation;
  const label = (id: string) =>
    options.agentLabels?.[id] ? `${options.agentLabels[id]} (agent ID: ${id})` : `Agent ${id}`;
  const block = (value: unknown) => {
    const text = JSON.stringify(value, null, 2);
    const fence = "`".repeat(
      Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)),
    );
    return `${fence}json\n${text}\n${fence}`;
  };
  const quote = (text: string) =>
    text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  const message = (m: AgentMessage): string[] => {
    const title =
      m.role === "tool"
        ? `Tool result — call ${m.callId}`
        : m.role[0]!.toUpperCase() + m.role.slice(1);
    let content = quote(m.text);
    if (m.role === "tool") {
      // Tool messages are text at this boundary. Pretty-print JSON when present, retaining literal text otherwise.
      try {
        const parsed: unknown = JSON.parse(m.text);
        if (parsed !== null && typeof parsed === "object") content = block(parsed);
      } catch {
        /* Literal tool text is valid and is rendered unchanged. */
      }
    }
    const lines = [`### ${title}`, "", ...(m.text ? [content, ""] : [])];
    if (m.role === "assistant" && m.calls) {
      for (const call of m.calls)
        lines.push(`**Tool call: ${call.name}** (call ID: ${call.id})`, "", block(call.args), "");
    }
    if (m.role !== "tool") {
      for (const part of m.parts ?? []) {
        if (part.type === "blob")
          lines.push(
            `Attachment: **${part.ref.name ?? "Unnamed attachment"}** — ${part.ref.media}, ${part.ref.bytes} bytes.`,
            "",
            `Blob ID: \`${part.ref.id}\` (bytes are stored separately).`,
            "",
          );
      }
    }
    return lines;
  };
  const lines = [
    `# Session ${c.sessionId}`,
    "",
    `Revision: ${state.revision}. System instruction version: ${state.systemVersion}.`,
    "",
  ];
  if (c.origin.kind === "root") lines.push("Origin: new root session.", "");
  else
    lines.push(
      `Origin: ${c.origin.kind} of session \`${c.origin.parent}\` at parent sequence ${c.origin.sequence}.`,
      "",
    );
  lines.push("## Agent system prompts", "");
  for (const [id, agent] of state.configuration.agents)
    lines.push(
      `### ${label(id)}`,
      "",
      agent.systemPrompt ? quote(agent.systemPrompt) : "No configured system prompt.",
      "",
    );
  const instructionRecords = state.records.flatMap((record) => {
    const body = record.body;
    if (body.kind === "created")
      return [
        {
          revision: record.revision,
          version: body.seed.systemVersion,
          inputs: body.seed.systemInputs,
        },
      ];
    if (body.kind === "system")
      return [{ revision: record.revision, version: body.version, inputs: body.inputs }];
    return [];
  });
  lines.push("## Session instruction history", "");
  for (const entry of instructionRecords)
    lines.push(
      `### Revision ${entry.revision} — instruction version ${entry.version}`,
      "",
      ...(entry.inputs.length
        ? entry.inputs.flatMap((text) => [quote(text), ""])
        : ["No shared instructions.", ""]),
    );
  if (state.systemInputs.length)
    lines.push(
      "## Shared instructions",
      "",
      ...state.systemInputs.flatMap((text) => [quote(text), ""]),
    );
  if (c.context.length)
    lines.push("## Inherited or replacement context", "", ...c.context.flatMap(message));
  if (!c.log.length) lines.push("No terminal turns have been committed.", "");
  c.log.forEach((record, index) => {
    lines.push(
      `## Turn ${index + 1} — ${record.outcome.kind}`,
      "",
      `Responsible agent: ${label(record.agent)}.`,
      "",
      ...record.messages.flatMap(message),
    );
    const outcome = record.outcome;
    lines.push(
      `**Outcome:** ${outcome.kind}${outcome.kind === "failed" ? ` — ${outcome.error.message}` : outcome.kind === "exhausted" ? " — model-step allowance reached" : outcome.kind === "aborted" ? " — turn cancelled" : ""}.`,
      "",
    );
  });
  if (c.turn.status !== "idle")
    lines.push(
      `## Unfinished turn — ${c.turn.status}`,
      "",
      ...c.turn.turn.messages.flatMap(message),
      ...state.partial.flatMap((entry) => [
        "Committed partial tool outcome:",
        "",
        block(entry),
        "",
      ]),
    );
  const permissions = state.records.flatMap(({ body }) => {
    if (
      body.kind !== "event" ||
      body.event.type !== "child" ||
      body.event.event.type !== "permission_settled"
    )
      return [];
    const result = body.event.event.result;
    return [
      `Turn ID: \`${body.event.turnId}\``,
      "",
      ...(result.kind === "succeeded"
        ? result.value.map(
            (decision) =>
              `- Call ${decision.callId}: **${decision.decision}**${decision.decision === "invalid_input" ? ` — ${decision.error.message}` : decision.approval ? ` — ${decision.approval.scope}, ${decision.approval.source}, grant ${decision.approval.grantId}` : ""}`,
          )
        : [
            `Permission operation: ${result.kind}${result.kind === "failed" ? ` — ${result.error.message}` : ""}.`,
          ]),
      "",
    ];
  });
  if (permissions.length) lines.push("## Recorded permission decisions", "", ...permissions);
  for (const { body, revision } of state.records) {
    if (body.kind === "recovery") lines.push("## Recovery", "", quote(body.reason), "");
    if (body.kind === "configuration")
      lines.push(
        `## Registry adopted at revision ${revision}`,
        "",
        `Agents: ${body.configuration.agents.map(([id]: [string, unknown]) => id).join(", ")}.`,
        "",
        `Tools: ${body.configuration.tools.map(([name]: [string, unknown]) => name).join(", ") || "none"}.`,
        "",
        ...(body.agent ? [`Conversation continues with ${label(body.agent)}.`, ""] : []),
        ...(body.policy
          ? [`Tool permissions reconciled as policy version ${body.policy.version}.`, ""]
          : []),
      );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

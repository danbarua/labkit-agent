export {
  connectAcp,
  type AcpOptions,
  type AcpSessionOptions,
  type SessionOptionsContext,
} from "./adapter.ts";
export { serveAcpStdio } from "./stdio.ts";

export {
  selectChoices,
  type AcpSelectOption,
  type AcpSelectGroup,
  type AcpSelectOptions,
  type AcpConfigBinding,
  type AcpSelectBinding,
  type AcpBooleanBinding,
} from "./session-config.ts";

export type { ClientFiles } from "./client-files.ts";

export type { FileReadRange } from "./workspace-files.ts";

export { terminalTool, type ClientTerminal } from "./client-terminal.ts";

export { planTool, type PlanEntries, type PlanSink } from "./plan.ts";

export type { AcpCommand } from "./commands.ts";

export type { AcpAuth, AcpAuthContext } from "./auth.ts";

export type { ClientElicitation, ElicitationResult } from "./client-elicitation.ts";

export {
  AcpUsageSchema,
  type AcpUsage,
  type AcpUsageContext,
  type AcpUsageBinding,
} from "./session-usage.ts";

export type { AcpToolContent, AcpToolContentContext } from "./tool-content.ts";

export type { AcpPromptCapabilities } from "./prompt-input.ts";

export {
  workspaceToolContent,
  FileWriteResultSchema,
  FileBeforeSchema,
  type FileWriteResult,
  type FileBefore,
} from "./file-write.ts";

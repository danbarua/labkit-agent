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
  type AcpConfigBinding,
  type AcpSelectBinding,
  type AcpBooleanBinding,
} from "./session-config.ts";

export type { ClientFiles } from "./client-files.ts";

export { terminalTool, type ClientTerminal } from "./client-terminal.ts";

export { planTool, type PlanEntries, type PlanSink } from "./plan.ts";

export type { AcpCommand } from "./commands.ts";

export type { AcpAuth, AcpAuthContext } from "./auth.ts";

export type { ClientElicitation, ElicitationResult } from "./client-elicitation.ts";

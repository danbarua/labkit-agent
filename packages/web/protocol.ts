export const MEDIA_KINDS = [
  "text/markdown",
  "text/plain",
  "image/png",
  "image/jpeg",
  "application/pdf",
] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

export type BlobChip = {
  id: string;
  media: MediaKind;
  bytes: number;
  name?: string;
};

export type ToolCallView = {
  id: string;
  name: string;
  args: unknown;
};

export type MessageView = {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  calls?: ToolCallView[];
  callId?: string;
  attachments?: BlobChip[];
};

export type FailureView = {
  message: string;
  classification?: string;
  phase?: string;
  timeoutMs?: number;
  operation?: {
    id: string;
    kind: string;
    toolName?: string;
    callId?: string;
  };
  cause?: string;
};

export type OutcomeView = {
  kind: string;
  failure?: FailureView;
};

export type TurnView = {
  agent: string;
  outcome: OutcomeView;
  messages: MessageView[];
};

export type CatalogModelOption = {
  id: string;
  label: string;
  stream: boolean;
  thinking: string[];
};

export type ProviderOption = {
  id: string;
  label: string;
  stream: boolean;
  thinking: string[];
  media: MediaKind[];
  defaultModel: string;
  models: CatalogModelOption[];
};

export type HostInfo = {
  mode: "live" | "fixture";
  providers: ProviderOption[];
};

export type SessionView = {
  sessionId: string;
  sessionStatus: string;
  phase: string;
  sessionError?: FailureView;
  resolved?: {
    provider: string;
    model: string;
    wireModel: string;
    profile: string;
    stream: boolean;
  };
  policy: {
    provider?: string;
    model?: string;
    thinking?: string;
    thinkingBudgetTokens?: number | null;
    maxOutputTokens?: number;
    stream?: boolean;
    permissions?: string;
    completionTimeoutMs?: number | null;
    toolTimeoutMs?: number | null;
  };
  log: TurnView[];
  live: MessageView[];
};

export type PublicReceipt = {
  kind: string;
  message?: string;
  failure?: FailureView;
};

export type PermissionPrompt = {
  requestId: string;
  turnId: string;
  tool: {
    toolCallId: string;
    title: string;
    name: string;
    kind: string;
    rawInput: unknown;
    locations?: Array<Record<string, unknown>>;
  };
  options: Array<{
    optionId: "allow-once" | "reject-once";
    name: string;
    kind: string;
  }>;
};

export type ConsoleEvent =
  | { kind: "snapshot"; view: SessionView }
  | { kind: "receipt"; receipt: PublicReceipt }
  | {
      kind: "settled";
      settlement: {
        kind: string;
        turnId?: string;
        outcome?: OutcomeView;
        message?: string;
        failure?: FailureView;
      };
    }
  | {
      kind: "delta";
      turnId: string;
      text?: string;
      thinking?: string;
      thinkingBudgetTokens?: number | null;
      maxOutputTokens?: number;
      status?: string;
    }
  | {
      kind: "tool";
      turnId: string;
      name?: string;
      status?: string;
      args?: unknown;
      result?: unknown;
    }
  | { kind: "permission"; request: PermissionPrompt }
  | { kind: "permission_clear"; requestId: string };

export type CreateSessionBody = {
  providerId?: string;
  model?: string;
  thinking?: string;
  thinkingBudgetTokens?: number | null;
  maxOutputTokens?: number;
  stream?: boolean;
};

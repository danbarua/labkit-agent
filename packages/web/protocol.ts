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

export type TurnView = {
  agent: string;
  outcome: { kind: string; message?: string };
  messages: MessageView[];
};

export type ProviderOption = {
  id: string;
  label: string;
  stream: boolean;
  thinking: string[];
  media: MediaKind[];
  defaultModel: string;
};

export type HostInfo = {
  mode: "live" | "fixture";
  providers: ProviderOption[];
};

export type SessionView = {
  sessionId: string;
  sessionStatus: string;
  phase: string;
  policy: {
    provider?: string;
    model?: string;
    thinking?: string;
    stream?: boolean;
    permissions?: string;
  };
  log: TurnView[];
  live: MessageView[];
};

export type PublicReceipt = {
  kind: string;
  message?: string;
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
      settlement: { kind: string; turnId?: string; outcome?: string; message?: string };
    }
  | {
      kind: "delta";
      turnId: string;
      text?: string;
      thinking?: string;
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
  stream?: boolean;
};

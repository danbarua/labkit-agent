import { RequestError } from "@agentclientprotocol/sdk";
import type {
  JsonRpcId,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

import { diagnosticError } from "../../../core/logging/index.ts";
import { logDiagnostic } from "../utils/Logger";

type Option = RequestPermissionRequest["options"][number];

type PermissionItem = vscode.QuickPickItem & { option: Option };

type Pending = {
  params: RequestPermissionRequest;
  settle: (option: Option | undefined, reason: string) => void;
  fail: (error: unknown) => void;
  picker?: vscode.QuickPick<PermissionItem>;
  subscriptions: vscode.Disposable[];
};

/** One visible decision at a time; cancellation also settles queued and late requests. */
export class PermissionHandler {
  private pending = new Set<Pending>();
  private cancelled = new Map<string, string>();
  private active?: Pending;
  private disposed = false;

  constructor(private readonly editor: typeof vscode = vscode) {}

  beginTurn(sessionId: string) {
    this.cancelSession(sessionId, "superseded_turn");
    this.cancelled.delete(sessionId);
  }

  cancelSession(sessionId: string, reason = "turn_cancelled") {
    this.cancelled.set(sessionId, reason);
    for (const entry of [...this.pending]) {
      if (entry.params.sessionId === sessionId) entry.settle(undefined, reason);
    }
  }

  dispose() {
    this.disposed = true;
    for (const entry of [...this.pending]) entry.settle(undefined, "connection_closed");
    this.cancelled.clear();
  }

  private fields(params: RequestPermissionRequest) {
    return {
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? params.toolCall.name ?? `Tool ${params.toolCall.toolCallId}`,
    };
  }

  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
    rpcRequestId?: JsonRpcId,
  ): Promise<RequestPermissionResponse> {
    const fields = { ...this.fields(params), rpcRequestId };
    const reason = this.disposed
      ? "connection_closed"
      : signal?.aborted
        ? "request_cancelled"
        : this.cancelled.get(params.sessionId);
    if (reason) {
      logDiagnostic("info", "vscode.permission.cancelled", {
        ...fields,
        reason,
        message: `Permission for ${fields.title} was cancelled; this request does not authorize execution`,
      });
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    if (
      !params.options.length ||
      new Set(params.options.map((option) => option.optionId)).size !== params.options.length
    ) {
      logDiagnostic("error", "vscode.permission.invalid", {
        ...fields,
        message: "Permission options must be nonempty and have distinct option IDs",
      });
      return Promise.reject(
        RequestError.invalidParams(
          fields,
          "Permission options must be nonempty and have distinct option IDs",
        ),
      );
    }
    const autoApprove = this.editor.workspace
      .getConfiguration("acp")
      .get<string>("autoApprovePermissions", "none");
    if (autoApprove === "allowAll") {
      const option =
        params.options.find((option) => option.kind === "allow_once") ??
        params.options.find((option) => option.kind === "allow_always");
      if (option) {
        logDiagnostic("info", "vscode.permission.selected", {
          ...fields,
          optionId: option.optionId,
          kind: option.kind,
          reason: "configured_allow_all",
        });
        return Promise.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
      }
    }
    return new Promise((resolve, reject) => {
      const finish = (entry: Pending) => {
        if (!this.pending.delete(entry)) return false;
        for (const subscription of entry.subscriptions) subscription.dispose();
        entry.picker?.hide();
        entry.picker?.dispose();
        if (this.active === entry) this.active = undefined;
        queueMicrotask(() => this.showNext());
        return true;
      };

      const entry: Pending = {
        params,
        subscriptions: [],
        settle: (option, reason) => {
          if (!finish(entry)) return;
          const rejected = option?.kind.startsWith("reject");
          logDiagnostic(
            rejected ? "warning" : "info",
            option ? "vscode.permission.selected" : "vscode.permission.cancelled",
            {
              ...fields,
              reason,
              optionId: option?.optionId,
              kind: option?.kind,
              message: option
                ? `Permission for ${fields.title}: ${option.name}${rejected ? "; this request does not authorize execution" : ""}`
                : `Permission for ${fields.title} was cancelled; this request does not authorize execution`,
            },
          );
          resolve({
            outcome: option
              ? { outcome: "selected", optionId: option.optionId }
              : { outcome: "cancelled" },
          });
        },
        fail: (error) => {
          if (!finish(entry)) return;
          const data = { ...fields, cause: diagnosticError(error) };
          logDiagnostic("error", "vscode.permission.failed", {
            ...data,
            message: `Cannot obtain permission for ${fields.title}; this request does not authorize execution`,
          });
          reject(new RequestError(-32603, `Cannot obtain permission for ${fields.title}`, data));
        },
      };
      this.pending.add(entry);
      if (signal) {
        const abort = () => entry.settle(undefined, "request_cancelled");
        signal.addEventListener("abort", abort, { once: true });
        entry.subscriptions.push({ dispose: () => signal.removeEventListener("abort", abort) });
      }
      logDiagnostic("info", "vscode.permission.waiting", {
        ...fields,
        reason: this.active ? "another_permission_is_visible" : "awaiting_user",
        optionKinds: params.options.map((option) => option.kind),
      });
      this.showNext();
    });
  }

  private showNext() {
    if (this.active || this.disposed) return;
    const entry = this.pending.values().next().value;
    if (!entry) return;
    this.active = entry;
    try {
      const picker = this.editor.window.createQuickPick<PermissionItem>();
      entry.picker = picker;
      picker.title = this.fields(entry.params).title;
      picker.placeholder = "Choose whether to authorize this tool operation";
      picker.ignoreFocusOut = true;
      picker.items = entry.params.options.map((option) => ({
        label: option.name,
        description: option.kind,
        option,
      }));
      entry.subscriptions.push(
        picker.onDidAccept(() => {
          const selected = picker.selectedItems[0]?.option;
          if (selected) entry.settle(selected, "user_selection");
        }),
        picker.onDidHide(() => entry.settle(undefined, "user_dismissed")),
      );
      picker.show();
    } catch (error) {
      entry.fail(error);
    }
  }
}

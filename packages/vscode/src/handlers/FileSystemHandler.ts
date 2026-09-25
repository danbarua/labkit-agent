import { dirname, isAbsolute } from "node:path";

import { RequestError } from "@agentclientprotocol/sdk";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

import { diagnosticError } from "../../../core/logging/index.ts";
import { logDiagnostic } from "../utils/Logger";

/** The editor owns text and saving. Direct disk writes would bypass dirty buffers. */
export class FileSystemHandler {
  constructor(private readonly editor: typeof vscode = vscode) {}

  private validatePath(path: string) {
    if (!isAbsolute(path)) {
      throw RequestError.invalidParams({ path }, "Filesystem requests require an absolute path");
    }
  }

  private failure(
    operation: string,
    params: { sessionId: string; path: string },
    phase: string,
    error: unknown,
  ): never {
    const cause = diagnosticError(error);
    const message = `${operation} ${params.path} failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`;
    const details = { sessionId: params.sessionId, path: params.path, operation, phase, cause };
    logDiagnostic("error", "vscode.filesystem.failed", { ...details, message });
    throw new RequestError(error instanceof RequestError ? error.code : -32603, message, details);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    let phase = "validate";
    const started = performance.now();
    const fields = {
      sessionId: params.sessionId,
      path: params.path,
      operation: "read",
      line: params.line,
      limit: params.limit,
    };
    logDiagnostic("debug", "vscode.filesystem.started", fields);
    try {
      this.validatePath(params.path);
      if (params.line != null && (!Number.isInteger(params.line) || params.line < 1)) {
        throw RequestError.invalidParams(fields, "line must be a positive, 1-based integer");
      }
      if (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 0)) {
        throw RequestError.invalidParams(fields, "limit must be a non-negative integer");
      }
      phase = "open";
      const uri = this.editor.Uri.file(params.path);
      const doc = await this.editor.workspace.openTextDocument(uri);
      let content = doc.getText();
      if (params.line != null || params.limit != null) {
        const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const start = (params.line ?? 1) - 1;
        content = lines
          .slice(start, params.limit == null ? undefined : start + params.limit)
          .join("");
      }
      logDiagnostic("info", "vscode.filesystem.completed", {
        ...fields,
        source: "editor",
        dirty: doc.isDirty,
        bytes: Buffer.byteLength(content),
        durationMs: performance.now() - started,
      });
      return { content };
    } catch (error) {
      this.failure("read", params, phase, error);
    }
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    let phase = "validate";
    const started = performance.now();
    const fields = {
      sessionId: params.sessionId,
      path: params.path,
      operation: "write",
      bytes: Buffer.byteLength(params.content),
    };
    logDiagnostic("debug", "vscode.filesystem.started", fields);
    try {
      this.validatePath(params.path);
      const uri = this.editor.Uri.file(params.path);
      let doc = this.editor.workspace.textDocuments.find(
        (document) => document.uri.toString() === uri.toString() && !document.isClosed,
      );
      let created = false;
      const edit = new this.editor.WorkspaceEdit();
      if (!doc) {
        phase = "stat";
        try {
          await this.editor.workspace.fs.stat(uri);
        } catch (error) {
          if (!(error instanceof this.editor.FileSystemError) || error.code !== "FileNotFound")
            throw error;
          phase = "create_parent";
          await this.editor.workspace.fs.createDirectory(
            this.editor.Uri.file(dirname(params.path)),
          );
          edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
          edit.insert(uri, new this.editor.Position(0, 0), params.content);
          created = true;
        }
        if (!created) {
          phase = "open";
          doc = await this.editor.workspace.openTextDocument(uri);
        }
      }
      if (doc) {
        edit.replace(
          uri,
          new this.editor.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
          params.content,
        );
      }
      phase = "apply_edit";
      if (!(await this.editor.workspace.applyEdit(edit))) {
        throw new Error("VS Code rejected the workspace edit; no save was attempted");
      }
      phase = "open_after_edit";
      doc ??= await this.editor.workspace.openTextDocument(uri);
      phase = "save";
      if (!(await doc.save())) {
        throw new Error(
          "VS Code did not confirm saving the applied edit. Inspect the editor and read the file again before deciding whether to retry",
        );
      }
      phase = "verify_saved_content";
      if (doc.isDirty || doc.getText() !== params.content) {
        throw new Error(
          "The document changed while saving, for example through a save participant or concurrent edit. Read the file again to inspect its current contents; the requested text is not confirmed saved",
        );
      }
      logDiagnostic("info", "vscode.filesystem.completed", {
        ...fields,
        source: "editor",
        created,
        saved: true,
        durationMs: performance.now() - started,
      });
      return {};
    } catch (error) {
      this.failure("write", params, phase, error);
    }
  }
}

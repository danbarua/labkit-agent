import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

mock.module("vscode", () => ({
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }) },
}));

const { FileSystemHandler } = await import("./FileSystemHandler.ts");

const logger = await import("../utils/Logger.ts");

function editorFixture(initial?: string) {
  const disk = new Map<string, string>();
  const documents = new Map<string, any>();
  const calls: string[] = [];
  const options = { apply: true, save: true, saveTransform: false, raceCreate: false };
  const path = "/workspace/nested/report.txt";
  if (initial !== undefined) disk.set(path, initial);

  class FileSystemError extends Error {
    constructor(readonly code: string) {
      super(`${code}: ${path}`);
    }
  }

  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }

  class WorkspaceEdit {
    operations: any[] = [];
    createFile(uri: any, options: unknown) {
      this.operations.push({ kind: "create", uri, options });
    }
    insert(uri: any, _position: unknown, content: string) {
      this.operations.push({ kind: "replace", uri, content });
    }
    replace(uri: any, _range: unknown, content: string) {
      this.operations.push({ kind: "replace", uri, content });
    }
  }

  const uri = (path: string) => ({ fsPath: path, toString: () => `file://${path}` });

  const open = async (uri: any) => {
    calls.push("open");
    if (documents.has(uri.fsPath)) return documents.get(uri.fsPath);
    if (!disk.has(uri.fsPath)) throw new FileSystemError("FileNotFound");
    const doc = {
      uri,
      text: disk.get(uri.fsPath)!,
      isDirty: false,
      isClosed: false,
      getText() {
        return this.text;
      },
      positionAt(offset: number) {
        return new Position(0, offset);
      },
      async save() {
        calls.push("save");
        if (!options.save) return false;
        if (options.saveTransform) this.text += " formatted";
        disk.set(uri.fsPath, this.text);
        this.isDirty = false;
        return true;
      },
    };
    documents.set(uri.fsPath, doc);
    return doc;
  };

  const editor = {
    Uri: { file: uri },
    Position,
    Range,
    WorkspaceEdit,
    FileSystemError,
    workspace: {
      get textDocuments() {
        return [...documents.values()];
      },
      openTextDocument: open,
      fs: {
        async stat(uri: any) {
          calls.push("stat");
          if (!disk.has(uri.fsPath)) throw new FileSystemError("FileNotFound");
          return {};
        },
        async createDirectory() {
          calls.push("createDirectory");
        },
        async writeFile() {
          throw new Error("Direct disk writes bypass the editor");
        },
      },
      async applyEdit(edit: WorkspaceEdit) {
        calls.push("apply");
        if (!options.apply) return false;
        for (const op of edit.operations) {
          if (op.kind === "create") {
            expect(op.options).toEqual({ overwrite: false, ignoreIfExists: false });
            if (options.raceCreate) disk.set(op.uri.fsPath, "concurrent creation");
            if (disk.has(op.uri.fsPath)) return false;
            disk.set(op.uri.fsPath, "");
          } else {
            const doc = await open(op.uri);
            doc.text = op.content;
            doc.isDirty = true;
          }
        }
        return true;
      },
    },
  };
  return {
    handler: new FileSystemHandler(editor as any),
    editor,
    path,
    disk,
    documents,
    calls,
    options,
  };
}

test("filesystem reads include dirty editor text and preserve requested line endings", async () => {
  const f = editorFixture("old disk");
  const doc = await f.editor.workspace.openTextDocument(f.editor.Uri.file(f.path));
  doc.text = "unsaved 🌍\r\nsecond\r\nthird";
  doc.isDirty = true;
  const params = { sessionId: "session-read", path: f.path };
  expect(await f.handler.readTextFile(params)).toEqual({ content: doc.text });
  expect(await f.handler.readTextFile({ ...params, line: 2, limit: 1 })).toEqual({
    content: "second\r\n",
  });
  expect(await f.handler.readTextFile({ ...params, limit: 0 })).toEqual({ content: "" });
  expect(await f.handler.readTextFile({ ...params, line: 9 })).toEqual({ content: "" });
  expect(f.disk.get(f.path)).toBe("old disk");
  await expect(f.handler.readTextFile({ ...params, line: 0 })).rejects.toMatchObject({
    code: -32602,
  });
  await expect(f.handler.readTextFile({ ...params, path: "relative" })).rejects.toMatchObject({
    code: -32602,
  });
});

test("writes update a dirty buffer through the editor and confirm its save", async () => {
  const f = editorFixture("old disk");
  const doc = await f.editor.workspace.openTextDocument(f.editor.Uri.file(f.path));
  doc.text = "unsaved draft";
  doc.isDirty = true;
  expect(
    await f.handler.writeTextFile({
      sessionId: "session-write",
      path: f.path,
      content: "agent edit 🌍\n",
    }),
  ).toEqual({});
  expect(doc.getText()).toBe("agent edit 🌍\n");
  expect(doc.isDirty).toBe(false);
  expect(f.disk.get(f.path)).toBe(doc.getText());
  expect(f.calls.filter((call) => call === "apply")).toHaveLength(1);
  expect(f.calls.filter((call) => call === "save")).toHaveLength(1);
});

test("new files create their parent and refuse to overwrite a concurrent creation", async () => {
  const f = editorFixture();
  await f.handler.writeTextFile({ sessionId: "new", path: f.path, content: "created" });
  expect(f.disk.get(f.path)).toBe("created");
  expect(f.calls).toContain("createDirectory");
  const race = editorFixture();
  race.options.raceCreate = true;
  await expect(
    race.handler.writeTextFile({ sessionId: "race", path: race.path, content: "overwrite" }),
  ).rejects.toMatchObject({ data: { phase: "apply_edit" } });
  expect(race.disk.get(race.path)).toBe("concurrent creation");
  expect(race.calls).not.toContain("save");
});

test("rejected edits, failed saves and save transformations never report confirmed success or retry", async () => {
  for (const [option, phase] of [
    ["apply", "apply_edit"],
    ["save", "save"],
    ["saveTransform", "verify_saved_content"],
  ] as const) {
    const f = editorFixture("original");
    f.options[option] = option === "saveTransform";
    await expect(
      f.handler.writeTextFile({ sessionId: "failure", path: f.path, content: "changed" }),
    ).rejects.toMatchObject({
      code: -32603,
      data: { sessionId: "failure", path: f.path, phase },
    });
    expect(f.calls.filter((call) => call === "apply")).toHaveLength(1);
    if (option === "apply") expect(f.calls).not.toContain("save");
    if (option === "save") {
      expect(f.disk.get(f.path)).toBe("original");
      expect(f.documents.get(f.path).getText()).toBe("changed");
      expect(f.documents.get(f.path).isDirty).toBe(true);
    }
  }
});

test("real filesystem lifecycle logs retain session, path, failed phase and original cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-editor-files-"));
  logger.configureDiagnostics(directory, []);
  try {
    const f = editorFixture("original");
    await f.handler.writeTextFile({
      sessionId: "logged",
      path: f.path,
      content: "PRIVATE_CONTENT",
    });
    const success = await readFile(join(directory, "client.jsonl"), "utf8");
    expect(success).toContain('"saved":true');
    expect(success).not.toContain('"level":"warning"');
    expect(success).not.toContain('"level":"error"');
    const missing = editorFixture();
    await expect(
      missing.handler.readTextFile({ sessionId: "missing", path: missing.path }),
    ).rejects.toMatchObject({ data: { cause: { code: "FileNotFound" } } });
    f.options.save = false;
    await expect(
      f.handler.writeTextFile({
        sessionId: "save-failed",
        path: f.path,
        content: "unsaved change",
      }),
    ).rejects.toMatchObject({ data: { phase: "save" } });
    const text = await readFile(join(directory, "client.jsonl"), "utf8");
    const failure = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.level === "error");
    expect(failure).toMatchObject({
      event: "vscode.filesystem.failed",
      operation: "read",
      phase: "open",
      sessionId: "missing",
      path: missing.path,
      cause: { code: "FileNotFound" },
    });
    expect(failure.message).toContain(missing.path);
    const saveFailure = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.sessionId === "save-failed" && record.level === "error");
    expect(saveFailure).toMatchObject({ operation: "write", phase: "save", path: f.path });
    expect(saveFailure.message).toContain("did not confirm saving");
    expect(text).not.toContain("PRIVATE_CONTENT");
    const artifact = `.session-artifacts/vscode-filesystem/${crypto.randomUUID()}`;
    await mkdir(artifact, { recursive: true });
    await Bun.write(join(artifact, "diagnostics.jsonl"), text);
  } finally {
    logger.disposeChannels();
    await rm(directory, { recursive: true, force: true });
  }
});

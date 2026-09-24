import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

import {
  AppendIdSchema,
  BlobMetaSchema,
  INITIAL_REVISION,
  RevisionSchema,
} from "@labkit-agent/core/session";
import { SessionIdSchema } from "@labkit-agent/core/types";

import { persistenceContract } from "../core/session/testing/persistence-contract.ts";
import { workspaceFiles } from "./workspace-files.ts";
import { workspacePersistence } from "./workspace-persistence.ts";

const directories: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "labkit-store-"));
  directories.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const sessionId = SessionIdSchema.parse("00000000-0000-4000-8000-000000000001");
const request = {
  sessionId,
  appendId: AppendIdSchema.parse("one"),
  expectedRevision: INITIAL_REVISION,
  records: ["one", "two"],
};
persistenceContract("workspace SQLite", () => {
  const cwd = directory();
  return { writer: workspacePersistence(cwd), reader: () => workspacePersistence(cwd) };
});

test("committed journal and blobs survive process kill; interrupted transaction rolls back", async () => {
  const cwd = directory();
  const module = new URL("./workspace-persistence.ts", import.meta.url).pathname;
  const script = `import {workspacePersistence} from ${JSON.stringify(module)};
    import {Database} from 'bun:sqlite';
    const store=workspacePersistence(${JSON.stringify(cwd)});
    const s=new AbortController().signal;
    const result=await store.append(${JSON.stringify(request)},s);
    if(result.kind!=='committed')throw new Error('commit failed');
    const blob=await store.putBlob(${JSON.stringify(sessionId)},new TextEncoder().encode('durable blob'),{media:'text/plain'},s);
    const db=new Database(${JSON.stringify(join(cwd, ".labkit/sessions/store.sqlite"))});
    db.exec('BEGIN IMMEDIATE');
    db.query('INSERT INTO batches VALUES (?, ?, ?, ?)').run(${JSON.stringify(sessionId)},'uncommitted',3,'broken');
    console.log(JSON.stringify(blob));
    setInterval(()=>{},1000);`;
  const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let blob: ReturnType<typeof BlobMetaSchema.parse>;
  try {
    const data = await reader.read();
    if (!data.value) throw new Error(await new Response(child.stderr).text());
    blob = BlobMetaSchema.parse(JSON.parse(new TextDecoder().decode(data.value)));
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
  }
  const store = workspacePersistence(cwd);
  const loaded = await store.load(sessionId, signal());
  expect(loaded.kind === "loaded" && Number(loaded.revision)).toBe(2);
  expect(await store.getBlob(sessionId, blob.id, signal())).toEqual({
    meta: blob,
    bytes: new TextEncoder().encode("durable blob"),
  });
  expect(await store.append(request, signal())).toMatchObject({
    kind: "committed",
    receipt: { revision: 2 },
  });
  expect(
    await store.append(
      {
        ...request,
        appendId: AppendIdSchema.parse("next"),
        expectedRevision: RevisionSchema.parse(2),
      },
      signal(),
    ),
  ).toMatchObject({ kind: "committed", receipt: { revision: 4 } });
});

test("store is workspace-bound, hidden from tools, and rejects symlink aliases and corrupt blobs", async () => {
  const cwd = directory(),
    other = directory();
  const store = workspacePersistence(cwd);
  const files = await workspaceFiles(cwd);
  expect(() => files.path(".labkit/sessions/store.sqlite")).toThrow("reserved");
  expect(() => files.path(join(cwd, ".labkit"))).toThrow("reserved");
  symlinkSync(join(cwd, ".labkit"), join(other, ".labkit"));
  expect(() => workspacePersistence(other)).toThrow("real workspace");
  const ref = await store.putBlob(sessionId, new Uint8Array([1]), { media: "image/png" }, signal());
  const db = new Database(join(cwd, ".labkit/sessions/store.sqlite"));
  try {
    db.query("UPDATE blobs SET bytes=?").run(new Uint8Array([2]));
  } finally {
    db.close();
  }
  await expect(store.getBlob(sessionId, ref.id, signal())).rejects.toThrow("integrity");
  expect(readFileSync(join(cwd, ".labkit/sessions/store.sqlite")).length).toBeGreaterThan(0);
});

test("separate processes contend atomically; cancelled retry preserves its committed receipt", async () => {
  const cwd = directory();
  const store = workspacePersistence(cwd);
  const module = new URL("./workspace-persistence.ts", import.meta.url).pathname;
  const children = ["one", "two"].map((appendId) =>
    Bun.spawn(
      [
        "bun",
        "-e",
        `import {workspacePersistence} from ${JSON.stringify(module)};console.log(JSON.stringify(await workspacePersistence(${JSON.stringify(cwd)}).append(${JSON.stringify({ ...request, appendId })},new AbortController().signal)));`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  const outcomes = await Promise.all(
    children.map(async (child) => {
      const result = JSON.parse(await new Response(child.stdout).text());
      expect(await child.exited).toBe(0);
      return result;
    }),
  );
  expect(outcomes.map((value) => value.kind).sort()).toEqual(["committed", "conflict"]);
  const committed = outcomes.find((value) => value.kind === "committed");
  const controller = new AbortController();
  controller.abort();
  expect(
    await store.append({ ...request, appendId: committed.receipt.appendId }, controller.signal),
  ).toEqual(committed);
});

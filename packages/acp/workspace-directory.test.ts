import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { AppendIdSchema, INITIAL_REVISION } from "@labkit-agent/core/session";
import { SessionIdSchema } from "@labkit-agent/core/types";

import { workspaceDirectory } from "./workspace-directory.ts";
import { workspacePersistence } from "./workspace-persistence.ts";

const signal = () => new AbortController().signal;
test("read-only discovery paginates known workspaces, validates cursors, and survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "labkit-directory-"));
  const other = mkdtempSync(join(tmpdir(), "labkit-directory-other-"));
  try {
    const directory = workspaceDirectory(root);
    expect(directory.list({}, signal())).toEqual({ sessions: [] });
    expect(existsSync(join(root, ".labkit"))).toBe(false);
    const store = workspacePersistence(root);
    for (let i = 0; i < 53; i++) {
      const sessionId = SessionIdSchema.parse(
        `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      await store.append(
        {
          sessionId,
          appendId: AppendIdSchema.parse("one"),
          expectedRevision: INITIAL_REVISION,
          records: [
            JSON.stringify({
              body: { kind: "event", event: { type: "user", text: `  Request\n${i} ` } },
            }),
          ],
        },
        signal(),
      );
    }
    const page = directory.list({}, signal());
    expect(page.sessions).toHaveLength(50);
    expect(page.sessions[0]).toMatchObject({ cwd: realpathSync(root), title: "Request 0" });
    expect(Number.isNaN(Date.parse(page.sessions[0]!.updatedAt!))).toBe(false);
    const last = directory.list({ cursor: page.nextCursor }, signal());
    expect(last.sessions).toHaveLength(3);
    expect(last.nextCursor).toBeUndefined();
    expect(new Set([...page.sessions, ...last.sessions].map((s) => s.sessionId)).size).toBe(53);
    expect(() => directory.list({ cursor: "invented" }, signal())).toThrow("cursor");
    expect(() => directory.list({ cursor: "" }, signal())).toThrow("cursor");
    expect(() => directory.list({ cwd: other, cursor: page.nextCursor }, signal())).toThrow(
      "cursor",
    );
    expect(workspaceDirectory(root).list({}, signal()).sessions).toEqual(page.sessions);
    expect(directory.list({ cwd: other }, signal())).toEqual({ sessions: [] });
    expect(existsSync(join(other, ".labkit"))).toBe(false);
    const otherStore = workspacePersistence(other);
    await otherStore.append(
      {
        sessionId: SessionIdSchema.parse(crypto.randomUUID()),
        appendId: AppendIdSchema.parse("other"),
        expectedRevision: INITIAL_REVISION,
        records: ["opaque"],
      },
      signal(),
    );
    directory.remember(other);
    const filtered = directory.list({ cwd: other }, signal());
    expect(filtered.sessions).toHaveLength(1);
    expect(filtered.sessions[0]!.title).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(() => directory.list({}, controller.signal)).toThrow();
    // Old stores have no metadata; discover them without migration or invented timestamps.
    const db = new Database(join(other, ".labkit/sessions/store.sqlite"));
    db.exec("DROP TABLE session_info");
    db.close();
    expect(directory.list({ cwd: other }, signal()).sessions[0]!.updatedAt).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

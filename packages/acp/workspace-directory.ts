import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  RequestError,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type SessionInfo,
} from "@agentclientprotocol/sdk";
import { SessionIdSchema } from "@labkit-agent/core/types";

/** Discovery scope is the launch cwd plus workspaces seen by this factory; no global disk scan. */
export function workspaceDirectory(initialCwd = process.cwd()) {
  const roots = new Set([realpathSync(initialCwd)]);
  type Page = { filter: string | null; roots: string[]; afterRoot: string; afterId: string };
  const cursors = new Map<string, Page>();
  function remember(cwd: string) {
    roots.add(realpathSync(cwd));
  }
  function rows(cwd: string, afterId: string, limit: number): SessionInfo[] {
    const path = join(cwd, ".labkit/sessions/store.sqlite");
    try {
      for (const directory of [join(cwd, ".labkit"), join(cwd, ".labkit/sessions")]) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("Unsafe session directory");
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("Unsafe session database");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const sidecar of [`${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      try {
        const stat = lstatSync(sidecar);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error("Unsafe session database sidecar");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const db = new Database(path, { readonly: true });
    try {
      if (
        (db.query("SELECT cwd FROM workspace WHERE singleton=1").get() as { cwd: string })?.cwd !==
        cwd
      )
        throw new Error("Stored sessions belong to a different workspace cwd");
      const metadata = !!db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_info'")
        .get();
      const result = db
        .query(
          metadata
            ? `SELECT DISTINCT b.session, i.title, i.updated_at FROM batches b LEFT JOIN session_info i ON i.session=b.session WHERE b.session > ? ORDER BY b.session LIMIT ?`
            : `SELECT DISTINCT session, NULL AS title, NULL AS updated_at FROM batches WHERE session > ? ORDER BY session LIMIT ?`,
        )
        .all(afterId, limit) as {
        session: string;
        title: string | null;
        updated_at: string | null;
      }[];
      return result.map((row) => ({
        sessionId: SessionIdSchema.parse(row.session),
        cwd,
        ...(row.title ? { title: row.title } : {}),
        ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
      }));
    } finally {
      db.close();
    }
  }
  return {
    remember,
    list(params: ListSessionsRequest, signal: AbortSignal): ListSessionsResponse {
      signal.throwIfAborted();
      let filter: string | null = null;
      if (params.cwd != null) {
        try {
          filter = realpathSync(params.cwd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && params.cursor == null)
            return { sessions: [] };
          throw error;
        }
      }
      const page = params.cursor != null ? cursors.get(params.cursor) : undefined;
      if (params.cursor != null && (!page || page.filter !== filter))
        throw RequestError.invalidParams(undefined, "Invalid or expired session-list cursor");
      const selected = page?.roots ?? (filter ? [filter] : [...roots].sort());
      const sessions: SessionInfo[] = [];
      for (const cwd of selected) {
        signal.throwIfAborted();
        if (page && cwd < page.afterRoot) continue;
        sessions.push(
          ...rows(cwd, page && cwd === page.afterRoot ? page.afterId : "", 51 - sessions.length),
        );
        if (sessions.length > 50) break;
      }
      if (sessions.length <= 50) return { sessions };
      sessions.pop();
      const last = sessions.at(-1)!;
      const nextCursor = crypto.randomUUID();
      cursors.set(nextCursor, {
        filter,
        roots: selected,
        afterRoot: last.cwd,
        afterId: last.sessionId,
      });
      if (cursors.size > 32) cursors.delete(cursors.keys().next().value!);
      return { sessions, nextCursor };
    },
  };
}

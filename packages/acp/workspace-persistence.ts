import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  AppendRequestSchema,
  BlobIdSchema,
  BlobInputMetaSchema,
  BlobMetaSchema,
  CommittedBatchSchema,
  hashBlob,
  INITIAL_REVISION,
  MAX_BLOB_BYTES,
  RevisionSchema,
  type AppendResult,
  type SessionPersistence,
} from "@labkit-agent/core/session";
import { SessionIdSchema } from "@labkit-agent/core/types";

export type WorkspacePersistence = SessionPersistence & {
  deleteSession: (sessionId: string, signal: AbortSignal) => Promise<void>;
};

/** Local SQLite transactions, with no database handles retained between operations. */
export function workspacePersistence(cwd: string): WorkspacePersistence {
  const root = realpathSync(cwd);
  for (const directory of [join(root, ".labkit"), join(root, ".labkit/sessions")]) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Session storage must use real workspace directories");
  }
  const path = join(root, ".labkit/sessions/store.sqlite");
  function database() {
    // Refuse aliases, including SQLite sidecars, before SQLite opens any files.
    for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error("Session storage file has an unsafe alias");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (realpathSync(join(root, ".labkit/sessions")) !== join(root, ".labkit/sessions"))
      throw new Error("Session storage path changed");
    const db = new Database(path, { create: true });
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  const initial = database();
  try {
    initial.exec(`
      CREATE TABLE IF NOT EXISTS workspace (singleton INTEGER PRIMARY KEY CHECK(singleton=1), cwd TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (session TEXT NOT NULL, append_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session, append_id), UNIQUE(session, revision));
      CREATE TABLE IF NOT EXISTS session_info (session TEXT PRIMARY KEY, title TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_sessions (session TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS blobs (session TEXT NOT NULL, id TEXT NOT NULL, meta TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(session, id));
    `);
    initial.query("INSERT OR IGNORE INTO workspace VALUES (1, ?)").run(root);
    if (
      (initial.query("SELECT cwd FROM workspace WHERE singleton=1").get() as { cwd: string })
        .cwd !== root
    )
      throw new Error("Stored sessions belong to a different workspace cwd");
  } finally {
    initial.close();
  }
  return {
    lifetime:
      "workspace-local SQLite; retained until session deletion or removal of .labkit/sessions",
    async deleteSession(rawId, signal) {
      signal.throwIfAborted();
      const sessionId = SessionIdSchema.parse(rawId);
      const db = database();
      try {
        db.transaction(() => {
          signal.throwIfAborted();
          db.query("INSERT OR IGNORE INTO deleted_sessions VALUES (?)").run(sessionId);
          db.query("DELETE FROM batches WHERE session=?").run(sessionId);
          db.query("DELETE FROM session_info WHERE session=?").run(sessionId);
          db.query("DELETE FROM blobs WHERE session=?").run(sessionId);
        }).immediate();
      } finally {
        db.close();
      }
    },
    async load(rawId, signal) {
      try {
        signal.throwIfAborted();
        const id = SessionIdSchema.parse(rawId);
        const db = database();
        try {
          const rows = db
            .query("SELECT body FROM batches WHERE session=? ORDER BY revision")
            .all(id) as { body: string }[];
          const batches = rows.map((row) => CommittedBatchSchema.parse(JSON.parse(row.body)));
          let revision = INITIAL_REVISION;
          for (const batch of batches) {
            if (
              batch.sessionId !== id ||
              batch.expectedRevision !== revision ||
              batch.revision !== revision + batch.records.length
            )
              throw new Error("Invalid journal continuity");
            revision = batch.revision;
          }
          return batches.length ? { kind: "loaded", revision, batches } : { kind: "not_found" };
        } finally {
          db.close();
        }
      } catch (error) {
        return { kind: "failed", message: error instanceof Error ? error.message : "Load failed" };
      }
    },
    async append(raw, signal) {
      const parsed = AppendRequestSchema.safeParse(raw);
      if (!parsed.success) return { kind: "rejected", message: parsed.error.message };
      const request = parsed.data;
      try {
        const db = database();
        try {
          return db
            .transaction((): AppendResult => {
              if (db.query("SELECT 1 FROM deleted_sessions WHERE session=?").get(request.sessionId))
                return { kind: "rejected", message: "Session was deleted" };
              const old = db
                .query("SELECT body FROM batches WHERE session=? AND append_id=?")
                .get(request.sessionId, request.appendId) as { body: string } | null;
              if (old) {
                const { revision, ...original } = CommittedBatchSchema.parse(JSON.parse(old.body));
                return JSON.stringify(original) === JSON.stringify(request)
                  ? {
                      kind: "committed",
                      receipt: {
                        sessionId: request.sessionId,
                        appendId: request.appendId,
                        revision,
                      },
                    }
                  : { kind: "rejected", message: "Append ID reused with different content" };
              }
              if (signal.aborted) return { kind: "rejected", message: "Cancelled before append" };
              const last = db
                .query("SELECT MAX(revision) AS revision FROM batches WHERE session=?")
                .get(request.sessionId) as { revision: number | null };
              const revision = RevisionSchema.parse(last.revision ?? 0);
              if (revision !== request.expectedRevision) return { kind: "conflict", revision };
              const next = RevisionSchema.parse(revision + request.records.length);
              db.query("INSERT INTO batches VALUES (?, ?, ?, ?)").run(
                request.sessionId,
                request.appendId,
                next,
                JSON.stringify({ ...request, revision: next }),
              );
              let title: string | null = null;
              for (const rawRecord of request.records) {
                try {
                  const record = JSON.parse(rawRecord);
                  const event = record?.body?.kind === "event" ? record.body.event : undefined;
                  if (
                    event?.type === "user" &&
                    typeof event.text === "string" &&
                    event.text.trim()
                  ) {
                    title = event.text.trim().replace(/\s+/g, " ").slice(0, 120);
                    break;
                  }
                } catch {
                  /* The port stores opaque record strings; the runtime validates them. */
                }
              }
              db.query(
                `INSERT INTO session_info VALUES (?, ?, ?)
                ON CONFLICT(session) DO UPDATE SET title=COALESCE(session_info.title, excluded.title), updated_at=excluded.updated_at`,
              ).run(request.sessionId, title, new Date().toISOString());
              return {
                kind: "committed",
                receipt: {
                  sessionId: request.sessionId,
                  appendId: request.appendId,
                  revision: next,
                },
              };
            })
            .immediate();
        } finally {
          db.close();
        }
      } catch (error) {
        return {
          kind: "indeterminate",
          message: error instanceof Error ? error.message : "Append failed",
        };
      }
    },
    async putBlob(rawId, rawBytes, rawMeta, signal) {
      signal.throwIfAborted();
      const sessionId = SessionIdSchema.parse(rawId);
      const metadata = BlobInputMetaSchema.parse(rawMeta);
      if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength > MAX_BLOB_BYTES)
        throw new Error("Blob must be bytes, at most 8 MiB");
      const bytes = Uint8Array.from(rawBytes);
      const id = hashBlob(bytes);
      const meta = BlobMetaSchema.parse({ ...metadata, id, bytes: bytes.byteLength });
      const db = database();
      try {
        return db
          .transaction(() => {
            if (db.query("SELECT 1 FROM deleted_sessions WHERE session=?").get(sessionId))
              throw new Error("Session was deleted");
            signal.throwIfAborted();
            const old = db
              .query("SELECT meta FROM blobs WHERE session=? AND id=?")
              .get(sessionId, id) as { meta: string } | null;
            if (old) {
              const previous = BlobMetaSchema.parse(JSON.parse(old.meta));
              if (previous.media !== meta.media)
                throw new Error("Blob media cannot change for existing bytes");
              return previous;
            }
            db.query("INSERT INTO blobs VALUES (?, ?, ?, ?)").run(
              sessionId,
              id,
              JSON.stringify(meta),
              bytes,
            );
            return meta;
          })
          .immediate();
      } finally {
        db.close();
      }
    },
    async getBlob(rawId, rawHash, signal) {
      signal.throwIfAborted();
      const sessionId = SessionIdSchema.parse(rawId);
      const id = BlobIdSchema.parse(rawHash);
      const db = database();
      try {
        const row = db
          .query("SELECT meta, bytes FROM blobs WHERE session=? AND id=?")
          .get(sessionId, id) as { meta: string; bytes: Uint8Array } | null;
        if (!row) return { kind: "not_found" };
        const meta = BlobMetaSchema.parse(JSON.parse(row.meta));
        const bytes = Uint8Array.from(row.bytes);
        if (meta.id !== id || meta.bytes !== bytes.length || hashBlob(bytes) !== id)
          throw new Error("Blob integrity failure");
        return { meta, bytes };
      } finally {
        db.close();
      }
    },
  };
}

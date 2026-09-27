# Hosting the ACP agent over HTTP

This note settles how the agent is served to a browser (conformance item G22). It answers three
questions: which connection owns a session, what protects the session store when several
connections share one process, and who may reach the endpoint. The stdio launcher is unchanged.

## Transport

The host uses `AcpServer` from `@agentclientprotocol/sdk/experimental/server` (SDK 1.5.0) and
serves Streamable HTTP at `/acp`. The SDK marks this transport experimental and ACP v1 does not
specify it, so conformance here means conformance with the SDK's implementation of it. WebSocket
is served by the same SDK class but needs a Bun socket adapter; it is a separate item.

Each accepted ACP connection is one `connectAcp` instance, built by the server's per-connection
factory. Everything `connectAcp` owns today stays per connection: the initialize and auth gate,
the session registry, MCP-over-ACP bridges, client permission requests, terminals and
`session/update` delivery. The connection's `closed` promise resolves only after its sessions
have shut down, so closing the server waits for every runtime to close.

The SDK assigns its own connection ID (the `Acp-Connection-Id` header). The host logs
`acp.http.connection.opened` with both that ID (`httpConnectionId`) and the adapter's
`connectionId`, so HTTP request logs and adapter logs join on one event.

## Session ownership

**A connection owns the sessions it opened, and closing it closes them.** A connection closes on
`DELETE /acp` or on server shutdown; a dropped event stream does not close it. A browser that
reconnects starts a new ACP connection and reopens its session with `session/load`, which
replays the journal. The host therefore requires `loadSession: true` and refuses to start
without it.

**One process runs at most one live runtime per session.** Two runtimes on one session would both
append to the journal; the second append fails with a revision conflict and its turn fails. The
host keeps a process-wide session lease. Every lifecycle method that opens or removes a runtime
claims the lease first: `session/new`, `load` and `resume`; `session/fork`, including when it
opens a parent privately because the parent is not open on this connection; and
`session/delete`. (`session/new` claims its ID as soon as core assigns it, before the session is
published; no other connection can hold a new ID.) Every path that removes a session from a
connection releases it.

**The newest claim wins.** When a connection claims a session another connection holds, the host
closes the holder's session exactly as `session/close` would. A running prompt on the old
connection ends with stop reason `cancelled`. If the holder is still opening, forking or deleting
the session, that operation is aborted and the claim waits for it to let go. Claims on one session
run one at a time, in arrival order; a claim cancelled while it waits takes nothing over. A later
request for that session on the old connection fails with an error naming the connection that took
it over (and, after a `delete`, saying it was deleted). Then the claim proceeds:

- `load`, `resume` and `new` open the session on the claiming connection.
- `fork` opens the parent privately, forks it, and releases the parent's lease. The old holder
  does not get the parent back; it reopens it with `session/load` if it still wants it.
- `delete` deletes the journal. It never deletes from under a live runtime.

Streamable HTTP has no liveness signal: a tab that crashes never sends `DELETE`, so refusing the
second claim would strand the session until the host restarts. The takeover is logged as
`acp.session.taken_over` with both connection IDs and the claiming method; it is a WARNING when
it cancels a running prompt and INFO otherwise.

The lease is per process. Two separate agent processes (two stdio launchers, or a launcher and an
HTTP host) on the same session still meet at the journal and resolve by revision conflict, as
they do today.

## The session store

The workspace store (`<cwd>/.labkit/sessions/store.sqlite`) already tolerates several writers:
it sets `busy_timeout`, appends in a transaction, and rejects an append whose expected revision is
stale. The lease above keeps one process from producing those conflicts itself. No further store
change is needed.

## Exposure

The agent runs commands and writes files, so the endpoint is closed by default:

- The host binds `127.0.0.1` only. There is no option to bind another interface.
- Every request carries `Authorization: Bearer <token>`. The token comes from
  `LABKIT_ACP_HTTP_TOKEN`, must be at least 32 characters, and is compared in constant time. The
  host refuses to start without it. A rejected request gets `401` and logs `acp.http.rejected`
  at WARNING with the method, path and reason (`missing_token` or `bad_token`), never the token.
  The host serves only `/acp`; other paths get `404`.
- The host sends no CORS headers. A browser reaches it through its own server, which adds the
  token (for labkit, the web app's dev server proxies `/acp`). The token never reaches page
  script.

ACP `authenticate` is unchanged and separate: it governs provider credentials inside a connection,
not who may connect.

## Known limits

- A connection whose client vanished without `DELETE` keeps its sessions open until another
  connection takes them over or the host stops. There is no idle reaping.
- WebSocket is not served.
- Logs go to the launcher's rotated files in `~/.labkit/logs/`; stdout carries nothing in HTTP
  mode.

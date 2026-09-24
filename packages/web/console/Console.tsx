import { ArrowUp, Paperclip, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Mark } from "../components/brand/mark.tsx";
import { StatusBadge } from "../components/brand/status-badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import type {
  BlobChip,
  ConsoleEvent,
  HostInfo,
  MediaKind,
  MessageView,
  PublicReceipt,
  SessionView,
} from "../protocol.ts";

type Draft = { text: string; thinking: string };
type Preview = { chip: BlobChip; url: string; text?: string };

const EMPTY: HostInfo = { mode: "fixture", providers: [] };

function mediaFor(file: File): MediaKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown";
  if (name.endsWith(".txt")) return "text/plain";
  if (file.type === "image/png" || name.endsWith(".png")) return "image/png";
  if (file.type === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg"))
    return "image/jpeg";
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "application/pdf";
  return null;
}

function hashPrefix(id: string) {
  return id.slice(0, 8);
}

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? response.statusText;
}

export function Console() {
  const [host, setHost] = useState<HostInfo>(EMPTY);
  const [view, setView] = useState<SessionView | null>(null);
  const [sessionId, setSessionId] = useState(() => sessionStorage.getItem("labkit-session"));
  const [draft, setDraft] = useState<Draft>({ text: "", thinking: "" });
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [awaitingReceipt, setAwaitingReceipt] = useState(false);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("off");
  const [stream, setStream] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch("/api/host")
      .then((response) => response.json() as Promise<HostInfo>)
      .then((info) => {
        setHost(info);
        const first = info.providers[0];
        if (!first) return;
        setProviderId((current) => current || first.id);
        setModel((current) => current || first.defaultModel);
      });
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const source = new EventSource(`/api/session/${sessionId}/events`);
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      sessionStorage.removeItem("labkit-session");
      setSessionId(null);
      setView(null);
    };
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ConsoleEvent;
      if (event.kind === "snapshot") {
        setView(event.view);
        if (event.view.phase === "idle") setDraft({ text: "", thinking: "" });
      } else if (event.kind === "delta") {
        setDraft((current) => ({
          text: current.text + (event.text ?? ""),
          thinking: current.thinking + (event.thinking ?? ""),
        }));
      } else if (event.kind === "receipt") {
        setAwaitingReceipt(false);
        setNotice(event.receipt.kind === "accepted" ? "" : receiptText(event.receipt));
      }
    };
    return () => source.close();
  }, [sessionId]);

  const provider = host.providers.find((item) => item.id === providerId);
  const active = view !== null && view.phase !== "idle";
  const messages = useMemo(() => {
    if (!view) return [];
    const settled = view.log.flatMap((turn, turnIndex) => [
      ...turn.messages.map((message, messageIndex) => ({
        key: `${turnIndex}:${messageIndex}`,
        message,
      })),
      ...(turn.outcome.kind === "completed"
        ? []
        : [
            {
              key: `${turnIndex}:outcome`,
              message: {
                role: "system" as const,
                text: turn.outcome.message
                  ? `${turn.outcome.kind}: ${turn.outcome.message}`
                  : turn.outcome.kind,
              },
            },
          ]),
    ]);
    const live = view.live.map((message, messageIndex) => ({
      key: `live:${messageIndex}`,
      message,
    }));
    return [...settled, ...live];
  }, [view]);

  async function startSession(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: providerId || undefined,
        model: model || undefined,
        thinking,
        stream: stream && provider?.stream,
      }),
    });
    if (!response.ok) {
      setNotice(await readError(response));
      return;
    }
    const created = (await response.json()) as { sessionId: string; view: SessionView };
    sessionStorage.setItem("labkit-session", created.sessionId);
    setSessionId(created.sessionId);
    setView(created.view);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!view || awaitingReceipt) return;
    setNotice("");
    setAwaitingReceipt(true);
    try {
      const attachments = [];
      for (const file of files) {
        const media = mediaFor(file);
        if (!media) throw new Error(`${file.name} is not markdown, text, png, jpeg, or pdf`);
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} exceeds 8 MiB`);
        const uploaded = await fetch(`/api/session/${view.sessionId}/blob`, {
          method: "POST",
          headers: { "Content-Type": media, "X-Blob-Name": file.name },
          body: file,
        });
        if (!uploaded.ok) throw new Error(await readError(uploaded));
        attachments.push(await uploaded.json());
      }
      const response = await fetch(`/api/session/${view.sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, attachments }),
      });
      const body = (await response.json()) as { receipt?: PublicReceipt; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Input was rejected");
      setAwaitingReceipt(false);
      setNotice(body.receipt && body.receipt.kind !== "accepted" ? receiptText(body.receipt) : "");
      if (body.receipt?.kind === "accepted") {
        setText("");
        setFiles([]);
      }
    } catch (error) {
      setAwaitingReceipt(false);
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function abortTurn() {
    if (!view) return;
    setNotice("");
    const response = await fetch(`/api/session/${view.sessionId}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "abort" }),
    });
    const body = (await response.json()) as { receipt?: PublicReceipt; error?: string };
    if (!response.ok) setNotice(body.error ?? "Abort failed");
    else if (body.receipt && body.receipt.kind !== "accepted") setNotice(receiptText(body.receipt));
  }

  async function applyPolicy(event: FormEvent) {
    event.preventDefault();
    if (!view) return;
    setNotice("");
    const patch: Record<string, unknown> = {
      thinking,
      stream: stream && Boolean(provider?.stream),
    };
    if (providerId) patch.provider = providerId;
    if (model.trim()) patch.model = model.trim();
    const response = await fetch(`/api/session/${view.sessionId}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "policy", patch }),
    });
    const body = (await response.json()) as { receipt?: PublicReceipt; error?: string };
    if (!response.ok) setNotice(body.error ?? "Policy was rejected");
    else if (body.receipt && body.receipt.kind !== "accepted") setNotice(receiptText(body.receipt));
  }

  async function openPreview(chip: BlobChip) {
    if (!view) return;
    const response = await fetch(`/api/session/${view.sessionId}/blob/${chip.id}`);
    if (!response.ok) {
      setNotice("Attachment bytes are missing");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const textBody =
      chip.media === "text/markdown" || chip.media === "text/plain" ? await blob.text() : undefined;
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return { chip, url, text: textBody };
    });
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-5 py-6 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <a href="/" className="inline-flex items-center gap-2 text-ink">
          <Mark className="h-8" />
          <span className="font-wordmark text-xl font-bold tracking-[-0.03em]">Labkit Agent</span>
        </a>
        <div className="flex items-center gap-3">
          {view ? <StatusBadge tone="committed">{view.phase}</StatusBadge> : null}
          <a
            href="/brand"
            className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase"
          >
            Brand
          </a>
        </div>
      </header>

      {notice ? (
        <p
          role="alert"
          className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-ink"
        >
          {notice}
        </p>
      ) : null}

      {!view ? (
        <form
          onSubmit={startSession}
          className="grid max-w-xl gap-4 rounded-lg border border-border bg-white p-5"
        >
          <div>
            <h1 className="font-wordmark text-2xl font-bold tracking-[-0.03em]">Start a session</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {host.mode === "fixture"
                ? "No provider keys are bound. Replies use the fixture answer."
                : "The server holds credentials. This browser never calls a provider."}
            </p>
          </div>
          <PolicyFields
            host={host}
            providerId={providerId}
            model={model}
            thinking={thinking}
            stream={stream}
            onProvider={setProviderId}
            onModel={setModel}
            onThinking={setThinking}
            onStream={setStream}
          />
          <Button type="submit" className="w-fit">
            Start session
          </Button>
        </form>
      ) : (
        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <section className="flex min-h-[28rem] flex-col rounded-lg border border-border bg-white">
            <div
              ref={scroller}
              className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
              aria-live="polite"
            >
              {messages.length === 0 && !draft.text && !draft.thinking ? (
                <p className="text-sm text-muted-foreground">
                  {view.phase === "idle"
                    ? "Session is idle."
                    : `${view.phase.replaceAll("_", " ")}…`}
                </p>
              ) : null}
              {messages.map((item) => (
                <Message key={item.key} message={item.message} onOpen={openPreview} />
              ))}
              {view.phase === "awaiting_model" && !draft.text && !draft.thinking ? (
                <p className="text-sm text-muted-foreground">awaiting model…</p>
              ) : null}
              {draft.text || draft.thinking ? (
                <article className="rounded-md border border-teal/30 bg-teal/5 px-3 py-2">
                  <p className="mb-1 text-[10px] font-semibold tracking-[0.16em] text-teal uppercase">
                    Stream draft
                  </p>
                  {draft.thinking ? (
                    <p className="mb-2 font-mono text-xs text-muted-foreground">{draft.thinking}</p>
                  ) : null}
                  <p className="whitespace-pre-wrap text-sm">{draft.text}</p>
                </article>
              ) : null}
            </div>
            <form onSubmit={send} className="grid gap-3 border-t border-border p-4">
              {files.length ? (
                <ul className="flex flex-wrap gap-2">
                  {files.map((file) => (
                    <li
                      key={file.name}
                      className="rounded-full border border-border px-2 py-1 text-xs"
                    >
                      {file.name}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Message the session"
                rows={3}
              />
              <div className="flex items-center justify-between gap-3">
                <div>
                  <input
                    ref={fileRef}
                    type="file"
                    className="sr-only"
                    accept=".md,.markdown,.txt,.png,.jpg,.jpeg,.pdf,text/plain,text/markdown,image/png,image/jpeg,application/pdf"
                    multiple
                    onChange={(event) => setFiles([...(event.target.files ?? [])])}
                  />
                  <Button type="button" variant="ghost" onClick={() => fileRef.current?.click()}>
                    <Paperclip />
                    Attach
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={abortTurn} disabled={!active}>
                    <Square />
                    Abort
                  </Button>
                  <Button
                    type="submit"
                    disabled={awaitingReceipt || (!text.trim() && files.length === 0)}
                  >
                    <ArrowUp />
                    Send
                  </Button>
                </div>
              </div>
            </form>
          </section>

          <aside className="grid content-start gap-4">
            <form
              onSubmit={applyPolicy}
              className="grid gap-3 rounded-lg border border-border bg-white p-4"
            >
              <h2 className="text-[11px] font-semibold tracking-[0.18em] uppercase">Policy</h2>
              <p className="font-mono text-xs text-muted-foreground">
                {view.policy.provider ?? "fixture"} · {view.policy.model ?? "fixture"} ·{" "}
                {view.policy.thinking ?? "off"} · stream {view.policy.stream ? "on" : "off"}
              </p>
              <PolicyFields
                host={host}
                providerId={providerId || view.policy.provider || ""}
                model={model || view.policy.model || ""}
                thinking={thinking}
                stream={stream}
                onProvider={setProviderId}
                onModel={setModel}
                onThinking={setThinking}
                onStream={setStream}
              />
              <Button type="submit" variant="outline" className="w-fit">
                Apply at idle
              </Button>
            </form>
            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="text-[11px] font-semibold tracking-[0.18em] uppercase">Permission</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Permission gate not in this runtime yet.
              </p>
              <p className="mt-2 font-mono text-xs text-cool">
                {"{ tool, kind?, locations?, options }"}
              </p>
            </section>
            {preview ? (
              <section className="rounded-lg border border-border bg-white p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">
                    {preview.chip.name ?? hashPrefix(preview.chip.id)}
                  </h2>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      URL.revokeObjectURL(preview.url);
                      setPreview(null);
                    }}
                  >
                    Close
                  </Button>
                </div>
                {preview.text !== undefined ? (
                  <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap">
                    {preview.text}
                  </pre>
                ) : preview.chip.media === "application/pdf" ? (
                  <iframe
                    title={preview.chip.name ?? "PDF"}
                    src={preview.url}
                    className="h-80 w-full"
                  />
                ) : (
                  <img
                    src={preview.url}
                    alt={preview.chip.name ?? "Attachment"}
                    className="max-h-80 w-full object-contain"
                  />
                )}
              </section>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

function receiptText(receipt: PublicReceipt) {
  if (receipt.kind === "failed") return receipt.message ?? "Rejected";
  if (receipt.kind === "busy")
    return "Busy. Abort the turn before changing policy or sending during tools.";
  return receipt.kind;
}

function PolicyFields({
  host,
  providerId,
  model,
  thinking,
  stream,
  onProvider,
  onModel,
  onThinking,
  onStream,
}: {
  host: HostInfo;
  providerId: string;
  model: string;
  thinking: string;
  stream: boolean;
  onProvider: (value: string) => void;
  onModel: (value: string) => void;
  onThinking: (value: string) => void;
  onStream: (value: boolean) => void;
}) {
  const provider = host.providers.find((item) => item.id === providerId) ?? host.providers[0];
  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm">
        Provider
        <select
          className="h-9 rounded-md border border-border bg-paper px-2"
          value={providerId}
          onChange={(event) => onProvider(event.target.value)}
          disabled={host.mode === "fixture"}
        >
          {host.providers.length === 0 ? <option value="">fixture</option> : null}
          {host.providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Model
        <input
          className="h-9 rounded-md border border-border bg-paper px-2"
          value={model}
          onChange={(event) => onModel(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Thinking
        <select
          className="h-9 rounded-md border border-border bg-paper px-2"
          value={thinking}
          onChange={(event) => onThinking(event.target.value)}
        >
          {(provider?.thinking ?? ["off"]).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={stream && Boolean(provider?.stream)}
          disabled={!provider?.stream}
          onChange={(event) => onStream(event.target.checked)}
        />
        Stream{provider?.stream ? "" : " (profile cannot stream)"}
      </label>
    </div>
  );
}

function Message({ message, onOpen }: { message: MessageView; onOpen: (chip: BlobChip) => void }) {
  return (
    <article className="grid gap-1 text-sm">
      <p className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
        {message.role}
      </p>
      {message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null}
      {message.calls?.map((call) => (
        <p key={call.id} className="font-mono text-xs text-ink">
          {call.name} {JSON.stringify(call.args)}
        </p>
      ))}
      {message.attachments?.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className="w-fit rounded-full border border-teal px-2 py-1 text-xs text-teal"
          onClick={() => onOpen(chip)}
        >
          {chip.name ?? chip.media} · {hashPrefix(chip.id)}
        </button>
      ))}
    </article>
  );
}

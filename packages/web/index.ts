import { serve } from "bun";

import index from "./index.html";
import { MEDIA_KINDS, type BlobChip, type CreateSessionBody } from "./protocol.ts";
import {
  admit,
  eventResponse,
  hostInfo,
  openSession,
  readBlob,
  storeBlob,
} from "./server/session-host.ts";

const MEDIA = new Set<string>(MEDIA_KINDS);

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

async function readJson(req: Request) {
  try {
    return (await req.json()) as unknown;
  } catch {
    return null;
  }
}

const server = serve({
  port: Number(process.env.PORT) || 3000,
  routes: {
    "/api/host": () => json(hostInfo()),

    "/api/session": {
      async POST(req) {
        const body = (await readJson(req)) ?? {};
        if (!body || typeof body !== "object") return json({ error: "Expected JSON" }, 400);
        try {
          return json(await openSession(body as CreateSessionBody));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      },
    },

    "/api/session/:id/events": (req) => eventResponse(req.params.id, req.signal),

    "/api/session/:id/event": {
      async POST(req) {
        const result = await admit(req.params.id, await readJson(req));
        return json(result.body, result.status);
      },
    },

    "/api/session/:id/input": {
      async POST(req) {
        const body = await readJson(req);
        if (!body || typeof body !== "object") return json({ error: "Expected JSON" }, 400);
        const record = body as { text?: unknown; attachments?: unknown };
        const event = {
          type: "user",
          ...(typeof record.text === "string" ? { text: record.text } : {}),
          ...(Array.isArray(record.attachments) ? { attachments: record.attachments } : {}),
        };
        const result = await admit(req.params.id, event);
        return json(result.body, result.status);
      },
    },

    "/api/session/:id/blob": {
      async POST(req) {
        const media = req.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
        if (!MEDIA.has(media)) return json({ error: "Unsupported media" }, 415);
        const declared = Number(req.headers.get("content-length") ?? "0");
        if (declared > 8 * 1024 * 1024) return json({ error: "Blob exceeds 8 MiB" }, 413);
        const name = req.headers.get("x-blob-name") ?? undefined;
        try {
          const bytes = new Uint8Array(await req.arrayBuffer());
          const meta = await storeBlob(req.params.id, bytes, media, name);
          return json(meta satisfies BlobChip);
        } catch (error) {
          if (error instanceof Response) return error;
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      },
    },

    "/api/session/:id/blob/:blobId": {
      async GET(req) {
        try {
          const loaded = await readBlob(req.params.id, req.params.blobId);
          if (!loaded) return new Response("Not found", { status: 404 });
          return new Response(Buffer.from(loaded.bytes), {
            headers: {
              "Content-Type": loaded.meta.media,
              "Cache-Control": "private, max-age=31536000, immutable",
            },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      },
    },

    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);

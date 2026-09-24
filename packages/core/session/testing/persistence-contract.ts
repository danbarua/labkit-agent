import { describe, expect, test } from "@logtape/testing-bun/autoload";

import { SessionIdSchema } from "../../agent/types.ts";
import {
  AppendIdSchema,
  BlobIdSchema,
  INITIAL_REVISION,
  MAX_BLOB_BYTES,
  RevisionSchema,
  type AppendRequest,
  type SessionPersistence,
} from "../persistence.ts";

/** Each factory call isolates a test; reader() supplies an independent connection to the same data. */
export function persistenceContract(
  name: string,
  factory: () => { writer: SessionPersistence; reader: () => SessionPersistence },
) {
  describe(name, () => {
    const sessionId = SessionIdSchema.parse("00000000-0000-4000-8000-000000000001");
    const signal = () => new AbortController().signal;
    const request = (extra: Partial<AppendRequest> = {}): AppendRequest => ({
      sessionId,
      expectedRevision: INITIAL_REVISION,
      appendId: AppendIdSchema.parse("one"),
      records: ['{"one":1}', '{"two":2}'],
      ...extra,
    });
    test("blob put/get is content-addressed, session-scoped, idempotent and alias-safe", async () => {
      const { writer, reader } = factory();
      const bytes = new TextEncoder().encode("abc");
      const put = writer.putBlob(
        sessionId,
        bytes,
        { media: "text/markdown", name: "DESIGN.md" },
        signal(),
      );
      bytes.fill(0);
      const meta = await put;
      expect(String(meta.id)).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
      const original = new TextEncoder().encode("abc");
      expect(
        await writer.putBlob(
          sessionId,
          original,
          { media: "text/markdown", name: "DESIGN.md" },
          signal(),
        ),
      ).toEqual(meta);
      const loaded = await reader().getBlob(sessionId, meta.id, signal());
      if ("kind" in loaded) throw new Error("Missing blob");
      expect(loaded.meta).toEqual(meta);
      expect(loaded.bytes).toEqual(original);
      loaded.bytes.fill(0);
      expect(await reader().getBlob(sessionId, meta.id, signal())).toEqual({
        meta,
        bytes: original,
      });
      expect(
        await reader().getBlob(
          SessionIdSchema.parse("00000000-0000-4000-8000-000000000002"),
          meta.id,
          signal(),
        ),
      ).toEqual({ kind: "not_found" });
      expect(
        await reader().getBlob(sessionId, BlobIdSchema.parse("0".repeat(64)), signal()),
      ).toEqual({ kind: "not_found" });
      expect(await reader().load(sessionId, signal())).toEqual({ kind: "not_found" });
    });
    test("blob size and cancellation are checked before writing", async () => {
      const { writer, reader } = factory();
      const controller = new AbortController();
      controller.abort();
      await expect(
        writer.putBlob(sessionId, new Uint8Array([1]), { media: "image/png" }, controller.signal),
      ).rejects.toThrow();
      await expect(
        reader().getBlob(sessionId, BlobIdSchema.parse("0".repeat(64)), controller.signal),
      ).rejects.toThrow();
      await expect(
        writer.putBlob(
          sessionId,
          new Uint8Array(MAX_BLOB_BYTES + 1),
          { media: "image/png" },
          signal(),
        ),
      ).rejects.toThrow();
      expect(
        await reader().getBlob(
          sessionId,
          BlobIdSchema.parse("4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a"),
          signal(),
        ),
      ).toEqual({ kind: "not_found" });
    });
    test("creates absent streams, preserves order, and exposes atomic batches to independent readers", async () => {
      const { writer, reader } = factory();
      expect(await reader().load(sessionId, signal())).toEqual({ kind: "not_found" });
      const first = await writer.append(request(), signal());
      expect(first).toMatchObject({
        kind: "committed",
        receipt: { sessionId, appendId: "one", revision: 2 },
      });
      expect(
        await writer.append(
          request({
            expectedRevision: RevisionSchema.parse(2),
            appendId: AppendIdSchema.parse("two"),
            records: ["third"],
          }),
          signal(),
        ),
      ).toMatchObject({ kind: "committed", receipt: { revision: 3 } });
      const loaded = await reader().load(sessionId, signal());
      expect(loaded.kind).toBe("loaded");
      if (loaded.kind === "loaded")
        expect(loaded.batches.flatMap((batch) => batch.records)).toEqual([
          ...request().records,
          "third",
        ]);
    });
    test("idempotent retries precede revision checks; ID reuse with different bytes is rejected", async () => {
      const { writer, reader } = factory();
      const first = await writer.append(request(), signal());
      await writer.append(
        request({
          appendId: AppendIdSchema.parse("later"),
          expectedRevision: RevisionSchema.parse(2),
        }),
        signal(),
      );
      expect(await reader().append(request(), signal())).toEqual(first);
      expect((await writer.append(request({ records: ["changed"] }), signal())).kind).toBe(
        "rejected",
      );
      expect(
        (await writer.append(request({ expectedRevision: RevisionSchema.parse(4) }), signal()))
          .kind,
      ).toBe("rejected");
      const loaded = await reader().load(sessionId, signal());
      expect(loaded.kind === "loaded" && Number(loaded.revision)).toBe(4);
    });
    test("competing writers commit exactly one complete batch", async () => {
      const { writer, reader } = factory();
      const results = await Promise.all([
        writer.append(request(), signal()),
        reader().append(request({ appendId: AppendIdSchema.parse("competitor") }), signal()),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["committed", "conflict"]);
      const loaded = await reader().load(sessionId, signal());
      expect(loaded.kind === "loaded" && loaded.batches.length).toBe(1);
      expect(loaded.kind === "loaded" && Number(loaded.revision)).toBe(2);
    });
    test("empty batch rejects without creating a stream; cancellation never implies rollback", async () => {
      const { writer, reader } = factory();
      expect((await writer.append(request({ records: [] }), signal())).kind).toBe("rejected");
      expect((await reader().load(sessionId, signal())).kind).toBe("not_found");
      const controller = new AbortController();
      controller.abort();
      const result = await writer.append(request(), controller.signal);
      const loaded = await reader().load(sessionId, signal());
      if (result.kind === "committed") expect(loaded.kind).toBe("loaded");
      if (result.kind === "rejected" || result.kind === "conflict")
        expect(loaded.kind).toBe("not_found");
      expect(["committed", "rejected", "indeterminate"]).toContain(result.kind);
    });
    test("read values and submitted arrays cannot mutate committed bytes", async () => {
      const { writer, reader } = factory();
      const records = ["original"];
      await writer.append(request({ records }), signal());
      records[0] = "mutated";
      const first = await reader().load(sessionId, signal());
      const second = await reader().load(sessionId, signal());
      expect(first).toEqual(second);
      expect(second.kind === "loaded" && second.batches[0]!.records).toEqual(["original"]);
    });
  });
}

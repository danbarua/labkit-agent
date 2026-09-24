import type { SessionInfoUpdate } from "@agentclientprotocol/sdk";
import { z } from "zod";

const InfoSchema = z.strictObject({
  title: z.string().max(4096).nullable().optional(),
  updatedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  _meta: z.record(z.string(), z.json()).nullable().optional(),
});
export function parseSessionInfo(value: unknown): SessionInfoUpdate | undefined {
  if (value === undefined) return;
  const info = InfoSchema.parse(value);
  if (!Object.values(info).some((value) => value !== undefined)) return;
  if (Buffer.byteLength(JSON.stringify(info)) > 64 * 1024)
    throw new Error("Session info exceeds 64 KiB");
  return info;
}

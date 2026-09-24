import { expect, test } from "bun:test";

import { parseSessionInfo } from "./session-info.ts";

test("session info validates timestamps and explicit clearing without inventing omitted fields", () => {
  expect(parseSessionInfo(undefined)).toBeUndefined();
  expect(parseSessionInfo({})).toBeUndefined();
  expect(parseSessionInfo({ title: null })).toEqual({ title: null });
  expect(parseSessionInfo({ updatedAt: "2026-01-01T12:00:00+01:00" })).toEqual({
    updatedAt: "2026-01-01T12:00:00+01:00",
  });
  expect(() => parseSessionInfo({ updatedAt: "yesterday" })).toThrow();
  expect(() => parseSessionInfo({ title: 2 })).toThrow();
  expect(() => parseSessionInfo({ _meta: { huge: "x".repeat(65536) } })).toThrow();
});

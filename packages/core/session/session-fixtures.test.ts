import { expect, test } from "bun:test";
import { runFixtures } from "./fixture-runner.ts";

test("approved structured and readable fixtures match across repeated deterministic runs", async () => {
  const first = await runFixtures({ artifactDirectory: ".session-artifacts/test-first" });
  const second = await runFixtures({ artifactDirectory: ".session-artifacts/test-second" });
  expect(first.count).toBe(17);
  expect(second.structured).toBe(first.structured);
  expect(second.markdown).toBe(first.markdown);
});

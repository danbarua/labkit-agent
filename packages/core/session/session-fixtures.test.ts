import { expect, test } from "@logtape/testing-bun/autoload";

import { runFixtures } from "./fixture-runner.ts";

test("approved structured and readable fixtures match across repeated deterministic runs", async () => {
  const first = await runFixtures({ artifactDirectory: ".session-artifacts/test-first" });
  const second = await runFixtures({ artifactDirectory: ".session-artifacts/test-second" });
  expect(first.count).toBe(17);
  expect(second.structured).toBe(first.structured);
  expect(second.markdown).toBe(first.markdown);
});

test("version-two policy fixtures are independent of the unchanged version-one baseline", async () => {
  const first = await runFixtures({ version: 2, artifactDirectory: ".session-artifacts/v2-first" });
  const second = await runFixtures({
    version: 2,
    artifactDirectory: ".session-artifacts/v2-second",
  });
  expect(first.count).toBe(22);
  expect(second.structured).toBe(first.structured);
  expect(second.markdown).toBe(first.markdown);
});

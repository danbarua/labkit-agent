import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@logtape/testing-bun/autoload";

// Exercise real child runners: this process has already initialized autoload and cannot
// re-read environment options safely. Temporary probes are not part of suite discovery.
test("test capture honors environment modes and levels after logging reconfiguration tests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-log-capture-"));
  const fixture = join(directory, "capture.test.ts");
  try {
    await Bun.write(
      fixture,
      `
import { test } from ${JSON.stringify(import.meta.resolve("@logtape/testing-bun/autoload"))};
import { getLogger } from ${JSON.stringify(import.meta.resolve("@logtape/logtape"))};
import { diagnostic } from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
test("capture probe", () => {
  const logger = getLogger(["labkit", "capture-probe"]);
  logger.debug("CAPTURE_DEBUG_MARKER");
  diagnostic("capture-probe", "debug", "operation.waiting", { sessionId: "session-probe", childId: "child-probe", reason: "permission response pending", path: "/workspace/core.ts" });
  logger.warning("CAPTURE_WARNING_MARKER");
  if (process.env.LOGTAPE_PROBE_FAIL === "1") throw new Error("expected probe failure");
});
`,
    );
    for (const [mode, level, fail, debug, warning] of [
      ["always", "debug", false, true, true],
      ["always", "warning", false, false, true],
      ["on-failure", "debug", false, false, false],
      ["on-failure", "debug", true, true, true],
      ["never", "debug", true, false, false],
    ] as const) {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "test",
          new URL("./logging.test.ts", import.meta.url).pathname,
          fixture,
        ],
        env: {
          ...process.env,
          LOGTAPE_TEST_MODE: mode,
          LOGTAPE_TEST_LOWEST_LEVEL: level,
          LOGTAPE_PROBE_FAIL: fail ? "1" : "0",
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = stdout + stderr;
      expect(exitCode).toBe(fail ? 1 : 0);
      expect(output.includes("labkit·capture-probe CAPTURE_DEBUG_MARKER")).toBe(debug);
      expect(output.includes("labkit·capture-probe CAPTURE_WARNING_MARKER")).toBe(warning);
      for (const detail of [
        "session-probe",
        "child-probe",
        "permission response pending",
        "/workspace/core.ts",
      ]) {
        expect(
          output
            .split("\n")
            .some(
              (line) =>
                line.includes("labkit·capture-probe operation.waiting") && line.includes(detail),
            ),
        ).toBe(debug);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

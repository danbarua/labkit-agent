#!/usr/bin/env bun
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { diagnostic, diagnosticError } from "../core/logging/index.ts";
import { startLauncherLogging } from "./launcher-logging.ts";
import { serveAcpStdio } from "./stdio.ts";

const logging = await startLauncherLogging();
const args = Bun.argv.slice(2);
diagnostic("acp", "info", "launcher.started", {
  cwd: process.cwd(),
  configPath: args[1] ? resolve(args[1]) : undefined,
});
try {
  if (args.length !== 2 || args[0] !== "--config") {
    console.error("Usage: labkit-agent-acp --config /absolute/path/to/acp-config.ts");
    process.exitCode = args.includes("--help") ? 0 : 1;
  } else {
    try {
      const { default: options } = await import(pathToFileURL(resolve(args[1]!)).href);
      if (!options || typeof options.sessionOptions !== "function")
        throw new Error("Config must default-export AcpOptions with a sessionOptions function");
      await serveAcpStdio(options);
    } catch (error) {
      diagnostic("acp", "error", "launcher.failed", { error: diagnosticError(error) });
      console.error(`Labkit launcher failed; diagnostics: ${logging.path}`);
      process.exitCode = 1;
    }
  }
} finally {
  diagnostic("acp", "info", "launcher.stopped", { exitCode: process.exitCode ?? 0 });
  await logging.close();
}

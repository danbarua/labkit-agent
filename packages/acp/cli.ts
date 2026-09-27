#!/usr/bin/env bun
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { diagnostic, diagnosticError } from "../core/logging/index.ts";
import type { AcpOptions } from "./adapter.ts";
import { serveAcpHttp, type AcpHttpServer } from "./http.ts";
import { startLauncherLogging } from "./launcher-logging.ts";
import { serveAcpStdio } from "./stdio.ts";

const usage = `Usage: labkit-agent-acp --config /absolute/path/to/acp-config.ts [--http <port>]
  Without --http, ACP runs over stdio. With --http, it serves Streamable HTTP at
  http://127.0.0.1:<port>/acp (0 picks a free port); every request needs
  Authorization: Bearer $LABKIT_ACP_HTTP_TOKEN (at least 32 characters).`;

/** Serves until SIGINT or SIGTERM, then closes every connection and its sessions. */
async function serveHttp(options: AcpOptions, port: number) {
  let server: AcpHttpServer;
  try {
    server = serveAcpHttp(options, { port, token: process.env.LABKIT_ACP_HTTP_TOKEN ?? "" });
  } catch (error) {
    console.error(
      `Labkit ACP HTTP host refused to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  console.error(`Labkit ACP HTTP endpoint: ${server.url}`);
  const { promise: stopped, resolve } = Promise.withResolvers<string>();
  const stop = (signal: string) => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    resolve(signal);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const signal = await stopped;
  diagnostic("acp", "info", "http.shutdown_requested", { signal, url: server.url });
  await server.close();
}

const logging = await startLauncherLogging();
const args = Bun.argv.slice(2);
let flags: Readonly<{ config?: string; http?: string; help?: boolean }> | undefined;
try {
  flags = parseArgs({
    args,
    options: { config: { type: "string" }, http: { type: "string" }, help: { type: "boolean" } },
  }).values;
} catch {
  flags = undefined; // Unknown flags and positionals print the usage.
}
const http = flags?.http;
const port =
  http !== undefined && /^\d{1,5}$/.test(http) && Number(http) <= 65535 ? Number(http) : undefined;
diagnostic("acp", "info", "launcher.started", {
  cwd: process.cwd(),
  configPath: flags?.config ? resolve(flags.config) : undefined,
  transport: http === undefined ? "stdio" : "http",
  port: http,
});
try {
  if (!flags?.config || flags.help || (http !== undefined && port === undefined)) {
    console.error(usage);
    process.exitCode = flags?.help ? 0 : 1;
  } else {
    try {
      const { default: options } = await import(pathToFileURL(resolve(flags.config)).href);
      if (!options || typeof options.sessionOptions !== "function")
        throw new Error("Config must default-export AcpOptions with a sessionOptions function");
      if (port === undefined) await serveAcpStdio(options);
      else await serveHttp(options, port);
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

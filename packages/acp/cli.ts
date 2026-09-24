#!/usr/bin/env bun
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { serveAcpStdio } from "./stdio.ts";

const args = Bun.argv.slice(2);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

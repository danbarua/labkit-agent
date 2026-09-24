import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const directory = resolve(process.env.LABKIT_ACP_LOG_DIR ?? join(homedir(), ".labkit", "logs"));
const errorsOnly = Bun.argv.includes("--errors");

try {
  const names = (await readdir(directory)).filter((name) => /^acp-.*\.jsonl$/.test(name));
  const files = await Promise.all(
    names.map(async (name) => ({
      path: join(directory, name),
      time: (await stat(join(directory, name))).mtimeMs,
    })),
  );
  const latest = files.sort((a, b) => b.time - a.time)[0];
  if (!latest) throw new Error(`No ACP launch logs found in ${directory}`);
  console.error(`ACP diagnostics: ${latest.path}`);
  for (const line of (await Bun.file(latest.path).text()).split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (errorsOnly && !["warning", "error", "fatal"].includes(record.level)) continue;
    console.log(JSON.stringify(record, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

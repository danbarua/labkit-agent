import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_FILE_BYTES = 256 * 1024;

/** Cwd is resolved once. Reject traversal, symlink components, and non-regular files. */
async function workspaceRootFiles(cwd: string) {
  if (!isAbsolute(cwd)) throw new Error("Workspace cwd must be absolute");
  const requestedRoot = resolve(cwd);
  const root = await realpath(requestedRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error("Workspace cwd must be a directory");
  const inside = (base: string, target: string) => {
    const path = relative(base, target);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  function path(raw: string) {
    if (!raw || raw.includes("\0") || raw.split(/[\\/]/).includes(".."))
      throw new Error("Path must stay inside the workspace; parent traversal is not allowed");
    const candidate = resolve(requestedRoot, raw);
    if (
      [relative(requestedRoot, candidate), relative(root, candidate)].some(
        (value) => value === ".labkit" || value.startsWith(`.labkit${sep}`),
      )
    )
      throw new Error("The .labkit directory is reserved for session storage");
    if (inside(requestedRoot, candidate)) return resolve(root, relative(requestedRoot, candidate));
    if (inside(root, candidate)) return candidate;
    throw new Error("Path is outside the workspace");
  }
  async function check(raw: string, create = false) {
    const target = path(raw);
    let current = root;
    const parts = relative(root, target).split(sep).filter(Boolean);
    // Recheck the root as well as every component before each effect.
    if ((await realpath(root)) !== root) throw new Error("Workspace root changed");
    for (const [index, part] of parts.entries()) {
      current = resolve(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error("Symlink paths are not allowed");
        if (index < parts.length - 1 && !stat.isDirectory())
          throw new Error("Path parent is not a directory");
      } catch (error) {
        if (
          create &&
          index === parts.length - 1 &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
          return target;
        throw error;
      }
    }
    return target;
  }
  async function read(raw: string, signal: AbortSignal, limit = MAX_FILE_BYTES) {
    signal.throwIfAborted();
    const target = await check(raw);
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Only regular workspace files without hard-link aliases are allowed");
      if (stat.size > limit)
        throw new Error(`File exceeds ${limit} bytes; narrow the requested file`);
      await check(target);
      const bytes = new Uint8Array(limit + 1);
      let length = 0;
      while (length <= limit) {
        signal.throwIfAborted();
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      signal.throwIfAborted();
      if (length > limit) throw new Error(`File exceeds ${limit} bytes; narrow the requested file`);
      return bytes.slice(0, length);
    } finally {
      await file.close();
    }
  }
  return {
    root,
    path,
    read,
    async readText(raw: string, signal: AbortSignal) {
      return new TextDecoder("utf-8", { fatal: true }).decode(await read(raw, signal));
    },
    async write(raw: string, text: string, signal: AbortSignal) {
      signal.throwIfAborted();
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > MAX_FILE_BYTES)
        throw new Error(`Content exceeds ${MAX_FILE_BYTES} bytes; narrow the write`);
      const target = await check(raw, true);
      // Parent directories must already exist. Never truncate before validating the opened file.
      const file = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error("Only regular workspace files without hard-link aliases are allowed");
        await check(target);
        signal.throwIfAborted();
        await file.truncate(0);
        await file.writeFile(bytes, { signal });
        return { path: target, bytes: bytes.length };
      } finally {
        await file.close();
      }
    },
    async list(raw: string, signal: AbortSignal) {
      signal.throwIfAborted();
      const target = await check(raw);
      const dir = await opendir(target);
      const entries: { name: string; type: string }[] = [];
      let bytes = 0;
      for await (const entry of dir) {
        signal.throwIfAborted();
        const value = {
          name: entry.name,
          type: entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
        };
        bytes += Buffer.byteLength(JSON.stringify(value));
        if (entries.length >= 1000 || bytes > MAX_FILE_BYTES)
          throw new Error("Directory listing is too large; choose a narrower directory");
        entries.push(value);
      }
      return { path: target, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
    },
  };
}
/** Relative paths stay anchored to cwd; additional roots require absolute paths. */
export async function workspaceFiles(cwd: string, additionalDirectories: readonly string[] = []) {
  const primary = await workspaceRootFiles(cwd);
  const roots = [primary];
  // Keep requested aliases for path resolution; expose canonical roots only once.
  for (const directory of new Set(additionalDirectories))
    roots.push(await workspaceRootFiles(directory));
  const reserved = (path: string) =>
    roots.some((files) => {
      const part = relative(files.root, path);
      return part === ".labkit" || part.startsWith(`.labkit${sep}`);
    });
  if (roots.some((files) => reserved(files.root)))
    throw new Error("The .labkit directory is reserved for session storage");
  function select(raw: string) {
    if (!raw || raw.includes("\0") || raw.split(/[\\/]/).includes(".."))
      throw new Error("Path must stay inside the workspace; parent traversal is not allowed");
    const absolute = resolve(cwd, raw);
    for (const files of roots) {
      let path: string;
      try {
        path = files.path(absolute);
      } catch {
        continue;
      }
      if (reserved(path)) throw new Error("The .labkit directory is reserved for session storage");
      return { files, path };
    }
    throw new Error("Path is outside the workspace or reserved for session storage");
  }
  return {
    root: primary.root,
    roots: Object.freeze([...new Set(roots.map((files) => files.root))]),
    path: (raw: string) => select(raw).path,
    read: async (raw: string, signal: AbortSignal, limit?: number) => {
      const { files, path } = select(raw);
      return files.read(path, signal, limit);
    },
    readText: async (raw: string, signal: AbortSignal) => {
      const { files, path } = select(raw);
      return files.readText(path, signal);
    },
    write: async (raw: string, text: string, signal: AbortSignal) => {
      const { files, path } = select(raw);
      return files.write(path, text, signal);
    },
    list: async (raw: string, signal: AbortSignal) => {
      const { files, path } = select(raw);
      return files.list(path, signal);
    },
  };
}
export type WorkspaceFiles = Awaited<ReturnType<typeof workspaceFiles>>;

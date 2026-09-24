import { isAbsolute } from "node:path";

/** No process cwd fallback: an extension host's cwd is not the user's workspace. */
export function workspaceCwd(configured: string, folders: readonly string[], active?: string) {
  if (configured) {
    if (!isAbsolute(configured))
      throw new Error("acp.defaultWorkingDirectory must be an absolute path");
    return { cwd: configured, source: "setting" };
  }
  if (active && folders.includes(active)) return { cwd: active, source: "active_editor" };
  if (folders.length === 1) return { cwd: folders[0]!, source: "workspace_folder" };
  if (!folders.length)
    throw new Error(
      "Open a workspace folder or set acp.defaultWorkingDirectory before connecting an agent",
    );
  return undefined;
}

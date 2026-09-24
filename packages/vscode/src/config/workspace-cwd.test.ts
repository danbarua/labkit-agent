import { expect, test } from "bun:test";

import { workspaceCwd } from "./workspace-cwd.ts";

test("agent cwd comes from explicit settings or the editor workspace, never the extension process", () => {
  expect(workspaceCwd("/configured", ["/workspace"], "/workspace")).toEqual({
    cwd: "/configured",
    source: "setting",
  });
  expect(workspaceCwd("", ["/one", "/two"], "/two")).toEqual({
    cwd: "/two",
    source: "active_editor",
  });
  expect(workspaceCwd("", ["/one"])).toEqual({ cwd: "/one", source: "workspace_folder" });
  expect(workspaceCwd("", ["/one", "/two"])).toBeUndefined();
  expect(() => workspaceCwd("", [])).toThrow("Open a workspace folder");
  expect(() => workspaceCwd("relative", ["/workspace"])).toThrow("absolute path");
});

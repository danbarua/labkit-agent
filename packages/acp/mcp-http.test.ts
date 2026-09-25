import { expect, test } from "bun:test";

import { until } from "../core/agent/test-support.ts";
import { mcpConnections, mcpToolName } from "./mcp.ts";
import { mcpHttpFixture } from "./testing/mcp-http.ts";

for (const type of ["http", "sse"] as const) {
  test(`${type} MCP forwards headers for initialization and calls, cancels, and closes`, async () => {
    const peer = mcpHttpFixture(type);
    const connection = mcpConnections(
      [{ type, name: "remote", url: peer.url, headers: peer.headers }],
      "/tmp",
    );
    try {
      const tools = await connection.open(new AbortController().signal);
      expect(
        await tools
          .get(mcpToolName("remote", "echo"))!
          .run({ text: "remote result" }, new AbortController().signal),
      ).toEqual({ content: [{ type: "text", text: "remote result" }] });
      const controller = new AbortController();
      const waiting = Promise.resolve(
        tools.get(mcpToolName("remote", "slow"))!.run({}, controller.signal),
      ).then(
        () => null,
        (error) => error,
      );
      await until(() => peer.events.filter((event) => event.method === "tools/call").length === 2);
      controller.abort();
      expect(await waiting).toBeInstanceOf(Error);
      await until(() => peer.events.some((event) => event.method === "notifications/cancelled"));
      await connection.close();
      expect(peer.events.every((event) => event.authorized)).toBe(true);
      if (type === "http") expect(peer.deleted).toBe(1);
      await until(() => peer.streams === 0);
    } finally {
      await connection.close();
      await peer.close();
    }
  });
  test(`${type} MCP auth failures are clear and don't disclose supplied headers`, async () => {
    const peer = mcpHttpFixture(type, { unauthorized: true });
    const connection = mcpConnections(
      [{ type, name: "remote", url: peer.url, headers: peer.headers }],
      "/tmp",
    );
    try {
      const error = await connection.open(new AbortController().signal).then(
        () => null,
        (error) => error as Error,
      );
      expect(error?.message).toStartWith(
        `Failed to connect to MCP server "remote": ${type === "http" ? "Streamable HTTP error: Error POSTing to endpoint: Unauthorized" : "SSE error: Non-200 status code (401)"}`,
      );
      expect(error?.message).not.toContain("mcp-test-secret");
    } finally {
      await connection.close();
      await peer.close();
    }
  });
}

test("remote MCP refuses redirects without forwarding credentials to another origin", async () => {
  const target = mcpHttpFixture("http");
  const redirect = mcpHttpFixture("http", { redirect: target.url });
  const connection = mcpConnections(
    [{ type: "http", name: "redirect", url: redirect.url, headers: redirect.headers }],
    "/tmp",
  );
  try {
    await expect(connection.open(new AbortController().signal)).rejects.toThrow(
      "Failed to connect",
    );
    expect(target.events).toHaveLength(0);
  } finally {
    await connection.close();
    await redirect.close();
    await target.close();
  }
});

test("cancelling SSE before its endpoint event closes the opening connection", async () => {
  const peer = mcpHttpFixture("sse", { hang: true });
  const connection = mcpConnections(
    [{ type: "sse", name: "hang", url: peer.url, headers: peer.headers }],
    "/tmp",
  );
  const controller = new AbortController();
  const opening = connection.open(controller.signal).then(
    () => null,
    (error) => error,
  );
  try {
    await until(() => peer.streams === 1);
    controller.abort();
    expect(await opening).toBeInstanceOf(Error);
    await until(() => peer.streams === 0);
  } finally {
    await connection.close();
    await peer.close();
  }
});

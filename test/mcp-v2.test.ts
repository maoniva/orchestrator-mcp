import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { createOrchestratorHandler } from "../src/server.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3939,
  allowedHosts: ["127.0.0.1", "localhost"],
  t3: {
    baseUrl: "http://127.0.0.1:3773",
    timeoutMs: 1_000,
    dispatchTimeoutMs: 2_000,
    worktreesDir: "/tmp/orchestrator-mcp-test-worktrees",
    worktreeTimeoutMs: 2_000,
  },
};

describe("MCP v2 handler", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  it("serves modern MCP requests without allocating a session", async () => {
    const handler = createOrchestratorHandler(config);
    closeables.push(handler);
    const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    });
    const client = new Client(
      { name: "orchestrator-mcp-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    closeables.push(client);

    await client.connect(transport);
    const listed = await client.listTools();
    const result = await client.callTool({ name: "list_platforms", arguments: {} });

    expect(transport.sessionId).toBeUndefined();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "list_platforms",
      "orchestrator_status",
      "list_projects",
      "list_models",
      "list_threads",
      "spawn_thread",
      "get_thread_status",
      "wait_for_thread",
      "send_follow_up",
      "interrupt_thread",
      "stop_thread_session",
      "set_thread_lifecycle",
    ]);
    const spawn = listed.tools.find((tool) => tool.name === "spawn_thread");
    expect(spawn?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["idempotency_key", "project", "prompt", "workspace"]),
    });
    expect(JSON.stringify(spawn?.inputSchema)).toContain('"start_from_origin"');
    expect(JSON.stringify(spawn?.inputSchema)).toContain('"const":false');
    expect(result.structuredContent).toEqual({
      platforms: [
        {
          id: "t3",
          name: "T3 Code",
          configured: false,
          capabilities: [
            "status",
            "list_projects",
            "list_models",
            "list_threads",
            "spawn_thread",
            "wait_for_thread",
            "send_follow_up",
            "interrupt_thread",
            "stop_thread_session",
            "set_thread_lifecycle",
          ],
        },
      ],
    });
  });
});

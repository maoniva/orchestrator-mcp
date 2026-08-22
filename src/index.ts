#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";

import { loadConfig } from "./config.js";
import { createOrchestratorHandler } from "./server.js";

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function authorized(req: IncomingMessage, expected?: string): boolean {
  if (expected === undefined) return true;
  const value = req.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  return sameSecret(value.slice("Bearer ".length), expected);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const config = loadConfig();
const handler = createOrchestratorHandler(config);
const handleMcp = toNodeHandler(handler, {
  onerror: (error) => console.error("MCP request failed:", error),
});
const validateHost = hostHeaderValidation([...config.allowedHosts]);
const validateOrigin = originValidation([...config.allowedHosts]);

const httpServer = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/healthz") {
    json(res, 200, {
      ok: true,
      service: "orchestrator-mcp",
      stateless: true,
      mcpEndpoint: "/mcp",
    });
    return;
  }
  if (pathname !== "/mcp") {
    json(res, 404, { error: "not_found" });
    return;
  }
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  if (!authorized(req, config.mcpBearerToken)) {
    res.setHeader("www-authenticate", 'Bearer realm="orchestrator-mcp"');
    json(res, 401, {
      jsonrpc: "2.0",
      error: { code: -32_000, message: "A valid MCP bearer token is required." },
      id: null,
    });
    return;
  }
  void handleMcp(
    req as Parameters<typeof handleMcp>[0],
    res as Parameters<typeof handleMcp>[1],
  );
});

httpServer.listen(config.port, config.host, () => {
  console.error(`orchestrator-mcp listening on http://${config.host}:${config.port}/mcp`);
});

async function shutdown(signal: string): Promise<void> {
  console.error(`Received ${signal}; shutting down.`);
  httpServer.close();
  await handler.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

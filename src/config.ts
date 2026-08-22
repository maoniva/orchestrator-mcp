import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly mcpBearerToken?: string;
  readonly t3: {
    readonly baseUrl: string;
    readonly bearerToken?: string;
    readonly timeoutMs: number;
    readonly dispatchTimeoutMs: number;
    readonly worktreesDir: string;
    readonly worktreeTimeoutMs: number;
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("T3_BASE_URL must use http or https.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isLoopback(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return false;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.ORCHESTRATOR_HOST?.trim() || "127.0.0.1";
  const mcpBearerToken = env.ORCHESTRATOR_MCP_BEARER_TOKEN?.trim() || undefined;
  if (!isLoopback(host) && mcpBearerToken === undefined) {
    throw new Error(
      "ORCHESTRATOR_MCP_BEARER_TOKEN is required when ORCHESTRATOR_HOST is not loopback.",
    );
  }

  const configuredAllowedHosts = env.ORCHESTRATOR_ALLOWED_HOSTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedHosts = configuredAllowedHosts?.length
    ? configuredAllowedHosts
    : isLoopback(host)
      ? ["localhost", "127.0.0.1", "[::1]"]
      : [host];

  return {
    host,
    port: parsePositiveInteger(env.ORCHESTRATOR_PORT, 3939, "ORCHESTRATOR_PORT"),
    allowedHosts,
    ...(mcpBearerToken === undefined ? {} : { mcpBearerToken }),
    t3: {
      baseUrl: normalizeBaseUrl(env.T3_BASE_URL?.trim() || "http://127.0.0.1:3773"),
      ...(env.T3_BEARER_TOKEN?.trim()
        ? { bearerToken: env.T3_BEARER_TOKEN.trim() }
        : {}),
      timeoutMs: parsePositiveInteger(
        env.T3_REQUEST_TIMEOUT_MS,
        15_000,
        "T3_REQUEST_TIMEOUT_MS",
      ),
      dispatchTimeoutMs: parsePositiveInteger(
        env.T3_DISPATCH_TIMEOUT_MS,
        1_800_000,
        "T3_DISPATCH_TIMEOUT_MS",
      ),
      worktreesDir: env.T3_WORKTREES_DIR?.trim() || join(homedir(), ".t3", "worktrees"),
      worktreeTimeoutMs: parsePositiveInteger(
        env.T3_WORKTREE_TIMEOUT_MS,
        1_800_000,
        "T3_WORKTREE_TIMEOUT_MS",
      ),
    },
  };
}

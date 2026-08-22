import WebSocket from "ws";

import { OrchestratorError } from "../errors.js";
import type {
  T3DispatchResult,
  T3EnvironmentDescriptor,
  T3ServerConfig,
  T3ShellSnapshot,
  T3ThreadCommand,
  T3ThreadDetailSnapshot,
  T3VcsListRefsResult,
} from "./types.js";

interface T3ClientConfig {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs: number;
  readonly dispatchTimeoutMs: number;
}

export interface T3ClientLike {
  readonly baseUrl: string;
  getDescriptor(): Promise<T3EnvironmentDescriptor>;
  getShellSnapshot(): Promise<T3ShellSnapshot>;
  getArchivedShellSnapshot(): Promise<T3ShellSnapshot>;
  getThreadSnapshot(threadId: string, turnLimit?: number): Promise<T3ThreadDetailSnapshot | null>;
  getServerConfig(): Promise<T3ServerConfig>;
  getCurrentBranch(cwd: string): Promise<string | null>;
  dispatch(command: T3ThreadCommand): Promise<T3DispatchResult>;
}

interface FetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

type WebSocketFactory = (url: string) => WebSocket;

function describePayload(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "reason", "code", "_tag"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function describeRpcFailure(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): string | undefined => {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim().split("\n", 1)[0]!.slice(0, 500);
    }
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) {
      return undefined;
    }
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    for (const key of ["message", "reason", "stderr", "description"]) {
      const detail = visit(record[key]);
      if (detail) {
        const tag = typeof record._tag === "string" && record._tag.endsWith("Error")
          ? `${record._tag}: `
          : "";
        return `${tag}${detail}`.slice(0, 500);
      }
    }
    for (const key of ["cause", "error", "failure"]) {
      const detail = visit(record[key]);
      if (detail) return detail;
    }
    for (const [key, entry] of Object.entries(record)) {
      if (key === "_tag") continue;
      const detail = visit(entry);
      if (detail) return detail;
    }
    return undefined;
  };
  return visit(value);
}

export class T3Client implements T3ClientLike {
  readonly baseUrl: string;
  readonly #bearerToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #dispatchTimeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #webSocketFactory: WebSocketFactory;

  constructor(
    config: T3ClientConfig,
    dependencies: {
      readonly fetch?: FetchLike;
      readonly webSocketFactory?: WebSocketFactory;
    } = {},
  ) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.#bearerToken = config.bearerToken;
    this.#timeoutMs = config.timeoutMs;
    this.#dispatchTimeoutMs = config.dispatchTimeoutMs;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#webSocketFactory = dependencies.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  async getDescriptor(): Promise<T3EnvironmentDescriptor> {
    return this.#requestJson<T3EnvironmentDescriptor>("/.well-known/t3/environment", false);
  }

  async getShellSnapshot(): Promise<T3ShellSnapshot> {
    return this.#requestJson<T3ShellSnapshot>("/api/orchestration/shell", true);
  }

  async getArchivedShellSnapshot(): Promise<T3ShellSnapshot> {
    const url = await this.#webSocketUrl();
    return this.#singleRpc<T3ShellSnapshot>(
      url,
      "orchestration.getArchivedShellSnapshot",
      {},
    );
  }

  async getThreadSnapshot(
    threadId: string,
    turnLimit?: number,
  ): Promise<T3ThreadDetailSnapshot | null> {
    const path = new URL(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      `${this.baseUrl}/`,
    );
    if (turnLimit !== undefined) path.searchParams.set("turnLimit", String(turnLimit));
    try {
      return await this.#requestJson<T3ThreadDetailSnapshot>(path.toString(), true);
    } catch (error) {
      if (error instanceof OrchestratorError && error.code === "T3_NOT_FOUND") return null;
      throw error;
    }
  }

  async getServerConfig(): Promise<T3ServerConfig> {
    return this.#singleRpc<T3ServerConfig>(await this.#webSocketUrl(), "server.getConfig", {});
  }

  async getCurrentBranch(cwd: string): Promise<string | null> {
    const result = await this.#singleRpc<T3VcsListRefsResult>(
      await this.#webSocketUrl(),
      "vcs.listRefs",
      { cwd, refKind: "local", refresh: true, limit: 2 },
    );
    if (!result.isRepo) return null;
    return result.refs.find((ref) => ref.current)?.name ?? null;
  }

  async dispatch(command: T3ThreadCommand): Promise<T3DispatchResult> {
    return this.#singleRpc<T3DispatchResult>(
      await this.#webSocketUrl(),
      "orchestration.dispatchCommand",
      command,
      this.#dispatchTimeoutMs,
    );
  }

  async #webSocketUrl(): Promise<string> {
    const ticket = await this.#requestJson<{ readonly ticket: string }>(
      "/api/auth/websocket-ticket",
      true,
      { method: "POST" },
    );
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.searchParams.set("wsTicket", ticket.ticket);
    return url.toString();
  }

  async #requestJson<T>(
    path: string,
    authenticated: boolean,
    init: RequestInit = {},
  ): Promise<T> {
    if (authenticated && this.#bearerToken === undefined) {
      throw new OrchestratorError(
        "T3_AUTH_MISSING",
        "T3_BEARER_TOKEN is required. Generate a scoped T3 session token and restart this server.",
      );
    }

    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (authenticated && this.#bearerToken !== undefined) {
      headers.set("authorization", `Bearer ${this.#bearerToken}`);
    }

    let response: Response;
    try {
      response = await this.#fetch(new URL(path, `${this.baseUrl}/`), {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new OrchestratorError(
        "T3_UNREACHABLE",
        `Could not reach T3 at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    let payload: unknown;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const detail = describePayload(payload);
      throw new OrchestratorError(
        response.status === 401 || response.status === 403
          ? "T3_AUTH_FAILED"
          : response.status === 404
            ? "T3_NOT_FOUND"
            : "T3_API_ERROR",
        `T3 returned HTTP ${response.status}${detail ? ` (${detail})` : ""}.`,
        payload,
      );
    }
    return payload as T;
  }

  #singleRpc<T>(
    url: string,
    tag: string,
    payload: unknown,
    timeoutMs = this.#timeoutMs,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.#webSocketFactory(url);
      const requestId = 0;
      let settled = false;
      const timer = setTimeout(() => {
        finish(
          new OrchestratorError(
            "T3_RPC_TIMEOUT",
            `T3 RPC ${tag} did not respond within ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error !== undefined) reject(error);
        else resolve(value as T);
      };

      socket.on("open", () => {
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: requestId,
            tag,
            payload,
            headers: [],
          }),
        );
      });
      socket.on("message", (data) => {
        let message: unknown;
        try {
          message = JSON.parse(data.toString());
        } catch (error) {
          finish(new OrchestratorError("T3_RPC_PROTOCOL_ERROR", "T3 sent invalid JSON.", error));
          return;
        }
        if (typeof message !== "object" || message === null) return;
        const record = message as Record<string, unknown>;
        if (record._tag === "Ping") {
          socket.send(JSON.stringify({ _tag: "Pong" }));
          return;
        }
        if (record._tag === "Defect" || record._tag === "ClientProtocolError") {
          finish(
            new OrchestratorError("T3_RPC_PROTOCOL_ERROR", `T3 rejected RPC ${tag}.`, message),
          );
          return;
        }
        if (record._tag !== "Exit" || record.requestId !== requestId) return;
        const exit = record.exit as Record<string, unknown> | undefined;
        if (exit?._tag === "Success") {
          finish(undefined, exit.value as T);
          return;
        }
        const detail = describeRpcFailure(exit);
        finish(
          new OrchestratorError(
            "T3_RPC_FAILED",
            `T3 RPC ${tag} failed${detail ? `: ${detail}` : "."}`,
            exit,
          ),
        );
      });
      socket.on("error", (error) => {
        finish(new OrchestratorError("T3_RPC_CONNECTION_FAILED", error.message));
      });
      socket.on("close", () => {
        if (!settled) {
          finish(
            new OrchestratorError(
              "T3_RPC_CONNECTION_CLOSED",
              `T3 closed the WebSocket before RPC ${tag} completed.`,
            ),
          );
        }
      });
    });
  }
}

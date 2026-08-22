import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { T3Client } from "../src/t3/client.js";

describe("T3Client", () => {
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("dispatches mutations through T3's native WebSocket orchestration RPC", async () => {
    const rpcServer = new WebSocketServer({ port: 0 });
    servers.push(rpcServer);
    await new Promise<void>((resolve) => rpcServer.once("listening", resolve));
    const address = rpcServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP WebSocket address");
    }

    let received: unknown;
    rpcServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        received = JSON.parse(data.toString());
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: 0,
            exit: { _tag: "Success", value: { sequence: 77 } },
          }),
        );
      });
    });

    let requestedT3Url = "";
    const client = new T3Client(
      {
        baseUrl: "http://t3.test",
        bearerToken: "secret",
        timeoutMs: 2_000,
        dispatchTimeoutMs: 5_000,
      },
      {
        fetch: async () => Response.json({ ticket: "one-shot-ticket" }),
        webSocketFactory: (url) => {
          requestedT3Url = url;
          return new WebSocket(`ws://127.0.0.1:${address.port}`);
        },
      },
    );

    const result = await client.dispatch({
      type: "thread.turn.interrupt",
      commandId: "command-1",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-08-22T10:00:00.000Z",
    });

    expect(result).toEqual({ sequence: 77 });
    expect(requestedT3Url).toContain("wsTicket=one-shot-ticket");
    expect(received).toEqual({
      _tag: "Request",
      id: 0,
      tag: "orchestration.dispatchCommand",
      payload: {
        type: "thread.turn.interrupt",
        commandId: "command-1",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-08-22T10:00:00.000Z",
      },
      headers: [],
    });
  });

  it("uses the long mutation timeout independently of ordinary RPCs", async () => {
    const rpcServer = new WebSocketServer({ port: 0 });
    servers.push(rpcServer);
    await new Promise<void>((resolve) => rpcServer.once("listening", resolve));
    const address = rpcServer.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");

    rpcServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { tag: string };
        if (request.tag === "vcs.listRefs") {
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: 0,
              exit: {
                _tag: "Success",
                value: { isRepo: true, refs: [{ name: "avhenig/dev", current: true }] },
              },
            }),
          );
          return;
        }
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: 0,
              exit: { _tag: "Success", value: { sequence: 88 } },
            }),
          );
        }, 60);
      });
    });

    const client = new T3Client(
      {
        baseUrl: "http://t3.test",
        bearerToken: "secret",
        timeoutMs: 20,
        dispatchTimeoutMs: 200,
      },
      {
        fetch: async () => Response.json({ ticket: "ticket" }),
        webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
      },
    );

    await expect(client.getCurrentBranch("/code/ecosconnect")).resolves.toBe("avhenig/dev");
    await expect(
      client.dispatch({
        type: "thread.session.stop",
        commandId: "command-long",
        threadId: "thread-long",
        createdAt: "2026-08-22T10:00:00.000Z",
      }),
    ).resolves.toEqual({ sequence: 88 });
  });

  it("surfaces the underlying T3 RPC failure detail", async () => {
    const rpcServer = new WebSocketServer({ port: 0 });
    servers.push(rpcServer);
    await new Promise<void>((resolve) => rpcServer.once("listening", resolve));
    const address = rpcServer.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");

    rpcServer.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: 0,
            exit: {
              _tag: "Failure",
              cause: {
                _tag: "Fail",
                failure: {
                  _tag: "GitCommandError",
                  message: "worktree branch already exists",
                },
              },
            },
          }),
        );
      });
    });

    const client = new T3Client(
      {
        baseUrl: "http://t3.test",
        bearerToken: "secret",
        timeoutMs: 200,
        dispatchTimeoutMs: 200,
      },
      {
        fetch: async () => Response.json({ ticket: "ticket" }),
        webSocketFactory: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
      },
    );

    await expect(
      client.dispatch({
        type: "thread.session.stop",
        commandId: "command-failed",
        threadId: "thread-failed",
        createdAt: "2026-08-22T10:00:00.000Z",
      }),
    ).rejects.toThrow("GitCommandError: worktree branch already exists");
  });
});

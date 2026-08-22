import { describe, expect, it } from "vitest";

import { T3Adapter } from "../src/adapters/t3.js";
import type { SpawnThreadInput } from "../src/adapters/types.js";
import type {
  PrepareWorktreeInput,
  PreparedWorktree,
  WorktreePreparer,
} from "../src/git/worktrees.js";
import type { T3ClientLike } from "../src/t3/client.js";
import type {
  T3DispatchResult,
  T3EnvironmentDescriptor,
  T3ServerConfig,
  T3ShellSnapshot,
  T3ThreadCommand,
  T3ThreadDetailSnapshot,
  T3ThreadShell,
} from "../src/t3/types.js";

const descriptor: T3EnvironmentDescriptor = {
  environmentId: "env-local",
  label: "Local T3",
  serverVersion: "0.0.33",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: {},
};

const snapshot: T3ShellSnapshot = {
  snapshotSequence: 12,
  updatedAt: "2026-08-22T10:00:00.000Z",
  projects: [
    {
      id: "project-1",
      title: "ecosconnect",
      workspaceRoot: "/code/ecosconnect",
      defaultModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "fastMode", value: false },
        ],
      },
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-22T10:00:00.000Z",
    },
  ],
  threads: [],
};

const serverConfig: T3ServerConfig = {
  environment: { environmentId: "env-local", label: "Local T3", serverVersion: "0.0.33" },
  cwd: "/code",
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      status: "ready",
      availability: "available",
      auth: { status: "authenticated" },
      models: [
        {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          isCustom: false,
          isDefault: true,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
              },
              { id: "fastMode", label: "Fast mode", type: "boolean" },
            ],
          },
        },
      ],
    },
  ],
};

class FakeWorktreePreparer implements WorktreePreparer {
  readonly calls: PrepareWorktreeInput[] = [];
  disposition: PreparedWorktree["disposition"] = "created";

  async prepare(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
    this.calls.push(input);
    return {
      path: `/worktrees/${input.branch.replaceAll("/", "-")}`,
      branch: input.branch,
      disposition: this.disposition,
    };
  }
}

class FakeClient implements T3ClientLike {
  readonly baseUrl = "http://127.0.0.1:3773";
  readonly commands: T3ThreadCommand[] = [];
  readonly activeThreads: T3ThreadShell[] = [];
  readonly archivedThreads: T3ThreadShell[] = [];
  readonly messages = new Map<string, T3ThreadDetailSnapshot["thread"]["messages"]>();
  readonly receipts = new Map<string, string>();
  currentBranch: string | null = "avhenig/dev";
  partialWorktreeBootstrap = false;
  phantomCreateFailures = 0;
  lagShellLatestTurn = false;
  detailLatestTurnLagCalls = 0;
  readonly phantomThreadIds = new Set<string>();

  async getDescriptor(): Promise<T3EnvironmentDescriptor> {
    return descriptor;
  }

  async getShellSnapshot(): Promise<T3ShellSnapshot> {
    return {
      ...snapshot,
      threads: this.lagShellLatestTurn
        ? this.activeThreads.map((thread) => ({ ...thread, latestTurn: null, session: null }))
        : this.activeThreads,
    };
  }

  async getArchivedShellSnapshot(): Promise<T3ShellSnapshot> {
    return { ...snapshot, threads: this.archivedThreads };
  }

  async getThreadSnapshot(threadId: string): Promise<T3ThreadDetailSnapshot | null> {
    const thread = this.activeThreads.find((candidate) => candidate.id === threadId);
    if (!thread) return null;
    const visibleThread =
      this.detailLatestTurnLagCalls > 0
        ? { ...thread, latestTurn: null, session: null }
        : thread;
    if (this.detailLatestTurnLagCalls > 0) this.detailLatestTurnLagCalls -= 1;
    return {
      snapshotSequence: 42,
      thread: {
        ...visibleThread,
        messages: this.messages.get(threadId) ?? [],
        deletedAt: null,
        activities: [],
        checkpoints: [],
      },
    };
  }

  async getServerConfig(): Promise<T3ServerConfig> {
    return serverConfig;
  }

  async getCurrentBranch(): Promise<string | null> {
    return this.currentBranch;
  }

  async dispatch(command: T3ThreadCommand): Promise<T3DispatchResult> {
    if (this.phantomThreadIds.has(command.threadId)) {
      this.commands.push(command);
      throw new Error(
        `Orchestration command invariant failed (thread.create): Thread '${command.threadId}' already exists and cannot be created twice.`,
      );
    }
    if (
      command.type === "thread.turn.start" &&
      command.bootstrap?.createThread &&
      this.phantomCreateFailures > 0
    ) {
      this.phantomCreateFailures -= 1;
      this.phantomThreadIds.add(command.threadId);
      this.commands.push(command);
      throw new Error(
        `Orchestration command invariant failed (thread.create): Thread '${command.threadId}' already exists and cannot be created twice.`,
      );
    }
    const receiptThreadId = this.receipts.get(command.commandId);
    if (receiptThreadId !== undefined) {
      if (receiptThreadId !== command.threadId) throw new Error("Command id conflict");
      return { sequence: 42 };
    }
    this.receipts.set(command.commandId, command.threadId);
    this.commands.push(command);
    if (command.type === "thread.turn.start" && command.bootstrap?.createThread) {
      const created = command.bootstrap.createThread;
      const prepared = command.bootstrap.prepareWorktree;
      this.activeThreads.push({
        id: command.threadId,
        projectId: created.projectId,
        title: created.title,
        modelSelection: created.modelSelection,
        runtimeMode: created.runtimeMode,
        interactionMode: created.interactionMode,
        branch: prepared && !this.partialWorktreeBootstrap ? prepared.branch : created.branch,
        worktreePath:
          prepared && !this.partialWorktreeBootstrap
            ? `/worktrees/${prepared.branch.replaceAll("/", "-")}`
            : created.worktreePath,
        latestTurn: this.partialWorktreeBootstrap
          ? null
          : {
              turnId: "turn-1",
              state: "running",
              requestedAt: command.createdAt,
              startedAt: command.createdAt,
              completedAt: null,
              assistantMessageId: null,
            },
        createdAt: created.createdAt,
        updatedAt: created.createdAt,
        archivedAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        backgroundLiveness: null,
        session: this.partialWorktreeBootstrap
          ? null
          : {
              status: "running",
              activeTurnId: "turn-1",
              lastError: null,
            },
      });
      if (this.partialWorktreeBootstrap) throw new Error("worktree bootstrap interrupted");
      this.messages.set(command.threadId, [
        {
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      ]);
    } else if (command.type === "thread.turn.start") {
      const existing = this.messages.get(command.threadId) ?? [];
      this.messages.set(command.threadId, [
        ...existing,
        {
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      ]);
    } else if (command.type === "thread.archive") {
      const index = this.activeThreads.findIndex((thread) => thread.id === command.threadId);
      const [thread] = index < 0 ? [] : this.activeThreads.splice(index, 1);
      if (thread) this.archivedThreads.push({ ...thread, archivedAt: new Date().toISOString() });
    } else if (command.type === "thread.unarchive") {
      const index = this.archivedThreads.findIndex((thread) => thread.id === command.threadId);
      const [thread] = index < 0 ? [] : this.archivedThreads.splice(index, 1);
      if (thread) this.activeThreads.push({ ...thread, archivedAt: null });
    }
    return { sequence: 42 };
  }
}

function spawnInput(overrides: Partial<SpawnThreadInput> = {}): SpawnThreadInput {
  return {
    idempotencyKey: "payment-fix-v1",
    project: "ecosconnect",
    prompt: "Implement the payment fix",
    runtimeMode: "full-access",
    interactionMode: "default",
    workspace: { mode: "project" },
    ...overrides,
  };
}

function createAdapter(
  client: FakeClient = new FakeClient(),
  worktrees: FakeWorktreePreparer = new FakeWorktreePreparer(),
): T3Adapter {
  return new T3Adapter(client, true, worktrees, { spawnVerificationTimeoutMs: 25 });
}

describe("T3Adapter", () => {
  it("lists the current checkout branch for each project", async () => {
    const client = new FakeClient();
    client.currentBranch = "avhenig/dev";
    const adapter = createAdapter(client);

    await expect(adapter.listProjects()).resolves.toEqual([
      expect.objectContaining({
        id: "project-1",
        workspaceRoot: "/code/ecosconnect",
        currentBranch: "avhenig/dev",
      }),
    ]);
  });

  it("lists live reasoning levels and model options", async () => {
    const adapter = createAdapter();

    const providers = await adapter.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      instanceId: "codex",
      available: true,
      models: [
        {
          slug: "gpt-5.6-sol",
          options: [
            {
              id: "reasoningEffort",
              options: [{ id: "low" }, { id: "medium" }, { id: "high" }],
            },
            { id: "fastMode", type: "boolean" },
          ],
        },
      ],
    });
  });

  it("creates and starts a project-checkout thread with inherited model options", async () => {
    const client = new FakeClient();
    const adapter = createAdapter(client);

    const result = await adapter.spawnThread(
      spawnInput({ reasoningLevel: "high", modelOptions: { fastMode: true } }),
    );

    expect(result).toMatchObject({
      platform: "t3",
      projectId: "project-1",
      provider: "codex",
      model: "gpt-5.6-sol",
      options: { reasoningEffort: "high", fastMode: true },
      baseBranch: null,
      branch: null,
      workspaceMode: "project",
      dispatchSequence: 42,
      deduplicated: false,
    });
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toMatchObject({
      type: "thread.turn.start",
      message: { role: "user", text: "Implement the payment fix", attachments: [] },
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "high" },
        ],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          branch: null,
          worktreePath: null,
        },
      },
    });
    const first = client.commands[0];
    expect(first?.type).toBe("thread.turn.start");
    if (first?.type === "thread.turn.start") {
      expect(first.bootstrap?.prepareWorktree).toBeUndefined();
    }
  });

  it("waits for both thread and shell projections to expose the initial turn", async () => {
    const client = new FakeClient();
    client.lagShellLatestTurn = true;
    client.detailLatestTurnLagCalls = 2;
    const adapter = createAdapter(client);

    await expect(adapter.spawnThread(spawnInput())).resolves.toMatchObject({
      deduplicated: false,
      dispatchSequence: 42,
    });
    expect(client.commands).toHaveLength(1);
  });

  it("deduplicates an exact spawn retry without dispatching twice", async () => {
    const client = new FakeClient();
    const adapter = createAdapter(client);

    const first = await adapter.spawnThread(spawnInput());
    const retry = await adapter.spawnThread(spawnInput());

    expect(retry.threadId).toBe(first.threadId);
    expect(retry).toMatchObject({ deduplicated: true, dispatchSequence: null });
    expect(client.commands).toHaveLength(1);
  });

  it("rejects reuse of a spawn key with changed effective arguments", async () => {
    const client = new FakeClient();
    const adapter = createAdapter(client);

    await adapter.spawnThread(spawnInput());

    await expect(
      adapter.spawnThread(spawnInput({ prompt: "A different task" })),
    ).rejects.toThrow("Command id conflict");
    expect(client.activeThreads).toHaveLength(1);
  });

  it("creates T3 with an already-bound MCP-managed worktree", async () => {
    const client = new FakeClient();
    const worktrees = new FakeWorktreePreparer();
    const adapter = createAdapter(client, worktrees);

    const result = await adapter.spawnThread(
      spawnInput({
        title: "Payment fix",
        workspace: {
          mode: "worktree",
          baseBranch: "main",
          branch: "agent/payment-fix",
          startFromOrigin: false,
          runSetupScript: true,
        },
      }),
    );

    expect(result).toMatchObject({
      baseBranch: "main",
      branch: "agent/payment-fix",
      worktreePath: "/worktrees/agent-payment-fix",
      worktreeDisposition: "created",
    });
    expect(worktrees.calls).toEqual([
      {
        projectCwd: "/code/ecosconnect",
        baseBranch: "main",
        branch: "agent/payment-fix",
        startFromOrigin: false,
      },
    ]);
    const command = client.commands[0];
    expect(command?.type).toBe("thread.turn.start");
    if (command?.type !== "thread.turn.start") throw new Error("Expected turn start");
    expect(command.bootstrap).toMatchObject({
      createThread: {
        branch: "agent/payment-fix",
        worktreePath: "/worktrees/agent-payment-fix",
      },
      runSetupScript: true,
    });
    expect(command.bootstrap?.prepareWorktree).toBeUndefined();
  });

  it("rejects origin-based worktrees before touching git or T3", async () => {
    const client = new FakeClient();
    const worktrees = new FakeWorktreePreparer();
    const adapter = createAdapter(client, worktrees);

    await expect(
      adapter.spawnThread(
        spawnInput({
          workspace: {
            mode: "worktree",
            baseBranch: "main",
            branch: "agent/payment-fix",
            startFromOrigin: true,
            runSetupScript: true,
          },
        }),
      ),
    ).rejects.toThrow("start_from_origin is disabled");

    expect(worktrees.calls).toHaveLength(0);
    expect(client.commands).toHaveLength(0);
  });

  it("defaults a worktree base to the project's currently checked-out branch", async () => {
    const client = new FakeClient();
    client.currentBranch = "avhenig/dev";
    const worktrees = new FakeWorktreePreparer();
    const adapter = createAdapter(client, worktrees);

    await adapter.spawnThread(
      spawnInput({
        workspace: {
          mode: "worktree",
          branch: "agent/payment-fix",
          startFromOrigin: false,
          runSetupScript: true,
        },
      }),
    );

    expect(client.commands[0]).toMatchObject({
      type: "thread.turn.start",
      bootstrap: {
        createThread: {
          branch: "agent/payment-fix",
          worktreePath: "/worktrees/agent-payment-fix",
        },
      },
    });
    expect(worktrees.calls[0]).toMatchObject({ baseBranch: "avhenig/dev" });
  });

  it("requires an explicit worktree base for a detached checkout", async () => {
    const client = new FakeClient();
    client.currentBranch = null;
    const adapter = createAdapter(client);

    await expect(
      adapter.spawnThread(
        spawnInput({
          workspace: {
            mode: "worktree",
            branch: "agent/payment-fix",
            startFromOrigin: false,
            runSetupScript: true,
          },
        }),
      ),
    ).rejects.toThrow("not on a local branch");
    expect(client.commands).toHaveLength(0);
  });

  it("reports a partial worktree bootstrap as incomplete and blocks follow-ups", async () => {
    const client = new FakeClient();
    client.partialWorktreeBootstrap = true;
    const adapter = createAdapter(client);
    const input = spawnInput({
      workspace: {
        mode: "worktree",
        baseBranch: "main",
        branch: "agent/payment-fix",
        startFromOrigin: false,
        runSetupScript: true,
      },
    });

    await expect(adapter.spawnThread(input)).rejects.toThrow("initial prompt is not persisted");
    const partial = client.activeThreads[0]!;
    await expect(adapter.spawnThread(input)).rejects.toThrow("incomplete bootstrap state");
    expect(client.commands).toHaveLength(1);
    await expect(adapter.getThreadStatus(partial.id, false)).resolves.toMatchObject({
      branch: "agent/payment-fix",
      worktreePath: "/worktrees/agent-payment-fix",
      workspaceState: "incomplete",
    });
    await expect(
      adapter.sendFollowUp({
        threadId: partial.id,
        prompt: "Continue",
        idempotencyKey: "unsafe-follow-up",
      }),
    ).rejects.toThrow("Refusing to fall back to the project checkout");
    expect(client.commands).toHaveLength(1);
  });

  it("skips invisible journaled thread IDs while preserving same-key retries", async () => {
    const client = new FakeClient();
    client.phantomCreateFailures = 1;
    const adapter = createAdapter(client);

    const first = await adapter.spawnThread(spawnInput());
    const retry = await adapter.spawnThread(spawnInput());

    expect(client.commands).toHaveLength(3);
    expect(client.commands[0]?.threadId).not.toBe(first.threadId);
    expect(client.commands[1]?.threadId).toBe(first.threadId);
    expect(client.commands[2]?.threadId).toBe(client.commands[0]?.threadId);
    expect(retry).toMatchObject({ threadId: first.threadId, deduplicated: true });
  });

  it("rejects a reasoning level that the selected model does not advertise", async () => {
    const adapter = createAdapter();

    await expect(adapter.spawnThread(spawnInput({ reasoningLevel: "ultra" }))).rejects.toThrow(
      "must be one of: low, medium, high",
    );
  });

  it("returns native completion status and the last assistant message", async () => {
    const client = new FakeClient();
    const adapter = createAdapter(client);
    const spawned = await adapter.spawnThread(spawnInput());
    const running = client.activeThreads[0]!;
    client.activeThreads[0] = {
      ...running,
      latestTurn: {
        ...running.latestTurn!,
        state: "completed",
        completedAt: "2026-08-22T10:01:00.000Z",
        assistantMessageId: "assistant-1",
      },
      session: { ...running.session, status: "ready", activeTurnId: null },
    };
    client.messages.set(spawned.threadId, [
      ...(client.messages.get(spawned.threadId) ?? []),
      {
        id: "assistant-1",
        role: "assistant",
        text: "Implemented the payment fix.",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-08-22T10:01:00.000Z",
        updatedAt: "2026-08-22T10:01:00.000Z",
      },
    ]);

    const status = await adapter.getThreadStatus(spawned.threadId);
    const waited = await adapter.waitForThread({
      threadId: spawned.threadId,
      condition: "turn_terminal",
      timeoutMs: 1_000,
      pollIntervalMs: 250,
    });

    expect(status).toMatchObject({
      phase: "completed",
      terminal: true,
      lastAssistantMessage: { text: "Implemented the payment fix.", streaming: false },
    });
    expect(waited).toMatchObject({ conditionMet: true, timedOut: false, reason: "completed" });
  });

  it("deduplicates follow-up prompts and detects key reuse with different text", async () => {
    const client = new FakeClient();
    const adapter = createAdapter(client);
    const spawned = await adapter.spawnThread(spawnInput());

    const first = await adapter.sendFollowUp({
      threadId: spawned.threadId,
      prompt: "Now add tests",
      idempotencyKey: "follow-up-tests-v1",
    });
    const retry = await adapter.sendFollowUp({
      threadId: spawned.threadId,
      prompt: "Now add tests",
      idempotencyKey: "follow-up-tests-v1",
    });

    expect(first.deduplicated).toBe(false);
    expect(retry).toMatchObject({ deduplicated: true, dispatchSequence: null });
    expect(client.commands).toHaveLength(2);
    await expect(
      adapter.sendFollowUp({
        threadId: spawned.threadId,
        prompt: "A different request",
        idempotencyKey: "follow-up-tests-v1",
      }),
    ).rejects.toThrow("already used with a different follow-up prompt");
  });

  it("archives idempotently and can unarchive the native thread", async () => {
    const client = new FakeClient();
    const adapter = createAdapter(client);
    const spawned = await adapter.spawnThread(spawnInput());

    await adapter.setThreadLifecycle({
      threadId: spawned.threadId,
      action: "archive",
      idempotencyKey: "archive-v1",
    });
    const retry = await adapter.setThreadLifecycle({
      threadId: spawned.threadId,
      action: "archive",
      idempotencyKey: "archive-v1",
    });
    const archivedStatus = await adapter.getThreadStatus(spawned.threadId, false);
    const archivedThreads = await adapter.listThreads(undefined, true);

    expect(retry).toMatchObject({ deduplicated: true, dispatchSequence: null });
    expect(archivedStatus).toMatchObject({ archived: true, phase: "archived" });
    expect(archivedThreads).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: spawned.threadId, archivedAt: expect.any(String) })]),
    );
    await adapter.setThreadLifecycle({
      threadId: spawned.threadId,
      action: "unarchive",
      idempotencyKey: "unarchive-v1",
    });
    await expect(adapter.getThreadStatus(spawned.threadId, false)).resolves.toMatchObject({
      archived: false,
    });
  });
});

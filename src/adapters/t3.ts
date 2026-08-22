import { createHash, randomBytes } from "node:crypto";

import { OrchestratorError } from "../errors.js";
import type { T3ClientLike } from "../t3/client.js";
import type {
  ModelSelection,
  ProviderOptionDescriptor,
  T3ProjectShell,
  T3Provider,
  T3ProviderModel,
  T3ThreadShell,
  T3ThreadTurnStartCommand,
} from "../t3/types.js";
import type {
  FollowUpInput,
  ProjectSummary,
  ProviderSummary,
  SpawnThreadInput,
  SpawnThreadResult,
  ThreadCommandResult,
  ThreadExecutionPhase,
  ThreadPlatformAdapter,
  ThreadStatusResult,
  ThreadSummary,
  WaitForThreadResult,
} from "./types.js";

const TITLE_MAX_LENGTH = 80;
const REASONING_OPTION_IDS = ["reasoningEffort", "effort"] as const;

function optionsToRecord(
  options: ModelSelection["options"],
): Record<string, string | boolean> {
  return Object.fromEntries((options ?? []).map(({ id, value }) => [id, value]));
}

function optionsToArray(options: Readonly<Record<string, string | boolean>>) {
  return Object.entries(options)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => ({ id, value }));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deterministicUuid(namespace: string, value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(namespace).update("\0").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deepLink(environmentId: string, threadId: string): string {
  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OrchestratorError("REQUEST_CANCELLED", "The wait request was cancelled."));
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      reject(new OrchestratorError("REQUEST_CANCELLED", "The wait request was cancelled."));
    }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

function projectSummary(project: T3ProjectShell): ProjectSummary {
  const selection = project.defaultModelSelection;
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultModelSelection:
      selection === null
        ? null
        : {
            provider: selection.instanceId,
            model: selection.model,
            ...(selection.options === undefined
              ? {}
              : { options: optionsToRecord(selection.options) }),
          },
  };
}

function providerAvailable(provider: T3Provider): boolean {
  return (
    provider.availability !== "unavailable" &&
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.status !== "disabled"
  );
}

function providerSummary(provider: T3Provider): ProviderSummary {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? provider.instanceId,
    available: providerAvailable(provider),
    status: provider.status,
    authStatus: provider.auth.status,
    ...(provider.message || provider.unavailableReason
      ? { message: provider.message ?? provider.unavailableReason }
      : {}),
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      isDefault: model.isDefault === true,
      isCustom: model.isCustom,
      options: model.capabilities?.optionDescriptors ?? [],
    })),
  };
}

function resolveProject(projects: readonly T3ProjectShell[], selector: string): T3ProjectShell {
  const exactId = projects.find((project) => project.id === selector);
  if (exactId) return exactId;
  const matches = projects.filter(
    (project) => project.title === selector || project.workspaceRoot === selector,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new OrchestratorError(
      "PROJECT_AMBIGUOUS",
      `Project selector '${selector}' matched multiple projects; use the project ID.`,
      matches.map(projectSummary),
    );
  }
  throw new OrchestratorError(
    "PROJECT_NOT_FOUND",
    `No T3 project matched '${selector}'. Call list_projects first.`,
  );
}

function requireProvider(providers: readonly T3Provider[], instanceId: string): T3Provider {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  if (!provider) {
    throw new OrchestratorError(
      "PROVIDER_NOT_FOUND",
      `Provider instance '${instanceId}' was not found. Call list_models first.`,
    );
  }
  if (!providerAvailable(provider)) {
    throw new OrchestratorError(
      "PROVIDER_UNAVAILABLE",
      `Provider instance '${instanceId}' is not ready (${provider.status}, auth: ${provider.auth.status}).`,
      providerSummary(provider),
    );
  }
  return provider;
}

function requireModel(provider: T3Provider, slug: string): T3ProviderModel {
  const model = provider.models.find((candidate) => candidate.slug === slug);
  if (!model) {
    throw new OrchestratorError(
      "MODEL_NOT_FOUND",
      `Model '${slug}' is not available on provider '${provider.instanceId}'. Call list_models first.`,
    );
  }
  return model;
}

function defaultModel(provider: T3Provider): T3ProviderModel {
  const model = provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  if (!model) {
    throw new OrchestratorError(
      "NO_PROVIDER_MODELS",
      `Provider '${provider.instanceId}' currently advertises no models.`,
    );
  }
  return model;
}

function findDescriptor(model: T3ProviderModel, id: string): ProviderOptionDescriptor | undefined {
  return model.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === id);
}

function validateOption(
  model: T3ProviderModel,
  id: string,
  value: string | boolean,
): void {
  const descriptor = findDescriptor(model, id);
  if (!descriptor) {
    throw new OrchestratorError(
      "MODEL_OPTION_NOT_FOUND",
      `Model '${model.slug}' does not advertise option '${id}'.`,
    );
  }
  if (descriptor.type === "boolean" && typeof value !== "boolean") {
    throw new OrchestratorError("MODEL_OPTION_INVALID", `Option '${id}' requires a boolean.`);
  }
  if (descriptor.type === "select") {
    if (typeof value !== "string" || !descriptor.options.some((option) => option.id === value)) {
      throw new OrchestratorError(
        "MODEL_OPTION_INVALID",
        `Option '${id}' must be one of: ${descriptor.options.map((option) => option.id).join(", ")}.`,
      );
    }
  }
}

function resolveSelection(
  project: T3ProjectShell,
  providers: readonly T3Provider[],
  input: Pick<SpawnThreadInput, "provider" | "model" | "reasoningLevel" | "modelOptions">,
): ModelSelection {
  let provider: T3Provider;
  let model: T3ProviderModel;
  const projectDefault = project.defaultModelSelection;

  if (input.provider !== undefined) {
    provider = requireProvider(providers, input.provider);
    model = input.model ? requireModel(provider, input.model) : defaultModel(provider);
  } else if (input.model !== undefined) {
    const matches = providers
      .filter(providerAvailable)
      .flatMap((candidate) =>
        candidate.models.some((model) => model.slug === input.model) ? [candidate] : [],
      );
    if (matches.length !== 1) {
      throw new OrchestratorError(
        matches.length === 0 ? "MODEL_NOT_FOUND" : "MODEL_AMBIGUOUS",
        matches.length === 0
          ? `No available provider advertises model '${input.model}'.`
          : `Multiple providers advertise '${input.model}'; specify provider.`,
      );
    }
    provider = matches[0]!;
    model = requireModel(provider, input.model);
  } else if (projectDefault !== null) {
    provider = requireProvider(providers, projectDefault.instanceId);
    model = requireModel(provider, projectDefault.model);
  } else {
    const first = providers.find(providerAvailable);
    if (!first) {
      throw new OrchestratorError("NO_AVAILABLE_PROVIDER", "T3 has no available provider instance.");
    }
    provider = first;
    model = defaultModel(provider);
  }

  const preservesProjectOptions =
    projectDefault !== null &&
    projectDefault.instanceId === provider.instanceId &&
    projectDefault.model === model.slug;
  const options: Record<string, string | boolean> = preservesProjectOptions
    ? optionsToRecord(projectDefault.options)
    : {};
  Object.assign(options, input.modelOptions ?? {});

  if (input.reasoningLevel !== undefined) {
    const reasoningId = REASONING_OPTION_IDS.find((id) => findDescriptor(model, id));
    if (!reasoningId) {
      throw new OrchestratorError(
        "REASONING_NOT_SUPPORTED",
        `Model '${model.slug}' does not advertise a reasoning or effort option.`,
      );
    }
    options[reasoningId] = input.reasoningLevel;
  }

  for (const [id, value] of Object.entries(options)) validateOption(model, id, value);
  return {
    instanceId: provider.instanceId,
    model: model.slug,
    ...(Object.keys(options).length === 0 ? {} : { options: optionsToArray(options) }),
  };
}

function defaultTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/, 1)[0]!
    .replace(/\s+/g, " ")
    .trim();
  return (firstLine || "New thread").slice(0, TITLE_MAX_LENGTH);
}

function branchSlug(title: string, idempotencyKey?: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = idempotencyKey
    ? createHash("sha256").update("branch\0").update(idempotencyKey).digest("hex").slice(0, 6)
    : randomBytes(3).toString("hex");
  return `t3code/${slug || "thread"}-${suffix}`;
}

function executionPhase(thread: T3ThreadShell, archived: boolean): ThreadExecutionPhase {
  if (archived) return "archived";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention_required";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") return "error";
  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted") {
    return "interrupted";
  }
  if (thread.latestTurn?.state === "running" || thread.session?.status === "running") {
    return "running";
  }
  if (thread.session?.status === "starting") return "starting";
  if (thread.latestTurn?.state === "completed") return "completed";
  if (thread.session?.status === "stopped") return "stopped";
  return "idle";
}

function isTerminalPhase(phase: ThreadExecutionPhase): boolean {
  return ["idle", "completed", "interrupted", "error", "stopped", "archived"].includes(phase);
}

function waitReason(
  status: ThreadStatusResult,
  condition: "turn_terminal" | "quiescent",
): WaitForThreadResult["reason"] | null {
  if (status.phase === "attention_required") return "attention_required";
  if (status.phase === "archived") return "archived";
  const turnState = status.latestTurn?.state;
  const turnTerminal =
    turnState === "completed" || turnState === "interrupted" || turnState === "error";
  if (condition === "turn_terminal" && status.phase === "error") return "error";
  if (condition === "turn_terminal" && status.phase === "interrupted") return "interrupted";
  if (condition === "turn_terminal" && status.phase === "completed") return "completed";
  if (condition === "turn_terminal" && turnTerminal) return turnState;
  if (condition === "turn_terminal" && status.latestTurn === null && isTerminalPhase(status.phase)) {
    return "idle";
  }
  const quiescent =
    isTerminalPhase(status.phase) &&
    status.backgroundLiveness === null &&
    status.session?.status !== "starting" &&
    status.session?.status !== "running";
  if (condition === "quiescent" && quiescent) return "quiescent";
  return null;
}

export class T3Adapter implements ThreadPlatformAdapter {
  readonly id = "t3";
  readonly name = "T3 Code";
  readonly #client: T3ClientLike;
  readonly #configured: boolean;

  constructor(client: T3ClientLike, configured: boolean) {
    this.#client = client;
    this.#configured = configured;
  }

  isConfigured(): boolean {
    return this.#configured;
  }

  async status(): Promise<Record<string, unknown>> {
    const descriptor = await this.#client.getDescriptor();
    if (!this.#configured) {
      return {
        connected: false,
        authenticated: false,
        endpoint: this.#client.baseUrl,
        environment: descriptor,
        problem: "T3_BEARER_TOKEN is not configured.",
      };
    }
    const [shell, config] = await Promise.all([
      this.#client.getShellSnapshot(),
      this.#client.getServerConfig(),
    ]);
    return {
      connected: true,
      authenticated: true,
      endpoint: this.#client.baseUrl,
      environment: descriptor,
      projectCount: shell.projects.length,
      threadCount: shell.threads.length,
      providerCount: config.providers.length,
    };
  }

  async listProjects(): Promise<readonly ProjectSummary[]> {
    const snapshot = await this.#client.getShellSnapshot();
    return snapshot.projects.map(projectSummary);
  }

  async listProviders(): Promise<readonly ProviderSummary[]> {
    const config = await this.#client.getServerConfig();
    return config.providers.map(providerSummary);
  }

  async listThreads(project?: string, includeArchived = false): Promise<readonly ThreadSummary[]> {
    const snapshot = await this.#client.getShellSnapshot();
    const archived = includeArchived ? await this.#client.getArchivedShellSnapshot() : null;
    const projects = [...snapshot.projects, ...(archived?.projects ?? [])].filter(
      (candidate, index, all) => all.findIndex((project) => project.id === candidate.id) === index,
    );
    const projectId = project ? resolveProject(projects, project).id : undefined;
    const threads = [...snapshot.threads, ...(archived?.threads ?? [])].filter(
      (candidate, index, all) => all.findIndex((thread) => thread.id === candidate.id) === index,
    );
    return threads
      .filter((thread) => projectId === undefined || thread.projectId === projectId)
      .map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        provider: thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        sessionStatus: thread.session?.status ?? null,
        latestTurnState: thread.latestTurn?.state ?? null,
        archivedAt: thread.archivedAt,
        hasPendingApprovals: thread.hasPendingApprovals ?? false,
        hasPendingUserInput: thread.hasPendingUserInput ?? false,
        backgroundLiveness: thread.backgroundLiveness ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      }));
  }

  async spawnThread(input: SpawnThreadInput): Promise<SpawnThreadResult> {
    const [snapshot, config] = await Promise.all([
      this.#client.getShellSnapshot(),
      this.#client.getServerConfig(),
    ]);
    const project = resolveProject(snapshot.projects, input.project);
    const selection = resolveSelection(project, config.providers, input);
    const title = (input.title?.trim() || defaultTitle(input.prompt)).slice(0, TITLE_MAX_LENGTH);
    const createdAt = new Date().toISOString();
    const branch =
      input.workspace.mode === "worktree"
        ? input.workspace.branch?.trim() || branchSlug(title, input.idempotencyKey)
        : null;
    const effectiveRequest = stableStringify({
      projectId: project.id,
      prompt: input.prompt,
      title,
      modelSelection: selection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      workspace:
        input.workspace.mode === "project"
          ? { mode: "project" }
          : {
              mode: "worktree",
              baseBranch: input.workspace.baseBranch,
              branch,
              startFromOrigin: input.workspace.startFromOrigin,
              runSetupScript: input.workspace.runSetupScript,
            },
    });
    const threadId = deterministicUuid(
      "orchestrator-mcp:t3:spawn-thread",
      `${input.idempotencyKey}\0${effectiveRequest}`,
    );
    const commandId = deterministicUuid(
      "orchestrator-mcp:t3:spawn-command",
      input.idempotencyKey,
    );

    const toResult = (dispatchSequence: number | null, deduplicated: boolean) => ({
      platform: this.id,
      environmentId: config.environment.environmentId,
      projectId: project.id,
      threadId,
      title,
      provider: selection.instanceId,
      model: selection.model,
      options: optionsToRecord(selection.options),
      branch,
      workspaceMode: input.workspace.mode,
      dispatchSequence,
      deduplicated,
      deepLink: deepLink(config.environment.environmentId, threadId),
    });

    const activeExisting = snapshot.threads.some((thread) => thread.id === threadId);
    if (activeExisting) return toResult(null, true);
    const archived = await this.#client.getArchivedShellSnapshot();
    if (archived.threads.some((thread) => thread.id === threadId)) return toResult(null, true);

    const command: T3ThreadTurnStartCommand = {
      type: "thread.turn.start",
      commandId,
      threadId,
      message: {
        messageId: deterministicUuid(
          "orchestrator-mcp:t3:spawn-message",
          `${input.idempotencyKey}\0${effectiveRequest}`,
        ),
        role: "user",
        text: input.prompt,
        attachments: [],
      },
      modelSelection: selection,
      titleSeed: title,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      bootstrap: {
        createThread: {
          projectId: project.id,
          title,
          modelSelection: selection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: input.workspace.mode === "worktree" ? input.workspace.baseBranch : null,
          worktreePath: null,
          createdAt,
        },
        ...(input.workspace.mode === "worktree"
          ? {
              prepareWorktree: {
                projectCwd: project.workspaceRoot,
                baseBranch: input.workspace.baseBranch,
                branch: branch!,
                ...(input.workspace.startFromOrigin ? { startFromOrigin: true } : {}),
              },
              runSetupScript: input.workspace.runSetupScript,
            }
          : {}),
      },
      createdAt,
    };

    try {
      const result = await this.#client.dispatch(command);
      return toResult(result.sequence, false);
    } catch (error) {
      // A concurrent retry can lose the bootstrap create race even though the
      // first request succeeded. The deterministic thread ID is the durable
      // idempotency record in that case.
      const [activeAfterFailure, archivedAfterFailure] = await Promise.all([
        this.#client.getShellSnapshot(),
        this.#client.getArchivedShellSnapshot(),
      ]);
      const exists = [...activeAfterFailure.threads, ...archivedAfterFailure.threads].some(
        (thread) => thread.id === threadId,
      );
      if (exists) return toResult(null, true);
      throw error;
    }
  }

  async getThreadStatus(
    threadId: string,
    includeLastMessage = true,
  ): Promise<ThreadStatusResult> {
    const descriptor = await this.#client.getDescriptor();
    return this.#loadThreadStatus(threadId, descriptor.environmentId, includeLastMessage);
  }

  async waitForThread(input: {
    readonly threadId: string;
    readonly condition: "turn_terminal" | "quiescent";
    readonly timeoutMs: number;
    readonly pollIntervalMs: number;
    readonly signal?: AbortSignal;
  }): Promise<WaitForThreadResult> {
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutMs;
    const descriptor = await this.#client.getDescriptor();
    let status = await this.#loadThreadStatus(input.threadId, descriptor.environmentId, false);

    while (true) {
      const reason = waitReason(status, input.condition);
      if (reason !== null) {
        status = await this.#loadThreadStatus(input.threadId, descriptor.environmentId, true);
        return {
          condition: input.condition,
          conditionMet: true,
          timedOut: false,
          reason,
          elapsedMs: Date.now() - startedAt,
          status,
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        status = await this.#loadThreadStatus(input.threadId, descriptor.environmentId, true);
        return {
          condition: input.condition,
          conditionMet: false,
          timedOut: true,
          reason: "timeout",
          elapsedMs: Date.now() - startedAt,
          status,
        };
      }
      await abortableDelay(Math.min(input.pollIntervalMs, remaining), input.signal);
      status = await this.#loadThreadStatus(input.threadId, descriptor.environmentId, false);
    }
  }

  async sendFollowUp(input: FollowUpInput): Promise<ThreadCommandResult> {
    const status = await this.getThreadStatus(input.threadId, false);
    if (status.archived) {
      throw new OrchestratorError(
        "THREAD_ARCHIVED",
        `Thread '${input.threadId}' is archived; unarchive it before sending a follow-up.`,
      );
    }
    const messageId = deterministicUuid(
      "orchestrator-mcp:t3:follow-up-message",
      input.idempotencyKey,
    );
    const existing = await this.#client.getThreadSnapshot(input.threadId, 20);
    const existingMessage = existing?.thread.messages.find((message) => message.id === messageId);
    if (existingMessage) {
      if (existingMessage.text !== input.prompt) {
        throw new OrchestratorError(
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used with a different follow-up prompt.",
        );
      }
      return this.#commandResult(status, "follow_up", null, true);
    }

    const createdAt = new Date().toISOString();
    const command: T3ThreadTurnStartCommand = {
      type: "thread.turn.start",
      commandId: deterministicUuid(
        "orchestrator-mcp:t3:follow-up-command",
        input.idempotencyKey,
      ),
      threadId: input.threadId,
      message: {
        messageId,
        role: "user",
        text: input.prompt,
        attachments: [],
      },
      runtimeMode: status.runtimeMode,
      interactionMode: status.interactionMode,
      createdAt,
    };
    const result = await this.#client.dispatch(command);
    const after = await this.#client.getThreadSnapshot(input.threadId, 20);
    const persisted = after?.thread.messages.find((message) => message.id === messageId);
    if (persisted && persisted.text !== input.prompt) {
      throw new OrchestratorError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used with a different follow-up prompt.",
      );
    }
    return this.#commandResult(status, "follow_up", result.sequence, false);
  }

  async interruptThread(input: {
    readonly threadId: string;
    readonly idempotencyKey: string;
  }): Promise<ThreadCommandResult> {
    const status = await this.getThreadStatus(input.threadId, false);
    if (status.archived) {
      throw new OrchestratorError("THREAD_ARCHIVED", "An archived thread cannot be interrupted.");
    }
    if (status.session?.activeTurnId === null && status.latestTurn?.state !== "running") {
      return this.#commandResult(status, "interrupt", null, true);
    }
    const result = await this.#client.dispatch({
      type: "thread.turn.interrupt",
      commandId: deterministicUuid(
        "orchestrator-mcp:t3:interrupt-command",
        `${input.threadId}\0${input.idempotencyKey}`,
      ),
      threadId: input.threadId,
      ...(status.latestTurn?.state === "running"
        ? { turnId: status.latestTurn.turnId }
        : {}),
      createdAt: new Date().toISOString(),
    });
    return this.#commandResult(status, "interrupt", result.sequence, false);
  }

  async stopThreadSession(input: {
    readonly threadId: string;
    readonly idempotencyKey: string;
  }): Promise<ThreadCommandResult> {
    const status = await this.getThreadStatus(input.threadId, false);
    if (status.archived) {
      throw new OrchestratorError("THREAD_ARCHIVED", "An archived thread has no active session to stop.");
    }
    if (status.session === null || status.session.status === "stopped") {
      return this.#commandResult(status, "stop_session", null, true);
    }
    const result = await this.#client.dispatch({
      type: "thread.session.stop",
      commandId: deterministicUuid(
        "orchestrator-mcp:t3:session-stop-command",
        `${input.threadId}\0${input.idempotencyKey}`,
      ),
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
    });
    return this.#commandResult(status, "stop_session", result.sequence, false);
  }

  async setThreadLifecycle(input: {
    readonly threadId: string;
    readonly action: "archive" | "unarchive" | "settle" | "activate";
    readonly idempotencyKey: string;
  }): Promise<ThreadCommandResult> {
    const status = await this.getThreadStatus(input.threadId, false);
    if (input.action === "archive" && status.archived) {
      return this.#commandResult(status, input.action, null, true);
    }
    if (input.action === "unarchive" && !status.archived) {
      return this.#commandResult(status, input.action, null, true);
    }
    if (input.action === "settle" && status.settledOverride === "settled") {
      return this.#commandResult(status, input.action, null, true);
    }
    if (input.action === "activate" && status.settledOverride === "active") {
      return this.#commandResult(status, input.action, null, true);
    }
    if ((input.action === "settle" || input.action === "activate") && status.archived) {
      throw new OrchestratorError(
        "THREAD_ARCHIVED",
        `Unarchive thread '${input.threadId}' before changing its active lifecycle.`,
      );
    }
    const commandId = deterministicUuid(
      `orchestrator-mcp:t3:lifecycle-${input.action}`,
      `${input.threadId}\0${input.idempotencyKey}`,
    );
    const result = await this.#client.dispatch(
      input.action === "activate"
        ? {
            type: "thread.unsettle",
            commandId,
            threadId: input.threadId,
            reason: "user",
          }
        : {
            type: `thread.${input.action}` as "thread.archive" | "thread.unarchive" | "thread.settle",
            commandId,
            threadId: input.threadId,
          },
    );
    return this.#commandResult(status, input.action, result.sequence, false);
  }

  async #loadThreadStatus(
    threadId: string,
    environmentId: string,
    includeLastMessage: boolean,
  ): Promise<ThreadStatusResult> {
    const active = await this.#client.getShellSnapshot();
    let thread = active.threads.find((candidate) => candidate.id === threadId);
    let archived = false;
    if (!thread) {
      const archivedSnapshot = await this.#client.getArchivedShellSnapshot();
      thread = archivedSnapshot.threads.find((candidate) => candidate.id === threadId);
      archived = thread !== undefined;
    }
    if (!thread) {
      throw new OrchestratorError(
        "THREAD_NOT_FOUND",
        `No T3 thread matched '${threadId}'. Call list_threads first.`,
      );
    }

    let lastAssistantMessage: ThreadStatusResult["lastAssistantMessage"] = null;
    if (includeLastMessage && !archived) {
      const detail = await this.#client.getThreadSnapshot(threadId, 1);
      const message = detail?.thread.messages
        .filter((candidate) => candidate.role === "assistant")
        .at(-1);
      if (message) {
        lastAssistantMessage = {
          id: message.id,
          text: message.text,
          streaming: message.streaming,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        };
      }
    }

    const phase = executionPhase(thread, archived);
    return {
      platform: this.id,
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      phase,
      terminal: isTerminalPhase(phase),
      archived,
      archivedAt: thread.archivedAt,
      settledOverride: thread.settledOverride ?? null,
      settledAt: thread.settledAt ?? null,
      snoozedUntil: thread.snoozedUntil ?? null,
      pinnedAt: thread.pinnedAt ?? null,
      provider: thread.modelSelection.instanceId,
      model: thread.modelSelection.model,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      session:
        thread.session === null
          ? null
          : {
              status: thread.session.status ?? "unknown",
              activeTurnId: thread.session.activeTurnId ?? null,
              lastError: thread.session.lastError ?? null,
            },
      latestTurn:
        thread.latestTurn == null
          ? null
          : {
              turnId: thread.latestTurn.turnId,
              state: thread.latestTurn.state,
              requestedAt: thread.latestTurn.requestedAt,
              startedAt: thread.latestTurn.startedAt,
              completedAt: thread.latestTurn.completedAt,
            },
      hasPendingApprovals: thread.hasPendingApprovals ?? false,
      hasPendingUserInput: thread.hasPendingUserInput ?? false,
      backgroundLiveness: thread.backgroundLiveness ?? null,
      planProgress: thread.planProgress ?? null,
      lastAssistantMessage,
      updatedAt: thread.updatedAt,
      deepLink: deepLink(environmentId, thread.id),
    };
  }

  #commandResult(
    status: ThreadStatusResult,
    action: string,
    dispatchSequence: number | null,
    deduplicated: boolean,
  ): ThreadCommandResult {
    return {
      platform: this.id,
      threadId: status.threadId,
      action,
      dispatchSequence,
      deduplicated,
      deepLink: status.deepLink,
    };
  }
}

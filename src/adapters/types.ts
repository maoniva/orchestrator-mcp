import type {
  InteractionMode,
  ProviderOptionDescriptor,
  RuntimeMode,
} from "../t3/types.js";

export interface PlatformSummary {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly capabilities: readonly string[];
}

export interface ProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: {
    readonly provider: string;
    readonly model: string;
    readonly options?: Readonly<Record<string, string | boolean>>;
  } | null;
}

export interface ModelSummary {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isCustom: boolean;
  readonly options: readonly ProviderOptionDescriptor[];
}

export interface ProviderSummary {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly status: string;
  readonly authStatus: string;
  readonly message?: string;
  readonly models: readonly ModelSummary[];
}

export interface ThreadSummary {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly sessionStatus: string | null;
  readonly latestTurnState: string | null;
  readonly archivedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpawnThreadInput {
  readonly idempotencyKey: string;
  readonly project: string;
  readonly prompt: string;
  readonly title?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningLevel?: string;
  readonly modelOptions?: Readonly<Record<string, string | boolean>>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly workspace:
    | { readonly mode: "project" }
    | {
        readonly mode: "worktree";
        readonly baseBranch: string;
        readonly branch?: string;
        readonly startFromOrigin: boolean;
        readonly runSetupScript: boolean;
      };
}

export interface SpawnThreadResult {
  readonly platform: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly branch: string | null;
  readonly workspaceMode: "project" | "worktree";
  readonly dispatchSequence: number | null;
  readonly deduplicated: boolean;
  readonly deepLink: string;
}

export type ThreadExecutionPhase =
  | "idle"
  | "starting"
  | "running"
  | "attention_required"
  | "completed"
  | "interrupted"
  | "error"
  | "stopped"
  | "archived";

export interface ThreadStatusResult {
  readonly platform: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly phase: ThreadExecutionPhase;
  readonly terminal: boolean;
  readonly archived: boolean;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly snoozedUntil: string | null;
  readonly pinnedAt: string | null;
  readonly provider: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly session: {
    readonly status: string;
    readonly activeTurnId: string | null;
    readonly lastError: string | null;
  } | null;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: string;
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness: string | null;
  readonly planProgress: {
    readonly step: string;
    readonly completedSteps: number;
    readonly totalSteps: number;
  } | null;
  readonly lastAssistantMessage: {
    readonly id: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
  } | null;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface FollowUpInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
}

export interface ThreadCommandResult {
  readonly platform: string;
  readonly threadId: string;
  readonly action: string;
  readonly dispatchSequence: number | null;
  readonly deduplicated: boolean;
  readonly deepLink: string;
}

export interface WaitForThreadResult {
  readonly condition: "turn_terminal" | "quiescent";
  readonly conditionMet: boolean;
  readonly timedOut: boolean;
  readonly reason: "completed" | "interrupted" | "error" | "attention_required" | "archived" | "idle" | "quiescent" | "timeout";
  readonly elapsedMs: number;
  readonly status: ThreadStatusResult;
}

export interface ThreadPlatformAdapter {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  status(): Promise<Record<string, unknown>>;
  listProjects(): Promise<readonly ProjectSummary[]>;
  listProviders(): Promise<readonly ProviderSummary[]>;
  listThreads(project?: string, includeArchived?: boolean): Promise<readonly ThreadSummary[]>;
  spawnThread(input: SpawnThreadInput): Promise<SpawnThreadResult>;
  getThreadStatus(threadId: string, includeLastMessage?: boolean): Promise<ThreadStatusResult>;
  waitForThread(input: {
    readonly threadId: string;
    readonly condition: "turn_terminal" | "quiescent";
    readonly timeoutMs: number;
    readonly pollIntervalMs: number;
    readonly signal?: AbortSignal;
  }): Promise<WaitForThreadResult>;
  sendFollowUp(input: FollowUpInput): Promise<ThreadCommandResult>;
  interruptThread(input: {
    readonly threadId: string;
    readonly idempotencyKey: string;
  }): Promise<ThreadCommandResult>;
  stopThreadSession(input: {
    readonly threadId: string;
    readonly idempotencyKey: string;
  }): Promise<ThreadCommandResult>;
  setThreadLifecycle(input: {
    readonly threadId: string;
    readonly action: "archive" | "unarchive" | "settle" | "activate";
    readonly idempotencyKey: string;
  }): Promise<ThreadCommandResult>;
}

export type RuntimeMode =
  | "approval-required"
  | "auto-accept-edits"
  | "auto"
  | "full-access";

export type InteractionMode = "default" | "plan";

export interface ProviderOptionChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}

export type ProviderOptionDescriptor =
  | {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly type: "select";
      readonly options: readonly ProviderOptionChoice[];
      readonly currentValue?: string;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly type: "boolean";
      readonly currentValue?: boolean;
    };

export interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: readonly {
    readonly id: string;
    readonly value: string | boolean;
  }[];
}

export interface T3ProviderModel {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly subProvider?: string;
  readonly isCustom: boolean;
  readonly isDefault?: boolean;
  readonly isLegacy?: boolean;
  readonly capabilities: {
    readonly optionDescriptors?: readonly ProviderOptionDescriptor[];
  } | null;
}

export interface T3Provider {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: "ready" | "warning" | "error" | "disabled" | string;
  readonly availability?: "available" | "unavailable";
  readonly unavailableReason?: string;
  readonly message?: string;
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown" | string;
    readonly label?: string;
    readonly email?: string;
  };
  readonly models: readonly T3ProviderModel[];
}

export interface T3ServerConfig {
  readonly environment: {
    readonly environmentId: string;
    readonly label: string;
    readonly serverVersion?: string;
  };
  readonly cwd: string;
  readonly providers: readonly T3Provider[];
}

export interface T3EnvironmentDescriptor {
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
  readonly platform: {
    readonly os: string;
    readonly arch: string;
  };
  readonly capabilities: Record<string, unknown>;
}

export interface T3ProjectShell {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly defaultThreadEnvMode?: "local" | "worktree" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface T3ThreadShell {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestTurn?: {
    readonly turnId: string;
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly assistantMessageId: string | null;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly settledAt?: string | null;
  readonly snoozedUntil?: string | null;
  readonly pinnedAt?: string | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
  readonly planProgress?: {
    readonly step: string;
    readonly completedSteps: number;
    readonly totalSteps: number;
  } | null;
  readonly session: {
    readonly status?: string;
    readonly providerName?: string | null;
    readonly providerInstanceId?: string;
    readonly activeTurnId?: string | null;
    readonly lastError?: string | null;
    readonly updatedAt?: string;
  } | null;
}

export interface T3ShellSnapshot {
  readonly snapshotSequence: number;
  readonly projects: readonly T3ProjectShell[];
  readonly threads: readonly T3ThreadShell[];
  readonly updatedAt: string;
}

export interface T3DispatchResult {
  readonly sequence: number;
}

export interface T3VcsRef {
  readonly name: string;
  readonly current: boolean;
}

export interface T3VcsListRefsResult {
  readonly refs: readonly T3VcsRef[];
  readonly isRepo: boolean;
}

export interface T3Message {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface T3ThreadDetailSnapshot {
  readonly snapshotSequence: number;
  readonly thread: T3ThreadShell & {
    readonly messages: readonly T3Message[];
    readonly deletedAt: string | null;
    readonly activities: readonly unknown[];
    readonly checkpoints: readonly unknown[];
  };
}

export interface T3ThreadTurnStartCommand {
  readonly type: "thread.turn.start";
  readonly commandId: string;
  readonly threadId: string;
  readonly message: {
    readonly messageId: string;
    readonly role: "user";
    readonly text: string;
    readonly attachments: readonly [];
  };
  readonly modelSelection?: ModelSelection;
  readonly titleSeed?: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly bootstrap?: {
    readonly createThread: {
      readonly projectId: string;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: InteractionMode;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly createdAt: string;
    };
    readonly prepareWorktree?: {
      readonly projectCwd: string;
      readonly baseBranch: string;
      readonly branch: string;
      readonly startFromOrigin?: boolean;
    };
    readonly runSetupScript?: boolean;
  };
  readonly createdAt: string;
}

export type T3ThreadCommand =
  | T3ThreadTurnStartCommand
  | {
      readonly type: "thread.turn.interrupt";
      readonly commandId: string;
      readonly threadId: string;
      readonly turnId?: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "thread.session.stop";
      readonly commandId: string;
      readonly threadId: string;
      readonly createdAt: string;
    }
  | {
      readonly type:
        | "thread.archive"
        | "thread.unarchive"
        | "thread.settle";
      readonly commandId: string;
      readonly threadId: string;
    }
  | {
      readonly type: "thread.unsettle";
      readonly commandId: string;
      readonly threadId: string;
      readonly reason: "user";
    };

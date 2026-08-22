import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { T3Adapter } from "./adapters/t3.js";
import type { SpawnThreadInput } from "./adapters/types.js";
import { AdapterRegistry } from "./registry.js";
import { LocalGitWorktreePreparer } from "./git/worktrees.js";
import { T3Client } from "./t3/client.js";

const platformInput = z
  .string()
  .min(1)
  .default("t3")
  .describe("Thread platform ID. Currently 't3'; call list_platforms to discover targets.");

const modelOptionValue = z.union([z.string(), z.boolean()]);
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Stable caller-generated key for this logical action. Reuse it only when retrying the exact same action.",
  );

function success(value: Record<string, unknown>, summary?: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: summary ? `${summary}\n${JSON.stringify(value, null, 2)}` : JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function failure(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: errorMessage(error) }],
  };
}

async function runTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  summary?: (value: Record<string, unknown>) => string,
): Promise<CallToolResult> {
  try {
    const value = await operation();
    return success(value, summary?.(value));
  } catch (error) {
    return failure(error);
  }
}

export function createRegistry(config: AppConfig): AdapterRegistry {
  const client = new T3Client(config.t3);
  const worktrees = new LocalGitWorktreePreparer({
    worktreesDir: config.t3.worktreesDir,
    timeoutMs: config.t3.worktreeTimeoutMs,
  });
  return new AdapterRegistry([
    new T3Adapter(client, config.t3.bearerToken !== undefined, worktrees, {
      spawnVerificationTimeoutMs: config.t3.timeoutMs,
    }),
  ]);
}

export function buildMcpServer(config: AppConfig): McpServer {
  const registry = createRegistry(config);
  const server = new McpServer(
    { name: "orchestrator-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Create and manage real, visible agent threads in orchestration apps. Call list_platforms and orchestrator_status first, then list_projects and list_models before spawn_thread. Use exact provider instance IDs, model slugs, and advertised option values. Every state-changing tool requires a stable idempotency_key; reuse it only for an exact retry. workspace is always explicit on spawn_thread. Use get_thread_status or wait_for_thread to observe work, send_follow_up to continue it, interrupt_thread to stop the active turn, and stop_thread_session to stop all provider background work.",
    },
  );

  server.registerTool(
    "list_platforms",
    {
      title: "List thread platforms",
      description: "List configured thread platforms and their supported operations.",
      outputSchema: z.object({
        platforms: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            configured: z.boolean(),
            capabilities: z.array(z.string()),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      runTool(() => ({
        platforms: registry.list().map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          configured: adapter.isConfigured(),
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
        })),
      })),
  );

  server.registerTool(
    "orchestrator_status",
    {
      title: "Check orchestrator status",
      description:
        "Check connectivity, authentication, environment identity, and discovery counts for a platform.",
      inputSchema: z.object({ platform: platformInput }),
      outputSchema: z.object({ platform: z.string(), status: z.record(z.string(), z.unknown()) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ platform }) =>
      runTool(async () => ({ platform, status: await registry.get(platform).status() })),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List projects that can own a new thread, including IDs, workspace roots, currently checked-out branches, and default models.",
      inputSchema: z.object({ platform: platformInput }),
      outputSchema: z.object({ platform: z.string(), projects: z.array(z.unknown()) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ platform }) =>
      runTool(async () => ({ platform, projects: await registry.get(platform).listProjects() })),
  );

  server.registerTool(
    "list_models",
    {
      title: "List providers and models",
      description:
        "List live provider instances, models, availability, authentication state, and valid model options such as reasoning effort.",
      inputSchema: z.object({ platform: platformInput }),
      outputSchema: z.object({ platform: z.string(), providers: z.array(z.unknown()) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ platform }) =>
      runTool(async () => ({ platform, providers: await registry.get(platform).listProviders() })),
  );

  server.registerTool(
    "list_threads",
    {
      title: "List threads",
      description:
        "List visible threads, optionally filtered by a project ID, exact title, or workspace root.",
      inputSchema: z.object({
        platform: platformInput,
        project: z.string().min(1).optional(),
        include_archived: z.boolean().default(false),
      }),
      outputSchema: z.object({ platform: z.string(), threads: z.array(z.unknown()) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ platform, project, include_archived }) =>
      runTool(async () => ({
        platform,
        threads: await registry.get(platform).listThreads(project, include_archived),
      })),
  );

  server.registerTool(
    "spawn_thread",
    {
      title: "Spawn an agent thread",
      description:
        "Idempotently create a real thread in the selected app and immediately start its initial prompt.",
      inputSchema: z.object({
        platform: platformInput,
        idempotency_key: idempotencyKey,
        project: z
          .string()
          .min(1)
          .describe("Project ID, exact project title, or exact workspace root from list_projects."),
        prompt: z.string().min(1).max(120_000).describe("Initial prompt sent to the new agent."),
        title: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe("Thread title. Defaults to the first line of the prompt."),
        provider: z
          .string()
          .min(1)
          .optional()
          .describe("Provider instance ID from list_models, such as 'codex'."),
        model: z.string().min(1).optional().describe("Exact model slug from list_models."),
        reasoning_level: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Convenience value for the model's reasoningEffort/effort option; validated against list_models.",
          ),
        model_options: z
          .record(z.string().min(1), modelOptionValue)
          .optional()
          .describe("Additional provider option IDs and values exactly as advertised by list_models."),
        runtime_mode: z
          .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
          .default("full-access"),
        interaction_mode: z.enum(["default", "plan"]).default("default"),
        workspace: z
          .discriminatedUnion("mode", [
            z.object({ mode: z.literal("project") }),
            z.object({
              mode: z.literal("worktree"),
              base_branch: z.string().min(1).optional(),
              branch: z.string().min(1).optional(),
              start_from_origin: z
                .literal(false)
                .default(false)
                .describe("Must remain false; worktrees are always created from a local ref."),
              run_setup_script: z.boolean().default(true),
            }),
          ])
          .describe(
            "Required: explicitly run in the project's current checkout or prepare an isolated git worktree. A worktree defaults to the project's currently checked-out branch when base_branch is omitted.",
          ),
      }),
      outputSchema: z.object({
        platform: z.string(),
        environmentId: z.string(),
        projectId: z.string(),
        threadId: z.string(),
        title: z.string(),
        provider: z.string(),
        model: z.string(),
        options: z.record(z.string(), modelOptionValue),
        baseBranch: z.string().nullable(),
        branch: z.string().nullable(),
        worktreePath: z.string().nullable(),
        worktreeDisposition: z.enum(["created", "adopted"]).nullable(),
        workspaceMode: z.enum(["project", "worktree"]),
        dispatchSequence: z.number().nullable(),
        deduplicated: z.boolean(),
        deepLink: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      platform,
      idempotency_key,
      project,
      prompt,
      title,
      provider,
      model,
      reasoning_level,
      model_options,
      runtime_mode,
      interaction_mode,
      workspace,
    }) => {
      const input: SpawnThreadInput = {
        idempotencyKey: idempotency_key,
        project,
        prompt,
        ...(title === undefined ? {} : { title }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(reasoning_level === undefined ? {} : { reasoningLevel: reasoning_level }),
        ...(model_options === undefined ? {} : { modelOptions: model_options }),
        runtimeMode: runtime_mode,
        interactionMode: interaction_mode,
        workspace:
          workspace.mode === "project"
            ? { mode: "project" }
            : {
                mode: "worktree",
                ...(workspace.base_branch === undefined
                  ? {}
                  : { baseBranch: workspace.base_branch }),
                ...(workspace.branch === undefined ? {} : { branch: workspace.branch }),
                startFromOrigin: workspace.start_from_origin,
                runSetupScript: workspace.run_setup_script,
              },
      };
      return runTool(
        () => registry.get(platform).spawnThread(input) as unknown as Promise<Record<string, unknown>>,
        (value) => `Created thread ${String(value.threadId)} and started its first turn.`,
      );
    },
  );

  server.registerTool(
    "get_thread_status",
    {
      title: "Get thread status",
      description:
        "Get a thread's native execution/lifecycle status, pending-attention flags, latest turn, plan progress, and latest assistant message.",
      inputSchema: z.object({
        platform: platformInput,
        thread_id: z.string().min(1).describe("Exact thread ID from spawn_thread or list_threads."),
        include_last_message: z.boolean().default(true),
      }),
      outputSchema: z.object({ platform: z.string(), status: z.record(z.string(), z.unknown()) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ platform, thread_id, include_last_message }) =>
      runTool(async () => ({
        platform,
        status: await registry.get(platform).getThreadStatus(thread_id, include_last_message),
      })),
  );

  server.registerTool(
    "wait_for_thread",
    {
      title: "Wait for thread",
      description:
        "Poll native T3 state until the current turn is terminal, all background work is quiescent, attention is required, or the timeout expires.",
      inputSchema: z.object({
        platform: platformInput,
        thread_id: z.string().min(1),
        condition: z.enum(["turn_terminal", "quiescent"]).default("turn_terminal"),
        timeout_seconds: z.number().int().min(1).max(300).default(120),
        poll_interval_ms: z.number().int().min(250).max(5_000).default(1_000),
      }),
      outputSchema: z.object({
        condition: z.enum(["turn_terminal", "quiescent"]),
        conditionMet: z.boolean(),
        timedOut: z.boolean(),
        reason: z.enum([
          "completed",
          "interrupted",
          "error",
          "attention_required",
          "archived",
          "idle",
          "quiescent",
          "timeout",
        ]),
        elapsedMs: z.number(),
        status: z.record(z.string(), z.unknown()),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (
      { platform, thread_id, condition, timeout_seconds, poll_interval_ms },
      context,
    ) =>
      runTool(
        () =>
          registry.get(platform).waitForThread({
            threadId: thread_id,
            condition,
            timeoutMs: timeout_seconds * 1_000,
            pollIntervalMs: poll_interval_ms,
            signal: context.mcpReq.signal,
          }) as unknown as Promise<Record<string, unknown>>,
      ),
  );

  server.registerTool(
    "send_follow_up",
    {
      title: "Send thread follow-up",
      description:
        "Idempotently send a new user prompt to an existing, unarchived thread and start its next turn.",
      inputSchema: z.object({
        platform: platformInput,
        thread_id: z.string().min(1),
        prompt: z.string().min(1).max(120_000),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: z.object({
        platform: z.string(),
        threadId: z.string(),
        action: z.string(),
        dispatchSequence: z.number().nullable(),
        deduplicated: z.boolean(),
        deepLink: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ platform, thread_id, prompt, idempotency_key }) =>
      runTool(
        () =>
          registry.get(platform).sendFollowUp({
            threadId: thread_id,
            prompt,
            idempotencyKey: idempotency_key,
          }) as unknown as Promise<Record<string, unknown>>,
      ),
  );

  server.registerTool(
    "interrupt_thread",
    {
      title: "Interrupt active thread turn",
      description:
        "Idempotently request interruption of the thread's active turn. This does not archive or delete the thread.",
      inputSchema: z.object({
        platform: platformInput,
        thread_id: z.string().min(1),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: z.object({
        platform: z.string(),
        threadId: z.string(),
        action: z.string(),
        dispatchSequence: z.number().nullable(),
        deduplicated: z.boolean(),
        deepLink: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ platform, thread_id, idempotency_key }) =>
      runTool(
        () =>
          registry.get(platform).interruptThread({
            threadId: thread_id,
            idempotencyKey: idempotency_key,
          }) as unknown as Promise<Record<string, unknown>>,
      ),
  );

  server.registerTool(
    "stop_thread_session",
    {
      title: "Stop thread session",
      description:
        "Idempotently stop the provider session and its background work without deleting the thread.",
      inputSchema: z.object({
        platform: platformInput,
        thread_id: z.string().min(1),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: z.object({
        platform: z.string(),
        threadId: z.string(),
        action: z.string(),
        dispatchSequence: z.number().nullable(),
        deduplicated: z.boolean(),
        deepLink: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ platform, thread_id, idempotency_key }) =>
      runTool(
        () =>
          registry.get(platform).stopThreadSession({
            threadId: thread_id,
            idempotencyKey: idempotency_key,
          }) as unknown as Promise<Record<string, unknown>>,
      ),
  );

  server.registerTool(
    "set_thread_lifecycle",
    {
      title: "Set thread lifecycle",
      description:
        "Idempotently archive, unarchive, settle, or reactivate a thread. Archive is reversible; this tool never deletes threads.",
      inputSchema: z.object({
        platform: platformInput,
        thread_id: z.string().min(1),
        action: z.enum(["archive", "unarchive", "settle", "activate"]),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: z.object({
        platform: z.string(),
        threadId: z.string(),
        action: z.string(),
        dispatchSequence: z.number().nullable(),
        deduplicated: z.boolean(),
        deepLink: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ platform, thread_id, action, idempotency_key }) =>
      runTool(
        () =>
          registry.get(platform).setThreadLifecycle({
            threadId: thread_id,
            action,
            idempotencyKey: idempotency_key,
          }) as unknown as Promise<Record<string, unknown>>,
      ),
  );

  return server;
}

export function createOrchestratorHandler(config: AppConfig) {
  return createMcpHandler(() => buildMcpServer(config));
}

import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { OrchestratorError } from "../errors.js";

const OUTPUT_TAIL_LIMIT = 32_768;

export interface PrepareWorktreeInput {
  readonly projectCwd: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly startFromOrigin: boolean;
}

export interface PreparedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly disposition: "created" | "adopted";
}

export interface WorktreePreparer {
  prepare(input: PrepareWorktreeInput): Promise<PreparedWorktree>;
  adopt(input: {
    readonly projectCwd: string;
    readonly worktreePath: string;
  }): Promise<PreparedWorktree>;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface ListedWorktree {
  readonly path: string;
  readonly branch: string | null;
}

function appendTail(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return combined.length <= OUTPUT_TAIL_LIMIT
    ? combined
    : combined.slice(combined.length - OUTPUT_TAIL_LIMIT);
}

function runGit(cwd: string, args: readonly string[], timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function parseWorktrees(output: string): readonly ListedWorktree[] {
  const entries: ListedWorktree[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (currentPath !== null) entries.push({ path: currentPath, branch: currentBranch });
      currentPath = field.slice("worktree ".length);
      currentBranch = null;
    } else if (field.startsWith("branch refs/heads/")) {
      currentBranch = field.slice("branch refs/heads/".length);
    }
  }
  if (currentPath !== null) entries.push({ path: currentPath, branch: currentBranch });
  return entries;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(candidate);
    throw error;
  }
}

export class LocalGitWorktreePreparer implements WorktreePreparer {
  readonly #worktreesDir: string;
  readonly #timeoutMs: number;

  constructor(config: { readonly worktreesDir: string; readonly timeoutMs: number }) {
    this.#worktreesDir = config.worktreesDir;
    this.#timeoutMs = config.timeoutMs;
  }

  async prepare(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
    if (input.startFromOrigin) {
      throw new OrchestratorError(
        "START_FROM_ORIGIN_DISABLED",
        "MCP-managed worktrees may only be created from local refs.",
      );
    }
    const expectedPath = path.resolve(
      this.#worktreesDir,
      path.basename(input.projectCwd),
      input.branch.replaceAll("/", "-"),
    );
    const existing = await this.#list(input.projectCwd);
    const expectedCanonicalPath = await canonicalPath(expectedPath);
    let atExpectedPath: ListedWorktree | undefined;
    for (const worktree of existing) {
      if ((await canonicalPath(worktree.path)) === expectedCanonicalPath) {
        atExpectedPath = worktree;
        break;
      }
    }
    if (atExpectedPath?.branch === input.branch) {
      return { path: expectedPath, branch: input.branch, disposition: "adopted" };
    }
    if (atExpectedPath) {
      throw new OrchestratorError(
        "WORKTREE_PATH_CONFLICT",
        `Expected worktree path '${expectedPath}' is registered to branch '${atExpectedPath.branch ?? "detached"}'.`,
      );
    }
    const branchWorktree = existing.find((worktree) => worktree.branch === input.branch);
    if (branchWorktree) {
      throw new OrchestratorError(
        "WORKTREE_BRANCH_CONFLICT",
        `Branch '${input.branch}' is already checked out at '${branchWorktree.path}', not '${expectedPath}'.`,
      );
    }
    if (await pathExists(expectedPath)) {
      throw new OrchestratorError(
        "WORKTREE_PATH_CONFLICT",
        `Expected worktree path '${expectedPath}' exists but is not registered with Git.`,
      );
    }

    const baseRef = input.baseBranch;
    const branchExists =
      (await runGit(
        input.projectCwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
        this.#timeoutMs,
      )).exitCode === 0;
    if (branchExists) {
      const [branchCommit, baseCommit] = await Promise.all([
        this.#revParse(input.projectCwd, input.branch),
        this.#revParse(input.projectCwd, baseRef),
      ]);
      if (branchCommit !== baseCommit) {
        throw new OrchestratorError(
          "WORKTREE_BRANCH_CONFLICT",
          `Branch '${input.branch}' already exists at ${branchCommit.slice(0, 12)}, not requested base ${baseCommit.slice(0, 12)}.`,
        );
      }
    }

    const args = branchExists
      ? ["worktree", "add", expectedPath, input.branch]
      : ["worktree", "add", "-b", input.branch, expectedPath, baseRef];
    const result = await runGit(input.projectCwd, args, this.#timeoutMs);
    if (result.exitCode !== 0) {
      const adopted = await this.#findMatching(input.projectCwd, expectedPath, input.branch);
      if (adopted) return adopted;
      if (result.timedOut) {
        throw new OrchestratorError(
          "WORKTREE_PREPARE_TIMEOUT",
          `git worktree add did not finish within ${this.#timeoutMs}ms. The expected path is '${expectedPath}'; retrying the same spawn will adopt it if the hook completes successfully.`,
        );
      }
      const detail = result.stderr.trim().split("\n").at(-1) || "git worktree add failed";
      throw new OrchestratorError(
        "WORKTREE_PREPARE_FAILED",
        `Could not create worktree '${expectedPath}': ${detail}`,
      );
    }

    const adopted = await this.#findMatching(input.projectCwd, expectedPath, input.branch);
    if (!adopted) {
      throw new OrchestratorError(
        "WORKTREE_PREPARE_FAILED",
        `git worktree add exited successfully, but '${expectedPath}' is not registered to '${input.branch}'.`,
      );
    }
    await runGit(
      input.projectCwd,
      ["config", `branch.${input.branch}.gh-merge-base`, input.baseBranch],
      this.#timeoutMs,
    );
    return { ...adopted, disposition: "created" };
  }

  async adopt(input: {
    readonly projectCwd: string;
    readonly worktreePath: string;
  }): Promise<PreparedWorktree> {
    if (!path.isAbsolute(input.worktreePath)) {
      throw new OrchestratorError(
        "WORKTREE_PATH_NOT_ABSOLUTE",
        `Worktree path '${input.worktreePath}' must be absolute.`,
      );
    }
    const requestedPath = path.resolve(input.worktreePath);
    const requestedCanonicalPath = await canonicalPath(requestedPath);
    const projectCanonicalPath = await canonicalPath(input.projectCwd);
    if (requestedCanonicalPath === projectCanonicalPath) {
      throw new OrchestratorError(
        "WORKTREE_PATH_IS_PROJECT",
        `'${requestedPath}' is the project's primary checkout, not a linked worktree.`,
      );
    }

    let match: ListedWorktree | undefined;
    for (const worktree of await this.#list(input.projectCwd)) {
      if ((await canonicalPath(worktree.path)) === requestedCanonicalPath) {
        match = worktree;
        break;
      }
    }
    if (!match) {
      throw new OrchestratorError(
        "WORKTREE_NOT_FOUND",
        `'${requestedPath}' is not a registered Git worktree for '${input.projectCwd}'.`,
      );
    }
    if (match.branch === null) {
      throw new OrchestratorError(
        "WORKTREE_DETACHED",
        `Worktree '${match.path}' is detached; move it onto a local branch before assigning a thread to it.`,
      );
    }
    return { path: requestedPath, branch: match.branch, disposition: "adopted" };
  }

  async #list(cwd: string): Promise<readonly ListedWorktree[]> {
    const result = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"], this.#timeoutMs);
    if (result.exitCode !== 0) {
      throw new OrchestratorError(
        "WORKTREE_DISCOVERY_FAILED",
        `Could not list Git worktrees for '${cwd}': ${result.stderr.trim()}`,
      );
    }
    return parseWorktrees(result.stdout);
  }

  async #findMatching(
    cwd: string,
    expectedPath: string,
    branch: string,
  ): Promise<PreparedWorktree | null> {
    const expectedCanonicalPath = await canonicalPath(expectedPath);
    let match: ListedWorktree | undefined;
    for (const worktree of await this.#list(cwd)) {
      if (
        (await canonicalPath(worktree.path)) === expectedCanonicalPath &&
        worktree.branch === branch
      ) {
        match = worktree;
        break;
      }
    }
    return match ? { path: expectedPath, branch, disposition: "adopted" } : null;
  }

  async #revParse(cwd: string, ref: string): Promise<string> {
    const result = await runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], this.#timeoutMs);
    if (result.exitCode !== 0) {
      throw new OrchestratorError(
        "WORKTREE_BASE_NOT_FOUND",
        `Git ref '${ref}' could not be resolved in '${cwd}'.`,
      );
    }
    return result.stdout.trim();
  }
}

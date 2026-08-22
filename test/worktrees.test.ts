import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalGitWorktreePreparer } from "../src/git/worktrees.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("LocalGitWorktreePreparer", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("waits through checkout hooks and adopts an exact existing worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orchestrator-worktree-test-"));
    roots.push(root);
    const repo = path.join(root, "sample-repo");
    const worktreesDir = path.join(root, "managed-worktrees");
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "user.email", "test@example.com");
    await writeFile(path.join(repo, "README.md"), "test\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "initial");
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\nsleep 0.1\n");
    await chmod(hook, 0o755);

    const preparer = new LocalGitWorktreePreparer({ worktreesDir, timeoutMs: 5_000 });
    const input = {
      projectCwd: repo,
      baseBranch: "main",
      branch: "agent/diagnostic",
      startFromOrigin: false,
    } as const;

    const created = await preparer.prepare(input);
    const adopted = await preparer.prepare(input);
    const adoptedByPath = await preparer.adopt({
      projectCwd: repo,
      worktreePath: created.path,
    });

    expect(created).toEqual({
      path: path.join(worktreesDir, "sample-repo", "agent-diagnostic"),
      branch: "agent/diagnostic",
      disposition: "created",
    });
    expect(adopted).toEqual({ ...created, disposition: "adopted" });
    expect(adoptedByPath).toEqual({ ...created, disposition: "adopted" });
    expect(git(created.path, "branch", "--show-current")).toBe("agent/diagnostic");
    expect(git(created.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
    await expect(
      preparer.adopt({ projectCwd: repo, worktreePath: repo }),
    ).rejects.toThrow("primary checkout");
    await expect(
      preparer.adopt({ projectCwd: repo, worktreePath: "agent-diagnostic" }),
    ).rejects.toThrow("must be absolute");
  });

  it("rejects origin mode before running git", async () => {
    const preparer = new LocalGitWorktreePreparer({
      worktreesDir: "/tmp/orchestrator-mcp-test-worktrees",
      timeoutMs: 5_000,
    });

    await expect(
      preparer.prepare({
        projectCwd: "/path/that/does/not/exist",
        baseBranch: "main",
        branch: "agent/diagnostic",
        startFromOrigin: true,
      }),
    ).rejects.toThrow("only be created from local refs");
  });
});

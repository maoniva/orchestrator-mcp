import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("keeps fast reads separate from long-running T3 mutations", () => {
    const config = loadConfig({});

    expect(config.t3).toMatchObject({
      timeoutMs: 15_000,
      dispatchTimeoutMs: 1_800_000,
      worktreeTimeoutMs: 1_800_000,
    });
  });

  it("allows the mutation timeout to be configured independently", () => {
    const config = loadConfig({
      T3_REQUEST_TIMEOUT_MS: "2500",
      T3_DISPATCH_TIMEOUT_MS: "7200000",
      T3_WORKTREE_TIMEOUT_MS: "7100000",
    });

    expect(config.t3).toMatchObject({
      timeoutMs: 2_500,
      dispatchTimeoutMs: 7_200_000,
      worktreeTimeoutMs: 7_100_000,
    });
  });
});

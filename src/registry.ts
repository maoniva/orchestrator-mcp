import { OrchestratorError } from "./errors.js";
import type { ThreadPlatformAdapter } from "./adapters/types.js";

export class AdapterRegistry {
  readonly #adapters: ReadonlyMap<string, ThreadPlatformAdapter>;

  constructor(adapters: readonly ThreadPlatformAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  list(): readonly ThreadPlatformAdapter[] {
    return [...this.#adapters.values()];
  }

  get(id = "t3"): ThreadPlatformAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new OrchestratorError(
        "PLATFORM_NOT_FOUND",
        `Unknown platform '${id}'. Call list_platforms first.`,
      );
    }
    return adapter;
  }
}

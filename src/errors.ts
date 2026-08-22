export class OrchestratorError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof OrchestratorError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

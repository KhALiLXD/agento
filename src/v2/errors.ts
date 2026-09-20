export type ErrorCategory =
  | "CONFIG"
  | "MODEL"
  | "ROUTING"
  | "INPUT"
  | "SESSION"
  | "AUTH"
  | "TOOL"
  | "DEPENDENCY"
  | "CONFIRMATION"
  | "RATE"
  | "INTERNAL";
export class AgentRuntimeError extends Error {
  readonly category: ErrorCategory;
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AgentRuntimeError";
    const category = code.split("_")[0];
    this.category = [
      "CONFIG",
      "MODEL",
      "ROUTING",
      "INPUT",
      "SESSION",
      "AUTH",
      "TOOL",
      "DEPENDENCY",
      "CONFIRMATION",
      "RATE",
    ].includes(category)
      ? (category as ErrorCategory)
      : "INTERNAL";
  }
  toJSON() {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      details: this.details,
    };
  }
}
export function fail(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AgentRuntimeError(code, message, details);
}
export function boundaryError(
  error: unknown,
  code = "INTERNAL_FAILURE",
): AgentRuntimeError {
  return error instanceof AgentRuntimeError
    ? error
    : new AgentRuntimeError(code, "Operation failed at an external boundary.");
}

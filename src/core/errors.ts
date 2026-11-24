/** Error codes are stable; messages are not. */
export type ShrinkErrorCode =
  | "ERR_INVALID_INPUT"
  | "ERR_INVALID_CONFIG"
  | "ERR_UNSUPPORTED_INPUT"
  | "ERR_INPUT_TOO_LARGE"
  | "ERR_PREDICATE_FAILED"
  | "ERR_PREDICATE_TIMEOUT"
  | "ERR_PREDICATE_INVALID_RESULT"
  | "ERR_PREDICATE_NOT_PRESERVED"
  | "ERR_CANCELLED";

/** Base class for every error thrown by ShrinkJS itself. */
export class ShrinkError extends Error {
  readonly code: ShrinkErrorCode;

  constructor(code: ShrinkErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ShrinkError";
    this.code = code;
  }
}

/** User input cannot be handled (wrong shape, cycle in JSON mode, ...). */
export class ShrinkInputError extends ShrinkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("ERR_INVALID_INPUT", message, options);
    this.name = "ShrinkInputError";
  }
}

/** Thrown when a required value is missing, e.g. `input: undefined` is fine but `{}` is not. */
export class ShrinkConfigError extends ShrinkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("ERR_INVALID_CONFIG", message, options);
    this.name = "ShrinkConfigError";
  }
}

/** A value type is not supported by the selected mode. */
export class ShrinkUnsupportedInputError extends ShrinkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("ERR_UNSUPPORTED_INPUT", message, options);
    this.name = "ShrinkUnsupportedInputError";
  }
}

/** The predicate threw (or the policy decided the throw is fatal). */
export class ShrinkPredicateError extends ShrinkError {
  readonly predicateError: unknown;

  constructor(message: string, predicateError: unknown) {
    super("ERR_PREDICATE_FAILED", message, { cause: predicateError });
    this.name = "ShrinkPredicateError";
    this.predicateError = predicateError;
  }
}

/** A single predicate invocation exceeded `limits.predicateTimeout`. */
export class ShrinkTimeoutError extends ShrinkError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("ERR_PREDICATE_TIMEOUT", `Predicate timed out after ${timeoutMs}ms`);
    this.name = "ShrinkTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The predicate returned something that is neither boolean nor a valid object. */
export class ShrinkPredicateResultError extends ShrinkError {
  constructor(message: string) {
    super("ERR_PREDICATE_INVALID_RESULT", message);
    this.name = "ShrinkPredicateResultError";
  }
}

/** Extraction of a human-readable message from an unknown thrown value. */
export function describeError(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: safeStringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function safeStringify(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

import { assertSupportedInput } from "../utils/clone.js";
import { sizeOf } from "../utils/serialize.js";
import { ShrinkConfigError, ShrinkError } from "./errors.js";
import { ShrinkEngine } from "./engine.js";
import { normalizeStability } from "./evaluator.js";
import { resolveHistory, type ResolvedHistoryOptions } from "./history.js";
import { PRESETS, resolveLimits } from "./limits.js";
import { builtinStrategyNames } from "../strategies/registry.js";
import type {
  CustomReducer,
  InputMode,
  Predicate,
  PredicateErrorPolicy,
  PresetName,
  ResolvedConfigSummary,
  ShrinkOptions,
  ShrinkResult,
} from "./types.js";
import { VERSION } from "../version.js";

const MODES: readonly InputMode[] = ["json", "js"];
const POLICIES: readonly PredicateErrorPolicy[] = ["fail", "preserve", "ignore"];

function fail(message: string): never {
  throw new ShrinkConfigError(message);
}

function normalizeReducers<T>(reducers: unknown): CustomReducer<T>[] {
  if (reducers === undefined) return [];
  if (!Array.isArray(reducers)) fail("reducers must be an array of { name, reduce } objects");
  const names = new Set<string>();
  return reducers.map((reducer, index) => {
    if (reducer === null || typeof reducer !== "object") fail(`reducers[${index}] must be an object`);
    const candidate = reducer as Partial<CustomReducer<T>>;
    if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
      fail(`reducers[${index}].name must be a non-empty string`);
    }
    if (names.has(candidate.name)) fail(`Duplicate reducer name "${candidate.name}"`);
    names.add(candidate.name);
    if (typeof candidate.reduce !== "function") fail(`reducers[${index}].reduce must be a function`);
    if (candidate.priority !== undefined && typeof candidate.priority !== "number") {
      fail(`reducers[${index}].priority must be a number when present`);
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== "function") {
      fail(`reducers[${index}].enabled must be a function when present`);
    }
    return candidate as CustomReducer<T>;
  });
}

/**
 * Minimizes `options.input` while keeping `options.test` satisfied.
 *
 * Programmer errors (invalid configuration, unsupported input, input larger
 * than `limits.maxInputSize`) throw synchronously-ish (the returned promise
 * rejects). Predicate problems never throw: they produce a result with
 * `ok: false` and `status: "failed"`.
 *
 * @example
 * ```ts
 * const result = await shrink({ input: payload, test: reproducesBug });
 * console.log(result.minimalInput, result.stats.reductionPercent);
 * ```
 */
export async function shrink<T>(options: ShrinkOptions<T>): Promise<ShrinkResult<T>> {
  if (options === null || typeof options !== "object") {
    fail("shrink() expects an options object: { input, test, ... }");
  }
  if (!("input" in options))
    fail('shrink() requires an "input" property (it may be undefined, but it must be declared)');
  if (typeof options.test !== "function")
    fail("shrink() requires a test function: test(candidate) => boolean | Promise<boolean>");

  const mode: InputMode = options.mode ?? "json";
  if (!MODES.includes(mode)) fail(`mode must be "json" or "js", received ${String(mode)}`);

  const predicateErrors: PredicateErrorPolicy = options.predicateErrors ?? "ignore";
  if (!POLICIES.includes(predicateErrors)) {
    fail(`predicateErrors must be one of ${POLICIES.join(", ")}, received ${String(predicateErrors)}`);
  }

  if (options.preset !== undefined && !Object.prototype.hasOwnProperty.call(PRESETS, options.preset)) {
    fail(`Unknown preset "${String(options.preset)}". Use one of: ${Object.keys(PRESETS).join(", ")}`);
  }
  const preset: PresetName | undefined = options.preset;

  const limits = resolveLimits(preset, options.limits);
  const stability = normalizeStability(options.stability);
  const history: ResolvedHistoryOptions = resolveHistorySafely(options.history);
  const reducers = normalizeReducers<T>(options.reducers);

  if (options.preserveSignature !== undefined && typeof options.preserveSignature !== "boolean") {
    fail("preserveSignature must be a boolean");
  }
  if (options.cache !== undefined && typeof options.cache !== "boolean") fail("cache must be a boolean");
  if (options.onProgress !== undefined && typeof options.onProgress !== "function") {
    fail("onProgress must be a function");
  }
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    fail("signal must be an AbortSignal");
  }

  // Validation first: it is an allocation-free iterative walk that also
  // enforces the depth ceiling, so later recursive helpers are safe.
  assertSupportedInput(options.input, mode, limits.maxInputDepth);

  const originalSize = sizeOf(options.input);
  if (limits.maxInputSize > 0 && originalSize > limits.maxInputSize) {
    throw new ShrinkError(
      "ERR_INPUT_TOO_LARGE",
      `Input measures ${originalSize} characters, above limits.maxInputSize (${limits.maxInputSize}). Raise the limit or reduce the input first.`,
    );
  }

  const hasLimitOverrides =
    options.limits !== undefined && Object.values(options.limits).some((value) => value !== undefined);

  const configSummary: ResolvedConfigSummary = {
    mode,
    preset: preset ?? (hasLimitOverrides ? "custom" : "balanced"),
    predicateErrors,
    preserveSignature: options.preserveSignature ?? true,
    cache: options.cache ?? true,
    stability,
    history,
    limits,
    reducers: [...builtinStrategyNames, ...reducers.map((reducer) => reducer.name)],
    libraryVersion: VERSION,
  };

  const engine = new ShrinkEngine<T>({
    input: options.input,
    predicate: options.test as Predicate<T>,
    limits,
    mode,
    predicateErrors,
    preserveSignature: options.preserveSignature ?? true,
    stability,
    history,
    cache: options.cache ?? true,
    reducers,
    verifyFinalInput: options.verifyFinalInput ?? true,
    configSummary,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return engine.run();
}

/** Alias of {@link shrink} for readers who prefer a verb that matches the goal. */
export const minimize = shrink;

function resolveHistorySafely(options: ShrinkOptions<unknown>["history"]): ResolvedHistoryOptions {
  try {
    return resolveHistory(options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function"
  );
}

import {
  describeError,
  ShrinkError,
  ShrinkPredicateError,
  ShrinkPredicateResultError,
  ShrinkTimeoutError,
} from "./errors.js";
import type { PredicateErrorPolicy, PredicateResult, StabilityOptions } from "./types.js";
import { stableKey } from "../utils/serialize.js";

export type EvaluationKind = "preserved" | "rejected" | "error" | "timeout" | "unstable";

export interface EvaluationOutcome {
  kind: EvaluationKind;
  preserve: boolean;
  signature: string | null;
  metadata?: Record<string, unknown>;
  durationMs: number;
  cached: boolean;
}

export interface EvaluatorConfig {
  stability: Required<StabilityOptions> | null;
  predicateErrors: PredicateErrorPolicy;
  timeoutMs: number;
  cache: boolean;
  maxCacheEntries?: number;
  onWarning?: (warning: string) => void;
}

export function normalizeStability(
  stability: StabilityOptions | undefined,
): Required<StabilityOptions> | null {
  if (!stability) return null;
  const runs = stability.runs ?? 1;
  if (!Number.isInteger(runs) || runs < 1) {
    throw new ShrinkError(
      "ERR_INVALID_CONFIG",
      `stability.runs must be an integer >= 1, received ${String(runs)}`,
    );
  }
  const requiredMatches = stability.requiredMatches ?? Math.ceil(runs / 2);
  if (!Number.isInteger(requiredMatches) || requiredMatches < 1 || requiredMatches > runs) {
    throw new ShrinkError(
      "ERR_INVALID_CONFIG",
      `stability.requiredMatches must be an integer between 1 and runs (${runs}), received ${String(requiredMatches)}`,
    );
  }
  return { runs, requiredMatches };
}

interface NormalizedResult {
  preserve: boolean;
  signature: string | null;
  metadata?: Record<string, unknown>;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return Array.isArray(value) ? "array" : "object";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return `${typeof value} ${String(value)}`;
}

function interpret(result: PredicateResult): NormalizedResult {
  if (typeof result === "boolean") return { preserve: result, signature: null };
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new ShrinkPredicateResultError(
      `Predicate must return a boolean or { preserve, signature?, metadata? }, received ${describeValue(result)}`,
    );
  }
  if (typeof result.preserve !== "boolean") {
    throw new ShrinkPredicateResultError(
      `Predicate result .preserve must be a boolean, received ${describeValue(result.preserve)}`,
    );
  }
  if (result.signature !== undefined && typeof result.signature !== "string") {
    throw new ShrinkPredicateResultError(
      `Predicate result .signature must be a string when present, received ${describeValue(result.signature)}`,
    );
  }
  if (result.metadata !== undefined && (result.metadata === null || typeof result.metadata !== "object")) {
    throw new ShrinkPredicateResultError("Predicate result .metadata must be an object when present");
  }
  const normalized: NormalizedResult = { preserve: result.preserve, signature: result.signature ?? null };
  if (result.metadata !== undefined) normalized.metadata = result.metadata;
  return normalized;
}

export function cacheKeyOf(candidate: unknown): string | null {
  try {
    return stableKey(candidate);
  } catch {
    return null;
  }
}

const CANCELLED = Symbol("cancelled");

/**
 * Runs the user predicate with timeout handling, optional stability repeats and
 * memoization. It never decides whether a candidate is *simpler*; it only
 * answers "does this candidate preserve the target behavior?".
 */
export class Evaluator {
  private readonly predicate: (candidate: unknown) => PredicateResult | Promise<PredicateResult>;
  private readonly config: EvaluatorConfig;
  private readonly cache = new Map<string, EvaluationOutcome>();
  private readonly maxCacheEntries: number;
  private warnedPreserveOnError = false;
  /** First error thrown by the predicate (for diagnostics). */
  lastError: { message: string; name?: string } | null = null;

  timeoutMs: number;
  cacheHits = 0;
  timeouts = 0;
  predicateErrors = 0;
  unstable = 0;

  constructor(
    predicate: (candidate: unknown) => PredicateResult | Promise<PredicateResult>,
    config: EvaluatorConfig,
  ) {
    this.predicate = predicate;
    this.config = config;
    this.timeoutMs = config.timeoutMs;
    this.maxCacheEntries = config.maxCacheEntries ?? 10_000;
  }

  /**
   * Evaluates `candidate`. Pass a precomputed cache key to avoid hashing twice,
   * or `null` to bypass the cache for this call.
   */
  async evaluate(candidate: unknown, precomputedKey?: string | null): Promise<EvaluationOutcome> {
    if (this.config.cache) {
      const key = precomputedKey === undefined ? cacheKeyOf(candidate) : precomputedKey;
      if (key !== null) {
        const cached = this.cache.get(key);
        if (cached) {
          this.cacheHits += 1;
          return { ...cached, cached: true };
        }
        const outcome = await this.run(candidate);
        this.store(key, outcome);
        return outcome;
      }
    }
    return this.run(candidate);
  }

  /** Always calls the predicate; never reads or writes the cache. */
  async evaluateFresh(candidate: unknown): Promise<EvaluationOutcome> {
    return this.run(candidate);
  }

  getCached(key: string): EvaluationOutcome | null {
    if (!this.config.cache) return null;
    const cached = this.cache.get(key);
    if (!cached) return null;
    this.cacheHits += 1;
    return { ...cached, cached: true };
  }

  private async run(candidate: unknown): Promise<EvaluationOutcome> {
    const started = Date.now();
    const runs = this.config.stability?.runs ?? 1;
    const results: NormalizedResult[] = [];

    for (let i = 0; i < runs; i += 1) {
      const result = await this.runOnce(candidate);
      if (result === CANCELLED) throw new ShrinkError("ERR_CANCELLED", "Minimization cancelled");
      results.push(result);
    }

    return this.combine(results, Date.now() - started, runs, started);
  }

  private combine(
    results: NormalizedResult[],
    durationMs: number,
    attempts: number,
    _started: number,
  ): EvaluationOutcome {
    void attempts;
    const stability = this.config.stability;
    if (!stability || results.length === 1) {
      const only = results[0] as NormalizedResult;
      const outcome: EvaluationOutcome = {
        kind: only.preserve ? "preserved" : "rejected",
        preserve: only.preserve,
        signature: only.signature,
        durationMs,
        cached: false,
      };
      if (only.metadata !== undefined) outcome.metadata = only.metadata;
      return outcome;
    }

    const positives = results.filter((r) => r.preserve).length;
    const negatives = results.length - positives;
    const dominantPreserve = positives >= negatives;
    const dominant = dominantPreserve ? positives : negatives;
    const signatures = new Set(results.filter((r) => r.preserve).map((r) => r.signature));
    const signatureStable = signatures.size <= 1;

    if (dominant < stability.requiredMatches || !signatureStable) {
      this.unstable += 1;
      return {
        kind: "unstable",
        preserve: false,
        signature: signatures.size === 1 ? ([...signatures][0] ?? null) : null,
        durationMs,
        cached: false,
      };
    }

    return {
      kind: dominantPreserve ? "preserved" : "rejected",
      preserve: dominantPreserve,
      signature: dominantPreserve ? ([...signatures][0] ?? null) : null,
      durationMs,
      cached: false,
    };
  }

  private async runOnce(candidate: unknown): Promise<NormalizedResult | typeof CANCELLED> {
    let result: PredicateResult;
    try {
      result = await this.invoke(candidate);
    } catch (error) {
      if (error instanceof ShrinkError && error.code === "ERR_CANCELLED") return CANCELLED;
      if (error instanceof ShrinkPredicateResultError) throw error;

      if (error instanceof ShrinkTimeoutError) {
        this.timeouts += 1;
        this.lastError = { message: error.message, name: error.name };
      } else {
        this.predicateErrors += 1;
        this.lastError = describeError(error);
      }

      const policy = this.config.predicateErrors;
      if (policy === "fail") {
        const detail = describeError(error);
        throw new ShrinkPredicateError(`Predicate failed: ${detail.message}`, error);
      }
      if (policy === "preserve") {
        if (!this.warnedPreserveOnError) {
          this.warnedPreserveOnError = true;
          this.config.onWarning?.(
            'predicateErrors is "preserve": thrown predicate errors count as reproductions. This can produce false positives.',
          );
        }
        return { preserve: true, signature: null };
      }
      return { preserve: false, signature: null };
    }

    return interpret(result);
  }

  private async invoke(candidate: unknown): Promise<PredicateResult> {
    const timeout = this.timeoutMs;
    if (timeout <= 0) return this.predicate(candidate);

    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new ShrinkTimeoutError(timeout));
      }, timeout);
      timer.unref?.();
    });

    const call = (async () => this.predicate(candidate))();
    // The predicate may settle after the timeout; never surface that as an
    // unhandled rejection.
    call.catch(() => undefined);

    try {
      return await Promise.race([call, timeoutPromise]);
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
    }
  }

  private store(key: string, outcome: EvaluationOutcome): void {
    if (this.cache.size >= this.maxCacheEntries) this.cache.clear();
    this.cache.set(key, { ...outcome, cached: false });
  }
}

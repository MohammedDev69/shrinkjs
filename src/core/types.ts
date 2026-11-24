/**
 * Public type surface for ShrinkJS.
 *
 * Everything exported from here is part of the documented API contract.
 */

/** Outcome of a single predicate invocation. */
export type PredicateResult =
  | boolean
  | {
      /** Whether the candidate still reproduces the target condition. */
      preserve: boolean;
      /**
       * Optional stable identifier for the failure. When signatures are
       * preserved (the default), the engine refuses to accept a candidate
       * whose signature differs from the original input's signature.
       */
      signature?: string;
      /** Optional user metadata. Never inspected by the engine. */
      metadata?: Record<string, unknown>;
    };

/**
 * A predicate decides whether a candidate still exhibits the target behavior.
 *
 * It may be synchronous or asynchronous. Throwing is governed by
 * {@link ShrinkOptions.predicateErrors}.
 */
export type Predicate<T> = (candidate: T) => PredicateResult | Promise<PredicateResult>;

/** How the engine treats non-JSON values. */
export type InputMode = "json" | "js";

/** Why the engine stopped early. */
export type LimitReason =
  | "max-evaluations"
  | "max-duration"
  | "max-input-size"
  | "max-passes"
  | "max-depth"
  | "max-candidates-per-node"
  | "predicate-timeout";

/** Terminal state of a minimization run. */
export type ShrinkStatus = "completed" | "limit-reached" | "cancelled" | "unstable" | "failed";

/** How to treat a predicate that throws or times out. */
export type PredicateErrorPolicy = "fail" | "preserve" | "ignore";
export interface StabilityOptions {
  /**
   * How many times to run the predicate per candidate. Defaults to 1
   * (no stability checking).
   */
  runs?: number;
  /**
   * How many of those runs must agree on the dominant result. Defaults to a
   * strict majority (`ceil(runs / 2)`).
   */
  requiredMatches?: number;
}

export interface HistoryOptions {
  /** Record every evaluated candidate. Defaults to `false`. */
  enabled?: boolean;
  /** Hard cap on retained entries (ring buffer). Defaults to `200`. */
  maxEntries?: number;
  /**
   * Include candidate values in history entries. Defaults to `false` so that
   * reports do not accidentally embed sensitive payloads.
   */
  includeValues?: boolean;
}

export interface ShrinkLimits {
  /** Maximum predicate invocations (cache hits are free). Default: 5_000. */
  maxEvaluations?: number;
  /** Maximum wall-clock duration of the whole run, in ms. Default: 60_000. */
  maxDuration?: number;
  /** Per-evaluation timeout in ms. `0` disables the timeout. Default: 5_000. */
  predicateTimeout?: number;
  /** Maximum container nesting depth the engine will descend into. Default: 32. */
  maxDepth?: number;
  /** Maximum candidates generated for a single node per visit. Default: 2_000. */
  maxCandidatesPerNode?: number;
  /**
   * Maximum measured input size (in characters of the canonical
   * representation). Default: 10_000_000.
   */
  maxInputSize?: number;
  /** Maximum number of structural passes. Default: 1_000. */
  maxPasses?: number;
}

/** Tuning preset. Explicit `limits` values always win over the preset. */
export type PresetName = "fast" | "balanced" | "thorough";

/**
 * A user-supplied reducer. It receives the current best input and returns
 * candidate replacements for the *whole* input.
 *
 * Custom reducers run after the built-in structural reducers and are repeated
 * until they stop producing strictly simpler accepted candidates.
 */
export interface CustomReducer<T = unknown> {
  /** Stable identifier; appears in stats, history and reports. */
  name: string;
  /**
   * Return any iterable of candidate inputs, a promise of one, or an async
   * iterable. Candidates must already be independent copies: the engine may
   * keep references to accepted candidates.
   */
  reduce: (
    input: T,
    context: ReducerContext,
  ) => Iterable<T> | AsyncIterable<T> | Promise<Iterable<T> | AsyncIterable<T>> | T[];
  /** Lower runs earlier. Default: 100 (after built-ins). */
  priority?: number;
  /** Skip this reducer entirely when it returns false. */
  enabled?: (input: T, context: ReducerContext) => boolean;
}

/** Information handed to custom reducers. Contains no input data. */
export interface ReducerContext {
  /** Attempts so far across the whole run. */
  readonly evaluations: number;
  /** Wall-clock ms since the run started. */
  readonly elapsedMs: number;
  /** Measured size of the current best input. */
  readonly currentSize: number;
  /** Measured size of the original input. */
  readonly originalSize: number;
  /** Current structural pass index. */
  readonly pass: number;
  /** Aborted when the caller cancels or a limit is exhausted. */
  readonly signal: AbortSignal;
  /** Returns true when the run must stop immediately. */
  isExhausted(): boolean;
}

export interface ProgressEvent {
  /** Predicate invocations so far. */
  evaluations: number;
  /** Candidates accepted so far. */
  accepted: number;
  /** Candidates rejected so far. */
  rejected: number;
  /** Measured size of the original input. */
  originalSize: number;
  /** Measured size of the current best input. */
  bestSize: number;
  /** Measured size of the candidate that triggered this event. */
  currentSize: number;
  /** Name of the active strategy / reducer. */
  strategy: string;
  /** Structural path being reduced, when applicable (no values inside). */
  path?: string;
  /** Elapsed wall-clock ms. */
  elapsedMs: number;
  phase: "init" | "reduce" | "finalize";
}

export interface ShrinkOptions<T> {
  /** The input to minimize. Never mutated. */
  input: T;
  /** Decides whether a candidate still exhibits the target behavior. */
  test: Predicate<T>;
  /** Extra whole-input reducers. */
  reducers?: Array<CustomReducer<T>>;
  /**
   * `"json"` (default) enforces JSON-compatible input and rejects cycles.
   * `"js"` additionally supports Map, Set, Date, RegExp, BigInt, ArrayBuffer,
   * typed arrays, class instances (own enumerable properties) and cycles.
   */
  mode?: InputMode;
  preset?: PresetName;
  limits?: ShrinkLimits;
  /**
   * How predicate exceptions and timeouts are handled.
   *
   * - `"ignore"` (default) — the candidate is treated as *not* reproducing the
   *   target behavior and skipped. Errors are counted and surfaced in
   *   `stats.predicateErrors` and as a warning. This is the safe default: an
   *   exception is never mistaken for a reproduction.
   * - `"fail"` — the whole run aborts with `status: "failed"`. Use it when any
   *   predicate error means your test harness is broken.
   * - `"preserve"` — the exception counts as a reproduction (dangerous; only
   *   sensible when the error *is* the signal, and documented as such).
   */
  predicateErrors?: PredicateErrorPolicy;
  /**
   * Refuse candidates whose failure signature differs from the original's.
   * Default: `true` whenever the predicate reports a signature.
   */
  preserveSignature?: boolean;
  /** Repeated predicate evaluation for flaky predicates. Off by default. */
  stability?: StabilityOptions;
  history?: HistoryOptions;
  /** Memoize predicate results. Default: `true`. */
  cache?: boolean;
  /**
   * Re-run the predicate on a fresh copy of the final input before returning,
   * and report `status: "unstable"` if it no longer holds. Default: `true`.
   * Costs one extra evaluation.
   */
  verifyFinalInput?: boolean;
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
}

export interface StrategyStat {
  attempts: number;
  accepted: number;
  rejected: number;
}

export interface ShrinkStats {
  /** Characters in the canonical representation of the original input. */
  originalSize: number;
  /** Characters in the canonical representation of the minimal input. */
  finalSize: number;
  /** `0`–`100`, rounded to one decimal. */
  reductionPercent: number;
  /** `originalSize - finalSize`. */
  savedChars: number;
  /** Predicate invocations (cache hits excluded). */
  evaluations: number;
  cacheHits: number;
  /** Candidates that passed the predicate and were strictly simpler. */
  successfulReductions: number;
  /** Candidates that were generated and evaluated but not accepted. */
  rejectedCandidates: number;
  predicateErrors: number;
  timeouts: number;
  /** Candidates discarded because repeated runs disagreed. */
  unstableCandidates: number;
  /** Candidates rejected because their failure signature did not match. */
  signatureMismatches: number;
  /** Fresh re-run of the predicate on the final input (before returning). */
  verification: {
    performed: boolean;
    preserved: boolean | null;
  };
  durationMs: number;
  passes: number;
  strategies: Record<string, StrategyStat>;
  limitReached: LimitReason | null;
}

export interface HistoryEntry {
  /** Monotonic step index. */
  step: number;
  strategy: string;
  path: string;
  outcome: "accepted" | "rejected" | "error" | "timeout" | "unstable";
  sizeBefore: number;
  sizeAfter: number;
  durationMs: number;
  signature?: string;
  /** Present only when `history.includeValues` is enabled. */
  value?: unknown;
}

export interface ShrinkErrorInfo {
  message: string;
  code: string;
  name?: string;
}

/**
 * Guarantee level of the returned input:
 *
 * - `"local"` — the run finished without hitting a limit, and no candidate
 *   produced by any enabled reducer for the final input was accepted. This is
 *   local minimality *with respect to the enabled reducer set*, not
 *   mathematical minimality.
 * - `"unknown"` — a limit/cancellation/error stopped the search early.
 */
export type Minimality = "local" | "unknown";

export interface ShrinkResult<T> {
  /** True unless the run failed (predicate never held, or fatal error). */
  ok: boolean;
  status: ShrinkStatus;
  /** Deep copy of the input as supplied by the caller. */
  originalInput: T;
  /** Deep copy of the smallest input found. Always satisfies the predicate. */
  minimalInput: T;
  minimality: Minimality;
  /** Signature reported for the original input, if any. */
  signature: string | null;
  stats: ShrinkStats;
  history?: HistoryEntry[];
  error?: ShrinkErrorInfo;
  warnings: string[];
  /** Resolved configuration summary (no user data). */
  config: ResolvedConfigSummary;
}

export interface ResolvedConfigSummary {
  mode: InputMode;
  preset: PresetName | "custom";
  predicateErrors: PredicateErrorPolicy;
  preserveSignature: boolean;
  cache: boolean;
  stability: { runs: number; requiredMatches: number } | null;
  history: { enabled: boolean; maxEntries: number; includeValues: boolean };
  limits: Required<ShrinkLimits>;
  reducers: string[];
  libraryVersion: string;
}

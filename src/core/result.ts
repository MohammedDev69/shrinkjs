import type {
  ResolvedConfigSummary,
  ShrinkResult,
  ShrinkStats,
  ShrinkStatus,
  StrategyStat,
} from "./types.js";

export function createStats(): ShrinkStats {
  return {
    originalSize: 0,
    finalSize: 0,
    reductionPercent: 0,
    savedChars: 0,
    evaluations: 0,
    cacheHits: 0,
    successfulReductions: 0,
    rejectedCandidates: 0,
    predicateErrors: 0,
    timeouts: 0,
    unstableCandidates: 0,
    signatureMismatches: 0,
    verification: { performed: false, preserved: null },
    durationMs: 0,
    passes: 0,
    strategies: {},
    limitReached: null,
  };
}

export function createStrategyStat(): StrategyStat {
  return { attempts: 0, accepted: 0, rejected: 0 };
}

/** Reduction percentage, rounded to one decimal. Can be negative. */
export function reductionPercent(originalSize: number, finalSize: number): number {
  if (originalSize <= 0) return 0;
  const raw = ((originalSize - finalSize) / originalSize) * 100;
  return Math.round(raw * 10) / 10;
}

export interface ResultParams<T> {
  status: ShrinkStatus;
  /** Defaults to `status !== "failed"`. */
  ok?: boolean;
  originalInput: T;
  minimalInput: T;
  signature?: string | null;
  stats: ShrinkStats;
  config: ResolvedConfigSummary;
  history?: ShrinkResult<T>["history"];
  error?: ShrinkResult<T>["error"];
  warnings: string[];
  /** True when the run finished without hitting a limit or an error. */
  localMinimal: boolean;
}

export function buildResult<T>(params: ResultParams<T>): ShrinkResult<T> {
  const stats: ShrinkStats = {
    ...params.stats,
    // Not clamped: a structural simplification can occasionally cost characters
    // (`{}` -> `null`), and the numbers must say so.
    reductionPercent: reductionPercent(params.stats.originalSize, params.stats.finalSize),
    savedChars: params.stats.originalSize - params.stats.finalSize,
  };

  const result: ShrinkResult<T> = {
    ok: params.ok ?? params.status !== "failed",
    status: params.status,
    originalInput: params.originalInput,
    minimalInput: params.minimalInput,
    minimality: params.status === "completed" && params.localMinimal ? "local" : "unknown",
    signature: params.signature ?? null,
    stats,
    warnings: params.warnings,
    config: params.config,
  };
  if (params.history !== undefined) result.history = params.history;
  if (params.error !== undefined) result.error = params.error;
  return result;
}

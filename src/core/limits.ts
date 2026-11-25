import { ShrinkConfigError } from "./errors.js";
import type { AbortSignalLike, LimitReason, PresetName, ShrinkLimits } from "./types.js";

export const PRESETS: Record<PresetName, Required<ShrinkLimits>> = {
  fast: {
    maxEvaluations: 500,
    maxDuration: 15_000,
    predicateTimeout: 2_000,
    maxDepth: 24,
    maxCandidatesPerNode: 200,
    maxInputSize: 2_000_000,
    maxPasses: 200,
    maxNodeVisits: 200_000,
    maxInputDepth: 500,
  },
  balanced: {
    maxEvaluations: 5_000,
    maxDuration: 60_000,
    predicateTimeout: 5_000,
    maxDepth: 32,
    maxCandidatesPerNode: 2_000,
    maxInputSize: 10_000_000,
    maxPasses: 1_000,
    maxNodeVisits: 1_000_000,
    maxInputDepth: 1_000,
  },
  thorough: {
    maxEvaluations: 100_000,
    maxDuration: 600_000,
    predicateTimeout: 15_000,
    maxDepth: 64,
    maxCandidatesPerNode: 20_000,
    maxInputSize: 50_000_000,
    maxPasses: 10_000,
    maxNodeVisits: 10_000_000,
    maxInputDepth: 2_000,
  },
};

const LIMIT_KEYS = [
  "maxEvaluations",
  "maxDuration",
  "predicateTimeout",
  "maxDepth",
  "maxCandidatesPerNode",
  "maxInputSize",
  "maxPasses",
  "maxNodeVisits",
  "maxInputDepth",
] as const satisfies ReadonlyArray<keyof ShrinkLimits>;

export function resolveLimits(
  preset: PresetName | undefined,
  overrides: ShrinkLimits | undefined,
): Required<ShrinkLimits> {
  const base = { ...PRESETS[preset ?? "balanced"] };
  if (overrides) {
    for (const key of LIMIT_KEYS) {
      const value = overrides[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
        throw new ShrinkConfigError(`limits.${key} must be a non-negative number, received ${String(value)}`);
      }
      base[key] = value;
    }
  }
  return base;
}

/**
 * Tracks evaluation count, wall-clock budget and cancellation.
 *
 * A `Budget` never throws on exhaustion; it reports a reason and lets the
 * engine stop cleanly with a partial result.
 */
export class Budget {
  readonly limits: Required<ShrinkLimits>;
  readonly startedAt = Date.now();
  readonly signal: AbortSignalLike;

  evaluations = 0;
  limitReached: LimitReason | null = null;

  private readonly controller = new AbortController();
  private readonly userSignal: AbortSignalLike | undefined;
  private readonly onUserAbort = (): void => {
    this.cancelled = true;
    this.controller.abort(new Error("cancelled"));
  };

  cancelled = false;

  constructor(limits: Required<ShrinkLimits>, userSignal?: AbortSignalLike) {
    this.limits = limits;
    this.userSignal = userSignal;
    if (userSignal) {
      if (userSignal.aborted) {
        this.cancelled = true;
        this.controller.abort(new Error("cancelled"));
      } else {
        userSignal.addEventListener("abort", this.onUserAbort, { once: true });
      }
    }
    this.signal = this.controller.signal;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get exhausted(): boolean {
    return this.limitReached !== null || this.cancelled;
  }

  /** Records a reason once; later reasons do not overwrite it. */
  exhaust(reason: LimitReason): void {
    if (this.limitReached === null) this.limitReached = reason;
    if (!this.controller.signal.aborted) this.controller.abort(new Error(reason));
  }

  /**
   * Reserves one predicate invocation. Returns false when a limit makes
   * further work pointless.
   */
  reserveEvaluation(): boolean {
    if (this.exhausted) return false;
    if (this.limits.maxEvaluations > 0 && this.evaluations >= this.limits.maxEvaluations) {
      this.exhaust("max-evaluations");
      return false;
    }
    if (this.limits.maxDuration > 0 && this.elapsedMs >= this.limits.maxDuration) {
      this.exhaust("max-duration");
      return false;
    }
    this.evaluations += 1;
    return true;
  }

  /** True when the engine should stop generating further candidates. */
  isExhausted(): boolean {
    if (this.exhausted) return true;
    if (this.limits.maxDuration > 0 && this.elapsedMs >= this.limits.maxDuration) {
      this.exhaust("max-duration");
      return true;
    }
    if (this.limits.maxEvaluations > 0 && this.evaluations >= this.limits.maxEvaluations) {
      this.exhaust("max-evaluations");
      return true;
    }
    return false;
  }

  dispose(): void {
    this.userSignal?.removeEventListener("abort", this.onUserAbort);
  }
}

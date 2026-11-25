import { deepClone } from "../utils/clone.js";
import { compareSimplicity, isSimpler } from "../utils/compare.js";
import {
  comparePaths,
  formatPath,
  getAtPath,
  replaceAtPath,
  walkNodes,
  type Path,
  type PathSegment,
  type WalkState,
} from "../utils/paths.js";
import { sizeOf } from "../utils/serialize.js";
import { builtinStrategies } from "../strategies/registry.js";
import { tryEach, type NodeContext, type NodeStrategy } from "../strategies/strategy.js";
import { describeError, ShrinkConfigError, ShrinkError, ShrinkPredicateError } from "./errors.js";
import { cacheKeyOf, Evaluator, type EvaluationOutcome } from "./evaluator.js";
import { HistoryRecorder, type ResolvedHistoryOptions } from "./history.js";
import { Budget } from "./limits.js";
import { ProgressEmitter } from "./progress.js";
import { buildResult, createStats, createStrategyStat } from "./result.js";
import type {
  CustomReducer,
  InputMode,
  PredicateErrorPolicy,
  PredicateResult,
  ProgressEvent,
  ReducerContext,
  ResolvedConfigSummary,
  ShrinkLimits,
  ShrinkResult,
  ShrinkStats,
  ShrinkStatus,
  StabilityOptions,
} from "./types.js";

export interface EngineConfig<T> {
  input: T;
  predicate: (candidate: T) => PredicateResult | Promise<PredicateResult>;
  limits: Required<ShrinkLimits>;
  mode: InputMode;
  predicateErrors: PredicateErrorPolicy;
  preserveSignature: boolean;
  stability: Required<StabilityOptions> | null;
  history: ResolvedHistoryOptions;
  cache: boolean;
  reducers: CustomReducer<T>[];
  strategies?: readonly NodeStrategy[];
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
  verifyFinalInput: boolean;
  configSummary: ResolvedConfigSummary;
}

const MAX_REDUCER_ACCEPT_ROUNDS = 10_000;
const MAX_ENGINE_ROUNDS = 1_000;

/**
 * The minimization engine.
 *
 * Search shape: a greedy, restart-on-improvement traversal of the input tree.
 * At every node each enabled strategy proposes candidates; a candidate is
 * evaluated only when it makes the whole input strictly simpler under the
 * engine ordering. Accepted candidates become the new best input and the
 * traversal continues from that node.
 *
 * Structural reduction runs to a fixpoint (a full pass over every node that
 * accepts nothing), which is what makes `minimality: "local"` an honest claim:
 * it means "no candidate from the enabled reducers was accepted", not
 * mathematical minimality.
 */
export class ShrinkEngine<T> {
  private readonly config: EngineConfig<T>;
  private readonly strategies: readonly NodeStrategy[];
  private readonly budget: Budget;
  private readonly evaluator: Evaluator;
  private readonly history: HistoryRecorder;
  private readonly progress: ProgressEmitter;
  private readonly warnings: string[] = [];

  private best: T;
  private bestSize: number;
  private readonly originalSize: number;
  private expectedSignature: string | null = null;
  private pass = 0;
  private status: ShrinkStatus = "completed";
  private readonly stats: ShrinkStats = createStats();
  private readonly strategyStats = new Map<string, ReturnType<typeof createStrategyStat>>();
  private hadUnstable = false;

  constructor(config: EngineConfig<T>) {
    this.config = config;
    this.strategies = config.strategies ?? builtinStrategies;
    this.budget = new Budget(config.limits, config.signal);
    this.evaluator = new Evaluator(
      config.predicate as (candidate: unknown) => PredicateResult | Promise<PredicateResult>,
      {
        stability: config.stability,
        predicateErrors: config.predicateErrors,
        timeoutMs: config.limits.predicateTimeout,
        cache: config.cache,
        onWarning: (warning) => this.warn(warning),
      },
    );
    this.history = new HistoryRecorder(config.history);
    this.progress = new ProgressEmitter(config.onProgress);
    this.best = deepClone(config.input);
    this.bestSize = sizeOf(this.best);
    this.originalSize = this.bestSize;
    this.stats.originalSize = this.originalSize;
  }

  async run(): Promise<ShrinkResult<T>> {
    this.emitProgress("init", this.originalSize, true);
    if (this.budget.cancelled) {
      return this.handleFatal(new ShrinkError("ERR_CANCELLED", "Minimization cancelled before it started"));
    }
    try {
      const baseline = await this.evaluateOriginal();
      if (baseline === "unstable") {
        return this.buildUnstableFailure(
          "The predicate disagreed with itself on the original input, so nothing can be minimized reliably. Make it deterministic or configure `stability`.",
        );
      }
      if (baseline === null && this.budget.exhausted) {
        if (this.budget.cancelled) {
          return this.handleFatal(new ShrinkError("ERR_CANCELLED", "Minimization cancelled"));
        }
        return this.buildFailure(
          "ERR_LIMIT_REACHED",
          "The evaluation budget was exhausted before the original input could be verified.",
        );
      }
      if (!baseline) {
        const lastError = this.evaluator.lastError;
        if (lastError) {
          return this.buildFailure(
            "ERR_PREDICATE_FAILED",
            `The predicate threw on the original input (${lastError.message}). Nothing can be minimized until the predicate can evaluate the input.`,
          );
        }
        if (this.budget.exhausted) {
          return this.buildFailure(
            "ERR_LIMIT_REACHED",
            "The evaluation budget was exhausted before the original input could be verified.",
          );
        }
        return this.buildFailure(
          "ERR_PREDICATE_NOT_PRESERVED",
          "The original input does not satisfy the predicate, so there is nothing to minimize.",
        );
      }

      if (this.config.preserveSignature && baseline.signature !== null) {
        this.expectedSignature = baseline.signature;
      }

      let rounds = 0;
      let changed = true;
      while (changed && !this.budget.isExhausted()) {
        rounds += 1;
        if (rounds > MAX_ENGINE_ROUNDS) {
          this.budget.exhaust("max-reducer-rounds");
          break;
        }
        changed = false;
        // Custom reducers run first: for opaque encodings (base64, signed
        // payloads) they can often shrink far more than structural candidate
        // generation, and running them early avoids wasting evaluations on
        // string mutations that cannot decode.
        if (await this.customReducerLoop()) changed = true;
        await this.structuralLoop();
        if (await this.customReducerLoop()) changed = true;
      }

      if (this.hadUnstable && this.status === "completed") this.status = "unstable";

      await this.verifyFinalInput();
      return this.buildSuccess();
    } catch (error) {
      return this.handleFatal(error);
    } finally {
      this.budget.dispose();
    }
  }

  // ---------------------------------------------------------------------
  // Setup and evaluation
  // ---------------------------------------------------------------------

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  private emitProgress(strategy: string, currentSize: number, force: boolean, path?: string): void {
    const event: ProgressEvent = {
      evaluations: this.budget.evaluations,
      accepted: this.stats.successfulReductions,
      rejected: this.stats.rejectedCandidates,
      originalSize: this.originalSize,
      bestSize: this.bestSize,
      currentSize,
      strategy,
      elapsedMs: this.budget.elapsedMs,
      phase: force && strategy === "init" ? "init" : "reduce",
    };
    if (path !== undefined) event.path = path;
    this.progress.emit(event, force);
  }

  private getStat(strategy: string) {
    let stat = this.strategyStats.get(strategy);
    if (!stat) {
      stat = createStrategyStat();
      this.strategyStats.set(strategy, stat);
    }
    return stat;
  }

  private async evaluateOriginal(): Promise<EvaluationOutcome | null | "unstable"> {
    if (!this.budget.reserveEvaluation()) return null;
    const outcome = await this.evaluator.evaluate(this.best, null);
    this.stats.evaluations = this.budget.evaluations;
    this.syncEvaluatorStats();
    if (outcome.kind === "unstable") {
      this.hadUnstable = true;
      this.warn("The predicate was unstable on the original input; results may be unreliable.");
      return "unstable";
    }
    if (!outcome.preserve) return null;
    return outcome;
  }

  private syncEvaluatorStats(): void {
    this.stats.predicateErrors = this.evaluator.predicateErrors;
    this.stats.timeouts = this.evaluator.timeouts;
    this.stats.unstableCandidates = this.evaluator.unstable;
    this.stats.cacheHits = this.evaluator.cacheHits;
  }

  // ---------------------------------------------------------------------
  // Structural reduction
  // ---------------------------------------------------------------------

  private async structuralLoop(): Promise<void> {
    let startPath: PathSegment[] = [];
    let iterations = 0;

    while (!this.budget.isExhausted()) {
      if (iterations >= this.config.limits.maxPasses) {
        this.budget.exhaust("max-passes");
        break;
      }
      iterations += 1;

      // The walk is streamed (O(depth) memory) and visits every *path*, so a
      // sub-object shared by two parents is reduced at both locations.
      const state: WalkState = { visits: 0, truncated: false };
      let accepted = false;

      for (const node of walkNodes(
        this.best,
        this.config.limits.maxDepth,
        this.config.limits.maxNodeVisits,
        state,
      )) {
        if (this.budget.isExhausted()) break;
        if (startPath.length > 0 && comparePaths(node.path, startPath) < 0) continue;
        if (await this.visitNode(node.path, node.depth, node.value)) {
          accepted = true;
          startPath = node.path;
          this.pass += 1;
          break;
        }
      }

      if (!accepted && state.truncated) {
        // A pass that did not examine every node cannot justify "local".
        this.budget.exhaust("max-nodes");
        break;
      }

      if (!accepted) {
        if (startPath.length === 0) break;
        // Finish with one complete pass from the root before declaring
        // local minimality.
        startPath = [];
        continue;
      }
    }

    this.stats.passes += iterations;
  }

  private async visitNode(path: Path, depth: number, value: unknown): Promise<boolean> {
    if (depth > this.config.limits.maxDepth) return false;

    const last = path.length === 0 ? null : (path[path.length - 1] as PathSegment);
    const maxAttempts = this.config.limits.maxCandidatesPerNode;
    let attemptsUsed = 0;
    let activeStrategy = "structural";

    const ctx: NodeContext = {
      path,
      depth,
      mode: this.config.mode,
      pass: this.pass,
      limits: this.config.limits,
      key: last,
      originalValue: getAtPath(this.config.input, path),
      inArray: typeof last === "number",
      inObject: typeof last === "string",
      get attemptsLeft() {
        return maxAttempts - attemptsUsed;
      },
      isExhausted: () => this.budget.isExhausted(),
      tryCandidate: async (candidate: unknown): Promise<boolean> => {
        if (attemptsUsed >= maxAttempts) return false;
        if (this.budget.isExhausted()) return false;
        attemptsUsed += 1;
        return this.tryNodeCandidate(path, candidate, activeStrategy);
      },
      tryCandidates: (candidates: Iterable<unknown>) => tryEach(ctx, candidates),
    };

    for (const strategy of this.strategies) {
      if (this.budget.isExhausted()) return false;
      if (attemptsUsed >= maxAttempts) break;
      let matches: boolean;
      try {
        matches = strategy.matches(value, ctx);
      } catch {
        matches = false;
      }
      if (!matches) continue;
      activeStrategy = strategy.name;
      if (await strategy.reduce(value, ctx)) return true;
    }

    return false;
  }

  private async tryNodeCandidate(path: Path, candidateValue: unknown, strategy: string): Promise<boolean> {
    const currentValue = getAtPath(this.best, path);
    if (compareSimplicity(candidateValue, currentValue) >= 0) return false;

    const candidateRoot = replaceAtPath(this.best, path, candidateValue);
    if (!isSimpler(candidateRoot, this.best)) return false;

    return this.attempt(candidateRoot, strategy, path, () =>
      Math.max(0, this.bestSize + sizeOf(candidateValue) - sizeOf(currentValue)),
    );
  }

  private async attempt(
    candidateRoot: unknown,
    strategy: string,
    path: Path,
    sizeOfCandidate: () => number,
  ): Promise<boolean> {
    const stat = this.getStat(strategy);
    const sizeBefore = this.bestSize;

    let outcome: EvaluationOutcome | null = null;
    let key: string | null = null;
    if (this.config.cache) {
      key = cacheKeyOf(candidateRoot);
      if (key !== null) outcome = this.evaluator.getCached(key);
    }
    if (!outcome) {
      if (!this.budget.reserveEvaluation()) {
        this.syncEvaluatorStats();
        return false;
      }
      outcome = await this.evaluator.evaluate(candidateRoot, key);
    }
    this.stats.evaluations = this.budget.evaluations;
    stat.attempts += 1;

    let accepted = outcome.preserve;
    let kind = outcome.kind;

    if (accepted && this.expectedSignature !== null && outcome.signature !== this.expectedSignature) {
      accepted = false;
      kind = "rejected";
      this.stats.signatureMismatches += 1;
    }
    if (outcome.kind === "unstable") this.hadUnstable = true;

    const candidateSize = accepted ? sizeOf(candidateRoot) : sizeOfCandidate();

    if (accepted) {
      this.best = candidateRoot as T;
      this.bestSize = candidateSize;
      this.stats.successfulReductions += 1;
      stat.accepted += 1;
    } else {
      this.stats.rejectedCandidates += 1;
      stat.rejected += 1;
    }

    this.history.record({
      strategy,
      path: formatPath(path),
      outcome: accepted ? "accepted" : mapOutcomeKind(kind),
      sizeBefore,
      sizeAfter: candidateSize,
      durationMs: outcome.durationMs,
      ...(outcome.signature === null ? {} : { signature: outcome.signature }),
      ...(this.config.history.includeValues ? { value: candidateRoot } : {}),
    });

    this.syncEvaluatorStats();
    this.emitProgress(strategy, candidateSize, accepted, formatPath(path));

    return accepted;
  }

  // ---------------------------------------------------------------------
  // Custom reducers
  // ---------------------------------------------------------------------

  /** Returns true when at least one candidate was accepted. */
  private async customReducerLoop(): Promise<boolean> {
    if (this.config.reducers.length === 0) return false;
    const reducers = [...this.config.reducers].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    let improved = false;
    let rounds = 0;
    while (!this.budget.isExhausted()) {
      rounds += 1;
      if (rounds > MAX_REDUCER_ACCEPT_ROUNDS) {
        // Long-but-productive chains are legitimate; stop only when the guard
        // trips, and report it rather than silently claiming minimality.
        this.budget.exhaust("max-reducer-rounds");
        return improved;
      }

      let roundImproved = false;
      for (const reducer of reducers) {
        if (this.budget.isExhausted()) break;
        const ctx = this.reducerContext();
        if (reducer.enabled && !reducer.enabled(this.best, ctx)) continue;
        const produced = await reducer.reduce(this.best, ctx);
        if (await this.consumeCandidates(produced, reducer.name)) {
          roundImproved = true;
          break;
        }
      }

      if (!roundImproved) break;
      improved = true;
    }
    return improved;
  }

  private async consumeCandidates(source: unknown, strategy: string): Promise<boolean> {
    const visit = async (candidate: unknown): Promise<boolean> => {
      if (this.budget.isExhausted()) return false;
      if (!isSimpler(candidate, this.best)) return false;
      return this.attempt(candidate, strategy, [], () => sizeOf(candidate));
    };

    if (isAsyncIterable(source)) {
      for await (const candidate of source) {
        if (await visit(candidate)) return true;
      }
      return false;
    }
    if (isIterable(source)) {
      for (const candidate of source) {
        if (await visit(candidate)) return true;
      }
      return false;
    }
    throw new ShrinkConfigError(
      `Reducer "${strategy}" must return an iterable or async iterable of candidate inputs`,
    );
  }

  private reducerContext(): ReducerContext {
    return {
      evaluations: this.budget.evaluations,
      elapsedMs: this.budget.elapsedMs,
      currentSize: this.bestSize,
      originalSize: this.originalSize,
      pass: this.pass,
      signal: this.budget.signal,
      isExhausted: () => this.budget.isExhausted(),
    };
  }

  // ---------------------------------------------------------------------
  // Verification and result assembly
  // ---------------------------------------------------------------------

  private async verifyFinalInput(): Promise<void> {
    if (!this.config.verifyFinalInput) return;
    if (this.budget.isExhausted()) {
      this.warn("Final verification skipped because the evaluation budget was exhausted.");
      return;
    }
    if (!this.budget.reserveEvaluation()) return;

    const snapshot = deepClone(this.best);
    try {
      const outcome = await this.evaluator.evaluateFresh(snapshot);
      this.stats.evaluations = this.budget.evaluations;
      this.syncEvaluatorStats();
      this.stats.verification = { performed: true, preserved: outcome.preserve };
      if (!outcome.preserve) {
        this.status = "unstable";
        this.warn(
          "Final verification failed: the minimized input did not reproduce the target behavior on a fresh copy. The predicate is likely non-deterministic or mutates its argument.",
        );
      }
    } catch (error) {
      this.status = "unstable";
      this.stats.verification = { performed: true, preserved: null };
      this.warn(`Final verification could not be completed: ${describeError(error).message}`);
    }
  }

  private finalizeStats(): void {
    this.syncEvaluatorStats();
    this.stats.limitReached = this.budget.limitReached;
    this.stats.durationMs = this.budget.elapsedMs;
    this.stats.finalSize = this.bestSize;
    const strategies: ShrinkStats["strategies"] = {};
    for (const [name, stat] of this.strategyStats) strategies[name] = { ...stat };
    this.stats.strategies = strategies;
  }

  private finalStatus(): ShrinkStatus {
    if (this.budget.cancelled) return "cancelled";
    if (this.status === "unstable") return "unstable";
    if (this.budget.limitReached !== null) return "limit-reached";
    return this.status;
  }

  private buildSuccess(): ShrinkResult<T> {
    this.finalizeStats();
    if (this.budget.cancelled) {
      this.warn("Minimization was cancelled; the result is the best input found so far.");
    }
    if (this.stats.finalSize > this.stats.originalSize) {
      this.warn(
        `The minimized input is ${this.stats.finalSize - this.stats.originalSize} characters larger than the original: a structural simplification replaced a container with a simpler but longer value (for example \`{}\` -> \`null\`). ` +
          "ShrinkJS orders by structural simplicity, not by character count.",
      );
    }
    if (this.config.predicateErrors === "ignore" && this.stats.predicateErrors > 0) {
      const first = this.evaluator.lastError;
      this.warn(
        `${this.stats.predicateErrors} predicate call(s) threw and were treated as "not reproduced" (predicateErrors: "ignore")${
          first ? `; first error: ${first.message}` : ""
        }. Set predicateErrors: "fail" to abort on the first error instead.`,
      );
    }
    const status = this.finalStatus();
    return buildResult({
      status,
      originalInput: deepClone(this.config.input),
      minimalInput: this.best,
      signature: this.expectedSignature,
      stats: this.stats,
      config: this.config.configSummary,
      warnings: this.warnings,
      localMinimal: !this.budget.exhausted,
      ...(this.config.history.enabled ? { history: this.history.snapshot() } : {}),
    });
  }

  private buildFailure(code: string, message: string): ShrinkResult<T> {
    this.finalizeStats();
    return buildResult({
      status: "failed",
      originalInput: deepClone(this.config.input),
      minimalInput: this.best,
      signature: this.expectedSignature,
      stats: this.stats,
      config: this.config.configSummary,
      warnings: this.warnings,
      localMinimal: false,
      error: { message, code },
      ...(this.config.history.enabled ? { history: this.history.snapshot() } : {}),
    });
  }

  /** The predicate exists but cannot be trusted: no reproduction is claimed. */
  private buildUnstableFailure(message: string): ShrinkResult<T> {
    this.finalizeStats();
    return buildResult({
      status: "unstable",
      ok: false,
      originalInput: deepClone(this.config.input),
      minimalInput: this.best,
      signature: this.expectedSignature,
      stats: this.stats,
      config: this.config.configSummary,
      warnings: this.warnings,
      localMinimal: false,
      error: { message, code: "ERR_PREDICATE_NOT_PRESERVED", name: "UnstablePredicate" },
      ...(this.config.history.enabled ? { history: this.history.snapshot() } : {}),
    });
  }

  private handleFatal(error: unknown): ShrinkResult<T> {
    if (error instanceof ShrinkError && error.code === "ERR_CANCELLED") {
      this.finalizeStats();
      return buildResult({
        status: "cancelled",
        originalInput: deepClone(this.config.input),
        minimalInput: this.best,
        signature: this.expectedSignature,
        stats: this.stats,
        config: this.config.configSummary,
        warnings: [
          ...this.warnings,
          "Minimization was cancelled; the result is the best input found so far.",
        ],
        localMinimal: false,
        ...(this.config.history.enabled ? { history: this.history.snapshot() } : {}),
      });
    }

    if (error instanceof ShrinkPredicateError) {
      const detail = describeError(error.predicateError);
      const errorInfo: { message: string; code: string; name?: string } = {
        message: `Predicate threw during minimization: ${detail.message}`,
        code: "ERR_PREDICATE_FAILED",
      };
      if (detail.name) errorInfo.name = detail.name;
      this.finalizeStats();
      return buildResult({
        status: "failed",
        originalInput: deepClone(this.config.input),
        minimalInput: this.best,
        signature: this.expectedSignature,
        stats: this.stats,
        config: this.config.configSummary,
        warnings: this.warnings,
        localMinimal: false,
        error: errorInfo,
        ...(this.config.history.enabled ? { history: this.history.snapshot() } : {}),
      });
    }

    const detail = describeError(error);
    const code = error instanceof ShrinkError ? error.code : "ERR_INVALID_CONFIG";
    const errorInfo: { message: string; code: string; name?: string } = { message: detail.message, code };
    if (detail.name) errorInfo.name = detail.name;
    return this.buildFailureWithError(errorInfo);
  }

  private buildFailureWithError(errorInfo: {
    message: string;
    code: string;
    name?: string;
  }): ShrinkResult<T> {
    this.finalizeStats();
    return buildResult({
      status: "failed",
      originalInput: deepClone(this.config.input),
      minimalInput: this.best,
      signature: this.expectedSignature,
      stats: this.stats,
      config: this.config.configSummary,
      warnings: this.warnings,
      localMinimal: false,
      error: errorInfo,
      ...(this.config.history.enabled ? { history: this.history.snapshot() } : {}),
    });
  }
}

function mapOutcomeKind(
  kind: EvaluationOutcome["kind"],
): "accepted" | "rejected" | "error" | "timeout" | "unstable" {
  switch (kind) {
    case "preserved":
      return "accepted";
    case "unstable":
      return "unstable";
    case "error":
      return "error";
    case "timeout":
      return "timeout";
    default:
      return "rejected";
  }
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.iterator in value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

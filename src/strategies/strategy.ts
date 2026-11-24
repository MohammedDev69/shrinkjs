import type { InputMode, ShrinkLimits } from "../core/types.js";
import type { Path, PathSegment } from "../utils/paths.js";

/**
 * Everything a strategy may know about the node it is reducing.
 *
 * Strategies never touch the engine directly: they propose candidate values and
 * the engine decides whether a candidate is simpler, whether it preserves the
 * predicate, and how it is recorded.
 */
export interface NodeContext {
  /** Path of the node inside the current best input. */
  readonly path: Path;
  readonly depth: number;
  readonly mode: InputMode;
  readonly pass: number;
  readonly limits: Required<ShrinkLimits>;
  /** Last path segment (`null` at the root). */
  readonly key: PathSegment | null;
  /** Value at this path in the original input (a heuristic hint for reducers). */
  readonly originalValue: unknown;
  /** True when the node is an element of an array. */
  readonly inArray: boolean;
  /** True when the node is a value of an object property. */
  readonly inObject: boolean;
  /** Evaluations remaining for this node visit. */
  readonly attemptsLeft: number;

  /** True when a limit, the caller's AbortSignal, or a failure stopped the run. */
  isExhausted(): boolean;

  /**
   * Proposes `candidate` as a replacement for this node.
   *
   * Returns true only when the candidate (a) makes the whole input strictly
   * simpler, (b) satisfies the predicate and (c) matches the preserved failure
   * signature. On true the engine's current best becomes the new input.
   */
  tryCandidate(candidate: unknown): Promise<boolean>;

  /** Tries candidates in order, stopping at the first accepted one. */
  tryCandidates(candidates: Iterable<unknown>): Promise<boolean>;
}

export interface NodeStrategy {
  /** Stable name used in stats, history and reports. */
  readonly name: string;
  /** Cheap structural check; must not evaluate the predicate. */
  matches(value: unknown, ctx: NodeContext): boolean;
  /**
   * Proposes candidates for the node. Returns true when at least one candidate
   * was accepted (the engine then restarts its traversal for correctness).
   */
  reduce(value: unknown, ctx: NodeContext): Promise<boolean>;
}

export const DEFAULT_MAX_PARTS = 512;

export async function tryEach(ctx: NodeContext, candidates: Iterable<unknown>): Promise<boolean> {
  for (const candidate of candidates) {
    if (ctx.isExhausted() || ctx.attemptsLeft <= 0) return false;
    if (await ctx.tryCandidate(candidate)) return true;
  }
  return false;
}

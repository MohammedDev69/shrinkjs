/**
 * Classic Delta Debugging (`ddmin`) for sequences.
 *
 * Reference: Zeller & Hildebrandt, "Simplifying and Isolating Failure-Inducing
 * Input" (2002). The algorithm partitions the current sequence into `n`
 * contiguous chunks and tries:
 *
 *   1. each chunk on its own (subset test — fast path to a small result),
 *   2. each chunk's complement (removal test — handles "the bug needs only
 *      one of the other chunks"),
 *   3. otherwise increases granularity (`n := 2n`) up to the sequence length.
 *
 * It terminates when granularity reaches the sequence length without any
 * successful test, which proves 1-minimality *with respect to single-element
 * removal* (for a monotone predicate). Every returned sequence is a
 * subsequence of the input, so results are always "smaller" in the sense used
 * by the engine.
 *
 * ShrinkJS adds two practical bounds: `maxParts` caps the finest granularity
 * (so very long inputs do not require one test per element) and
 * `shouldContinue` lets the caller stop when an evaluation budget runs out.
 */

export interface DdminOptions {
  /** Finest granularity to attempt. Default: 1024. */
  maxParts?: number;
  /** Hard cap on predicate calls made by this ddmin run. */
  maxTests?: number;
  /** Return false to stop immediately (budget exhausted, cancellation, ...). */
  shouldContinue?: () => boolean;
  /** Called after each predicate call. */
  onTest?: (candidateSize: number) => void;
}

export interface DdminResult<T> {
  items: T[];
  tests: number;
  /** True when the result is 1-minimal under the attempted granularity. */
  oneMinimal: boolean;
}

/**
 * Delta-debug a sequence down to a subsequence that still satisfies `test`.
 *
 * `test` must be deterministic (the engine's evaluator enforces stability
 * separately). The returned array never contains items that were not in the
 * input and never contains them more often than in the input.
 */
export async function deltaDebug<T>(
  items: readonly T[],
  test: (candidate: readonly T[]) => Promise<boolean>,
  options: DdminOptions = {},
): Promise<DdminResult<T>> {
  const maxParts = Math.max(2, Math.floor(options.maxParts ?? 1024));
  const maxTests = options.maxTests ?? Number.POSITIVE_INFINITY;
  const shouldContinue = options.shouldContinue ?? (() => true);

  let tests = 0;
  let current = items.slice();

  const run = async (candidate: readonly T[]): Promise<boolean> => {
    tests += 1;
    options.onTest?.(candidate.length);
    return test(candidate);
  };

  if (current.length === 0) return { items: current, tests, oneMinimal: true };

  // Fast path: is the target behavior reproducible with no input at all?
  if (!shouldContinue()) return { items: current, tests, oneMinimal: false };
  if (tests < maxTests && (await run([]))) {
    return { items: [], tests, oneMinimal: true };
  }

  let n = 2;
  let exhausted = tests >= maxTests;

  while (current.length >= 2 && !exhausted) {
    const granularity = Math.min(n, current.length, maxParts);
    const partitions = partitionIndices(current.length, granularity);
    let reduced = false;

    // 1. Subsets.
    for (const partition of partitions) {
      if (tests >= maxTests || !shouldContinue()) {
        exhausted = true;
        break;
      }
      const candidate = partition.map((index) => current[index] as T);
      if (await run(candidate)) {
        current = candidate;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (exhausted) break;
    if (reduced) continue;

    // 2. Complements.
    for (const partition of partitions) {
      if (tests >= maxTests || !shouldContinue()) {
        exhausted = true;
        break;
      }
      const removed = new Set(partition);
      const candidate = current.filter((_, index) => !removed.has(index));
      if (await run(candidate)) {
        current = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (exhausted) break;
    if (reduced) continue;

    // 3. Refine granularity.
    if (granularity >= current.length) {
      // Every single element and every complement has been tried: 1-minimal.
      return { items: current, tests, oneMinimal: true };
    }
    const next = Math.min(granularity * 2, maxParts, current.length);
    if (next <= granularity) {
      // Granularity cap reached without further reduction: chunk-minimal.
      return { items: current, tests, oneMinimal: false };
    }
    n = next;
  }

  return { items: current, tests, oneMinimal: !exhausted && current.length < 2 };
}

/**
 * Splits `[0, length)` into `parts` contiguous index ranges as evenly as
 * possible; earlier partitions receive the extra element.
 */
export function partitionIndices(length: number, parts: number): number[][] {
  const count = Math.max(1, Math.min(parts, length));
  const base = Math.floor(length / count);
  const remainder = length % count;
  const result: number[][] = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    const partition: number[] = [];
    for (let j = 0; j < size; j += 1) partition.push(cursor + j);
    cursor += size;
    result.push(partition);
  }
  return result;
}

import { compareSimplicity } from "../utils/compare.js";
import { deltaDebug } from "./ddmin.js";

export interface ReduceSequenceOptions<T> {
  /**
   * Predicate over the sequence. It receives a fresh array copy; mutating it
   * has no effect on the search.
   */
  test: (candidate: T[]) => boolean | Promise<boolean>;
  /** Finest partition count. Default: 512. */
  maxParts?: number;
  /** Hard cap on predicate calls. */
  maxTests?: number;
  signal?: AbortSignal;
  /**
   * Optional per-item simplifier. Returns candidate replacements for one item.
   * Applied greedily (first improvement wins) until nothing improves, then a
   * final removal pass restores 1-minimality.
   */
  simplifyItem?: (item: T, index: number) => Iterable<T> | Promise<Iterable<T>>;
  /** Called after each predicate call with the candidate length. */
  onTest?: (candidateLength: number) => void;
}

export interface ReduceSequenceResult<T> {
  items: T[];
  /** Predicate calls performed. */
  tests: number;
  /** True when no single element could be removed at the end. */
  oneMinimal: boolean;
}

/**
 * Standalone sequence minimization for event streams, tool calls, recorded
 * actions, workflow steps, and similar ordered inputs.
 *
 * The array is reduced with {@link deltaDebug}; when `simplifyItem` is given,
 * each surviving element is simplified afterwards. Removals are only
 * *proposed* — the predicate decides whether an order-dependent sequence still
 * reproduces the target behavior, so stateful sequences remain safe.
 */
export async function minimizeSequence<T>(
  items: readonly T[],
  options: ReduceSequenceOptions<T>,
): Promise<ReduceSequenceResult<T>> {
  let tests = 0;
  const maxParts = options.maxParts ?? 512;
  const maxTests = options.maxTests ?? Number.POSITIVE_INFINITY;

  const exhausted = (): boolean => tests >= maxTests || options.signal?.aborted === true;

  const test = async (candidate: readonly T[]): Promise<boolean> => {
    if (exhausted()) return false;
    tests += 1;
    options.onTest?.(candidate.length);
    return Boolean(await options.test(candidate.slice()));
  };

  const first = await deltaDebug(items, test, {
    maxParts,
    shouldContinue: () => !exhausted(),
  });

  let current = first.items;
  let oneMinimal = first.oneMinimal;
  let simplified = false;

  const simplifyItem = options.simplifyItem;
  if (simplifyItem) {
    let improved = true;
    let guard = 0;
    while (improved && !exhausted() && guard < 1_000) {
      guard += 1;
      improved = false;
      for (let index = 0; index < current.length; index += 1) {
        if (exhausted()) break;
        const item = current[index] as T;
        const replacements = await simplifyItem(item, index);
        for (const replacement of replacements) {
          if (exhausted()) break;
          if (compareSimplicity(replacement, item) >= 0) continue;
          if (await test(replaceItems(current, index, replacement))) {
            current = replaceItems(current, index, replacement) as T[];
            improved = true;
            simplified = true;
            break;
          }
        }
        if (improved || exhausted()) break;
      }
    }
  }

  // Element simplification can make previously-required elements removable.
  if (simplified && !exhausted()) {
    const final = await deltaDebug(current, test, {
      maxParts,
      shouldContinue: () => !exhausted(),
    });
    current = final.items;
    oneMinimal = final.oneMinimal;
  }

  return { items: current, tests, oneMinimal };
}

function replaceItems<T>(items: readonly T[], index: number, value: T): T[] {
  const copy = items.slice();
  copy[index] = value;
  return copy;
}

import { deltaDebug, type DdminOptions } from "./ddmin.js";
import type { NodeContext, NodeStrategy } from "./strategy.js";

/**
 * Removes duplicate elements, keeping the first occurrence of each value.
 * Returns `null` when some element has no JSON identity (then dedupe is
 * skipped rather than guessing).
 */
function dedupe(values: readonly unknown[]): unknown[] | null {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    let key: string | undefined;
    try {
      key = JSON.stringify(value);
    } catch {
      return null;
    }
    if (key === undefined) return null;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Array reduction: chunk removal + single-element removal through
 * delta debugging, with an empty-array fast path and a duplicate-removal
 * candidate. Nested elements are reduced by the engine's traversal, not here.
 */
export const arrayStrategy: NodeStrategy = {
  name: "array",

  matches(value) {
    return Array.isArray(value);
  },

  async reduce(value, ctx: NodeContext): Promise<boolean> {
    const array = value as unknown[];
    if (array.length === 0) return false;

    if (array.length > 1) {
      const unique = dedupe(array);
      if (unique && unique.length < array.length && (await ctx.tryCandidate(unique))) return true;
    }

    let accepted = false;
    const maxParts = Math.min(512, Math.max(2, ctx.limits.maxCandidatesPerNode));
    const options: DdminOptions = {
      maxParts,
      shouldContinue: () => !ctx.isExhausted() && ctx.attemptsLeft > 0,
    };

    await deltaDebug(
      array,
      async (subset) => {
        const ok = await ctx.tryCandidate(subset.slice());
        if (ok) accepted = true;
        return ok;
      },
      options,
    );

    return accepted;
  },
};

import { compareSimplicity } from "../utils/compare.js";
import type { NodeContext, NodeStrategy } from "./strategy.js";

const MAX_BISECTION_STEPS = 64;

function isSimplerThan(candidate: number, value: number): boolean {
  if (Object.is(candidate, value)) return false;
  return compareSimplicity(candidate, value) < 0;
}

/**
 * Cheap numeric candidates, simplest first. Used before bisection; they handle
 * the common cases (`0`, `1`, `-1`, integer truncation, halving for integers).
 */
export function numberCandidates(value: number): number[] {
  const candidates: number[] = [];
  const push = (candidate: number): void => {
    if (!Number.isFinite(candidate)) return;
    if (!isSimplerThan(candidate, value)) return;
    candidates.push(candidate);
  };

  push(0);
  push(1);
  push(-1);

  if (Number.isFinite(value)) {
    const half = value / 2;
    push(Math.trunc(half));
    push(Math.round(half));
    push(Math.floor(half));
    push(Math.ceil(half));
    push(Math.trunc(value));
    push(Math.round(value));
    push(Math.floor(value));
    push(Math.ceil(value));
    push(value - Math.sign(value));
    const magnitude = Math.abs(value);
    if (magnitude >= 2) push(Math.sign(value) * 2 ** Math.floor(Math.log2(magnitude)));
    push(Math.sign(value));

    // Decimal-friendly values: turn 0.40000033378 into 0.4.
    if (!Number.isInteger(value)) {
      for (let digits = 1; digits <= 6; digits += 1) {
        const factor = 10 ** digits;
        push(Math.round(value * factor) / factor);
      }
    }
  }

  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = Object.is(candidate, -0) ? "-0" : String(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(compareSimplicity);
}

function bisectionPrecision(value: number, preferInteger: boolean): number {
  if (preferInteger) return 1;
  return Math.max(Math.abs(value) * 1e-6, Number.EPSILON * 8);
}

/**
 * Binary search for the smallest magnitude that still satisfies the predicate.
 *
 * This is what turns "find the threshold" from a linear scan into ~log2(n)
 * predicate calls: for `n > 100` starting at 98 765 the reducer converges to
 * 101 in about 17 steps. Sign is preserved; the search never crosses zero.
 *
 * Integer inputs are searched on an integer grid (so results stay readable),
 * fractional inputs keep fractional resolution down to a relative 1e-6.
 */
async function bisectMagnitude(value: number, ctx: NodeContext): Promise<boolean> {
  if (!Number.isFinite(value) || value === 0) return false;
  const sign = Math.sign(value);
  const preferInteger = typeof ctx.originalValue === "number" && Number.isInteger(ctx.originalValue);
  const precision = bisectionPrecision(value, preferInteger);

  let lo = 0; // known to fail (0 was already rejected by the caller)
  let hi = Math.abs(value); // known to pass
  let accepted = false;

  for (let step = 0; step < MAX_BISECTION_STEPS; step += 1) {
    if (ctx.isExhausted() || ctx.attemptsLeft <= 0) break;
    const gap = hi - lo;
    if (gap <= precision) break;

    const mid = preferInteger ? lo + Math.floor(gap / 2) : lo + gap / 2;
    if (mid <= lo || mid >= hi) break;

    const candidate = sign * mid;
    if (await ctx.tryCandidate(candidate)) {
      hi = mid;
      accepted = true;
    } else {
      lo = mid;
    }
  }

  return accepted;
}

async function reduceBigInt(value: bigint, ctx: NodeContext): Promise<boolean> {
  let accepted = false;
  let current = value;
  for (const candidate of [0n, 1n, -1n]) {
    if (compareSimplicity(candidate, value) >= 0) continue;
    if (await ctx.tryCandidate(candidate)) return true;
  }
  for (let step = 0; step < MAX_BISECTION_STEPS; step += 1) {
    if (ctx.isExhausted() || ctx.attemptsLeft <= 0) break;
    const half = current / 2n;
    if (half === current || half === 0n) break;
    if (!(await ctx.tryCandidate(half))) break;
    current = half;
    accepted = true;
  }
  return accepted;
}

/**
 * Numeric reduction for `number` and (in `js` mode) `bigint`.
 *
 * Order of operations:
 *   1. simplest values (`0`, `1`, `-1`),
 *   2. integer-friendly simplifications (truncation, halving, one step toward
 *      zero, lower power of two),
 *   3. bisection toward zero to find the failure boundary.
 *
 * Every accepted value is strictly smaller in magnitude (or closer to zero), so
 * the search is monotone and terminates. Floating point is never compared for
 * exact equality: candidates are proposed as new values and judged by the
 * predicate, and bisection stops at a relative precision of 1e-6.
 */
export const numberStrategy: NodeStrategy = {
  name: "number",

  matches(value) {
    return typeof value === "number" || typeof value === "bigint";
  },

  async reduce(value, ctx: NodeContext): Promise<boolean> {
    if (typeof value === "bigint") return reduceBigInt(value, ctx);

    const numeric = value as number;
    if (Number.isNaN(numeric)) {
      // NaN cannot be ordered; only explicit replacements are useful.
      for (const candidate of [0, 1, -1]) {
        if (await ctx.tryCandidate(candidate)) return true;
      }
      return false;
    }

    for (const candidate of numberCandidates(numeric)) {
      if (ctx.isExhausted() || ctx.attemptsLeft <= 0) return false;
      if (await ctx.tryCandidate(candidate)) return true;
    }

    return bisectMagnitude(numeric, ctx);
  },
};

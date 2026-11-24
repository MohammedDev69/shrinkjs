import { deltaDebug } from "./ddmin.js";
import type { NodeContext, NodeStrategy } from "./strategy.js";

/** Objects whose contents are addressable and reducible. */
export function isReducibleObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set)
    return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  return true;
}

/**
 * Object reduction: delta debugging over own enumerable property names.
 *
 * Rebuilt candidates keep the original prototype, so class instances stay
 * instances of their class. Empty-subset testing (i.e. `{}`) happens inside
 * ddmin as its first test.
 */
export const objectStrategy: NodeStrategy = {
  name: "object",

  matches(value) {
    return isReducibleObject(value);
  },

  async reduce(value, ctx: NodeContext): Promise<boolean> {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length === 0) return false;

    const proto = Object.getPrototypeOf(object) as object | null;
    const rebuild = (subset: readonly string[]): Record<string, unknown> => {
      const next = Object.create(proto) as Record<string, unknown>;
      for (const key of subset) next[key] = object[key];
      return next;
    };

    let accepted = false;
    await deltaDebug(
      keys,
      async (subset) => {
        const ok = await ctx.tryCandidate(rebuild(subset));
        if (ok) accepted = true;
        return ok;
      },
      {
        maxParts: Math.min(512, Math.max(2, ctx.limits.maxCandidatesPerNode)),
        shouldContinue: () => !ctx.isExhausted() && ctx.attemptsLeft > 0,
      },
    );

    return accepted;
  },
};

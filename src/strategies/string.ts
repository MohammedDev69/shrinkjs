import { DEFAULT_MAX_PARTS, tryEach, type NodeContext, type NodeStrategy } from "./strategy.js";
import { deltaDebug } from "./ddmin.js";

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\r\n\f\v]+/g, " ").trim();
}

/**
 * String reduction: tries the empty string, whitespace normalization, then
 * delta-debugging over Unicode code points.
 *
 * Long strings are reduced at chunk granularity (see `maxParts`), so a 100 kB
 * string does not need one predicate call per character. Strings shorter than
 * the granularity cap end up 1-minimal.
 */
export const stringStrategy: NodeStrategy = {
  name: "string",

  matches(value) {
    return typeof value === "string";
  },

  async reduce(value, ctx: NodeContext): Promise<boolean> {
    const text = value as string;
    if (text.length === 0) return false;

    const quick = new Set<string>([""]);
    const trimmed = text.trim();
    if (trimmed !== text) quick.add(trimmed);
    const collapsed = collapseWhitespace(text);
    if (collapsed !== text && collapsed.length < text.length) quick.add(collapsed);

    if (await tryEach(ctx, [...quick])) return true;

    let accepted = false;
    const characters = Array.from(text);
    const maxParts = Math.min(DEFAULT_MAX_PARTS, Math.max(2, ctx.limits.maxCandidatesPerNode));
    await deltaDebug(
      characters,
      async (subset) => {
        const candidate = subset.join("");
        const ok = await ctx.tryCandidate(candidate);
        if (ok) accepted = true;
        return ok;
      },
      {
        maxParts,
        shouldContinue: () => !ctx.isExhausted() && ctx.attemptsLeft > 0,
      },
    );
    return accepted;
  },
};

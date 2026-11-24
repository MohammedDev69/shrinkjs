import { tryEach, type NodeContext, type NodeStrategy } from "./strategy.js";

/**
 * Nullish reduction: any value is offered as `null`.
 *
 * `undefined` is only offered for array elements in `js` mode: in `json` mode a
 * result must stay JSON-shaped (`JSON.stringify([undefined])` is `"[null]"`,
 * which would make the reported minimal input differ from the serialized one).
 * Inside objects a property is removed outright by the object strategy, which
 * keeps the distinction between "missing" and "explicitly null".
 */
export const nullishStrategy: NodeStrategy = {
  name: "nullish",

  matches(value) {
    return value !== null && value !== undefined;
  },

  async reduce(_value, ctx: NodeContext): Promise<boolean> {
    const allowUndefined = ctx.inArray && ctx.mode === "js";
    const candidates: unknown[] = allowUndefined ? [undefined, null] : [null];
    return tryEach(ctx, candidates);
  },
};

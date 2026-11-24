import { tryEach, type NodeContext, type NodeStrategy } from "./strategy.js";

/** Boolean reduction: `true` is simplified to `false` when the predicate allows it. */
export const booleanStrategy: NodeStrategy = {
  name: "boolean",

  matches(value) {
    return typeof value === "boolean";
  },

  async reduce(value, ctx: NodeContext): Promise<boolean> {
    if (value === false) return false;
    return tryEach(ctx, [false]);
  },
};

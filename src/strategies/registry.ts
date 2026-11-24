import { arrayStrategy } from "./array.js";
import { booleanStrategy } from "./boolean.js";
import { nullishStrategy } from "./nullish.js";
import { numberStrategy } from "./number.js";
import { objectStrategy } from "./object.js";
import type { NodeStrategy } from "./strategy.js";
import { stringStrategy } from "./string.js";

/**
 * Built-in strategies, in decreasing order of "cheapness" for a single node.
 *
 * Order matters only for speed and for which accepted value wins first: every
 * accepted candidate must still be strictly simpler than the current input, so
 * a later pass can always improve on an earlier one.
 */
export const builtinStrategies: readonly NodeStrategy[] = [
  nullishStrategy,
  booleanStrategy,
  numberStrategy,
  stringStrategy,
  arrayStrategy,
  objectStrategy,
];

export const builtinStrategyNames: readonly string[] = builtinStrategies.map((s) => s.name);

export { arrayStrategy, booleanStrategy, nullishStrategy, numberStrategy, objectStrategy, stringStrategy };
export type { NodeContext, NodeStrategy } from "./strategy.js";

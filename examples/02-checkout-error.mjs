/**
 * Example 2 — Checkout error.
 *
 * `processOrder` throws `InvalidPriceError` for a negative line-item price.
 * The predicate preserves that specific error *signature*, so minimization
 * cannot drift to a different failure while it searches.
 *
 * Run: node examples/02-checkout-error.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { shrink } from "../dist/index.js";
import { processOrder } from "./lib/checkout.mjs";

const input = JSON.parse(
  await readFile(fileURLToPath(new URL("./fixtures/order.json", import.meta.url)), "utf8"),
);

const result = await shrink({
  input,
  test: async (candidate) => {
    try {
      await processOrder(candidate);
      return false;
    } catch (error) {
      return {
        preserve: error?.code === "INVALID_PRICE",
        signature: error?.code,
      };
    }
  },
});

console.log("Example 2 — checkout error");
console.log("  status     :", result.status, `(${result.minimality})`);
console.log("  signature  :", result.signature);
console.log("  evaluations:", result.stats.evaluations);
console.log(
  "  size       :",
  result.stats.originalSize,
  "->",
  result.stats.finalSize,
  `(${result.stats.reductionPercent}% smaller)`,
);
console.log("  minimal    :", JSON.stringify(result.minimalInput));

if (result.signature !== "INVALID_PRICE" || !result.ok) {
  throw new Error("example 2 failed: expected the INVALID_PRICE failure to be preserved");
}

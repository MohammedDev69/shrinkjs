/**
 * Example 3 — String parser.
 *
 * A long expression string crashes the parser because of a stray ")". ShrinkJS
 * reduces the 2 kB string down to the single character that triggers the bug.
 *
 * Run: node examples/03-string-parser.mjs
 */
import { shrink } from "../dist/index.js";
import { parseError } from "./lib/predicates.mjs";
import { parseExpression } from "./lib/validation.mjs";

const expression = `${"sin(x) + cos(y) * (a - b) / 2 + ".repeat(60)}) + ${"tan(z) + ".repeat(40)}`;

const result = await shrink({
  input: expression,
  test: (candidate) => parseError(candidate, parseExpression),
  limits: { maxEvaluations: 2_000 },
});

console.log("Example 3 — string parser");
console.log("  status     :", result.status, `(${result.minimality})`);
console.log("  evaluations:", result.stats.evaluations, "· cache hits:", result.stats.cacheHits);
console.log(
  "  size       :",
  result.stats.originalSize,
  "->",
  result.stats.finalSize,
  `(${result.stats.reductionPercent}% smaller)`,
);
console.log("  minimal    :", JSON.stringify(result.minimalInput));

if (![")", "("].includes(result.minimalInput)) {
  throw new Error(
    `example 3 failed: expected a single unbalanced parenthesis, got ${JSON.stringify(result.minimalInput)}`,
  );
}

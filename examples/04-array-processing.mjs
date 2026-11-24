/**
 * Example 4 — Array processing produces a wrong result.
 *
 * `summarizeRows` silently drops the sign of negative amounts, so a wrong total
 * is produced. The predicate does not throw: it compares the produced value
 * against the expected invariant, which is equally valid.
 *
 * Run: node examples/04-array-processing.mjs
 */
import { shrink } from "../dist/index.js";
import { summarizeRows } from "./lib/validation.mjs";

const rows = Array.from({ length: 200 }, (_, index) => ({
  id: `row_${index}`,
  account: `acc_${index % 7}`,
  amount: index === 137 ? -250.5 : 100 + index,
  currency: "GBP",
  postedAt: new Date(Date.UTC(2024, 0, 1 + (index % 365))).toISOString(),
}));

const result = await shrink({
  input: rows,
  test: (candidate) => {
    if (!Array.isArray(candidate)) return false;
    const summary = summarizeRows(candidate);
    return (
      summary.total !==
      candidate.filter((row) => typeof row?.amount === "number").reduce((sum, row) => sum + row.amount, 0)
    );
  },
});

console.log("Example 4 — array processing");
console.log("  status     :", result.status, `(${result.minimality})`);
console.log("  evaluations:", result.stats.evaluations);
console.log(
  "  rows       :",
  rows.length,
  "->",
  Array.isArray(result.minimalInput) ? result.minimalInput.length : "?",
);
console.log("  minimal    :", JSON.stringify(result.minimalInput));

const summary = summarizeRows(result.minimalInput);
if (!summary.wrong) throw new Error("example 4 failed: the wrong-summary condition was not preserved");

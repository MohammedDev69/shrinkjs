/**
 * Example 7 — Regression test generation.
 *
 * After minimizing, write a self-contained artifact directory with:
 *   result.json, minimized-input.json, reproduction.mjs,
 *   regression.test.ts, report.md
 *
 * Run: node examples/07-regression-artifacts.mjs
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { shrink, writeArtifacts } from "../dist/index.js";
import { parseError } from "./lib/predicates.mjs";
import { parseExpression } from "./lib/validation.mjs";

const input = `${"value = compute(a, b) + ".repeat(30)}) + tail`;

const result = await shrink({
  input,
  test: (candidate) => parseError(candidate, parseExpression),
});

const written = await writeArtifacts(result, {
  outputDir: path.resolve(".tmp/example-07"),
  testModule: path.resolve("examples/predicates/parser.mjs"),
  name: "expression-parser",
  overwrite: true,
});

console.log("Example 7 — regression artifacts");
console.log("  status :", result.status, `(${result.minimality})`);
console.log("  minimal:", JSON.stringify(result.minimalInput));
console.log("  files  :");
for (const file of written.files) console.log("   -", path.relative(process.cwd(), file));

const regression = await readFile(path.join(written.outputDir, "regression.test.ts"), "utf8");
console.log("\n--- generated regression.test.ts ---\n");
console.log(regression.trim());

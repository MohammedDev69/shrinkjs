/**
 * Runs every example in order and fails loudly if one of them does not hold.
 *
 * Usage: npm run examples   (builds first)
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const examples = [
  "01-api-payload.mjs",
  "02-checkout-error.mjs",
  "03-string-parser.mjs",
  "04-array-processing.mjs",
  "05-custom-reducer.mjs",
  "06-async-predicate.mjs",
  "07-regression-artifacts.mjs",
];

let failures = 0;
const started = Date.now();

for (const file of examples) {
  const url = pathToFileURL(path.join(import.meta.dirname, file)).href;
  const exampleStarted = Date.now();
  try {
    await import(url);
    console.log(`\n  ✓ ${file} (${Date.now() - exampleStarted} ms)\n`);
  } catch (error) {
    failures += 1;
    console.error(`\n  ✗ ${file}\n`);
    console.error(error);
  }
}

console.log(`${examples.length - failures}/${examples.length} examples passed in ${Date.now() - started} ms`);
process.exitCode = failures === 0 ? 0 : 1;

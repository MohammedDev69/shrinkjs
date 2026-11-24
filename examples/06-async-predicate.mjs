/**
 * Example 6 — Async predicate with a timeout.
 *
 * Real predicates call APIs, spawn processes or wait for I/O. Two safeguards
 * matter: `limits.predicateTimeout` (a single call cannot hang the run) and
 * `limits.maxDuration` (the whole run has a deadline).
 *
 * Run: node examples/06-async-predicate.mjs
 */
import { shrink } from "../dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const payload = {
  job: "resize-image",
  attempts: 3,
  input: { url: "https://example.com/photo.jpg", width: 1920, height: 1080 },
  options: { quality: 82, format: "webp", stripMetadata: true },
  metadata: { traceId: "trace_1", retriesLeft: 2 },
};

const started = Date.now();

const result = await shrink({
  input: payload,
  test: async (candidate) => {
    // Pretend each check is an I/O round trip.
    await sleep(2);
    return candidate?.input?.format === undefined && candidate?.options?.format === "webp";
  },
  limits: {
    predicateTimeout: 1_000,
    maxDuration: 10_000,
    maxEvaluations: 3_000,
  },
});

console.log("Example 6 — async predicate");
console.log("  status     :", result.status, `(${result.minimality})`);
console.log("  evaluations:", result.stats.evaluations, "in", Date.now() - started, "ms");
console.log("  timeouts   :", result.stats.timeouts);
console.log("  minimal    :", JSON.stringify(result.minimalInput));

if (!result.ok) throw new Error("example 6 failed: the async predicate never held");

/**
 * Jest convenience wrapper around the ShrinkJS core engine.
 *
 * Identical behaviour to the Vitest adapter: run a minimization inside a test,
 * write artifacts, and fail the test when the target behavior cannot be
 * established. ShrinkJS never imports Jest, so this works with any runner that
 * can await a promise.
 *
 * @example
 * ```ts
 * // tests/parser.shrink.test.ts
 * import { minimizeTestCase } from "@shrinkjs/core/jest";
 *
 * test("minimal parser failure", async () => {
 *   const result = await minimizeTestCase({
 *     input: failingSource,
 *     test: (candidate) => parse(candidate) === "error",
 *   });
 *   expect(result.minimalInput).toBe("");
 * });
 * ```
 */
import { runMinimizedCase, type MinimizeTestCaseOptions, type MinimizeTestCaseResult } from "../shared.js";

/** Minimizes a case inside a Jest (or Jest-compatible) test. */
export function minimizeTestCase<T>(options: MinimizeTestCaseOptions<T>): Promise<MinimizeTestCaseResult<T>> {
  return runMinimizedCase(options, "jest");
}

export type { MinimizeTestCaseOptions, MinimizeTestCaseResult };
export { createRegressionTest } from "../../reporting/artifacts.js";
export type { ShrinkResult } from "../../core/types.js";

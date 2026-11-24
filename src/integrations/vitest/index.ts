/**
 * Vitest convenience wrapper around the ShrinkJS core engine.
 *
 * This is *not* official Vitest functionality and does not depend on Vitest.
 * It only provides a test-shaped API and writes reusable artifacts.
 *
 * @example
 * ```ts
 * // tests/checkout.shrink.test.ts
 * import { describe, expect, it } from "vitest";
 * import { minimizeTestCase } from "@shrinkjs/core/vitest";
 * import { reproducesInvalidPrice } from "../src/predicate.js";
 *
 * describe("checkout regression", () => {
 *   it("keeps a minimal reproduction", async () => {
 *     const result = await minimizeTestCase({
 *       input: failingPayload,
 *       test: reproducesInvalidPrice,
 *       name: "checkout-price",
 *     });
 *     expect(result.ok).toBe(true);
 *     expect(result.minimalInput).toBeDefined();
 *   });
 * });
 * ```
 */
import { runMinimizedCase, type MinimizeTestCaseOptions, type MinimizeTestCaseResult } from "../shared.js";

/** Minimizes a case inside a Vitest test. */
export function minimizeTestCase<T>(options: MinimizeTestCaseOptions<T>): Promise<MinimizeTestCaseResult<T>> {
  return runMinimizedCase(options, "vitest");
}

export type { MinimizeTestCaseOptions, MinimizeTestCaseResult };
export { createRegressionTest } from "../../reporting/artifacts.js";
export type { ShrinkResult } from "../../core/types.js";

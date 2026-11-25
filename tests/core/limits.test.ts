import { describe, expect, it, vi } from "vitest";
import { shrink } from "../../src/index.js";
import { makeLargePayload } from "../helpers/fixtures.js";

describe("limits", () => {
  it("stops at maxEvaluations and reports it", async () => {
    const input = makeLargePayload(80);
    const result = await shrink({
      input,
      test: (candidate) => JSON.stringify(candidate).includes("user-70"),
      limits: { maxEvaluations: 25 },
    });

    expect(result.stats.limitReached).toBe("max-evaluations");
    expect(result.status).toBe("limit-reached");
    expect(result.stats.evaluations).toBeLessThanOrEqual(25);
    expect(result.ok).toBe(true);
    expect(result.minimality).toBe("unknown");
  });

  it("stops at maxDuration", async () => {
    const result = await shrink({
      input: makeLargePayload(50),
      test: async (candidate) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return JSON.stringify(candidate).includes("user-40");
      },
      limits: { maxDuration: 120, maxEvaluations: 10_000 },
    });

    expect(result.stats.limitReached).toBe("max-duration");
    expect(result.status).toBe("limit-reached");
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(100);
  });

  it("stops at maxPasses", async () => {
    const result = await shrink({
      input: { a: [1, 2, 3], b: { c: 4, d: 5 } },
      test: (candidate) => candidate.a !== undefined,
      limits: { maxPasses: 1 },
    });
    expect(result.stats.limitReached).toBe("max-passes");
    expect(result.status).toBe("limit-reached");
  });

  it("respects maxDepth", async () => {
    const deep = { l1: { l2: { l3: { l4: { keep: true, noise: "x".repeat(50) } } } } };
    const result = await shrink({
      input: deep,
      test: (candidate) =>
        JSON.stringify(candidate).includes("keep") && JSON.stringify(candidate).includes("noise"),
      limits: { maxDepth: 2, maxEvaluations: 200 },
    });
    // The deep object is beyond the depth limit, so its keys cannot be reduced.
    expect(JSON.stringify(result.minimalInput)).toContain("noise");
  });

  it("respects maxCandidatesPerNode", async () => {
    const result = await shrink({
      input: Array.from({ length: 40 }, (_, index) => index),
      test: (candidate) => candidate.includes(39),
      limits: { maxCandidatesPerNode: 6, maxEvaluations: 1_000 },
    });
    // Reduction still happens, but the candidate set per node visit is tiny.
    expect(result.ok).toBe(true);
    expect(result.minimalInput.length).toBeLessThan(40);
    expect(result.minimalInput).toContain(39);
  });

  it("treats zero limits as unlimited for evaluations", async () => {
    const result = await shrink({ input: { a: 1, b: 2 }, test: () => true, limits: { maxEvaluations: 0 } });
    expect(result.stats.limitReached).toBeNull();
    expect(result.minimalInput).toBeNull();
  });

  it("warns when the final verification is skipped", async () => {
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: (candidate) => candidate.a === 1,
      limits: { maxEvaluations: 2 },
    });
    expect(result.stats.limitReached).toBe("max-evaluations");
    expect(result.warnings.some((warning) => warning.includes("verification skipped"))).toBe(true);
  });

  it("skips verification when asked", async () => {
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: (candidate) => candidate.a === 1,
      verifyFinalInput: false,
    });
    expect(result.stats.verification.performed).toBe(false);
  });
});

describe("cancellation", () => {
  it("returns cancelled when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await shrink({
      input: { a: 1 },
      test: () => true,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.ok).toBe(true);
    expect(result.minimality).toBe("unknown");
  });

  it("cancels mid-run and keeps the best input found so far", async () => {
    const controller = new AbortController();
    const input = makeLargePayload(60);
    let calls = 0;

    const result = await shrink({
      input,
      test: (candidate) => {
        calls += 1;
        if (calls === 12) controller.abort();
        return JSON.stringify(candidate).includes("user-55");
      },
      signal: controller.signal,
      limits: { maxEvaluations: 5_000 },
    });

    expect(result.status).toBe("cancelled");
    expect(result.ok).toBe(true);
    expect(result.stats.evaluations).toBeLessThan(5_000);
    expect(JSON.stringify(result.minimalInput)).toContain("user-55");
    expect(result.warnings.some((warning) => warning.includes("cancelled"))).toBe(true);
  });

  it("does not call the predicate at all when pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const test = vi.fn(() => true);
    await shrink({ input: 1, test, signal: controller.signal });
    expect(test).not.toHaveBeenCalled();
  });

  it("stops after the in-flight predicate settles when aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const result = await shrink({
      input: { a: 1, b: 2, c: 3 },
      test: async (candidate) => {
        // A real I/O-shaped predicate: slow but finite. A per-call timeout is
        // deliberately disabled, so cancellation can only take effect once the
        // current call settles — that is the documented guarantee.
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.abort();
        return (candidate as { a?: number }).a === 1;
      },
      limits: { predicateTimeout: 0, maxDuration: 0, maxEvaluations: 1_000 },
      signal: controller.signal,
      verifyFinalInput: false,
    });

    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.stats.evaluations).toBeLessThan(10);
  });
});

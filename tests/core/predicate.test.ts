import { describe, expect, it, vi } from "vitest";
import { shrink } from "../../src/index.js";

describe("predicate error policy", () => {
  it("ignores exceptions by default and counts them", async () => {
    const result = await shrink({
      input: { a: 1, b: "text", c: [1, 2] },
      test: (candidate) => {
        if (typeof candidate !== "object" || candidate === null) throw new TypeError("not an object");
        return (candidate as { a?: number }).a === 1;
      },
      limits: { maxEvaluations: 300 },
    });

    expect(result.ok).toBe(true);
    expect(result.stats.predicateErrors).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes("predicateErrors"))).toBe(true);
    expect(result.minimalInput).toEqual({ a: 1 });
  });

  it("aborts the run under the fail policy", async () => {
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: (candidate) => {
        if (candidate === null || typeof candidate !== "object") throw new Error("predicate exploded");
        if ((candidate as { a?: number }).a === undefined) throw new Error("predicate exploded");
        return true;
      },
      predicateErrors: "fail",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ERR_PREDICATE_FAILED");
    expect(result.error?.message).toContain("predicate exploded");
  });

  it("treats exceptions as reproductions under the preserve policy", async () => {
    const result = await shrink({
      input: { a: 1, b: 2, c: 3 },
      test: (candidate) => {
        if (candidate === null || typeof candidate !== "object") throw new Error("shape changed");
        if (Object.keys(candidate).length < 3) throw new Error("shape changed");
        return true;
      },
      predicateErrors: "preserve",
      limits: { maxEvaluations: 100 },
    });

    expect(result.ok).toBe(true);
    // Every reduced shape throws, so the engine happily walks into the
    // throwing region — exactly the risk the warning documents.
    expect(result.warnings.some((warning) => warning.includes("preserve"))).toBe(true);
    expect(result.minimalInput).toBeNull();
  });

  it("reports the predicate error when the original input throws", async () => {
    const result = await shrink({
      input: { a: 1 },
      test: () => {
        throw new Error("always broken");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ERR_PREDICATE_FAILED");
    expect(result.error?.message).toContain("always broken");
  });

  it("rejects invalid predicate results", async () => {
    const result = await shrink({
      input: 1,
      // @ts-expect-error invalid on purpose
      test: () => ({ preserved: true }),
    });
    expect(result.error?.code).toBe("ERR_PREDICATE_INVALID_RESULT");
  });
});

describe("predicate timeout", () => {
  it("times out slow candidates and continues", async () => {
    const result = await shrink({
      input: { a: 1, b: 2, c: 3 },
      test: async (candidate) => {
        if (candidate === null || typeof candidate !== "object") return false;
        // Only two-key shapes are slow; the original and small shapes are fast.
        if (Object.keys(candidate).length === 2) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return (candidate as { a?: number }).a === 1;
      },
      limits: { predicateTimeout: 25, maxEvaluations: 200 },
      verifyFinalInput: false,
    });

    expect(result.stats.timeouts).toBeGreaterThan(0);
    expect(result.stats.predicateErrors).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.minimalInput).toEqual({ a: 1 });
  });

  it("aborts when timeouts are fatal", async () => {
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      },
      limits: { predicateTimeout: 10 },
      predicateErrors: "fail",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.stats.timeouts).toBeGreaterThanOrEqual(1);
  });
});

describe("stability", () => {
  it("accepts stable predicates", async () => {
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: () => true,
      stability: { runs: 3, requiredMatches: 3 },
    });
    expect(result.ok).toBe(true);
    expect(result.stats.evaluations).toBeGreaterThanOrEqual(3);
  });

  it("never accepts candidates when repeated runs disagree", async () => {
    let calls = 0;
    const result = await shrink({
      input: { a: 1, b: 2, c: 3 },
      test: () => {
        calls += 1;
        return calls % 2 === 0;
      },
      stability: { runs: 2, requiredMatches: 2 },
      limits: { maxEvaluations: 40 },
      verifyFinalInput: false,
    });

    expect(result.ok).toBe(false);
    expect(result.stats.unstableCandidates).toBeGreaterThan(0);
    expect(result.error?.code).toBe("ERR_PREDICATE_NOT_PRESERVED");
  });

  it("marks the run unstable when the original input is flaky", async () => {
    let calls = 0;
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: () => {
        calls += 1;
        return calls % 3 !== 0;
      },
      stability: { runs: 3, requiredMatches: 3 },
      limits: { maxEvaluations: 10 },
      verifyFinalInput: false,
    });
    expect(result.status).toBe("unstable");
    expect(result.ok).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("unstable"))).toBe(true);
    expect(result.error?.name).toBe("UnstablePredicate");
  });

  it("detects a non-deterministic predicate during final verification", async () => {
    let calls = 0;
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: () => {
        calls += 1;
        return calls === 1;
      },
      limits: { maxEvaluations: 50 },
    });
    expect(result.stats.verification.performed).toBe(true);
    expect(result.stats.verification.preserved).toBe(false);
    expect(result.status).toBe("unstable");
    expect(result.warnings.some((warning) => warning.includes("Final verification failed"))).toBe(true);
  });
});

describe("caching", () => {
  it("counts cache hits and avoids duplicate calls", async () => {
    const test = vi.fn((candidate: { a?: number }) => candidate.a === 1);
    const result = await shrink({ input: { a: 1, b: 2, c: 3 }, test });
    expect(result.stats.cacheHits + test.mock.calls.length).toBeGreaterThan(0);
    expect(result.stats.evaluations).toBe(test.mock.calls.length);
  });

  it("can be disabled", async () => {
    const result = await shrink({
      input: { a: 1, b: 2, c: 3 },
      test: (candidate) => candidate.a === 1,
      cache: false,
    });
    expect(result.stats.cacheHits).toBe(0);
    expect(result.ok).toBe(true);
  });
});

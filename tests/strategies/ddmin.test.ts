import { describe, expect, it, vi } from "vitest";
import { deltaDebug, partitionIndices } from "../../src/index.js";

function isSubsequence<T>(candidate: readonly T[], source: readonly T[]): boolean {
  let index = 0;
  for (const value of source) {
    if (index < candidate.length && Object.is(candidate[index], value)) index += 1;
  }
  return index === candidate.length;
}

describe("deltaDebug", () => {
  it("reduces to the single required element", async () => {
    const result = await deltaDebug([1, 2, 3, 4, 5, 6, 7, 8], async (candidate) => candidate.includes(5));
    expect(result.items).toEqual([5]);
    expect(result.oneMinimal).toBe(true);
    expect(result.tests).toBeLessThan(20);
  });

  it("returns the empty array when the predicate accepts it", async () => {
    const result = await deltaDebug([1, 2, 3], async () => true);
    expect(result.items).toEqual([]);
    expect(result.tests).toBe(1);
  });

  it("handles empty input", async () => {
    const test = vi.fn(async () => true);
    const result = await deltaDebug([], test);
    expect(result.items).toEqual([]);
    expect(test).not.toHaveBeenCalled();
  });

  it("returns a subsequence of the input and preserves order", async () => {
    const input = ["a", "b", "c", "d", "e", "f"];
    const result = await deltaDebug(
      input,
      async (candidate) => candidate.includes("b") && candidate.includes("e"),
    );
    expect(result.items).toEqual(["b", "e"]);
    expect(isSubsequence(result.items, input)).toBe(true);
  });

  it("cannot remove two elements when only the pair preserves the predicate", async () => {
    // Honest limitation: removing "a" alone breaks the predicate (last must be
    // "e"), so ddmin stops at a 1-minimal input instead of guessing.
    const input = ["a", "b", "c", "d", "e", "f"];
    const result = await deltaDebug(
      input,
      async (candidate) => candidate[0] === "b" && candidate.at(-1) === "e",
    );
    expect(result.items).toEqual(input);
    expect(result.oneMinimal).toBe(true);
  });

  it("keeps duplicates when multiplicity matters", async () => {
    const result = await deltaDebug(
      [1, 1, 1, 1],
      async (candidate) => candidate.filter((v) => v === 1).length >= 2,
    );
    expect(result.items).toEqual([1, 1]);
  });

  it("preserves required pairs at each end", async () => {
    const input = Array.from({ length: 64 }, (_, index) => index);
    const result = await deltaDebug(
      input,
      async (candidate) => candidate.includes(3) && candidate.includes(60),
    );
    expect(result.items).toEqual([3, 60]);
    expect(result.oneMinimal).toBe(true);
  });

  it("reports 1-minimality honestly", async () => {
    const input = [1, 2, 3, 4, 5];
    const result = await deltaDebug(input, async (candidate) => candidate.length >= 3);
    expect(result.items.length).toBe(3);
    expect(result.oneMinimal).toBe(true);
  });

  it("marks oneMinimal false when granularity is capped", async () => {
    const input = Array.from({ length: 500 }, (_, index) => index);
    const result = await deltaDebug(input, async (candidate) => candidate.length >= 300, { maxParts: 4 });
    expect(result.oneMinimal).toBe(false);
    expect(result.items.length).toBeGreaterThanOrEqual(300);
    expect(result.items.length).toBeLessThan(500);
  });

  it("stops when shouldContinue returns false", async () => {
    let calls = 0;
    const input = Array.from({ length: 100 }, (_, index) => index);
    const result = await deltaDebug(input, async () => false, {
      shouldContinue: () => {
        calls += 1;
        return calls < 3;
      },
    });
    expect(result.tests).toBeLessThanOrEqual(3);
    expect(result.items).toEqual(input);
  });

  it("stops at maxTests", async () => {
    const result = await deltaDebug(
      Array.from({ length: 50 }, (_, index) => index),
      async () => false,
      {
        maxTests: 4,
      },
    );
    expect(result.tests).toBeLessThanOrEqual(4);
  });

  it("is deterministic", async () => {
    const input = Array.from({ length: 40 }, (_, index) => index);
    const predicate = async (candidate: readonly number[]): Promise<boolean> =>
      candidate.includes(7) && candidate.includes(33);
    const first = await deltaDebug(input, predicate);
    const second = await deltaDebug(input, predicate);
    expect(first.items).toEqual(second.items);
    expect(first.tests).toBe(second.tests);
  });

  it("handles single-element input", async () => {
    const kept = await deltaDebug([42], async () => false);
    expect(kept.items).toEqual([42]);
    const removed = await deltaDebug([42], async () => true);
    expect(removed.items).toEqual([]);
  });
});

describe("partitionIndices", () => {
  it("covers every index exactly once", () => {
    for (const length of [1, 2, 3, 5, 10, 17]) {
      for (const parts of [1, 2, 3, 4, 8]) {
        const partitions = partitionIndices(length, parts);
        const flat = partitions.flat();
        expect(flat).toEqual(Array.from({ length }, (_, index) => index));
      }
    }
  });

  it("never produces empty partitions", () => {
    for (const length of [1, 2, 3, 7]) {
      for (const parts of [1, 2, 3, 10]) {
        for (const partition of partitionIndices(length, parts)) {
          expect(partition.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("splits as evenly as possible", () => {
    const partitions = partitionIndices(10, 3);
    const sizes = partitions.map((partition) => partition.length);
    expect(sizes).toEqual([4, 3, 3]);
  });
});

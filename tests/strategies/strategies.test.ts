import { describe, expect, it } from "vitest";
import { shrink } from "../../src/index.js";
import { numberCandidates } from "../../src/strategies/number.js";

describe("array reduction", () => {
  it("removes chunks and unrelated elements", async () => {
    const input = Array.from({ length: 64 }, (_, index) => ({ index, label: `row-${index}` }));
    const result = await shrink({
      input,
      test: (candidate) => candidate.some((row) => row.label === "row-9"),
    });
    expect(result.minimalInput).toEqual([{ label: "row-9" }]);
  });

  it("removes duplicates", async () => {
    const result = await shrink({
      input: ["a", "a", "b", "a", "c"],
      test: (candidate) => candidate.includes("a") && candidate.includes("c"),
    });
    expect(result.minimalInput).toEqual(["a", "c"]);
  });

  it("handles nested arrays", async () => {
    const result = await shrink({
      input: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
      test: (candidate) => candidate.flat().includes(8),
    });
    expect(result.minimalInput).toEqual([[8]]);
  });

  it("supports arrays of primitives with a length requirement", async () => {
    const result = await shrink({
      input: Array.from({ length: 32 }, (_, index) => index),
      test: (candidate) =>
        candidate.length >= 3 && candidate.every((value) => typeof value === "number" && value >= 0),
    });
    expect(result.minimalInput).toEqual([0, 0, 0]);
  });

  it("keeps empty arrays when the predicate needs one", async () => {
    const result = await shrink({
      input: { list: [1, 2, 3], name: "x" },
      test: (candidate) => Array.isArray(candidate.list) && candidate.list.includes(2),
    });
    expect(result.minimalInput).toEqual({ list: [2] });
  });
});

describe("object reduction", () => {
  it("drops irrelevant nested properties", async () => {
    const result = await shrink({
      input: {
        a: { deep: { deeper: { keep: "yes", drop: "no" } } },
        b: [1, 2, 3],
        c: "noise",
      },
      test: (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        JSON.stringify(candidate).includes("keep") &&
        JSON.stringify(candidate).includes("yes"),
    });
    expect(result.minimalInput).toEqual({ a: { deep: { deeper: { keep: "yes" } } } });
  });

  it("distinguishes missing properties from undefined and null", async () => {
    const result = await shrink({
      input: { a: 1, b: 2, c: 3 },
      test: (candidate) => Object.prototype.hasOwnProperty.call(candidate, "b") && candidate.b === 2,
    });
    expect(result.minimalInput).toEqual({ b: 2 });
    expect("a" in result.minimalInput).toBe(false);
  });

  it("keeps class instances as instances", async () => {
    class Payload {
      constructor(
        public readonly kind: string,
        public readonly noise: string,
      ) {}
    }
    const result = await shrink({
      input: new Payload("target", "noise"),
      mode: "js",
      test: (candidate) => candidate instanceof Payload && candidate.kind === "target",
    });
    expect(result.minimalInput).toBeInstanceOf(Payload);
    expect(result.minimalInput).toEqual({ kind: "target" });
  });
});

describe("string reduction", () => {
  it("reduces to the shortest triggering substring", async () => {
    const input = `${"a".repeat(500)}MAGIC${"b".repeat(500)}`;
    const result = await shrink({ input, test: (candidate) => candidate.includes("MAGIC") });
    expect(result.minimalInput).toBe("MAGIC");
  });

  it("normalizes whitespace", async () => {
    const result = await shrink({
      input: "  hello \n\t world   ",
      test: (candidate) => candidate.replace(/\s+/g, " ").trim() === "hello world",
    });
    expect(result.minimalInput).toBe("hello world");
  });

  it("handles unicode without splitting surrogate pairs", async () => {
    const result = await shrink({
      input: `🎉🎉🎉KEY🎉🎉🎉`,
      test: (candidate) => candidate.includes("KEY"),
    });
    expect(result.minimalInput).toBe("KEY");
  });

  it("reduces long repeated text with a bounded number of evaluations", async () => {
    const input = "lorem ipsum dolor sit amet ".repeat(2_000);
    const result = await shrink({
      input,
      test: (candidate) => candidate.includes("dolor"),
      limits: { maxEvaluations: 2_000 },
    });
    expect(result.minimalInput).toContain("dolor");
    expect(result.stats.evaluations).toBeLessThan(2_000);
  });

  it("can reduce to the empty string", async () => {
    const result = await shrink({ input: "anything", test: (candidate) => typeof candidate === "string" });
    expect(result.minimalInput).toBe("");
  });
});

describe("number reduction", () => {
  it("offers simpler values first", () => {
    const candidates = numberCandidates(1000);
    expect(candidates[0]).toBe(0);
    expect(candidates).toContain(1);
    expect(candidates).toContain(500);
    expect(candidates).not.toContain(1000);
  });

  it("reduces integers to the simplest satisfying value", async () => {
    const result = await shrink({
      input: 123_459,
      // Note the type guard: without it, `null % 7 === 0` would (correctly) win.
      test: (candidate) => typeof candidate === "number" && candidate % 7 === 0,
    });
    expect(result.minimalInput).toBe(0);
  });

  it("finds a modular boundary", async () => {
    const result = await shrink({ input: 1000, test: (candidate) => candidate > 512 && candidate % 2 === 0 });
    expect(result.minimalInput).toBe(514);
  });

  it("reduces floats toward the boundary", async () => {
    const result = await shrink({ input: 3.25, test: (candidate) => candidate > 1.5 });
    expect(result.minimalInput).toBeGreaterThan(1.5);
    expect(result.minimalInput).toBeLessThan(1.5001);
  });

  it("keeps NaN when the predicate requires it", async () => {
    const result = await shrink({ input: Number.NaN, test: (candidate) => Number.isNaN(candidate) });
    expect(Number.isNaN(result.minimalInput)).toBe(true);
  });

  it("reduces Infinity when allowed", async () => {
    const result = await shrink({
      input: { value: Infinity, note: "x" },
      test: (candidate) => typeof candidate.value === "number",
    });
    expect(result.minimalInput).toEqual({ value: 0 });
  });

  it("handles negative zero", async () => {
    const result = await shrink({
      input: { value: -0, note: "x" },
      test: (candidate) => Object.is(candidate.value, -0),
    });
    expect(Object.is(result.minimalInput.value, -0)).toBe(true);
  });

  it("reduces bigint values in js mode", async () => {
    const result = await shrink({
      input: 9_000_000_000n,
      mode: "js",
      test: (candidate) => candidate > 1000n,
    });
    expect(typeof result.minimalInput).toBe("bigint");
    expect(result.minimalInput < 9_000_000_000n).toBe(true);
  });
});

describe("scalar reduction", () => {
  it("flips true to false", async () => {
    const result = await shrink({ input: { flag: true, noise: 1 }, test: () => true });
    expect(result.minimalInput).toBeNull();
  });

  it("keeps true when required", async () => {
    const result = await shrink({
      input: { flag: true, noise: 1 },
      test: (candidate) => candidate.flag === true,
    });
    expect(result.minimalInput).toEqual({ flag: true });
  });

  it("reduces to the simplest container when null is rejected", async () => {
    const result = await shrink({ input: { a: "text", b: 5 }, test: (candidate) => candidate !== null });
    expect(result.minimalInput).toEqual({});
  });
});

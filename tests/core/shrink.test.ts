import { describe, expect, it, vi } from "vitest";
import { minimize, shrink, sizeOf, type ProgressEvent } from "../../src/index.js";
import { InvalidPriceError, makeLargePayload, makeOrder } from "../helpers/fixtures.js";

describe("shrink(): basic reduction", () => {
  it("reduces a nested object to the part that matters", async () => {
    const input = makeOrder({
      items: [
        { sku: "A", price: 10, quantity: 1, note: "gift" },
        { sku: "TARGET", price: 25, quantity: 3, note: "keep" },
        { sku: "C", price: 30, quantity: 1 },
      ],
      metadata: { source: "web", version: "2.0.0", flags: { x: true, y: false } },
    });

    const result = await shrink({
      input,
      test: (candidate) =>
        Array.isArray(candidate.items) && candidate.items.some((item) => item.sku === "TARGET"),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.minimality).toBe("local");
    expect(result.minimalInput).toEqual({ items: [{ sku: "TARGET" }] });
    expect(result.stats.finalSize).toBeLessThan(result.stats.originalSize);
    expect(result.stats.successfulReductions).toBeGreaterThan(0);
    expect(result.stats.evaluations).toBeGreaterThan(0);
  });

  it("returns the input unchanged when it is already minimal", async () => {
    const result = await shrink({ input: { a: 1 }, test: (candidate) => candidate.a === 1 });
    expect(result.minimalInput).toEqual({ a: 1 });
    expect(result.stats.successfulReductions).toBe(0);
    expect(result.stats.reductionPercent).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.minimality).toBe("local");
  });

  it("reports a failure when the predicate rejects the original input", async () => {
    const result = await shrink({ input: { keep: true }, test: () => false });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ERR_PREDICATE_NOT_PRESERVED");
    expect(result.minimalInput).toEqual({ keep: true });
    expect(result.minimality).toBe("unknown");
    expect(result.stats.evaluations).toBe(1);
  });

  it("reduces to null when the predicate accepts everything", async () => {
    const result = await shrink({ input: { a: 1, b: [1, 2, 3] }, test: () => true });
    expect(result.minimalInput).toBeNull();
    expect(result.stats.finalSize).toBe(4);
    expect(result.status).toBe("completed");
  });

  it("does not mutate the caller's input", async () => {
    const input = makeOrder();
    const snapshot = structuredClone(input);
    await shrink({ input, test: (candidate) => candidate.items.length > 0 });
    expect(input).toEqual(snapshot);
  });

  it("is deterministic for the same input and predicate", async () => {
    const input = makeLargePayload(40);
    const predicate = (candidate: typeof input): boolean => JSON.stringify(candidate).includes("user-17");

    const first = await shrink({ input, test: predicate });
    const second = await shrink({ input, test: predicate });

    expect(first.minimalInput).toEqual(second.minimalInput);
    expect(first.stats.evaluations).toBe(second.stats.evaluations);
  });

  it("exposes minimize() as an alias", async () => {
    expect(minimize).toBe(shrink);
  });
});

describe("shrink(): input types", () => {
  it("reduces long strings to the triggering token", async () => {
    const text = `${"filler text ".repeat(200)}TOKEN${" more filler".repeat(100)}`;
    const result = await shrink({ input: text, test: (candidate) => candidate.includes("TOKEN") });
    expect(result.minimalInput).toBe("TOKEN");
    expect(result.stats.evaluations).toBeLessThan(400);
  });

  it("reduces arrays of objects with chunk removal", async () => {
    const input = Array.from({ length: 300 }, (_, index) => ({ index, name: `item-${index}` }));
    const result = await shrink({
      input,
      test: (candidate) => candidate.some((item) => item.name === "item-211"),
    });
    expect(result.minimalInput).toEqual([{ name: "item-211" }]);
    expect(result.stats.evaluations).toBeLessThan(500);
  });

  it("reduces numbers toward the predicate boundary", async () => {
    const result = await shrink({ input: 98_765, test: (candidate) => candidate > 100 });
    expect(result.minimalInput).toBe(101);
  });

  it("reduces negative numbers without crossing zero", async () => {
    const result = await shrink({ input: -98_765, test: (candidate) => candidate < 0 });
    expect(result.minimalInput).toBe(-1);
  });

  it("reduces decimals to readable values", async () => {
    const result = await shrink({ input: 0.75, test: (candidate) => candidate > 0.4 });
    expect(typeof result.minimalInput).toBe("number");
    expect(result.minimalInput).toBeGreaterThan(0.4);
    expect(result.minimalInput).toBeLessThan(0.41);
  });

  it("reduces booleans and null-ish values", async () => {
    const result = await shrink({
      input: { verbose: true, mode: "quiet", extra: "x" },
      test: (candidate) => candidate.verbose === true,
    });
    expect(result.minimalInput).toEqual({ verbose: true });
  });

  it("handles empty containers", async () => {
    const emptyArray = await shrink({ input: [], test: (candidate) => Array.isArray(candidate) });
    expect(emptyArray.minimalInput).toEqual([]);

    const emptyObject = await shrink({
      input: {},
      test: (candidate) => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate),
    });
    expect(emptyObject.minimalInput).toEqual({});
  });

  it("supports non-JSON values in js mode", async () => {
    const input = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    const result = await shrink({
      input,
      mode: "js",
      test: (candidate) => candidate instanceof Map,
    });
    expect(result.minimalInput).toBeInstanceOf(Map);
  });

  it("rejects JSON-incompatible values in json mode", async () => {
    await expect(shrink({ input: new Date(), test: () => true })).rejects.toMatchObject({
      code: "ERR_UNSUPPORTED_INPUT",
    });
  });

  it("rejects circular structures in json mode", async () => {
    const input: Record<string, unknown> = { a: 1 };
    input.self = input;
    await expect(shrink({ input, test: () => true })).rejects.toMatchObject({
      code: "ERR_UNSUPPORTED_INPUT",
    });
  });

  it("supports circular structures in js mode", async () => {
    const input: Record<string, unknown> = { a: 1, keep: "yes" };
    input.self = input;
    const result = await shrink({
      input,
      mode: "js",
      test: (candidate) => (candidate as Record<string, unknown>).keep === "yes",
    });
    expect(result.ok).toBe(true);
    expect((result.minimalInput as Record<string, unknown>).keep).toBe("yes");
  });
});

describe("shrink(): statistics and result shape", () => {
  it("keeps statistics internally consistent", async () => {
    const result = await shrink({
      input: makeOrder(),
      test: (candidate) => candidate.items.some((item) => item.price === 20),
      history: { enabled: true },
    });

    const { stats } = result;
    expect(stats.originalSize).toBe(sizeOf(result.originalInput));
    expect(stats.finalSize).toBe(sizeOf(result.minimalInput));
    expect(stats.savedChars).toBe(stats.originalSize - stats.finalSize);
    expect(stats.reductionPercent).toBeGreaterThan(0);
    expect(stats.evaluations).toBeGreaterThanOrEqual(1);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(stats.verification.performed).toBe(true);
    expect(stats.verification.preserved).toBe(true);
    expect(stats.limitReached).toBeNull();

    const strategyTotals = Object.values(stats.strategies).reduce((sum, entry) => sum + entry.attempts, 0);
    expect(strategyTotals).toBeGreaterThan(0);
    expect(stats.successfulReductions + stats.rejectedCandidates).toBeLessThanOrEqual(
      strategyTotals + stats.evaluations,
    );
  });

  it("records bounded history without values by default", async () => {
    const result = await shrink({
      input: makeLargePayload(20),
      test: (candidate) => JSON.stringify(candidate).includes("user-3"),
      history: { enabled: true, maxEntries: 5 },
    });

    expect(result.history).toBeDefined();
    expect(result.history!.length).toBeLessThanOrEqual(5);
    for (const entry of result.history!) {
      expect(entry.value).toBeUndefined();
      expect(entry.path.startsWith("$")).toBe(true);
      expect(typeof entry.strategy).toBe("string");
    }
    // Steps increase monotonically.
    const steps = result.history!.map((entry) => entry.step);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("records values when explicitly enabled", async () => {
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: () => true,
      history: { enabled: true, includeValues: true },
    });
    expect(result.history!.some((entry) => entry.value !== undefined)).toBe(true);
  });

  it("omits history by default", async () => {
    const result = await shrink({ input: { a: 1 }, test: () => true });
    expect(result.history).toBeUndefined();
  });

  it("reports a stable config summary", async () => {
    const result = await shrink({ input: 1, test: () => true });
    expect(result.config.mode).toBe("json");
    expect(result.config.preset).toBe("balanced");
    expect(result.config.predicateErrors).toBe("ignore");
    expect(result.config.libraryVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.config.reducers).toContain("array");
    expect(result.config.limits.maxEvaluations).toBeGreaterThan(0);
  });

  it("emits progress events that never increase the best size", async () => {
    const events: ProgressEvent[] = [];
    await shrink({
      input: makeLargePayload(50),
      test: (candidate) => JSON.stringify(candidate).includes("user-31"),
      onProgress: (event) => events.push(event),
      limits: { maxEvaluations: 300 },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.phase).toBe("init");
    let best = Number.POSITIVE_INFINITY;
    for (const event of events) {
      expect(event.bestSize).toBeLessThanOrEqual(best);
      best = event.bestSize;
      expect(event.currentSize).toBeGreaterThanOrEqual(0);
    }
  });

  it("survives a throwing progress callback", async () => {
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: () => true,
      onProgress: () => {
        throw new Error("listener exploded");
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe("shrink(): predicate styles", () => {
  it("supports async predicates", async () => {
    const result = await shrink({
      input: makeOrder(),
      test: async (candidate) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return candidate.items.some((item) => item.price === 20);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.minimalInput).toEqual({ items: [{ price: 20 }] });
  });

  it("supports rich predicate results with signatures", async () => {
    const result = await shrink({
      input: { kind: "checkout", price: -5, noise: [1, 2, 3] },
      test: (candidate) => {
        const price = (candidate as { price?: number }).price;
        if (typeof price === "number" && price < 0) {
          return { preserve: true, signature: "INVALID_PRICE", metadata: { price } };
        }
        return { preserve: false };
      },
    });
    expect(result.signature).toBe("INVALID_PRICE");
    expect(result.minimalInput).toEqual({ price: -1 });
  });

  it("refuses to drift to a different signature", async () => {
    const seen: string[] = [];
    const result = await shrink({
      input: { b: 2, a: 1, c: 3 },
      test: (candidate) => {
        const record = candidate as Record<string, unknown>;
        // "a: 1" -> signature A, "b: 2" -> signature B, others nothing.
        if (record.a === 1) {
          seen.push("A");
          return { preserve: true, signature: "A" };
        }
        if (record.b === 2) {
          seen.push("B");
          return { preserve: true, signature: "B" };
        }
        return false;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.signature).toBe("A");
    expect(result.minimalInput).toEqual({ a: 1 });
    expect(result.stats.signatureMismatches).toBeGreaterThan(0);
    expect(seen).toContain("B");
  });
});

describe("shrink(): validation", () => {
  it("rejects a missing test function", async () => {
    // @ts-expect-error deliberately invalid
    await expect(shrink({ input: 1 })).rejects.toMatchObject({ code: "ERR_INVALID_CONFIG" });
  });

  it("rejects a missing input property", async () => {
    // @ts-expect-error deliberately invalid
    await expect(shrink({ test: () => true })).rejects.toMatchObject({ code: "ERR_INVALID_CONFIG" });
  });

  it("accepts an explicit undefined input", async () => {
    const result = await shrink({ input: undefined, test: (candidate) => candidate === undefined });
    expect(result.ok).toBe(true);
    expect(result.minimalInput).toBeUndefined();
  });

  it("rejects an unknown mode", async () => {
    await expect(
      // @ts-expect-error deliberately invalid
      shrink({ input: 1, test: () => true, mode: "yaml" }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_CONFIG" });
  });

  it("rejects an unknown preset", async () => {
    await expect(
      // @ts-expect-error deliberately invalid
      shrink({ input: 1, test: () => true, preset: "turbo" }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_CONFIG" });
  });

  it("rejects duplicate reducer names", async () => {
    await expect(
      shrink({
        input: 1,
        test: () => true,
        reducers: [
          { name: "dup", reduce: () => [] },
          { name: "dup", reduce: () => [] },
        ],
      }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_CONFIG" });
  });

  it("rejects invalid limits", async () => {
    await expect(
      shrink({ input: 1, test: () => true, limits: { maxEvaluations: -5 } }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_CONFIG" });
    await expect(
      shrink({ input: 1, test: () => true, limits: { maxDepth: Number.NaN } }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_CONFIG" });
  });

  it("rejects an oversized input before evaluating the predicate", async () => {
    const test = vi.fn(() => true);
    await expect(
      shrink({ input: "x".repeat(1000), test, limits: { maxInputSize: 10 } }),
    ).rejects.toMatchObject({ code: "ERR_INPUT_TOO_LARGE" });
    expect(test).not.toHaveBeenCalled();
  });

  it("throws on a predicate that returns an invalid shape", async () => {
    const result = await shrink({
      input: { a: 1 },
      // @ts-expect-error deliberately invalid predicate
      test: () => "yes",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ERR_PREDICATE_INVALID_RESULT");
  });
});

describe("shrink(): realistic example", () => {
  it("minimizes a checkout payload that throws InvalidPriceError", async () => {
    const payload = makeLargePayload(60);
    (payload.users as Array<Record<string, unknown>>)[57]!.score = -1;

    const result = await shrink({
      input: payload,
      test: (candidate) => {
        const users = (candidate as { users?: Array<{ score?: number }> }).users;
        if (!Array.isArray(users)) return false;
        if (!users.some((user) => typeof user.score === "number" && user.score < 0)) {
          return false;
        }
        try {
          for (const user of users) {
            if ((user.score ?? 0) < 0) throw new InvalidPriceError();
          }
          return false;
        } catch (error) {
          return error instanceof InvalidPriceError;
        }
      },
    });

    expect(result.ok).toBe(true);
    expect(result.minimalInput).toEqual({ users: [{ score: -1 }] });
    expect(result.stats.reductionPercent).toBeGreaterThan(95);
  });
});

import { describe, expect, it, vi } from "vitest";
import { shrink, type CustomReducer } from "../../src/index.js";

describe("custom reducers", () => {
  it("applies a domain reducer that removes a signed section atomically", async () => {
    const digest = (value: { headers?: Record<string, string> }): string =>
      `sig:${JSON.stringify(value.headers ?? null)}`;

    const headers: Record<string, string> = {
      authorization: "Bearer x",
      "x-trace-id": "abc",
      accept: "*/*",
    };
    const input = {
      headers,
      body: { message: "hello", priority: 3 },
      signature: digest({ headers }),
    };

    // Removing a single header invalidates the signature, so the structural
    // reducers cannot make progress on `headers`. A domain reducer that drops
    // the whole set and re-signs the request can.
    const dropHeaders: CustomReducer<typeof input> = {
      name: "drop-headers",
      reduce: (candidate) => {
        if (!candidate.headers || Object.keys(candidate.headers).length === 0) return [];
        const next = { ...candidate, headers: {} };
        return [{ ...next, signature: digest(next) }];
      },
    };

    const result = await shrink({
      input,
      test: (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "headers" in candidate &&
        candidate.signature === digest(candidate) &&
        candidate.body?.message === "hello",
      reducers: [dropHeaders],
    });

    expect(result.ok).toBe(true);
    expect(result.minimalInput.headers).toEqual({});
    expect(result.minimalInput.body).toEqual({ message: "hello" });
    expect(result.stats.strategies["drop-headers"]).toBeDefined();
    expect(result.stats.strategies["drop-headers"]!.attempts).toBeGreaterThan(0);
    expect(result.stats.reductionPercent).toBeGreaterThan(30);
  });

  it("supports reducers for value types the built-ins treat as leaves", async () => {
    const input = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);

    const result = await shrink({
      input,
      mode: "js",
      test: (candidate) => candidate instanceof Map && candidate.has("b"),
      reducers: [
        {
          name: "map-entries",
          reduce: (map) =>
            [...map.keys()]
              .filter((key) => key !== "b")
              .map((key) => {
                const next = new Map(map);
                next.delete(key);
                return next;
              }),
        },
      ],
    });

    expect([...result.minimalInput]).toEqual([["b", 2]]);
  });

  it("supports async generators", async () => {
    const result = await shrink({
      input: { a: 1, b: 2, c: 3 },
      test: (candidate) =>
        Object.keys(candidate).includes("c") &&
        typeof (candidate as unknown as Record<string, unknown>).c === "number",
      reducers: [
        {
          name: "async-drop",
          async *reduce(candidate) {
            for (const key of Object.keys(candidate)) {
              if (key === "c") continue;
              const copy = { ...candidate } as Record<string, unknown>;
              delete copy[key];
              yield copy as unknown as typeof candidate;
            }
          },
        },
      ],
    });
    expect(result.minimalInput).toEqual({ c: 0 });
  });

  it("skips disabled reducers", async () => {
    const reduce = vi.fn((): Array<{ a: number; b: number }> => []);
    await shrink({
      input: { a: 1, b: 2 },
      test: () => true,
      reducers: [{ name: "never", reduce, enabled: () => false }],
    });
    expect(reduce).not.toHaveBeenCalled();
  });

  it("runs reducers by priority", async () => {
    const order: string[] = [];
    await shrink({
      input: { a: 1, b: 2, c: 3, d: 4 },
      test: (candidate) => Object.keys(candidate).length >= 4,
      reducers: [
        {
          name: "second",
          priority: 200,
          reduce: () => {
            order.push("second");
            return [];
          },
        },
        {
          name: "first",
          priority: 10,
          reduce: () => {
            order.push("first");
            return [];
          },
        },
      ],
    });
    expect(order.slice(0, 2)).toEqual(["first", "second"]);
  });

  it("ignores candidates that are not simpler", async () => {
    const result = await shrink({
      input: { a: 1 },
      test: () => true,
      reducers: [
        {
          name: "bigger",
          // Deliberately returns a larger value; the engine must ignore it.
          reduce: () => [{ a: 1, b: 2, c: 3 } as unknown as { a: number }],
        },
      ],
    });
    // Null wins first, and the bigger candidate is never accepted.
    expect(result.minimalInput).toBeNull();
  });

  it("rejects reducers that return something else", async () => {
    const result = await shrink({
      input: { a: 1, b: 2 },
      test: (candidate) => candidate.b === 2,
      // @ts-expect-error invalid on purpose
      reducers: [{ name: "bad", reduce: () => 42 }],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ERR_INVALID_CONFIG");
    expect(result.error?.message).toContain("bad");
  });

  it("receives a read-only context without input data", async () => {
    const captured: Record<string, unknown> = {};
    await shrink({
      input: { a: 1 },
      test: () => true,
      reducers: [
        {
          name: "ctx",
          reduce: (_candidate, context) => {
            captured.evaluations = context.evaluations;
            captured.currentSize = context.currentSize;
            captured.originalSize = context.originalSize;
            captured.pass = context.pass;
            captured.exhausted = context.isExhausted();
            captured.aborted = context.signal.aborted;
            return [];
          },
        },
      ],
    });
    expect(Object.keys(captured).length).toBeGreaterThan(0);
    expect(captured).not.toHaveProperty("candidate");
    expect(typeof captured.currentSize).toBe("number");
  });
});

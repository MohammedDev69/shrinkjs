import { describe, expect, it } from "vitest";
import { compareSimplicity, compactRepresentation, stableKey } from "../../src/index.js";
import { deepClone } from "../../src/utils/clone.js";
import { describeError, ShrinkError } from "../../src/core/errors.js";

describe("compareSimplicity: exotic values", () => {
  it("orders maps and sets by size", () => {
    expect(compareSimplicity(new Map(), new Map([["a", 1]]))).toBeLessThan(0);
    expect(compareSimplicity(new Set([1]), new Set([1, 2]))).toBeLessThan(0);
    expect(compareSimplicity(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(0);
  });

  it("compares map and set contents", () => {
    expect(compareSimplicity(new Map([["a", 1]]), new Map([["a", 2]]))).toBeLessThan(0);
    expect(compareSimplicity(new Set([1]), new Set([5]))).toBeLessThan(0);
  });

  it("compares dates and regular expressions", () => {
    expect(compareSimplicity(new Date(0), new Date(1_000))).toBeLessThan(0);
    expect(compareSimplicity(/a/, /abc/)).toBeLessThan(0);
    expect(compareSimplicity(/abc/, /abc/)).toBe(0);
  });

  it("compares binary values by length then bytes", () => {
    expect(compareSimplicity(new Uint8Array([1]), new Uint8Array([1, 2]))).toBeLessThan(0);
    expect(compareSimplicity(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBeLessThan(0);
    expect(compareSimplicity(new Uint8Array([1]), new Uint8Array([1]))).toBe(0);
    expect(compareSimplicity(new ArrayBuffer(2), new ArrayBuffer(4))).toBeLessThan(0);
  });

  it("compares bigints by magnitude", () => {
    expect(compareSimplicity(1n, 100n)).toBeLessThan(0);
    expect(compareSimplicity(-1n, 1n)).toBeGreaterThan(0);
    expect(compareSimplicity(5n, 5n)).toBe(0);
  });

  it("orders functions and symbols after data", () => {
    expect(compareSimplicity({}, () => 1)).toBeLessThan(0);
    expect(compareSimplicity({}, Symbol("x"))).toBeLessThan(0);
    expect(compareSimplicity(Symbol("a"), Symbol("b"))).toBe(0);
  });

  it("compares deep structures without recursion errors", () => {
    let deepA: Record<string, unknown> = { leaf: 1 };
    let deepB: Record<string, unknown> = { leaf: 2 };
    for (let index = 0; index < 100; index += 1) {
      deepA = { nested: deepA };
      deepB = { nested: deepB };
    }
    expect(() => compareSimplicity(deepA, deepB)).not.toThrow();
  });

  it("treats identical shared references as equivalent", () => {
    const shared = { a: 1 };
    expect(compareSimplicity({ x: shared, y: shared }, { x: shared, y: shared })).toBe(0);
  });

  it("compares arrays against objects by type rank", () => {
    expect(compareSimplicity([], {})).toBeLessThan(0);
    expect(compareSimplicity(new Map(), [])).toBeGreaterThan(0);
  });
});

describe("stableKey: exotic values", () => {
  it("is structural for maps, sets, dates and regexps", () => {
    expect(stableKey(new Map([["a", 1]]))).toBe(stableKey(new Map([["a", 1]])));
    expect(stableKey(new Set([1, 2]))).toBe(stableKey(new Set([2, 1])));
    expect(stableKey(new Date(5))).toBe(stableKey(new Date(5)));
    expect(stableKey(/x/g)).toBe(stableKey(/x/g));
    expect(stableKey(/x/g)).not.toBe(stableKey(/x/i));
  });

  it("distinguishes binary payloads", () => {
    expect(stableKey(Buffer.from("a"))).not.toBe(stableKey(Buffer.from("b")));
    expect(stableKey(new Uint8Array([1, 2]))).toBe(stableKey(new Uint8Array([1, 2])));
    expect(stableKey(new ArrayBuffer(2))).toBe(stableKey(new ArrayBuffer(2)));
    expect(stableKey(new DataView(new ArrayBuffer(2)))).toBe(stableKey(new DataView(new ArrayBuffer(2))));
  });

  it("tags functions and symbols", () => {
    const named = function named(): void {};
    expect(stableKey(named)).toContain("named");
    expect(stableKey(Symbol("s"))).toContain("Symbol");
  });

  it("handles shared references without throwing or recursing forever", () => {
    const shared = { v: 1 };
    const withShared = stableKey({ a: shared, b: shared });
    const cyclic: Record<string, unknown> = { v: 1 };
    cyclic.self = cyclic;
    expect(() => stableKey(cyclic)).not.toThrow();
    expect(withShared).toBe(stableKey({ a: shared, b: shared }));
    // Repeated references are numbered, so a shared graph keeps a distinct key
    // from a duplicated one — cache-safe (never a false hit).
    expect(withShared).not.toBe(stableKey({ a: { v: 1 }, b: { v: 1 } }));
  });
});

describe("compactRepresentation: exotic values", () => {
  it("renders binary views and data views", () => {
    expect(compactRepresentation(new Uint8Array([1, 2]))).toBe("Uint8Array[1,2]");
    expect(compactRepresentation(new ArrayBuffer(4))).toBe("ArrayBuffer<4>");
    expect(compactRepresentation(new DataView(new ArrayBuffer(2)))).toContain("DataView");
  });

  it("renders functions and symbols", () => {
    const named = function named(): void {};
    expect(compactRepresentation(named)).toBe("[Function named]");
    expect(compactRepresentation(Symbol("s"))).toContain("Symbol");
  });
});

describe("deepClone: edge cases", () => {
  it("clones null-prototype objects", () => {
    const source = Object.create(null) as Record<string, unknown>;
    source.a = 1;
    const copy = deepClone(source);
    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(copy.a).toBe(1);
  });

  it("clones DataViews and ArrayBuffers", () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const view = new DataView(buffer, 1, 2);
    const copy = deepClone({ buffer, view });
    expect(copy.buffer.byteLength).toBe(4);
    expect(copy.view.byteLength).toBe(2);
    expect(copy.view).not.toBe(view);
  });

  it("clones nested maps and sets with cycles", () => {
    const map = new Map<string, unknown>();
    map.set("self", map);
    const copy = deepClone(map);
    expect(copy.get("self")).toBe(copy);
  });

  it("returns primitives unchanged", () => {
    expect(deepClone(5)).toBe(5);
    expect(deepClone("x")).toBe("x");
    expect(deepClone(null)).toBeNull();
    expect(deepClone(undefined)).toBeUndefined();
  });

  it("keeps functions by reference", () => {
    const fn = (): number => 1;
    expect(deepClone({ fn }).fn).toBe(fn);
  });
});

describe("describeError", () => {
  it("handles Error instances, strings and arbitrary values", () => {
    expect(describeError(new TypeError("boom"))).toEqual({ message: "boom", name: "TypeError" });
    expect(describeError("plain")).toEqual({ message: "plain" });
    expect(describeError({ code: 7 })).toEqual({ message: '{"code":7}' });
    expect(describeError(undefined as unknown)).toEqual({ message: "undefined" });
    expect(describeError(new ShrinkError("ERR_INVALID_INPUT", "bad")).message).toBe("bad");
  });
});

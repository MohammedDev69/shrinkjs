import { describe, expect, it } from "vitest";
import {
  assertSupportedInput,
  compareSimplicity,
  compactRepresentation,
  deepClone,
  formatPath,
  isSimpler,
  sizeOf,
  stableKey,
  toJsonSafe,
  toJsonString,
} from "../../src/index.js";
import { collectNodes, comparePaths, getAtPath, replaceAtPath } from "../../src/utils/paths.js";
import { formatDuration, formatSize, preview, truncate } from "../../src/utils/format.js";

describe("sizeOf / compactRepresentation", () => {
  it("matches a compact JSON representation for JSON values", () => {
    expect(compactRepresentation({ a: 1 })).toBe('{"a":1}');
    expect(sizeOf({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
    expect(sizeOf([1, 2, 3])).toBe(7);
    expect(sizeOf("hello")).toBe(7);
    expect(sizeOf(null)).toBe(4);
    expect(sizeOf(true)).toBe(4);
  });

  it("documents its treatment of non-JSON values", () => {
    expect(compactRepresentation(undefined)).toBe("undefined");
    expect(sizeOf(undefined)).toBe(9);
    expect(compactRepresentation(Number.NaN)).toBe("NaN");
    expect(compactRepresentation(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(compactRepresentation(-0)).toBe("-0");
    expect(compactRepresentation(10n)).toBe("10n");
    expect(compactRepresentation(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(compactRepresentation(/ab+/gi)).toBe("/ab+/gi");
    expect(compactRepresentation(new Set([1, 2]))).toBe("Set{1,2}");
    expect(compactRepresentation(new Map([["k", 1]]))).toBe('Map{"k"=>1}');
    expect(compactRepresentation(Buffer.from([1, 2]))).toBe("Buffer<2>");
  });

  it("does not recurse forever on cycles", () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    expect(compactRepresentation(value)).toContain("[Circular]");
    expect(Number.isFinite(sizeOf(value))).toBe(true);
  });
});

describe("stableKey", () => {
  it("is order independent for object keys", () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
  });

  it("distinguishes types and special values", () => {
    expect(stableKey(1)).not.toBe(stableKey("1"));
    expect(stableKey(0)).not.toBe(stableKey(-0));
    expect(stableKey(Number.NaN)).toBe(stableKey(Number.NaN));
    expect(stableKey(undefined)).not.toBe(stableKey(null));
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const b: Record<string, unknown> = { x: 1 };
    b.self = b;
    expect(stableKey(a)).toBe(stableKey(b));
  });

  it("distinguishes different class instances", () => {
    class A {
      constructor(public readonly v: number) {}
    }
    class B {
      constructor(public readonly v: number) {}
    }
    expect(stableKey(new A(1))).not.toBe(stableKey(new B(1)));
  });
});

describe("compareSimplicity", () => {
  it("orders by type simplicity", () => {
    expect(compareSimplicity(null, false)).toBeLessThan(0);
    expect(compareSimplicity(false, 0)).toBeLessThan(0);
    expect(compareSimplicity(0, "")).toBeLessThan(0);
    expect(compareSimplicity("", [])).toBeLessThan(0);
    expect(compareSimplicity([], {})).toBeLessThan(0);
  });

  it("orders containers by size then content", () => {
    expect(compareSimplicity([1], [1, 2])).toBeLessThan(0);
    expect(compareSimplicity({}, { a: 1 })).toBeLessThan(0);
    expect(compareSimplicity({ a: 1 }, { b: 1 })).not.toBe(0);
    expect(compareSimplicity([1, 2], [1, 2])).toBe(0);
  });

  it("orders numbers by magnitude and treats non-finite values as complex", () => {
    expect(compareSimplicity(0, 1000)).toBeLessThan(0);
    expect(compareSimplicity(1, -1)).toBeLessThan(0);
    expect(compareSimplicity(0.5, 1)).toBeLessThan(0);
    expect(compareSimplicity(5, Number.POSITIVE_INFINITY)).toBeLessThan(0);
    expect(compareSimplicity(Number.NaN, 5)).toBeGreaterThan(0);
  });

  it("orders strings by length then lexicographically", () => {
    expect(compareSimplicity("ab", "abc")).toBeLessThan(0);
    expect(compareSimplicity("aa", "ab")).toBeLessThan(0);
    expect(compareSimplicity("ab", "ab")).toBe(0);
  });

  it("is safe for cycles", () => {
    const a: Record<string, unknown> = { v: 1 };
    a.self = a;
    const b: Record<string, unknown> = { v: 1 };
    b.self = b;
    expect(() => compareSimplicity(a, b)).not.toThrow();
  });

  it("isSimpler mirrors compareSimplicity", () => {
    expect(isSimpler(0, 5)).toBe(true);
    expect(isSimpler(5, 0)).toBe(false);
    expect(isSimpler(5, 5)).toBe(false);
  });
});

describe("deepClone", () => {
  it("clones nested JSON data", () => {
    const input = { a: [1, { b: 2 }], c: new Date(123), d: /x/g };
    const copy = deepClone(input);
    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    expect(copy.a[1]).not.toBe(input.a[1]);
    expect(copy.c).not.toBe(input.c);
  });

  it("preserves cycles and identity relationships", () => {
    const input: Record<string, unknown> = { name: "x" };
    input.self = input;
    const shared = { shared: true };
    input.left = shared;
    input.right = shared;

    const copy = deepClone(input);
    expect(copy.self).toBe(copy);
    expect(copy.left).toBe(copy.right);
    expect(copy.left).not.toBe(shared);
  });

  it("clones Map, Set, Buffer and typed arrays", () => {
    const map = new Map([["a", { b: 1 }]]);
    const set = new Set([1, 2]);
    const buffer = Buffer.from("hello");
    const typed = new Uint16Array([1, 2, 3]);

    const copy = deepClone({ map, set, buffer, typed });
    expect(copy.map).not.toBe(map);
    expect(copy.map.get("a")).not.toBe(map.get("a"));
    expect([...copy.set]).toEqual([1, 2]);
    expect(Buffer.compare(copy.buffer, buffer)).toBe(0);
    expect(copy.typed).toEqual(typed);
    expect(copy.typed).not.toBe(typed);
  });

  it("preserves prototypes", () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    const copy = deepClone({ point: new Point(1, 2) });
    expect(copy.point).toBeInstanceOf(Point);
    expect(copy.point.x).toBe(1);
  });
});

describe("assertSupportedInput", () => {
  it("accepts JSON values in json mode", () => {
    expect(() =>
      assertSupportedInput({ a: [1, "x", true, null], b: { c: undefined } }, "json"),
    ).not.toThrow();
  });

  it("rejects functions, symbols and BigInt in json mode", () => {
    expect(() => assertSupportedInput(() => 1, "json")).toThrow(/Function/);
    expect(() => assertSupportedInput(Symbol("s"), "json")).toThrow(/Symbol/);
    expect(() => assertSupportedInput({ big: 1n }, "json")).toThrow(/BigInt/);
  });

  it("rejects class instances in json mode but accepts them in js mode", () => {
    class Custom {}
    expect(() => assertSupportedInput(new Custom(), "json")).toThrow(/not JSON-compatible/);
    expect(() => assertSupportedInput(new Custom(), "js")).not.toThrow();
  });
});

describe("paths", () => {
  const input = { users: [{ name: "a" }, { name: "b" }], meta: { x: 1 } };

  it("reads values by path", () => {
    expect(getAtPath(input, [])).toBe(input);
    expect(getAtPath(input, ["users", 1, "name"])).toBe("b");
    expect(getAtPath(input, ["missing"])).toBeUndefined();
  });

  it("replaces values with structural sharing", () => {
    const next = replaceAtPath(input, ["users", 0, "name"], "z");
    expect(getAtPath(next, ["users", 0, "name"])).toBe("z");
    expect(next.meta).toBe(input.meta);
    expect(next.users).not.toBe(input.users);
    expect(next.users[1]).toBe(input.users[1]);
    expect(input.users[0]!.name).toBe("a");
  });

  it("replaces the root when the path is empty", () => {
    expect(replaceAtPath(input, [], "root")).toBe("root");
  });

  it("formats paths readably", () => {
    expect(formatPath([])).toBe("$");
    expect(formatPath(["users", 0, "name"])).toBe("$.users[0].name");
    expect(formatPath(["weird key"])).toBe('$["weird key"]');
  });

  it("collects nodes depth-first with a depth limit", () => {
    const nodes = collectNodes(input, 10);
    expect(nodes[0]!.path).toEqual([]);
    expect(nodes.map((node) => formatPath(node.path))).toEqual([
      "$",
      "$.users",
      "$.users[0]",
      "$.users[0].name",
      "$.users[1]",
      "$.users[1].name",
      "$.meta",
      "$.meta.x",
    ]);

    const shallow = collectNodes(input, 1);
    expect(shallow.map((node) => formatPath(node.path))).toEqual(["$", "$.users", "$.meta"]);
  });

  it("does not loop on cycles", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const nodes = collectNodes(cyclic, 10);
    expect(nodes.length).toBeLessThan(5);
  });

  it("orders paths in pre-order semantics", () => {
    // A path sorts before its descendants...
    expect(comparePaths(["a"], ["a", "b"])).toBeLessThan(0);
    expect(comparePaths(["users"], ["users", 0])).toBeLessThan(0);
    // ...array indices compare numerically...
    expect(comparePaths([2], [10])).toBeLessThan(0);
    // ...and sibling keys compare deterministically.
    expect(comparePaths(["a"], ["b"])).toBeLessThan(0);
    expect(comparePaths(["a", "b"], ["a", "b"])).toBe(0);
  });
});

describe("formatting", () => {
  it("formats sizes and durations", () => {
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1_500)).toBe("1.5 kB");
    expect(formatSize(2_000_000)).toBe("2.00 MB");
    expect(formatDuration(500)).toBe("500 ms");
    expect(formatDuration(1_500)).toBe("1.50 s");
    expect(formatDuration(61_000)).toBe("1m 1s");
  });

  it("truncates and previews values", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 10)).toBe("abc");
    expect(preview({ a: 1 }, 100)).toBe('{"a":1}');
    // Newlines are escaped by the compact representation, so a preview stays
    // on one line.
    expect(preview("line\nbreak", 100)).toBe('"line\\nbreak"');
  });
});

describe("json-safe conversion", () => {
  it("converts special values into JSON-safe data", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    const safe = toJsonSafe({
      big: 10n,
      huge: 2n ** 80n,
      map: new Map([["k", 1]]),
      set: new Set([1]),
      date: new Date(0),
      regexp: /x/g,
      missing: undefined,
      fn: () => 1,
      cyclic,
      nan: Number.NaN,
    }) as Record<string, unknown>;

    expect(safe.big).toBe(10);
    expect(safe.huge).toBe("1208925819614629174706176n");
    expect(safe.map).toEqual({ k: 1 });
    expect(safe.set).toEqual([1]);
    expect(safe.date).toBe("1970-01-01T00:00:00.000Z");
    expect(safe.regexp).toBe("/x/g");
    expect(safe.missing).toBeNull();
    expect(String(safe.fn)).toContain("Function");
    expect((safe.cyclic as Record<string, unknown>).self).toBe("[Circular]");
    expect(safe.nan).toBe("NaN");
  });

  it("always produces valid JSON", () => {
    const text = toJsonString({ a: undefined, b: 1n, c: new Set([1]) });
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

/**
 * Regression tests for issues found during the pre-release audit.
 *
 * Each test names the defect it locks down. They are intentionally adversarial:
 * they describe the *honest* behaviour the library promises, not the behaviour
 * that happened to be implemented first.
 */
import { describe, expect, it } from "vitest";
import { compareSimplicity, shrink, sizeOf } from "../../src/index.js";

describe("shared references (not cycles) must be accepted and fully reduced", () => {
  it("accepts an acyclic graph with shared sub-objects in json mode", async () => {
    const shared = { kind: "target", noise: "x" };
    const input = { left: shared, right: shared };

    // This is valid JSON: JSON.stringify produces a duplicated subtree.
    expect(() => JSON.stringify(input)).not.toThrow();

    const result = await shrink({
      input,
      test: (candidate) => candidate.left.kind === "target" && candidate.right.kind === "target",
    });

    expect(result.ok).toBe(true);
    expect(result.minimalInput).toEqual({ left: { kind: "target" }, right: { kind: "target" } });
  });

  it("still rejects a real cycle in json mode", async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    await expect(shrink({ input: cyclic, test: () => true })).rejects.toMatchObject({
      code: "ERR_UNSUPPORTED_INPUT",
    });
  });

  it("reduces every path of a shared graph, not only the first", async () => {
    // The predicate pins `a.nested.b`, so only the *second* path can lose it.
    // With path-deduplicated traversal the second path was never visited, and
    // the run still claimed `minimality: "local"`.
    const shared = { kind: "x", nested: { b: 2 } };
    const result = await shrink({
      input: { a: shared, b: shared },
      mode: "js",
      test: (candidate) =>
        candidate.a.kind === "x" &&
        candidate.a.nested.b === 2 &&
        candidate.b.kind === "x" &&
        candidate.b.nested !== undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.minimalInput.a).toEqual({ kind: "x", nested: { b: 2 } });
    // `nested` must stay present, but nothing inside it is required.
    expect(result.minimalInput.b).toEqual({ kind: "x", nested: null });
    expect(result.minimality).toBe("local");
  });

  it("terminates on cyclic js-mode input instead of hanging", async () => {
    const cyclic: Record<string, unknown> = { keep: true, noise: "x" };
    cyclic.self = cyclic;
    const result = await shrink({
      input: cyclic,
      mode: "js",
      test: (candidate) => (candidate as Record<string, unknown>).keep === true,
      limits: { maxNodeVisits: 10_000 },
    });
    expect(result.ok).toBe(true);
  });
});

describe("node-visit budget", () => {
  it("reports limit-reached instead of claiming local minimality", async () => {
    const input = Array.from({ length: 20 }, (_, index) => ({ index, label: `row-${index}` }));
    const json = JSON.stringify(input);

    // Only the exact original satisfies the predicate, so no reduction is ever
    // accepted and the caps are what stop the run.
    const result = await shrink({
      input,
      test: (candidate) => JSON.stringify(candidate) === json,
      limits: { maxNodeVisits: 4, maxEvaluations: 2_000 },
    });

    expect(result.stats.limitReached).toBe("max-nodes");
    expect(result.status).toBe("limit-reached");
    expect(result.minimality).toBe("unknown");
    expect(result.ok).toBe(true);
  });
});

describe("custom reducers", () => {
  it("completes long reducer chains instead of silently stopping", async () => {
    const result = await shrink({
      input: new Map([["n", 2_000]]),
      mode: "js",
      test: (candidate) =>
        candidate instanceof Map &&
        typeof candidate.get("n") === "number" &&
        (candidate.get("n") as number) >= 0,
      reducers: [
        {
          name: "countdown",
          reduce: (candidate) => {
            const n = candidate.get("n") ?? 0;
            return n > 0 ? [new Map([["n", n - 1]])] : [];
          },
        },
      ],
      limits: { maxEvaluations: 5_000 },
    });

    // Before the fix the run stopped at n = 1200 and still said "local".
    expect(result.minimalInput.get("n")).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.minimality).toBe("local");
  });
});

describe("configuration reporting", () => {
  it("does not label the default preset as custom when limits is empty", async () => {
    const result = await shrink({ input: { a: 1 }, test: () => true, limits: {} });
    expect(result.config.preset).toBe("balanced");
  });

  it("labels a run with real limit overrides as custom", async () => {
    const result = await shrink({ input: { a: 1 }, test: () => true, limits: { maxEvaluations: 10 } });
    expect(result.config.preset).toBe("custom");
  });
});

describe("simplicity ordering", () => {
  it("compares ArrayBuffer contents, not only their length", () => {
    const first = new ArrayBuffer(4);
    new Uint8Array(first).set([1, 2, 3, 4]);
    const second = new ArrayBuffer(4);
    new Uint8Array(second).set([9, 9, 9, 9]);
    expect(compareSimplicity(first, second)).not.toBe(0);
    expect(compareSimplicity(first, first.slice(0))).toBe(0);
  });
});

describe("honest size reporting", () => {
  it("reports a negative reduction when a structural simplification grows the input", async () => {
    const result = await shrink({
      input: { a: {} },
      test: (candidate) => candidate.a !== undefined,
    });

    // `{}` (2 chars) is replaced by `null` (4 chars) because `null` is the
    // simpler value. The numbers must show the growth instead of clamping to 0.
    expect(result.minimalInput).toEqual({ a: null });
    expect(result.stats.finalSize).toBeGreaterThan(result.stats.originalSize);
    expect(result.stats.savedChars).toBe(result.stats.originalSize - result.stats.finalSize);
    expect(result.stats.savedChars).toBeLessThan(0);
    expect(result.stats.reductionPercent).toBeLessThan(0);
    expect(result.warnings.some((warning) => warning.includes("larger than the original"))).toBe(true);
  });
});

describe("predicate hazards", () => {
  it("never lets a mutating predicate touch the caller's input", async () => {
    const input = { a: 1, b: 2 };
    const snapshot = structuredClone(input);

    await shrink({
      input,
      test: (candidate) => {
        (candidate as Record<string, unknown>).injected = true;
        return true;
      },
      limits: { maxEvaluations: 50 },
    });

    // The engine clones on entry, so the caller's object is untouched even when
    // the predicate mutates every candidate it receives.
    expect(input).toEqual(snapshot);
  });

  it("rejects a candidate that stops reporting the original signature", async () => {
    const result = await shrink({
      input: { b: 2, a: 1 },
      test: (candidate) => {
        const record = candidate as Record<string, unknown>;
        if (record.a === 1) return { preserve: true, signature: "A" };
        // A *different* failure that reports no signature at all.
        if (record.b === 2 && record.a === undefined) return true;
        return false;
      },
    });

    expect(result.minimalInput).toEqual({ a: 1 });
    expect(result.signature).toBe("A");
    expect(result.stats.signatureMismatches).toBeGreaterThan(0);
  });

  it("keeps the best verified input when the predicate starts throwing mid-run", async () => {
    let calls = 0;
    const result = await shrink({
      input: { keep: 1, drop: 2 },
      test: (candidate) => {
        calls += 1;
        if (calls > 4) throw new Error("predicate died");
        return (candidate as { keep?: number }).keep === 1;
      },
      predicateErrors: "fail",
      limits: { maxEvaluations: 100 },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ERR_PREDICATE_FAILED");
    // Whatever was already accepted still reproduces the condition.
    expect((result.minimalInput as { keep?: number }).keep).toBe(1);
  });
});

describe("input validation order", () => {
  it("rejects an oversized input before walking it", async () => {
    const huge = { text: "x".repeat(5_000) };
    await expect(
      shrink({ input: huge, test: () => true, limits: { maxInputSize: 100 } }),
    ).rejects.toMatchObject({ code: "ERR_INPUT_TOO_LARGE" });
  });

  it("rejects unsupported values with a path", async () => {
    await expect(
      shrink({ input: { nested: [{ when: new Date() }] }, test: () => true }),
    ).rejects.toMatchObject({ code: "ERR_UNSUPPORTED_INPUT" });
  });
});

describe("depth guard", () => {
  const nest = (depth: number): unknown => {
    let value: unknown = { leaf: true };
    for (let index = 0; index < depth; index += 1) value = { child: value };
    return value;
  };
  const depthOf = (candidate: unknown): number => {
    let node = candidate as { child?: unknown } | undefined;
    let depth = 0;
    while (node && typeof node === "object" && "child" in node) {
      node = node.child as { child?: unknown };
      depth += 1;
    }
    return depth;
  };

  it("rejects inputs deeper than maxInputDepth with a typed error", async () => {
    // Before the guard this surfaced as `RangeError: Maximum call stack size
    // exceeded` from deepClone, outside the documented error model.
    await expect(
      shrink({ input: nest(2_000), test: () => true, limits: { maxEvaluations: 10 } }),
    ).rejects.toMatchObject({ code: "ERR_UNSUPPORTED_INPUT" });
  });

  it("accepts deep-but-legal inputs below the limit", async () => {
    const result = await shrink({
      input: nest(200),
      test: (candidate) => depthOf(candidate) >= 200,
      limits: { maxEvaluations: 40 },
    });
    expect(result.ok).toBe(true);
    expect(depthOf(result.minimalInput)).toBe(200);
  });

  it("honours a raised maxInputDepth", async () => {
    const result = await shrink({
      input: nest(1_500),
      test: (candidate) => depthOf(candidate) >= 1_500,
      limits: { maxEvaluations: 10, maxInputDepth: 2_000 },
    });
    expect(result.status).toBe("limit-reached");
  });
});

describe("statistics identity", () => {
  it("keeps attempts === accepted + rejected for every strategy", async () => {
    const result = await shrink({
      input: { a: [1, 2, 3], b: { c: "text", d: 4 } },
      test: (candidate) => Array.isArray(candidate.a) && candidate.a.length >= 1,
      limits: { maxEvaluations: 300 },
    });

    for (const [name, stat] of Object.entries(result.stats.strategies)) {
      expect(stat.attempts, `strategy ${name}`).toBe(stat.accepted + stat.rejected);
    }
    const totals = Object.values(result.stats.strategies).reduce(
      (accumulator, stat) => ({
        attempts: accumulator.attempts + stat.attempts,
        accepted: accumulator.accepted + stat.accepted,
        rejected: accumulator.rejected + stat.rejected,
      }),
      { attempts: 0, accepted: 0, rejected: 0 },
    );
    expect(totals.attempts).toBe(totals.accepted + totals.rejected);
    expect(totals.accepted).toBe(result.stats.successfulReductions);
    expect(totals.rejected).toBe(result.stats.rejectedCandidates);
  });

  it("reports sizes that match the returned values", async () => {
    const result = await shrink({
      input: { a: [1, 2, 3], b: "noise", c: { d: true } },
      test: (candidate) => candidate.a.length === 3,
    });
    expect(result.stats.originalSize).toBe(sizeOf(result.originalInput));
    expect(result.stats.finalSize).toBe(sizeOf(result.minimalInput));
  });
});

describe("engine invariants on generated inputs", () => {
  it("never returns a result that fails its own predicate and never grows", async () => {
    // Deterministic pseudo-random inputs: the assertion is what matters.
    let state = 12345;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const makeValue = (depth: number): unknown => {
      const pick = random();
      if (depth <= 0 || pick < 0.3) {
        return pick < 0.15 ? Math.floor(random() * 1000) : `s${Math.floor(random() * 100)}`;
      }
      if (pick < 0.65) {
        return Array.from({ length: 1 + Math.floor(random() * 4) }, () => makeValue(depth - 1));
      }
      const out: Record<string, unknown> = {};
      const keys = 1 + Math.floor(random() * 4);
      for (let index = 0; index < keys; index += 1) out[`k${index}`] = makeValue(depth - 1);
      return out;
    };

    for (let round = 0; round < 40; round += 1) {
      const input = makeValue(4);
      const marker = `s${Math.floor(random() * 100)}`;
      const predicate = (candidate: unknown): boolean => JSON.stringify(candidate)?.includes(marker) ?? false;

      const result = await shrink({
        input,
        test: predicate,
        limits: { maxEvaluations: 400, maxDuration: 10_000 },
      });

      if (!result.ok) {
        // The marker may genuinely be absent: then the run must fail cleanly.
        expect(predicate(input)).toBe(false);
        continue;
      }
      expect(predicate(result.minimalInput)).toBe(true);
      expect(sizeOf(result.minimalInput)).toBeLessThanOrEqual(sizeOf(result.originalInput));
      expect(result.stats.finalSize).toBe(sizeOf(result.minimalInput));

      const again = await shrink({
        input,
        test: predicate,
        limits: { maxEvaluations: 400, maxDuration: 10_000 },
      });
      expect(again.minimalInput).toEqual(result.minimalInput);
      expect(again.stats.evaluations).toBe(result.stats.evaluations);
    }
  });
});

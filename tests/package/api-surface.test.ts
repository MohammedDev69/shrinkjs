import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as api from "../../src/index.js";
import { shrink } from "../../src/index.js";

describe("public API surface", () => {
  it("exports the documented runtime functions", () => {
    expect(typeof api.shrink).toBe("function");
    expect(typeof api.minimize).toBe("function");
    expect(typeof api.deltaDebug).toBe("function");
    expect(typeof api.minimizeSequence).toBe("function");
    expect(typeof api.sizeOf).toBe("function");
    expect(typeof api.deepClone).toBe("function");
    expect(typeof api.compareSimplicity).toBe("function");
    expect(typeof api.diffValues).toBe("function");
    expect(typeof api.createJsonReport).toBe("function");
    expect(typeof api.createMarkdownReport).toBe("function");
    expect(typeof api.writeArtifacts).toBe("function");
    expect(typeof api.createRegressionTest).toBe("function");
    expect(typeof api.createReproductionScript).toBe("function");
    expect(typeof api.formatPath).toBe("function");
    expect(typeof api.resolveLimits).toBe("function");
  });

  it("exports the error classes with stable codes", () => {
    expect(api.ShrinkInputError.prototype).toBeInstanceOf(api.ShrinkError);
    expect(new api.ShrinkConfigError("x").code).toBe("ERR_INVALID_CONFIG");
    expect(new api.ShrinkTimeoutError(10).code).toBe("ERR_PREDICATE_TIMEOUT");
    expect(new api.ShrinkUnsupportedInputError("x").code).toBe("ERR_UNSUPPORTED_INPUT");
  });

  it("exposes presets that are internally consistent", () => {
    expect(api.resolveLimits("fast", undefined).maxEvaluations).toBeLessThan(
      api.resolveLimits("thorough", undefined).maxEvaluations,
    );
    expect(api.builtinStrategyNames).toContain("array");
    expect(api.builtinStrategyNames).toContain("string");
  });

  it("exposes the library version", () => {
    expect(api.VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("preserves the input type through generics", async () => {
    interface Payload {
      id: number;
      tags: string[];
    }
    const input: Payload = { id: 1, tags: ["a"] };
    const result = await shrink({ input, test: () => true });

    expectTypeOf(result).toEqualTypeOf<api.ShrinkResult<Payload>>();
    expectTypeOf(result.minimalInput).toEqualTypeOf<Payload>();
    expectTypeOf(result.stats.evaluations).toEqualTypeOf<number>();
  });

  it("types custom reducers against the input", () => {
    const reducer: api.CustomReducer<{ a: number }> = {
      name: "noop",
      reduce: (candidate) => [candidate],
    };
    expectTypeOf(reducer.reduce).toBeFunction();
  });

  it("has a package.json that matches the runtime identity", async () => {
    const pkg = JSON.parse(await readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      name: string;
      type: string;
      license: string;
      version: string;
      exports: Record<string, unknown>;
      bin: Record<string, string>;
      engines: { node: string };
      files: string[];
      sideEffects: boolean;
    };

    expect(pkg.name).toBe("@shrinkjs/core");
    expect(pkg.type).toBe("module");
    expect(pkg.license).toBe("MIT");
    expect(pkg.version).toBe(api.VERSION);
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.exports["."]).toBeDefined();
    expect(pkg.exports["./vitest"]).toBeDefined();
    expect(pkg.exports["./jest"]).toBeDefined();
    expect(pkg.bin.shrinkjs).toBe("./dist/cli/index.js");
    expect(pkg.files).toContain("dist");
    expect(pkg.engines.node).toMatch(/>=\d+/);
  });
});

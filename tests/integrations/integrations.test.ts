import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { minimizeTestCase as vitestMinimize } from "../../src/integrations/vitest/index.js";
import { minimizeTestCase as jestMinimize } from "../../src/integrations/jest/index.js";
import { createRegressionTest } from "../../src/index.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "shrinkjs-integration-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workdir, { recursive: true, force: true });
});

const input = { a: 1, b: "noise", c: [1, 2, 3] };

describe("vitest adapter", () => {
  it("minimizes and writes artifacts", async () => {
    const result = await vitestMinimize({
      input,
      test: (candidate) => candidate.a === 1,
      name: "unit-case",
      artifactsDir: path.join(workdir, "artifacts"),
    });

    expect(result.ok).toBe(true);
    expect(result.minimalInput).toEqual({ a: 1 });
    expect(result.artifacts?.files.length).toBeGreaterThan(0);

    const report = JSON.parse(await readFile(path.join(workdir, "artifacts", "result.json"), "utf8")) as {
      status: string;
    };
    expect(report.status).toBe("completed");
  });

  it("supports async predicates", async () => {
    const result = await vitestMinimize({
      input,
      test: async (candidate) => {
        await Promise.resolve();
        return candidate.c.length === 3;
      },
      writeArtifacts: false,
      log: false,
    });
    expect(result.minimalInput).toEqual({ c: [null, null, null] });
  });

  it("throws when the target behavior cannot be established", async () => {
    await expect(
      vitestMinimize({
        input,
        test: () => false,
        writeArtifacts: false,
        log: false,
      }),
    ).rejects.toThrow(/could not establish the target behavior/);
  });

  it("can be configured not to throw", async () => {
    const result = await vitestMinimize({
      input,
      test: () => false,
      writeArtifacts: false,
      log: false,
      throwOnFailure: false,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("attaches the result to the thrown error", async () => {
    const error = (await vitestMinimize({
      input,
      test: () => false,
      writeArtifacts: false,
      log: false,
    }).catch((caught: unknown) => caught)) as Error & { shrinkResult?: { status: string } };

    expect(error.shrinkResult).toBeDefined();
    expect(error.shrinkResult?.status).toBe("failed");
  });

  it("generates a regression test referencing the predicate module", async () => {
    const predicatePath = path.join(workdir, "predicate.mjs");
    await writeFile(predicatePath, "export default () => true;\n", "utf8");

    const result = await vitestMinimize({
      input,
      test: () => true,
      testModule: predicatePath,
      artifactsDir: path.join(workdir, "with-predicate"),
      name: "case",
    });

    const regression = await readFile(path.join(workdir, "with-predicate", "regression.test.ts"), "utf8");
    expect(regression).toContain("vitest");
    expect(regression).toContain("predicate.mjs");
    expect(createRegressionTest(result, { testModule: predicatePath })).toContain("describe(");
  });
});

describe("jest adapter", () => {
  it("exposes the same API surface", () => {
    expect(typeof jestMinimize).toBe("function");
    expect(jestMinimize).not.toBe(vitestMinimize);
  });

  it("works the same way", async () => {
    const result = await jestMinimize({
      input,
      test: (candidate) => candidate.b === "noise",
      writeArtifacts: false,
      log: false,
    });
    expect(result.minimalInput).toEqual({ b: "noise" });
  });
});

describe("core independence", () => {
  it("does not import vitest or jest from the core entry point", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/index.ts"), "utf8");
    expect(source).not.toContain("vitest");
    expect(source).not.toContain("jest");

    const pkg = JSON.parse(await readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

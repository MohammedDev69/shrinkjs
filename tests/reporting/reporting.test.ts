import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJsonReport,
  createMarkdownReport,
  diffValues,
  formatDiff,
  serializeJsonReport,
  shrink,
  type ShrinkResult,
} from "../../src/index.js";
import {
  createRegressionTest,
  createReproductionScript,
  writeArtifacts,
} from "../../src/reporting/artifacts.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "shrinkjs-report-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const input = {
  user: { id: 7, name: "Ada", role: "admin", tags: ["a", "b"] },
  items: [
    { sku: "A", price: 10 },
    { sku: "B", price: -5 },
  ],
  meta: { source: "web", secret: "s3cr3t" },
};

async function minimized(): Promise<ShrinkResult<typeof input>> {
  return shrink({
    input,
    test: (candidate) =>
      Array.isArray(candidate.items) &&
      candidate.items.some((item) => item.price < 0) &&
      candidate.meta?.secret === "s3cr3t",
    history: { enabled: true, maxEntries: 50 },
    limits: { maxEvaluations: 500 },
  });
}

describe("diffValues", () => {
  it("detects removed, added and changed values structurally", () => {
    const entries = diffValues({ a: 1, b: { c: 2 }, list: [1, 2, 3] }, { a: 2, list: [1, 3] });
    const kinds = entries.map((entry) => `${entry.kind}:${entry.path}`).sort();
    expect(kinds).toContain("changed:$.a");
    expect(kinds).toContain("removed:$.b");
    expect(kinds).toContain("removed:$.list[1]");
  });

  it("is order independent for object keys", () => {
    expect(diffValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it("reports no differences for identical values", () => {
    expect(diffValues({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(formatDiff([])).toBe("(no structural difference)");
  });

  it("caps the number of entries and formats them", () => {
    const before = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, index]));
    const entries = diffValues(before, {}, { maxEntries: 10 });
    expect(entries.length).toBe(10);
    expect(formatDiff(entries).split("\n").length).toBe(10);
    expect(formatDiff(entries)).toContain("- $.k");
  });

  it("collapses a removed array slice into one entry", () => {
    const entries = diffValues(
      { items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] },
      { items: [{ id: 1 }] },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("$.items[1..3]");
    expect(entries[0]!.kind).toBe("removed");
    expect(entries[0]!.beforePreview).toBe("3 item(s) removed");
  });

  it("handles type changes", () => {
    const entries = diffValues({ a: { b: 1 } }, { a: "text" });
    expect(entries).toEqual([
      {
        path: "$.a",
        kind: "changed",
        before: { b: 1 },
        after: "text",
        beforePreview: '{"b":1}',
        afterPreview: '"text"',
      },
    ]);
  });
});

describe("createJsonReport", () => {
  it("produces a complete, serializable report without the original input", async () => {
    const result = await minimized();
    const report = createJsonReport(result, { inputSource: "fixtures/order.json" });

    expect(report.tool.name).toBe("@shrinkjs/core");
    expect(report.tool.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.inputSource).toBe("fixtures/order.json");
    expect(report.status).toBe("completed");
    expect(report.stats.evaluations).toBeGreaterThan(0);
    expect(report.minimalInput).toEqual(result.minimalInput);
    expect(report).not.toHaveProperty("originalInput");
    expect(() => JSON.parse(serializeJsonReport(report))).not.toThrow();
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.diff.length).toBeGreaterThan(0);
    expect(report.history?.length).toBeGreaterThan(0);
  });

  it("redacts sensitive property values on request", async () => {
    const result = await minimized();
    const report = createJsonReport(result, { redact: { keys: ["secret", "name"] } });
    const minimal = report.minimalInput as Record<string, unknown>;
    const meta = minimal.meta as Record<string, unknown>;
    expect(meta.secret).toBe("[REDACTED]");
    expect(JSON.stringify(report)).not.toContain("s3cr3t");
  });

  it("supports a custom redaction placeholder", async () => {
    const result = await minimized();
    const report = createJsonReport(result, { redact: { keys: ["secret"], replacement: "<hidden>" } });
    expect((report.minimalInput as { meta: { secret: string } }).meta.secret).toBe("<hidden>");
  });

  it("can skip the diff", async () => {
    const result = await minimized();
    const report = createJsonReport(result, { includeDiff: false });
    expect(report.diff).toEqual([]);
  });
});

describe("createMarkdownReport", () => {
  it("documents summary, reproduction, diff, config and limitations", async () => {
    const result = await minimized();
    const markdown = createMarkdownReport(result, { inputSource: "fixtures/order.json" });

    expect(markdown).toContain("# ShrinkJS Reduction Report");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("## Minimal reproduction");
    expect(markdown).toContain("## Structural diff");
    expect(markdown).toContain("## Statistics");
    expect(markdown).toContain("## Configuration");
    expect(markdown).toContain("## Limitations");
    expect(markdown).toContain("locally minimal");
    expect(markdown).toMatch(/Reduction \| \d+\.\d%/);
  });

  it("describes failures honestly", async () => {
    const result = await shrink({ input: { a: 1 }, test: () => false });
    const markdown = createMarkdownReport(result);
    expect(markdown).toContain("Failed");
    expect(markdown).toContain("ERR_PREDICATE_NOT_PRESERVED");
    expect(markdown).toContain("not proven minimal");
  });

  it("redacts property values in the rendered reproduction", async () => {
    const result = await minimized();
    const markdown = createMarkdownReport(result, { redact: { keys: ["secret"] } });
    expect(markdown).not.toContain("s3cr3t");
    expect(markdown).toContain("[REDACTED]");
  });

  it("includes history rows when history is enabled", async () => {
    const result = await minimized();
    const markdown = createMarkdownReport(result, { maxHistoryEntries: 100 });
    expect(markdown).toContain("## History");
    expect(markdown).toContain("| accepted |");
  });
});

describe("artifacts", () => {
  it("writes a complete artifact directory", async () => {
    const predicatePath = path.join(workdir, "predicate.mjs");
    await writeFile(
      predicatePath,
      `export default function test(input) {
  return Array.isArray(input.items) && input.items.some((item) => item.price < 0);
}
`,
      "utf8",
    );

    const result = await minimized();
    const written = await writeArtifacts(result, {
      outputDir: path.join(workdir, "out"),
      testModule: predicatePath,
      inputSource: "fixtures/order.json",
      name: "checkout",
    });

    expect(written.files.map((file) => path.basename(file)).sort()).toEqual([
      "minimized-input.json",
      "regression.test.ts",
      "report.md",
      "reproduction.mjs",
      "result.json",
    ]);
    expect(written.skipped).toEqual([]);
    expect(written.notGenerated).toEqual([]);

    const report = JSON.parse(await readFile(path.join(written.outputDir, "result.json"), "utf8")) as {
      status: string;
      minimalInput: unknown;
    };
    expect(report.status).toBe("completed");
    expect(report.minimalInput).toEqual(result.minimalInput);

    const minimizedFile = JSON.parse(
      await readFile(path.join(written.outputDir, "minimized-input.json"), "utf8"),
    ) as unknown;
    expect(minimizedFile).toEqual(result.minimalInput);

    const regression = await readFile(path.join(written.outputDir, "regression.test.ts"), "utf8");
    expect(regression).toContain('from "vitest"');
    expect(regression).toContain("predicate");
    expect(regression).toContain("minimized-input.json");

    const markdown = await readFile(path.join(written.outputDir, "report.md"), "utf8");
    expect(markdown).toContain("# ShrinkJS Reduction Report");
  });

  it("generates a reproduction script that actually runs", async () => {
    const predicatePath = path.join(workdir, "predicate.mjs");
    await writeFile(
      predicatePath,
      `export default async function test(input) {
  if (Array.isArray(input.items) && input.items.some((item) => item.price < 0)) {
    return { preserve: true, signature: "INVALID_PRICE" };
  }
  return false;
}
`,
      "utf8",
    );

    const result = await minimized();
    const written = await writeArtifacts(result, {
      outputDir: path.join(workdir, "run"),
      testModule: predicatePath,
    });

    const output = execFileSync(process.execPath, [path.join(written.outputDir, "reproduction.mjs")], {
      encoding: "utf8",
    });
    expect(output).toContain("still reproduces");
    expect(output).toContain("INVALID_PRICE");
  });

  it("does not overwrite existing files unless asked", async () => {
    const result = await minimized();
    const outputDir = path.join(workdir, "twice");
    const first = await writeArtifacts(result, { outputDir, artifacts: ["input"] });
    expect(first.files.length).toBe(1);

    const second = await writeArtifacts(result, { outputDir, artifacts: ["input"] });
    expect(second.files).toEqual([]);
    expect(second.skipped.length).toBe(1);

    const third = await writeArtifacts(result, { outputDir, artifacts: ["input"], overwrite: true });
    expect(third.files.length).toBe(1);
  });

  it("skips the regression test when no test module is provided", async () => {
    const result = await minimized();
    const written = await writeArtifacts(result, {
      outputDir: path.join(workdir, "nopredicate"),
      artifacts: ["result", "input", "reproduction", "regression", "markdown"],
    });
    expect(written.notGenerated.some((file) => file.endsWith("regression.test.ts"))).toBe(true);
  });

  it("produces the same content from the standalone generators", async () => {
    const result = await minimized();
    const options = { testModule: path.join(workdir, "predicate.mjs"), outputDir: workdir };
    const script = createReproductionScript(result, options);
    const test = createRegressionTest(result, { ...options, name: "case" });
    expect(script).toContain("#!/usr/bin/env node");
    expect(test).toContain("ShrinkJS regression: case");
  });

  it.skipIf(process.platform !== "win32")(
    "falls back to an absolute path when artifacts and predicate live on different drives",
    async () => {
      // The OS temp dir is on C:, the repository is on E: (or vice versa) — there
      // is no relative path between them.
      const outputDir = path.resolve(process.cwd(), ".tmp", "audit-cross-drive");
      const predicatePath = path.join(workdir, "cross-drive-predicate.mjs");
      await writeFile(
        predicatePath,
        `export default (input) => Array.isArray(input.items) && input.items.some((item) => item.price < 0);\n`,
        "utf8",
      );

      try {
        const result = await minimized();
        const written = await writeArtifacts(result, {
          outputDir,
          testModule: predicatePath,
          overwrite: true,
        });

        const script = await readFile(path.join(written.outputDir, "reproduction.mjs"), "utf8");
        expect(script).not.toContain("join(here, " + JSON.stringify("../"));

        const output = execFileSync(process.execPath, [path.join(written.outputDir, "reproduction.mjs")], {
          encoding: "utf8",
        });
        expect(output).toContain("still reproduces");
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
  );
});

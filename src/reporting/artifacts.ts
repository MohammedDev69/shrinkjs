import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ShrinkResult } from "../core/types.js";
import { ShrinkConfigError } from "../core/errors.js";
import { toJsonString } from "../utils/json-safe.js";
import { VERSION } from "../version.js";
import { createJsonReport, serializeJsonReport } from "./json.js";
import { createMarkdownReport } from "./markdown.js";
import type { RedactOptions } from "./redact.js";

export type ArtifactKind = "result" | "markdown" | "input" | "reproduction" | "regression";

const ALL_ARTIFACTS: readonly ArtifactKind[] = ["result", "markdown", "input", "reproduction", "regression"];

export interface ArtifactOptions {
  /** Directory to write into. Created when missing. */
  outputDir: string;
  /** Where the input came from; recorded in reports. */
  inputSource?: string;
  /** Path to the predicate module (used by generated reproduction/regression files). */
  testModule?: string;
  /** Export name of the predicate. Default: `"default"`. */
  testExport?: string;
  /** Overwrite existing files. Default: `false` (existing files are reported as skipped). */
  overwrite?: boolean;
  /** Human-readable case name used in generated test titles. */
  name?: string;
  /** Restrict which artifacts are written. Default: all. */
  artifacts?: ArtifactKind[];
  redact?: RedactOptions;
  /** Include the (already bounded) history in `result.json`. Default: follows the result. */
  includeHistory?: boolean;
}

export interface ArtifactResult {
  outputDir: string;
  /** Absolute paths of files written. */
  files: string[];
  /** Absolute paths of files that already existed and were not overwritten. */
  skipped: string[];
  /** Absolute paths of artifacts that were not generated (e.g. no `testModule`). */
  notGenerated: string[];
}

const FILE_NAMES: Record<ArtifactKind, string> = {
  result: "result.json",
  markdown: "report.md",
  input: "minimized-input.json",
  reproduction: "reproduction.mjs",
  regression: "regression.test.ts",
};

/**
 * Writes a self-contained artifact directory:
 *
 * ```text
 * shrinkjs-output/
 *   result.json
 *   minimized-input.json
 *   reproduction.mjs
 *   regression.test.ts
 *   report.md
 * ```
 *
 * Nothing is overwritten unless `overwrite: true`; existing files are listed in
 * `skipped` so a caller can decide what to do.
 */
export async function writeArtifacts<T>(
  result: ShrinkResult<T>,
  options: ArtifactOptions,
): Promise<ArtifactResult> {
  if (!options.outputDir || typeof options.outputDir !== "string") {
    throw new ShrinkConfigError("writeArtifacts requires options.outputDir");
  }

  const kinds = options.artifacts ?? ALL_ARTIFACTS;
  const outputDir = path.resolve(options.outputDir);
  const created: string[] = [];
  const skipped: string[] = [];
  const notGenerated: string[] = [];

  const write = async (kind: ArtifactKind, contents: string): Promise<void> => {
    const file = path.join(outputDir, FILE_NAMES[kind]);
    if (!file.startsWith(outputDir + path.sep)) {
      throw new ShrinkConfigError(`Refusing to write outside the output directory: ${file}`);
    }
    if (!options.overwrite && existsSync(file)) {
      skipped.push(file);
      return;
    }
    await mkdir(outputDir, { recursive: true });
    await writeFile(file, contents, "utf8");
    created.push(file);
  };

  if (kinds.includes("result")) {
    const report = createJsonReport(result, {
      ...(options.inputSource === undefined ? {} : { inputSource: options.inputSource }),
      ...(options.redact === undefined ? {} : { redact: options.redact }),
    });
    if (options.includeHistory === false && report.history) delete report.history;
    await write("result", serializeJsonReport(report));
  }

  if (kinds.includes("input")) {
    await write("input", `${toJsonString(result.minimalInput, 2)}\n`);
  }

  if (kinds.includes("markdown")) {
    await write(
      "markdown",
      `${createMarkdownReport(result, {
        ...(options.inputSource === undefined ? {} : { inputSource: options.inputSource }),
        ...(options.redact === undefined ? {} : { redact: options.redact }),
      })}\n`,
    );
  }

  if (kinds.includes("reproduction")) {
    await write(
      "reproduction",
      createReproductionScript(result, {
        ...(options.testModule === undefined ? {} : { testModule: options.testModule }),
        ...(options.testExport === undefined ? {} : { testExport: options.testExport }),
        outputDir,
      }),
    );
  }

  if (kinds.includes("regression")) {
    if (!options.testModule) {
      notGenerated.push(path.join(outputDir, FILE_NAMES.regression));
    } else {
      await write(
        "regression",
        createRegressionTest(result, {
          testModule: options.testModule,
          ...(options.testExport === undefined ? {} : { testExport: options.testExport }),
          outputDir,
          ...(options.name === undefined ? {} : { name: options.name }),
        }),
      );
    }
  }

  return { outputDir, files: created, skipped, notGenerated };
}

export interface GeneratedFileOptions {
  testModule?: string;
  testExport?: string;
  outputDir?: string;
  name?: string;
}

/** Path of `testModule` relative to the artifact directory, as an import specifier. */
function relativeSpecifier(testModule: string, outputDir: string | undefined): string {
  const base = outputDir ?? process.cwd();
  const target = path.resolve(testModule);
  let relative = path.relative(base, target).split(path.sep).join("/");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

/**
 * A standalone Node script that re-runs the user's predicate against the
 * minimized input.
 */
export function createReproductionScript<T>(
  result: ShrinkResult<T>,
  options: GeneratedFileOptions = {},
): string {
  void result;
  const specifier = options.testModule
    ? relativeSpecifier(options.testModule, options.outputDir)
    : "./predicate.mjs";
  const exportName = options.testExport ?? "default";

  return `#!/usr/bin/env node
// Generated by @shrinkjs/core v${VERSION}
// Re-runs the predicate against the minimized input found by ShrinkJS.
//
// Usage: node reproduction.mjs
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inputPath = join(here, "minimized-input.json");
const predicatePath = join(here, ${JSON.stringify(specifier)});

const input = JSON.parse(await readFile(inputPath, "utf8"));
const module_ = await import(pathToFileURL(predicatePath).href);
const predicate = ${exportName === "default" ? "module_.default ?? module_.test" : `module_[${JSON.stringify(exportName)}]`};

if (typeof predicate !== "function") {
  console.error("No predicate function found in " + predicatePath);
  console.error("Export it as default or as a named \\"test\\" export.");
  process.exit(2);
}

const outcome = await predicate(input);
const preserved = typeof outcome === "boolean" ? outcome : Boolean(outcome && outcome.preserve);

console.log(preserved ? "✓ minimized input still reproduces the target behavior" : "✗ minimized input no longer reproduces the target behavior");
if (typeof outcome === "object" && outcome && "signature" in outcome) {
  console.log("signature: " + String(outcome.signature));
}
process.exit(preserved ? 0 : 1);
`;
}

/** A Vitest test file asserting that the minimized input keeps reproducing. */
export function createRegressionTest<T>(
  result: ShrinkResult<T>,
  options: GeneratedFileOptions & { testModule: string },
): string {
  void result;
  const specifier = relativeSpecifier(options.testModule, options.outputDir);
  const exportName = options.testExport ?? "default";
  const title = (options.name ?? "minimized case").replace(/[\r\n]+/g, " ");

  const importLine =
    exportName === "default"
      ? `import predicate from ${JSON.stringify(specifier)};`
      : `import { ${exportName} as predicate } from ${JSON.stringify(specifier)};`;

  return `// Generated by @shrinkjs/core v${VERSION}
// Regression test for a case minimized by ShrinkJS.
// Keeps the original failure from silently disappearing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
${importLine}

const inputPath = fileURLToPath(new URL("./minimized-input.json", import.meta.url));
const input = JSON.parse(readFileSync(inputPath, "utf8"));

describe(${JSON.stringify(`ShrinkJS regression: ${title}`)}, () => {
  it("still reproduces the target behavior", async () => {
    const outcome = await predicate(input);
    const preserved = typeof outcome === "boolean" ? outcome : Boolean(outcome && outcome.preserve);
    expect(preserved).toBe(true);
  });
});
`;
}

/** Convenience helper for tooling that only needs the file URL of an artifact. */
export function artifactUrl(outputDir: string, kind: ArtifactKind): string {
  return pathToFileURL(path.join(path.resolve(outputDir), FILE_NAMES[kind])).href;
}

import { shrink } from "../core/shrink.js";
import type { ShrinkOptions, ShrinkResult } from "../core/types.js";
import { createRegressionTest } from "../reporting/artifacts.js";
import { writeArtifacts, type ArtifactResult } from "../reporting/artifacts.js";
import { formatPercent, formatSize } from "../utils/format.js";

export interface MinimizeTestCaseOptions<T> extends ShrinkOptions<T> {
  /** Human-readable case name used in artifact titles. */
  name?: string;
  /** Where artifacts are written. Default: `.shrinkjs`. */
  artifactsDir?: string;
  /** Write report/artifact files. Default: `true`. */
  writeArtifacts?: boolean;
  /** Overwrite existing artifacts. Default: `true` (test runs are repeatable). */
  overwriteArtifacts?: boolean;
  /**
   * Throw when the predicate never held on the original input. Default: `true`,
   * which makes the enclosing test fail loudly.
   */
  throwOnFailure?: boolean;
  /** Print a one-line summary to the console. Default: `true`. */
  log?: boolean;
  /** Predicate module path used by generated artifacts (optional). */
  testModule?: string;
}

export interface MinimizeTestCaseResult<T> extends ShrinkResult<T> {
  /** Artifact information when artifacts were written. */
  artifacts?: ArtifactResult;
}

/**
 * Shared implementation of the test-framework adapters.
 *
 * It is deliberately framework-agnostic: ShrinkJS never imports Vitest or Jest,
 * so the core package stays dependency-free and the adapters work with any
 * runner that can await a promise.
 */
export async function runMinimizedCase<T>(
  options: MinimizeTestCaseOptions<T>,
  framework: "vitest" | "jest",
): Promise<MinimizeTestCaseResult<T>> {
  const {
    name,
    artifactsDir = ".shrinkjs",
    writeArtifacts: shouldWrite = true,
    overwriteArtifacts = true,
    throwOnFailure = true,
    log = true,
    testModule,
    ...shrinkOptions
  } = options;

  const result = await shrink<T>(shrinkOptions as ShrinkOptions<T>);

  const output: MinimizeTestCaseResult<T> = result as MinimizeTestCaseResult<T>;

  if (!result.ok) {
    const message = `${framework}: ShrinkJS could not establish the target behavior (${result.error?.code ?? "unknown"}): ${result.error?.message ?? "predicate failed"}`;
    if (throwOnFailure) {
      const error = new Error(message);
      (error as Error & { shrinkResult?: ShrinkResult<T> }).shrinkResult = result;
      throw error;
    }
  }

  if (shouldWrite) {
    output.artifacts = await writeArtifacts(result, {
      outputDir: artifactsDir,
      overwrite: overwriteArtifacts,
      ...(name === undefined ? {} : { name }),
      ...(testModule === undefined ? {} : { testModule }),
    });
  }

  if (log) {
    const summary =
      result.ok && result.status !== "failed"
        ? `${framework}: ShrinkJS ${result.status} — ${formatSize(result.stats.originalSize)} → ${formatSize(result.stats.finalSize)} (${formatPercent(result.stats.reductionPercent)} smaller, ${result.stats.evaluations} evaluations)`
        : `${framework}: ShrinkJS failed — ${result.error?.message ?? "unknown error"}`;
    console.log(summary);
  }

  return output;
}

export { createRegressionTest };

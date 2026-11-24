import type { ShrinkResult } from "../core/types.js";
import { VERSION } from "../version.js";
import { diffValues, type DiffEntry } from "./diff.js";
import { redactDiffEntries, redactValue, type RedactOptions } from "./redact.js";
import { toJsonSafe } from "../utils/json-safe.js";

export interface JsonReportOptions {
  /** Where the input came from (file path, label). Included verbatim. */
  inputSource?: string;
  /** Include the structural diff. Default: `true`. */
  includeDiff?: boolean;
  /** Replacement for sensitive property values. */
  redact?: RedactOptions;
}

export interface JsonReport {
  tool: { name: string; version: string };
  generatedAt: string;
  inputSource: string | null;
  status: ShrinkResult<unknown>["status"];
  ok: boolean;
  minimality: ShrinkResult<unknown>["minimality"];
  signature: string | null;
  stats: ShrinkResult<unknown>["stats"];
  config: ShrinkResult<unknown>["config"];
  minimalInput: unknown;
  diff: DiffEntry[];
  warnings: string[];
  error: ShrinkResult<unknown>["error"] | null;
  history?: ShrinkResult<unknown>["history"];
}

/**
 * Machine-readable report. Never includes the original input (it can be huge or
 * sensitive); use `stats.originalSize` for the comparison and
 * `minimalInput` for the result.
 */
export function createJsonReport<T>(result: ShrinkResult<T>, options: JsonReportOptions = {}): JsonReport {
  const redact = options.redact;
  const minimalInput = toJsonSafe(redactValue(result.minimalInput, redact));
  const diff = options.includeDiff === false ? [] : diffValues(result.originalInput, result.minimalInput);

  const report: JsonReport = {
    tool: { name: "@shrinkjs/core", version: VERSION },
    generatedAt: new Date().toISOString(),
    inputSource: options.inputSource ?? null,
    status: result.status,
    ok: result.ok,
    minimality: result.minimality,
    signature: result.signature,
    stats: result.stats,
    config: result.config,
    minimalInput,
    diff: redact ? redactDiffEntries(diff, redact) : diff,
    warnings: result.warnings,
    error: result.error ?? null,
  };

  if (result.history) {
    report.history = redact
      ? (result.history.map((entry) => ({
          ...entry,
          ...(entry.value === undefined ? {} : { value: redactValue(entry.value, redact) }),
        })) as JsonReport["history"])
      : result.history;
  }

  return report;
}

export function serializeJsonReport(report: JsonReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

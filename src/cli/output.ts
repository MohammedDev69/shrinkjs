import { formatCount, formatDuration, formatPercent, formatSize } from "../utils/format.js";
import type { ProgressEvent, ShrinkResult } from "../core/types.js";

export interface Style {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  gray(text: string): string;
  inverse(text: string): string;
}

function wrap(code: string): (text: string) => string {
  return (text: string) => `\u001b[${code}m${text}\u001b[0m`;
}

export function createStyle(enabled: boolean): Style {
  const identity = (text: string): string => text;
  return {
    enabled,
    bold: enabled ? wrap("1") : identity,
    dim: enabled ? wrap("2") : identity,
    green: enabled ? wrap("32") : identity,
    red: enabled ? wrap("31") : identity,
    yellow: enabled ? wrap("33") : identity,
    cyan: enabled ? wrap("36") : identity,
    gray: enabled ? wrap("90") : identity,
    inverse: enabled ? wrap("7") : identity,
  };
}

export function renderBar(fraction: number, width = 24): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

/** Renders an in-place progress line on stderr. No-op when not a TTY. */
export class ProgressRenderer {
  private readonly enabled: boolean;
  private readonly style: Style;
  private readonly write: (text: string) => void;
  private readonly maxEvaluations: number;
  private started = false;
  private lastLength = 0;

  constructor(options: {
    enabled: boolean;
    style: Style;
    maxEvaluations: number;
    write: (text: string) => void;
  }) {
    this.enabled = options.enabled;
    this.style = options.style;
    this.maxEvaluations = options.maxEvaluations;
    this.write = options.write;
  }

  update(event: ProgressEvent): void {
    if (!this.enabled) return;
    const ratio = this.maxEvaluations > 0 ? event.evaluations / this.maxEvaluations : 0;
    const line = `${this.style.cyan(renderBar(ratio, 20))} ${formatPercent(Math.min(100, ratio * 100)).padStart(5)}  ${formatCount(event.evaluations)} evals · best ${formatSize(event.bestSize)}`;
    this.render(line);
  }

  note(line: string): void {
    if (!this.enabled) return;
    this.clear();
    this.write(`${line}\n`);
    this.started = false;
  }

  private render(line: string): void {
    const padding = this.lastLength > line.length ? " ".repeat(this.lastLength - line.length) : "";
    this.write(`\r${line}${padding}`);
    this.lastLength = line.length;
    this.started = true;
  }

  clear(): void {
    if (!this.enabled || !this.started) return;
    this.write(`\r${" ".repeat(this.lastLength)}\r`);
    this.lastLength = 0;
    this.started = false;
  }
}

export function renderSummary<T>(result: ShrinkResult<T>, style: Style): string {
  const lines: string[] = [];
  const statusOk = result.ok;
  const marker = statusOk ? style.green("✓") : style.red("✗");
  const statusLine = statusOk
    ? style.green("Target behavior preserved")
    : style.red("Target behavior could not be established");

  lines.push(`${marker} ${statusLine}`);
  lines.push("");
  lines.push(
    `   Original   ${style.bold(formatSize(result.stats.originalSize).padStart(9))}  ${style.gray(`(${formatCount(result.stats.originalSize)} chars)`)}`,
  );
  lines.push(
    `   Minimized  ${style.bold(formatSize(result.stats.finalSize).padStart(9))}  ${style.gray(`(${formatCount(result.stats.finalSize)} chars)`)}`,
  );
  lines.push(
    `   Saved      ${style.bold(formatPercent(result.stats.reductionPercent).padStart(9))}  ${style.gray(`${formatCount(result.stats.successfulReductions)} accepted reductions`)}`,
  );
  lines.push(
    `   Duration   ${formatDuration(result.stats.durationMs).padStart(9)}  ${style.gray(`${formatCount(result.stats.evaluations)} evaluations · ${formatCount(result.stats.cacheHits)} cache hits`)}`,
  );

  const minimalityText =
    result.minimality === "local" ? "locally minimal for the enabled reducers" : "not proven minimal";
  lines.push(`   Status     ${statusLine2(result, style)}  ${style.gray(minimalityText)}`);

  if (result.stats.limitReached) {
    lines.push(style.yellow(`   ! stopped early: ${result.stats.limitReached}`));
  }
  if (result.signature !== null) {
    lines.push(`   Signature  ${style.cyan(result.signature)}`);
  }
  if (result.error) {
    lines.push("");
    lines.push(style.red(`   ${result.error.code}: ${result.error.message}`));
  }
  for (const warning of result.warnings) {
    lines.push(style.yellow(`   ! ${warning}`));
  }

  return lines.join("\n");
}

function statusLine2<T>(result: ShrinkResult<T>, style: Style): string {
  switch (result.status) {
    case "completed":
      return style.green("completed");
    case "limit-reached":
      return style.yellow("limit-reached");
    case "cancelled":
      return style.yellow("cancelled");
    case "unstable":
      return style.yellow("unstable");
    default:
      return style.red("failed");
  }
}

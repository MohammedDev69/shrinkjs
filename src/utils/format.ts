import { compactRepresentation } from "./serialize.js";

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** Sizes are counts of characters in the canonical representation. */
export function formatSize(chars: number): string {
  if (chars < 1_000) return `${chars} B`;
  if (chars < 1_000_000) return `${(chars / 1_000).toFixed(1)} kB`;
  return `${(chars / 1_000_000).toFixed(2)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/** Single-line preview of a value, safe for terminals and markdown tables. */
export function preview(value: unknown, max = 60): string {
  let text: string;
  try {
    text = compactRepresentation(value);
  } catch {
    text = String(value);
  }
  text = text.replace(/\s+/g, " ");
  return truncate(text, max);
}

import { preview } from "../utils/format.js";
import { stableKey } from "../utils/serialize.js";
import { getAtPath, formatPath, type PathSegment } from "../utils/paths.js";

export type DiffKind = "removed" | "added" | "changed";

export interface DiffEntry {
  /** `$.users[2].name` style location. */
  path: string;
  kind: DiffKind;
  before?: unknown;
  after?: unknown;
  /** Short previews, so a diff can be printed without the full payload. */
  beforePreview?: string;
  afterPreview?: string;
}

export interface DiffOptions {
  /** Cap on produced entries. Default: 200. */
  maxEntries?: number;
  /** Preview length. Default: 60. */
  previewLength?: number;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set)
    return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  return true;
}

/**
 * Structural diff between the original and minimized input.
 *
 * Objects are compared by key, arrays by index (length changes show up as
 * added/removed entries at the tail), and everything else is compared with
 * `Object.is`. This is intentionally a *structural* diff, not a textual one: it
 * works for non-JSON values and never depends on key order.
 */
export function diffValues(before: unknown, after: unknown, options: DiffOptions = {}): DiffEntry[] {
  const maxEntries = options.maxEntries ?? 200;
  const previewLength = options.previewLength ?? 60;
  const entries: DiffEntry[] = [];

  const push = (
    kind: DiffKind,
    path: PathSegment[] | string,
    b: unknown,
    a: unknown,
    previewOverride?: string,
  ): void => {
    if (entries.length >= maxEntries) return;
    const label = typeof path === "string" ? path : formatPath(path);
    entries.push({
      path: label,
      kind,
      ...(kind === "added" ? { after: a, afterPreview: previewOverride ?? preview(a, previewLength) } : {}),
      ...(kind === "removed"
        ? { before: b, beforePreview: previewOverride ?? preview(b, previewLength) }
        : {}),
      ...(kind === "changed"
        ? {
            before: b,
            after: a,
            beforePreview: preview(b, previewLength),
            afterPreview: preview(a, previewLength),
          }
        : {}),
    });
  };

  const walk = (b: unknown, a: unknown, path: PathSegment[], depth: number): void => {
    if (entries.length >= maxEntries) return;
    if (Object.is(b, a)) return;
    void depth;

    if (isContainer(b) && isContainer(a) && Array.isArray(b) === Array.isArray(a)) {
      if (Array.isArray(b) && Array.isArray(a)) {
        // Common prefix / suffix are identical: only the middle can differ.
        // Structural equality (not reference equality) is used so that cloned
        // but unchanged elements are recognised as equal.
        const same = (x: unknown, y: unknown): boolean => Object.is(x, y) || safeKey(x) === safeKey(y);

        let prefix = 0;
        while (prefix < b.length && prefix < a.length && same(b[prefix], a[prefix])) prefix += 1;

        let suffix = 0;
        while (
          suffix < b.length - prefix &&
          suffix < a.length - prefix &&
          same(b[b.length - 1 - suffix], a[a.length - 1 - suffix])
        ) {
          suffix += 1;
        }

        const beforeMiddle = b.slice(prefix, b.length - suffix);
        const afterMiddle = a.slice(prefix, a.length - suffix);

        // Pair what can be paired, then describe each remaining contiguous
        // slice with a single entry — that is what keeps minimized-array diffs
        // readable instead of one line per removed element.
        const paired = Math.min(beforeMiddle.length, afterMiddle.length);
        for (let i = 0; i < paired; i += 1) {
          walk(beforeMiddle[i], afterMiddle[i], [...path, prefix + i], depth + 1);
          if (entries.length >= maxEntries) return;
        }

        const removed = beforeMiddle.slice(paired);
        const added = afterMiddle.slice(paired);
        if (removed.length > 0) {
          push(
            "removed",
            sliceLabel(path, prefix + paired, removed.length),
            removed,
            undefined,
            `${removed.length} item(s) removed`,
          );
        }
        if (added.length > 0) {
          push(
            "added",
            sliceLabel(path, prefix + paired, added.length),
            undefined,
            added,
            `${added.length} item(s) added`,
          );
        }
        return;
      }

      const before = b as Record<string, unknown>;
      const after = a as Record<string, unknown>;
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of [...keys].sort()) {
        const inBefore = Object.prototype.hasOwnProperty.call(before, key);
        const inAfter = Object.prototype.hasOwnProperty.call(after, key);
        if (inBefore && !inAfter) {
          push("removed", [...path, key], before[key], undefined);
        } else if (!inBefore && inAfter) {
          push("added", [...path, key], undefined, after[key]);
        } else {
          walk(before[key], after[key], [...path, key], depth + 1);
        }
        if (entries.length >= maxEntries) return;
      }
      return;
    }

    push("changed", path, b, a);
  };

  walk(before, after, [], 0);
  return entries;
}

/** `$.items[3]` for one element, `$.items[3..9]` for a range. */
function sliceLabel(path: readonly PathSegment[], start: number, count: number): string {
  const base = formatPath(path);
  return count === 1 ? `${base}[${start}]` : `${base}[${start}..${start + count - 1}]`;
}

function safeKey(value: unknown): string {
  try {
    return stableKey(value);
  } catch {
    return String(value);
  }
}

/** Renders diff entries as stable, greppable text. */
export function formatDiff(entries: readonly DiffEntry[]): string {
  if (entries.length === 0) return "(no structural difference)";
  return entries
    .map((entry) => {
      switch (entry.kind) {
        case "removed":
          return `- ${entry.path}: ${entry.beforePreview}`;
        case "added":
          return `+ ${entry.path}: ${entry.afterPreview}`;
        default:
          return `~ ${entry.path}: ${entry.beforePreview} -> ${entry.afterPreview}`;
      }
    })
    .join("\n");
}

/** Convenience: value at a path, exposed for report templates. */
export function valueAt(value: unknown, path: readonly PathSegment[]): unknown {
  return getAtPath(value, path);
}

import { preview } from "../utils/format.js";
import type { DiffEntry } from "./diff.js";

export interface RedactOptions {
  /** Property names whose values are replaced (case-sensitive). */
  keys?: string[];
  /** Replacement text. Default: `"[REDACTED]"`. */
  replacement?: string;
}

const DEFAULT_REPLACEMENT = "[REDACTED]";

/**
 * Returns a copy of `value` with values under the given property names
 * replaced. Redaction is applied to reports only; `minimized-input.json`
 * artifacts always contain the real data so the reproduction stays runnable.
 */
export function redactValue(value: unknown, options: RedactOptions | undefined): unknown {
  if (!options?.keys?.length) return value;
  const keys = new Set(options.keys);
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  const seen = new WeakMap<object, unknown>();

  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    const object = node as object;
    const existing = seen.get(object);
    if (existing !== undefined) return existing;

    if (Array.isArray(object)) {
      const out: unknown[] = [];
      seen.set(object, out);
      for (const item of object) out.push(walk(item));
      return out;
    }
    if (
      object instanceof Date ||
      object instanceof RegExp ||
      object instanceof Map ||
      object instanceof Set
    ) {
      return node;
    }
    if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) return node;

    const out: Record<string, unknown> = {};
    seen.set(object, out);
    for (const key of Object.keys(object)) {
      const child = (object as Record<string, unknown>)[key];
      out[key] = keys.has(key) ? replacement : walk(child);
    }
    return out;
  };

  return walk(value);
}

/**
 * Redacts diff entries, including their rendered previews (which otherwise
 * still contain the original text).
 *
 * Two rules apply: values of redacted property names are replaced anywhere in
 * the entry, and an entry whose own path ends in a redacted property name is
 * replaced wholesale (e.g. the `- $.user.token: "..."` line).
 */
export function redactDiffEntries(
  entries: readonly DiffEntry[],
  options: RedactOptions | undefined,
): DiffEntry[] {
  if (!options?.keys?.length) return [...entries];
  const keys = new Set(options.keys);
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  const isSliceNote = (text: string | undefined): boolean =>
    text !== undefined && /^\d+ item\(s\) (added|removed)$/.test(text);

  return entries.map((entry) => {
    const next: DiffEntry = { ...entry };
    const pathKey = lastPathKey(entry.path);
    if (pathKey !== null && keys.has(pathKey)) {
      if ("before" in entry) {
        next.before = replacement;
        next.beforePreview = replacement;
      }
      if ("after" in entry) {
        next.after = replacement;
        next.afterPreview = replacement;
      }
      return next;
    }
    if ("before" in entry) {
      const redacted = redactValue(entry.before, options);
      next.before = redacted;
      next.beforePreview = isSliceNote(entry.beforePreview) ? entry.beforePreview : preview(redacted);
    }
    if ("after" in entry) {
      const redacted = redactValue(entry.after, options);
      next.after = redacted;
      next.afterPreview = isSliceNote(entry.afterPreview) ? entry.afterPreview : preview(redacted);
    }
    return next;
  });
}

function lastPathKey(path: string): string | null {
  if (path === "$") return null;
  const bracket = /\[(?:"((?:[^"\\]|\\.)*)"|(\d+))\]$/.exec(path);
  if (bracket) {
    const quoted = bracket[1];
    if (quoted === undefined) return null; // numeric index
    try {
      return JSON.parse(`"${quoted}"`) as string;
    } catch {
      return quoted;
    }
  }
  const dot = path.lastIndexOf(".");
  return dot === -1 ? null : path.slice(dot + 1);
}

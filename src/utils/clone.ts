import { ShrinkUnsupportedInputError } from "../core/errors.js";
import type { InputMode } from "../core/types.js";

const hasBuffer = typeof Buffer !== "undefined";

function isPlainPrototype(proto: object | null): boolean {
  if (proto === null) return true;
  return proto === Object.prototype;
}

/**
 * Deep clone that preserves prototypes (so `instanceof` keeps working),
 * supports cycles, and understands Date, RegExp, Map, Set, ArrayBuffer,
 * typed arrays and Buffers.
 *
 * Limitations (documented): non-enumerable properties, accessor descriptors
 * and private class fields are not copied. Functions are copied by reference.
 * Inputs deeper than `maxInputDepth` are rejected by `assertSupportedInput`
 * before this function runs, which keeps the recursion bounded.
 */
export function deepClone<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const object = value as unknown as object;
  const existing = seen.get(object);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(object)) {
    const out: unknown[] = new Array(object.length);
    seen.set(object, out);
    for (let i = 0; i < object.length; i += 1) {
      out[i] = deepClone((object as unknown[])[i], seen);
    }
    return out as unknown as T;
  }

  if (object instanceof Date) return new Date(object.getTime()) as unknown as T;
  if (object instanceof RegExp) return new RegExp(object.source, object.flags) as unknown as T;

  if (object instanceof Map) {
    const out = new Map<unknown, unknown>();
    seen.set(object, out);
    for (const [k, v] of object) out.set(deepClone(k, seen), deepClone(v, seen));
    return out as unknown as T;
  }

  if (object instanceof Set) {
    const out = new Set<unknown>();
    seen.set(object, out);
    for (const v of object) out.add(deepClone(v, seen));
    return out as unknown as T;
  }

  if (hasBuffer && Buffer.isBuffer(object)) {
    return Buffer.from(object) as unknown as T;
  }

  if (object instanceof ArrayBuffer) return object.slice(0) as unknown as T;

  if (ArrayBuffer.isView(object)) {
    const view = object as unknown as ArrayBufferView;
    // Copy the exact bytes, then re-interpret them with the same view type so
    // element width is preserved (Uint16Array must stay Uint16Array).
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    if (object instanceof DataView) return new DataView(bytes.buffer) as unknown as T;
    const Ctor = object.constructor as new (buffer: ArrayBuffer) => ArrayBufferView;
    return new Ctor(bytes.buffer) as unknown as T;
  }

  const proto = Object.getPrototypeOf(object) as object | null;
  const out = Object.create(proto) as Record<string, unknown>;
  seen.set(object, out);
  for (const key of Object.keys(object)) {
    out[key] = deepClone((object as Record<string, unknown>)[key], seen);
  }
  return out as unknown as T;
}

/** A structural fingerprint used to detect "no structural change". */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return isPlainPrototype(proto);
}

interface Frame {
  node: unknown;
  at: string;
  depth: number;
  /** When set, this frame only pops the object off the ancestor stack. */
  exit?: object;
}

/**
 * Validates that a value can be handled by the selected mode.
 *
 * - Rejects unsupported types with the path of the offending value.
 * - Rejects true cycles in `json` mode (shared acyclic references are fine).
 * - Rejects inputs nesting deeper than `maxDepth`, because every later step
 *   (clone, measure, compare) is recursive; this turns a potential
 *   `RangeError: Maximum call stack size exceeded` into an actionable error.
 *
 * Implemented with an explicit stack so validation itself cannot overflow.
 */
export function assertSupportedInput(value: unknown, mode: InputMode, maxDepth = 1_000, path = "$"): void {
  const ancestors = new WeakSet<object>();
  const validated = new WeakSet<object>();
  const stack: Frame[] = [{ node: value, at: path, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.exit) {
      ancestors.delete(frame.exit);
      continue;
    }

    const node = frame.node;
    if (node === null) continue;
    const type = typeof node;
    if (type === "string" || type === "number" || type === "boolean" || type === "undefined") continue;
    if (type === "bigint") {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `BigInt at ${frame.at} is not JSON-compatible. Use mode: "js" to minimize non-JSON values.`,
        );
      }
      continue;
    }
    if (type === "function") {
      throw new ShrinkUnsupportedInputError(
        `Function at ${frame.at} cannot be minimized. Replace it with data your predicate can rebuild.`,
      );
    }
    if (type === "symbol") {
      throw new ShrinkUnsupportedInputError(`Symbol at ${frame.at} cannot be minimized.`);
    }

    const object = node as object;
    if (ancestors.has(object)) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `Circular reference detected at ${frame.at}. JSON cannot represent cycles; use mode: "js" instead.`,
        );
      }
      continue;
    }
    if (validated.has(object)) continue;
    validated.add(object);

    if (frame.depth >= maxDepth) {
      throw new ShrinkUnsupportedInputError(
        `Input nests deeper than limits.maxInputDepth (${maxDepth} levels) at ${frame.at}. ` +
          "Flatten the data or raise the limit.",
      );
    }

    if (Array.isArray(object)) {
      ancestors.add(object);
      stack.push({ node: null, at: frame.at, depth: frame.depth, exit: object });
      for (let i = object.length - 1; i >= 0; i -= 1) {
        stack.push({ node: object[i], at: `${frame.at}[${i}]`, depth: frame.depth + 1 });
      }
      continue;
    }
    if (object instanceof Date || object instanceof RegExp) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `${object.constructor.name} at ${frame.at} is not JSON-compatible. Use mode: "js".`,
        );
      }
      continue;
    }
    if (object instanceof Map || object instanceof Set) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `${object.constructor.name} at ${frame.at} is not JSON-compatible. Use mode: "js".`,
        );
      }
      continue;
    }
    if (hasBuffer && Buffer.isBuffer(object)) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `Buffer at ${frame.at} is not JSON-compatible. Use mode: "js".`,
        );
      }
      continue;
    }
    if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `Binary value at ${frame.at} is not JSON-compatible. Use mode: "js".`,
        );
      }
      continue;
    }

    const proto = Object.getPrototypeOf(object) as object | null;
    if (mode === "json" && !isPlainPrototype(proto)) {
      throw new ShrinkUnsupportedInputError(
        `Instance of ${(proto?.constructor as { name?: string } | undefined)?.name ?? "unknown class"} at ${frame.at} is not JSON-compatible. Use mode: "js".`,
      );
    }

    ancestors.add(object);
    stack.push({ node: null, at: frame.at, depth: frame.depth, exit: object });
    const keys = Object.keys(object);
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const key = keys[i] as string;
      stack.push({
        node: (object as Record<string, unknown>)[key],
        at: `${frame.at}.${key}`,
        depth: frame.depth + 1,
      });
    }
  }
}

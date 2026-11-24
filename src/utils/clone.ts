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

/**
 * Validates that a value can be handled by the selected mode.
 * Throws {@link ShrinkUnsupportedInputError} with an actionable message.
 */
export function assertSupportedInput(value: unknown, mode: InputMode, path = "$"): void {
  const seen = new WeakSet<object>();

  const visit = (node: unknown, at: string): void => {
    if (node === null) return;
    const type = typeof node;
    if (type === "string" || type === "number" || type === "boolean" || type === "undefined") return;
    if (type === "bigint") {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `BigInt at ${at} is not JSON-compatible. Use mode: "js" to minimize non-JSON values.`,
        );
      }
      return;
    }
    if (type === "function") {
      throw new ShrinkUnsupportedInputError(
        `Function at ${at} cannot be minimized. Replace it with data your predicate can rebuild.`,
      );
    }
    if (type === "symbol") {
      throw new ShrinkUnsupportedInputError(`Symbol at ${at} cannot be minimized.`);
    }

    const object = node as object;
    if (seen.has(object)) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `Circular reference detected at ${at}. JSON cannot represent cycles; use mode: "js" instead.`,
        );
      }
      return;
    }
    seen.add(object);

    if (Array.isArray(object)) {
      for (let i = 0; i < object.length; i += 1) visit(object[i], `${at}[${i}]`);
      return;
    }
    if (object instanceof Date || object instanceof RegExp) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `${object.constructor.name} at ${at} is not JSON-compatible. Use mode: "js".`,
        );
      }
      return;
    }
    if (object instanceof Map || object instanceof Set) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `${object.constructor.name} at ${at} is not JSON-compatible. Use mode: "js".`,
        );
      }
      return;
    }
    if (hasBuffer && Buffer.isBuffer(object)) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(`Buffer at ${at} is not JSON-compatible. Use mode: "js".`);
      }
      return;
    }
    if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
      if (mode === "json") {
        throw new ShrinkUnsupportedInputError(
          `Binary value at ${at} is not JSON-compatible. Use mode: "js".`,
        );
      }
      return;
    }

    const proto = Object.getPrototypeOf(object) as object | null;
    if (mode === "json" && !isPlainPrototype(proto)) {
      throw new ShrinkUnsupportedInputError(
        `Instance of ${(proto?.constructor as { name?: string } | undefined)?.name ?? "unknown class"} at ${at} is not JSON-compatible. Use mode: "js".`,
      );
    }

    for (const key of Object.keys(object)) {
      visit((object as Record<string, unknown>)[key], `${at}.${key}`);
    }
  };

  visit(value, path);
}

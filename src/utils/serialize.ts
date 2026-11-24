/**
 * Deterministic representation helpers.
 *
 * `compactRepresentation` mirrors what a compact JSON serialization would look
 * like and is the basis of every size number reported by ShrinkJS.
 * `stableKey` is a type-tagged canonical string used for caching/deduplication.
 */

const hasBuffer = typeof Buffer !== "undefined";

/** Characters in the compact representation. Documented in README ("Measuring size"). */
export function sizeOf(value: unknown): number {
  return compactRepresentation(value).length;
}

export function compactRepresentation(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";
  const type = typeof value;
  switch (type) {
    case "undefined":
      return "undefined";
    case "boolean":
      return value === true ? "true" : "false";
    case "number":
      return formatNumber(value as number);
    case "bigint":
      return `${String(value)}n`;
    case "string":
      return JSON.stringify(value);
    case "symbol":
      return String(value as symbol);
    case "function":
      return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) return "[Circular]";
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (let i = 0; i < object.length; i += 1) parts.push(compactRepresentation(object[i], seen));
      return `[${parts.join(",")}]`;
    }
    if (object instanceof Date) return JSON.stringify(object.toISOString());
    if (object instanceof RegExp) return `/${object.source}/${object.flags}`;
    if (object instanceof Map) {
      const parts: string[] = [];
      for (const [k, v] of object) {
        parts.push(`${compactRepresentation(k, seen)}=>${compactRepresentation(v, seen)}`);
      }
      return `Map{${parts.join(",")}}`;
    }
    if (object instanceof Set) {
      const parts: string[] = [];
      for (const v of object) parts.push(compactRepresentation(v, seen));
      return `Set{${parts.join(",")}}`;
    }
    if (hasBuffer && Buffer.isBuffer(object)) {
      return `Buffer<${object.length}>`;
    }
    if (object instanceof ArrayBuffer) return `ArrayBuffer<${object.byteLength}>`;
    if (ArrayBuffer.isView(object)) {
      const view = object as unknown as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const name = object.constructor.name;
      return `${name}[${Array.from(bytes).join(",")}]`;
    }
    const entries: string[] = [];
    for (const key of Object.keys(object)) {
      entries.push(
        `${JSON.stringify(key)}:${compactRepresentation((object as Record<string, unknown>)[key], seen)}`,
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

/**
 * Type-tagged, order-independent canonical key.
 *
 * Two values get the same key only when they are structurally identical under
 * the same notion of identity the reducers use. Object keys are sorted, special
 * values are tagged, and repeated/cyclic references are numbered.
 */
export function stableKey(value: unknown): string {
  const refs = new Map<object, number>();
  let nextRef = 0;

  const encode = (node: unknown): string => {
    if (node === null) return "z";
    const type = typeof node;
    switch (type) {
      case "undefined":
        return "u";
      case "boolean":
        return node === true ? "b1" : "b0";
      case "number": {
        const n = node as number;
        if (Number.isNaN(n)) return "n:NaN";
        if (n === Infinity) return "n:Inf";
        if (n === -Infinity) return "n:-Inf";
        if (Object.is(n, -0)) return "n:-0";
        return `n:${String(n)}`;
      }
      case "bigint":
        return `g:${String(node)}`;
      case "string":
        return `s:${JSON.stringify(node)}`;
      case "symbol":
        return `y:${String(node as symbol)}`;
      case "function":
        return `f:${(node as { name?: string }).name ?? ""}`;
      default:
        break;
    }

    const object = node as object;
    const seen = refs.get(object);
    if (seen !== undefined) return `#${seen}`;
    refs.set(object, nextRef);
    const ref = nextRef;
    nextRef += 1;

    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (let i = 0; i < object.length; i += 1) parts.push(encode(object[i]));
      return `a${ref}[${parts.join(",")}]`;
    }
    if (object instanceof Date) return `d${ref}(${object.getTime()})`;
    if (object instanceof RegExp) return `r${ref}(${object.source}/${object.flags})`;
    if (object instanceof Map) {
      const parts: string[] = [];
      for (const [k, v] of object) parts.push(`${encode(k)}=>${encode(v)}`);
      parts.sort();
      return `m${ref}{${parts.join(",")}}`;
    }
    if (object instanceof Set) {
      const parts: string[] = [];
      for (const v of object) parts.push(encode(v));
      parts.sort();
      return `e${ref}{${parts.join(",")}}`;
    }
    if (hasBuffer && Buffer.isBuffer(object)) return `B${ref}<${object.toString("base64")}>`;
    if (object instanceof ArrayBuffer) {
      return `A${ref}<${Buffer.from(object).toString("base64")}>`;
    }
    if (ArrayBuffer.isView(object)) {
      const view = object as unknown as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      return `v${ref}:${object.constructor.name}<${Buffer.from(bytes).toString("base64")}>`;
    }

    const keys = Object.keys(object).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${encode((object as Record<string, unknown>)[key])}`,
    );
    const tag = object.constructor && object.constructor !== Object ? `:${object.constructor.name}` : "";
    return `o${ref}${tag}{${parts.join(",")}}`;
  };

  return encode(value);
}

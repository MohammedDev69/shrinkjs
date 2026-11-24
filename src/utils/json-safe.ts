/**
 * Converts any supported value into plain JSON-compatible data.
 *
 * - `undefined`, functions and symbols become descriptive strings/`null`.
 * - BigInt becomes a number when it is safely representable, else a string.
 * - Map becomes an object, Set an array, Date an ISO string, RegExp a string.
 * - Binary data becomes `{ type, base64 }`.
 * - Cycles become the string `"[Circular]"`.
 */
export function toJsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const convert = (node: unknown): unknown => {
    if (node === null) return null;
    switch (typeof node) {
      case "undefined":
        return null;
      case "boolean":
      case "string":
        return node;
      case "number":
        return Number.isFinite(node) ? node : String(node);
      case "bigint": {
        const asNumber = Number(node);
        return Number.isSafeInteger(asNumber) ? asNumber : `${String(node)}n`;
      }
      case "function":
        return `[Function ${(node as { name?: string }).name || "anonymous"}]`;
      case "symbol":
        return String(node as symbol);
      default:
        break;
    }

    const object = node as object;
    if (seen.has(object)) return "[Circular]";
    seen.add(object);
    try {
      if (Array.isArray(object)) return object.map(convert);
      if (object instanceof Date) return object.toISOString();
      if (object instanceof RegExp) return `/${object.source}/${object.flags}`;
      if (object instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of object) out[String(k)] = convert(v);
        return out;
      }
      if (object instanceof Set) return [...object].map(convert);
      if (object instanceof ArrayBuffer) {
        return { type: "ArrayBuffer", base64: Buffer.from(object).toString("base64") };
      }
      if (ArrayBuffer.isView(object)) {
        const view = object as unknown as ArrayBufferView;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        return { type: object.constructor.name, base64: Buffer.from(bytes).toString("base64") };
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(object)) {
        out[key] = convert((object as Record<string, unknown>)[key]);
      }
      return out;
    } finally {
      seen.delete(object);
    }
  };

  return convert(value);
}

/** `JSON.stringify` that always succeeds for supported values. */
export function toJsonString(value: unknown, indent = 2): string {
  return JSON.stringify(toJsonSafe(value), null, indent) ?? "null";
}

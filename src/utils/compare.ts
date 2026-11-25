/**
 * Simplicity ordering.
 *
 * Every accepted reduction must make the input *strictly simpler* under this
 * total preorder. Without such an ordering the engine could oscillate forever
 * (e.g. swapping `{a:1}` for `{b:1}` and back). The ordering is intentionally
 * conservative and documented in DESIGN.md:
 *
 * 1. Type rank (`undefined` < `null` < boolean < number < bigint < string <
 *    array < plain object < Map < Set < Date < RegExp < binary < other).
 * 2. Within a type: smaller magnitude / shorter length / fewer entries.
 * 3. Containers compare length first, then contents (sorted keys for objects).
 */

const ids = new WeakMap<object, number>();
let nextId = 0;

function idOf(object: object): number {
  const existing = ids.get(object);
  if (existing !== undefined) return existing;
  const id = nextId;
  nextId += 1;
  ids.set(object, id);
  return id;
}

const MAX_COMPARE_DEPTH = 64;

export function typeRank(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null) return 1;
  switch (typeof value) {
    case "boolean":
      return 2;
    case "number":
      return 3;
    case "bigint":
      return 4;
    case "string":
      return 5;
    case "function":
      return 14;
    case "symbol":
      return 15;
    default:
      break;
  }
  const object = value as object;
  if (Array.isArray(object)) return 6;
  if (object instanceof Map) return 8;
  if (object instanceof Set) return 9;
  if (object instanceof Date) return 10;
  if (object instanceof RegExp) return 11;
  if (object instanceof ArrayBuffer || ArrayBuffer.isView(object)) return 12;
  return 7;
}

function numberComplexity(n: number): [number, number, number, number] {
  if (Number.isNaN(n)) return [3, 0, 0, 0];
  if (n === Infinity) return [2, 0, 0, 0];
  if (n === -Infinity) return [2, 0, 1, 0];
  const negative = n < 0 || Object.is(n, -0) ? 1 : 0;
  return [0, Math.abs(n), negative, Number.isInteger(n) ? 0 : 1];
}

function compareNumber(a: number, b: number): number {
  const ca = numberComplexity(a);
  const cb = numberComplexity(b);
  for (let i = 0; i < ca.length; i += 1) {
    const x = ca[i] as number;
    const y = cb[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function compareEntries(
  a: Iterable<[unknown, unknown]>,
  b: Iterable<[unknown, unknown]>,
  depth: number,
  seen: Set<string>,
): number {
  const left = [...a];
  const right = [...b];
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  // Order-independent comparison: sort by key preview, then compare values.
  const sortKey = (entry: [unknown, unknown]): string => String(entry[0]);
  left.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
  right.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
  for (let i = 0; i < left.length; i += 1) {
    const cmp = compareCore(
      (left[i] as [unknown, unknown])[1],
      (right[i] as [unknown, unknown])[1],
      depth + 1,
      seen,
    );
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function compareCore(a: unknown, b: unknown, depth: number, seen: Set<string>): number {
  if (Object.is(a, b)) {
    // `Object.is(-0, 0)` is false, so this only catches exact matches.
    return 0;
  }
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;

  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return compareNumber(a, b);
  if (typeof a === "bigint" && typeof b === "bigint") {
    const absA = a < 0n ? -a : a;
    const absB = b < 0n ? -b : b;
    if (absA !== absB) return absA < absB ? -1 : 1;
    const negA = a < 0n ? 1 : 0;
    const negB = b < 0n ? 1 : 0;
    if (negA !== negB) return negA < negB ? -1 : 1;
    return 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return 0;
  if (depth > MAX_COMPARE_DEPTH) return 0;

  const key = `${idOf(a)}|${idOf(b)}`;
  if (seen.has(key)) return 0;
  seen.add(key);

  try {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return a.length < b.length ? -1 : 1;
      for (let i = 0; i < a.length; i += 1) {
        const cmp = compareCore(a[i], b[i], depth + 1, seen);
        if (cmp !== 0) return cmp;
      }
      return 0;
    }
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return a.size < b.size ? -1 : 1;
      return compareEntries(a.entries(), b.entries(), depth, seen);
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return a.size < b.size ? -1 : 1;
      return compareEntries(
        [...a].map((v, i) => [i, v] as [unknown, unknown]),
        [...b].map((v, i) => [i, v] as [unknown, unknown]),
        depth,
        seen,
      );
    }
    if (a instanceof Date && b instanceof Date) {
      const ta = a.getTime();
      const tb = b.getTime();
      if (ta === tb) return 0;
      return Math.abs(ta) <= Math.abs(tb) ? -1 : 1;
    }
    if (a instanceof RegExp && b instanceof RegExp) {
      if (a.source.length !== b.source.length) return a.source.length < b.source.length ? -1 : 1;
      return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
    }
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
      const ba = new Uint8Array(
        (a as ArrayBufferView).buffer,
        (a as ArrayBufferView).byteOffset,
        (a as ArrayBufferView).byteLength,
      );
      const bb = new Uint8Array(
        (b as ArrayBufferView).buffer,
        (b as ArrayBufferView).byteOffset,
        (b as ArrayBufferView).byteLength,
      );
      return compareBytes(ba, bb);
    }
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
      return compareBytes(new Uint8Array(a), new Uint8Array(b));
    }
    if (Array.isArray(a) || Array.isArray(b)) return 0;

    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return keysA.length < keysB.length ? -1 : 1;
    keysA.sort();
    keysB.sort();
    const joinedA = keysA.join("\u0000");
    const joinedB = keysB.join("\u0000");
    if (joinedA !== joinedB) return joinedA < joinedB ? -1 : 1;
    for (let i = 0; i < keysA.length; i += 1) {
      const k = keysA[i] as string;
      const cmp = compareCore(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        depth + 1,
        seen,
      );
      if (cmp !== 0) return cmp;
    }
    return 0;
  } finally {
    seen.delete(key);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Total preorder over "simplicity". Negative means `a` is simpler than `b`,
 * positive means `b` is simpler, zero means "equivalent or incomparable".
 */
export function compareSimplicity(a: unknown, b: unknown): number {
  return compareCore(a, b, 0, new Set());
}

/** True when `candidate` is strictly simpler than `current`. */
export function isSimpler(candidate: unknown, current: unknown): boolean {
  return compareSimplicity(candidate, current) < 0;
}

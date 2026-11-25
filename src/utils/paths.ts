/** Location of a node inside a value tree. */
export type PathSegment = string | number;
export type Path = readonly PathSegment[];

export function getAtPath(root: unknown, path: Path): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PathSegment, unknown>)[segment];
  }
  return current;
}

/**
 * Returns a structurally-shared copy of `root` with `path` replaced by
 * `value`. Ancestors on the path are cloned; everything else is reused.
 */
export function replaceAtPath<T>(root: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;

  const [head, ...rest] = path as [PathSegment, ...PathSegment[]];

  if (Array.isArray(root)) {
    const copy = root.slice() as unknown[];
    copy[head as number] = replaceAtPath(copy[head as number], rest, value);
    return copy as unknown as T;
  }

  if (root === null || typeof root !== "object") {
    throw new TypeError(`Cannot replace at path segment ${String(head)} of a non-container value`);
  }

  const source = root as Record<PathSegment, unknown>;
  const prototype: object | null = Object.getPrototypeOf(root) as object | null;
  const copy = Object.assign(Object.create(prototype) as Record<PathSegment, unknown>, source);
  copy[head] = replaceAtPath(source[head], rest, value);
  return copy as unknown as T;
}

export interface NodeRef {
  path: PathSegment[];
  value: unknown;
  depth: number;
}

/** Progress of a {@link walkNodes} traversal. */
export interface WalkState {
  /** Nodes yielded so far. */
  visits: number;
  /** True when `maxVisits` stopped the walk before it was complete. */
  truncated: boolean;
}

/**
 * Lazily yields addressable nodes depth-first in pre-order.
 *
 * Every path is visited, including paths that reach the same object twice: the
 * engine addresses nodes *by path*, so `{a: shared, b: shared}` has two
 * independent subtrees to reduce. Cycles are cut with an ancestor stack (an
 * object that is its own ancestor is not descended into again).
 *
 * Only arrays and plain-ish objects are traversed: Map/Set/Date/RegExp/binary
 * values are leaves (documented limitation).
 *
 * `maxVisits` bounds the walk so pathological sharing graphs (which have
 * exponentially many paths) cannot hang the process; the caller can inspect
 * `state.truncated` and report the limit honestly.
 */
export function* walkNodes(
  root: unknown,
  maxDepth: number,
  maxVisits = Number.POSITIVE_INFINITY,
  state: WalkState = { visits: 0, truncated: false },
): Generator<NodeRef> {
  const ancestors = new WeakSet<object>();

  function* visit(value: unknown, path: PathSegment[], depth: number): Generator<NodeRef> {
    if (state.visits >= maxVisits) {
      state.truncated = true;
      return;
    }
    state.visits += 1;
    yield { path, value, depth };

    if (depth >= maxDepth) return;
    if (value === null || typeof value !== "object") return;
    const object = value as object;
    if (ancestors.has(object)) return;
    if (
      object instanceof Date ||
      object instanceof RegExp ||
      object instanceof Map ||
      object instanceof Set
    ) {
      return;
    }
    if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) return;

    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        for (let i = 0; i < object.length; i += 1) yield* visit(object[i], [...path, i], depth + 1);
      } else {
        for (const key of Object.keys(object)) {
          yield* visit((object as Record<string, unknown>)[key], [...path, key], depth + 1);
        }
      }
    } finally {
      ancestors.delete(object);
    }
  }

  yield* visit(root, [], 0);
}

/**
 * Eager variant of {@link walkNodes}, kept for callers that want a materialised
 * list (tests, tooling). The engine streams with `walkNodes` instead so memory
 * stays O(depth).
 */
export function collectNodes(root: unknown, maxDepth: number): NodeRef[] {
  return [...walkNodes(root, maxDepth)];
}

/** Human readable path such as `$.users[2].name`. */
export function formatPath(path: Path): string {
  if (path.length === 0) return "$";
  let out = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      out += `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out;
}

/**
 * Pre-order comparison of two paths: a path sorts before its descendants, and
 * siblings keep numeric/lexicographic order.
 */
export function comparePaths(a: Path, b: Path): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const x = a[i] as PathSegment;
    const y = b[i] as PathSegment;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    const sx = String(x);
    const sy = String(y);
    return sx < sy ? -1 : sx > sy ? 1 : 0;
  }
  return a.length - b.length;
}

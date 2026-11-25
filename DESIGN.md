# ShrinkJS — Design

This document explains how ShrinkJS works, why it is built this way, and where the boundaries of its guarantees are. It is written for maintainers and for users who want to reason about a result.

- [Goals and non-goals](#goals-and-non-goals)
- [Architecture](#architecture)
- [The search loop](#the-search-loop)
- [Algorithms](#algorithms)
  - [Delta debugging (ddmin)](#delta-debugging-ddmin)
  - [Structural reduction](#structural-reduction)
  - [Numeric reduction and bisection](#numeric-reduction-and-bisection)
  - [String reduction](#string-reduction)
  - [Simplicity ordering](#simplicity-ordering)
- [Predicate evaluation](#predicate-evaluation)
- [Termination and limits](#termination-and-limits)
- [Results and honest reporting](#results-and-honest-reporting)
- [Reporting and artifacts](#reporting-and-artifacts)
- [Decisions and trade-offs](#decisions-and-trade-offs)
- [Testing strategy](#testing-strategy)

---

## Goals and non-goals

**Goals**

1. Turn one large failing input into a small one, automatically and deterministically.
2. Never lie about what was achieved: no "minimal" claim without a defensible meaning.
3. Be usable in ten lines, configurable in fifty.
4. Stay dependency-free, local and private.
5. Give the result to a human, a CI job, or an AI agent in a machine-readable form.

**Non-goals**

- Proving global minimality (impossible in general; exponential).
- Understanding _why_ an input fails. The predicate defines the target.
- Generating new test data (that is property-based testing; different problem).
- Sandboxing user code.

## Architecture

```text
src/
  index.ts                  public exports (API surface is the contract)
  version.ts                single source of truth for the version string
  core/
    shrink.ts               option validation, config resolution, entry point
    engine.ts               traversal, acceptance, orchestration, result assembly
    evaluator.ts            predicate invocation: timeout, stability, cache, policy
    limits.ts               presets, Budget (evaluations, duration, cancellation)
    result.ts               statistics and result construction
    history.ts              bounded history recorder
    progress.ts             throttled progress emitter
    errors.ts               typed errors with stable codes
    types.ts                the public type surface
  strategies/
    ddmin.ts                classic delta debugging + partitioning
    strategy.ts             NodeStrategy/NodeContext contracts
    array.ts                chunk removal over arrays
    object.ts               key removal over objects
    string.ts               character/code-point reduction
    number.ts               numeric candidates + bisection
    boolean.ts, nullish.ts  scalar simplification
    sequence.ts             public minimizeSequence() helper
    registry.ts             built-in strategy list and order
  utils/
    clone.ts                deep clone + input validation per mode
    compare.ts              the simplicity ordering (acceptance criterion)
    serialize.ts            stableKey (cache/dedupe) + compactRepresentation (size)
    paths.ts                addressing nodes inside a value tree
    json-safe.ts            JSON-safe conversion for reports
    format.ts               human formatting helpers
  reporting/
    diff.ts                 structural diff
    json.ts                 machine-readable report
    markdown.ts             human-readable report
    artifacts.ts            artifact directory writer + code generation
    redact.ts               property redaction (reports only)
  cli/
    index.ts                bin entry (SIGINT handling)
    args.ts                 dependency-free argument parser
    run.ts                  command implementation with injectable I/O
    output.ts               colors, progress bar, summary rendering
  integrations/
    shared.ts               framework-agnostic adapter implementation
    vitest/index.ts         @shrinkjs/core/vitest
    jest/index.ts           @shrinkjs/core/jest
```

Dependencies point downward only: `cli`/`integrations`/`reporting` → `core` → `strategies`/`utils`. The core never imports a CLI, reporter or test framework. That is what allows `@shrinkjs/core` to stay dependency-free and lets the adapters be optional subpaths.

The engine mutates nothing it was given: the caller's input is cloned on entry and on the way out.

## The search loop

```text
run()
 ├─ clone input, measure size
 ├─ evaluate original  ── predicate false/throws ──► status "failed", stop
 ├─ loop (bounded by MAX_REDUCER_ROUNDS):
 │    ├─ custom reducers (if any)
 │    ├─ structural pass  ── repeat until a full pass accepts nothing
 │    └─ custom reducers (if any)
 ├─ final verification on a fresh clone
 └─ assemble result (status, stats, history)
```

A **structural pass** streams every addressable node in pre-order and visits each one:

```text
for each path yielded by walkNodes(root, maxDepth, maxNodeVisits):
  if path sorts before the resume point: skip
  if visit(path) accepted: resume from this path
```

`walkNodes` is a generator: memory stays O(depth) instead of materialising the whole node list. It tracks an **ancestor stack** (not a global visited set), so a sub-object shared by two parents is reduced at _both_ paths while true cycles are cut. `maxNodeVisits` bounds graphs with exponentially many paths; when the bound is hit the run reports `limit-reached` (`max-nodes`) instead of claiming minimality over nodes it never examined.

`visitNode(path, value)`:
for strategy in [nullish, boolean, number, string, array, object]:
if strategy.matches(value):
if strategy.reduce(value, ctx) accepted something: return true
return false

````

`ctx.tryCandidate(x)` replaces the node with `x` in the current best input, checks that the whole input became strictly simpler, evaluates the predicate, and — on success — commits `x` as the new best. Strategies therefore never touch engine internals; they propose values and the engine decides.

After an accepted reduction the pass resumes at the same node (not the root). When a pass reaches the end with no acceptance, one complete pass from the root is performed; only if that also accepts nothing does the run declare local minimality. This "restart from the accepted node, then verify from the root" pattern is what makes the greedy traversal safe to reason about: paths stay valid because a reduction only ever rewrites the node it was proposed for.

## Algorithms

### Delta debugging (ddmin)

[`deltaDebug`](../src/strategies/ddmin.ts) implements the classic algorithm from Zeller & Hildebrandt (2002):

1. If the empty sequence satisfies the predicate, return it immediately.
2. Partition the sequence into `n` contiguous chunks (`n = 2` initially).
3. Test each chunk on its own. If one passes, keep it and reset `n = 2`.
4. Otherwise test each chunk's complement. If one passes, keep it and set `n = n - 1`.
5. Otherwise double the granularity (`n = 2n`) and repeat.
6. Stop when a granularity of `|sequence|` yields no success; the result is then **1-minimal** (no single element can be removed).

ShrinkJS adds two bounds that the classic algorithm does not have:

- `maxParts` caps the finest granularity (default 1024 for the helper, 512 for the engine). Above that, results are chunk-minimal and `oneMinimal` is reported as `false` — honestly, not silently.
- `shouldContinue`/`maxTests` let the caller stop when an evaluation budget is exhausted.

Complexity: `O(n log n)` predicate calls in the good case, `O(n²)` in the worst case, versus `O(n)` tests for a naive "delete one item at a time" sweep — and ddmin is far better at finding _large_ removals early. Its known weakness is that it cannot remove two elements at once when removing either alone breaks the predicate; the engine compensates with repeated passes and, for objects/arrays, happens to test complements too.

`partitionIndices` is exported and unit-tested for the invariants "covers every index exactly once" and "never produces an empty partition".

### Structural reduction

Each container type has a strategy:

- **array**: dedupe (when every element has a JSON identity), then ddmin over elements.
- **object**: ddmin over `Object.keys`, rebuilding candidates with the original prototype so class instances stay instances.
- **string**: `""`, trimmed and whitespace-collapsed variants, then ddmin over `Array.from(text)` (Unicode code points, so surrogate pairs are never split).
- **number**: candidates then bisection (below).
- **boolean/nullish**: `false`, `null`, and `undefined` (arrays in `js` mode only).

Nested containers are handled by the traversal, not by the parent's strategy: after an array shrinks, its elements become nodes in the next pass.

### Numeric reduction and bisection

Reducing `98765` with `n > 100` by repeated halving would take log₂(98765) ≈ 17 accepted steps plus overhead, and land on an arbitrary value. Instead:

1. Try simple values: `0`, `1`, `-1`.
2. Try integer-friendly forms: `trunc(n/2)`, `round(n/2)`, `floor`, `ceil`, `trunc(n)`, `round(n)`, `n - sign(n)`, the next lower power of two.
3. **Bisect the magnitude**: keep `lo` (known to fail) and `hi` (known to pass), probe the midpoint, and shrink the interval. Integer inputs use an integer grid (`precision = 1`), fractional inputs use a relative precision of `1e-6`, plus decimal-rounding candidates so `0.4000003337…` becomes `0.4`.

The sign is preserved, the search never crosses zero, and every accepted probe is verified. Result: `98765 → 101` in ~17 predicate calls; `0.75 → 0.4000003… → 0.4` for a fractional boundary; `-98765 → -1` for `n < 0`.

Floating point is never assumed to be exact. Bisection compares magnitudes with `<`, and the stopping rule is an interval width, not equality.

### Simplicity ordering

Acceptance is driven by `compareSimplicity(candidate, current) < 0` evaluated on the **whole input**. The ordering is total (a preorder with ties) and well-founded for finite data:

| Rank  | Types                        |
| ----- | ---------------------------- |
| 0     | `undefined`                  |
| 1     | `null`                       |
| 2     | boolean (`false` < `true`)   |
| 3     | number                       |
| 4     | bigint                       |
| 5     | string                       |
| 6     | array                        |
| 7     | object                       |
| 8–11  | Map, Set, Date, RegExp       |
| 12    | binary (ArrayBuffer / views) |
| 14–15 | function, symbol             |

Within a type:

- **number**: `NaN` is the most complex, then `±Infinity`, then finite values ordered by magnitude, positive before negative, integers before fractions. `-0` is slightly more complex than `0`.
- **bigint**: same magnitude/sign rules.
- **string**: length, then code-unit order.
- **array**: length, then element-wise.
- **object**: key count, then sorted key names, then values.
- **Map/Set**: size, then entries.
- **Date**: absolute time; **RegExp**: source length then source.

Why a single global ordering instead of per-node heuristics? Because two properties fall out for free:

1. **Termination.** A strictly decreasing well-founded measure cannot cycle, so "keep reducing" always terminates even with custom reducers in the mix.
2. **Determinism.** Candidate choice does not depend on traversal history, wall clock or randomness.

Ties are broken by returning `0` ("equivalent"), and equivalent candidates are _not_ accepted — this is what prevents `{a:1}` ↔ `{b:1}` ping-pong.

Cycle safety: comparisons track visited `(a,b)` object-id pairs and stop at depth 64, so circular structures compare in bounded time.

### Predicate evaluation

[`Evaluator`](../src/core/evaluator.ts) is the only place user code runs.

```text
evaluate(candidate):
  key = stableKey(candidate)               (cache lookup, optional)
  repeat `runs` times:
      invoke predicate with a timeout
      normalize the result (boolean | { preserve, signature, metadata })
  combine runs:
      majority must reach `requiredMatches`
      signatures must agree, otherwise the candidate is "unstable"
  cache the outcome (bounded map, cleared when full)
````

- **Timeout**: `Promise.race` against a timer. The predicate's promise is not cancellable — its later settlement is swallowed (`call.catch(() => undefined)`) so a slow callback cannot produce an unhandled rejection. This is documented: the work is abandoned, not stopped.
- **Policy** (`predicateErrors`): `ignore` (default) rejects the candidate and counts the error; `fail` aborts the run; `preserve` counts the exception as a reproduction and warns once.
- **Signature pinning**: the original input's signature becomes the expected one; candidates reporting a different signature are rejected and counted in `stats.signatureMismatches`. This is the guard against "the bug changed into a different bug".
- **Cache keys** come from `stableKey`, a type-tagged canonical string with sorted object keys and numbered repeated references. Repeated references hash differently from duplicated ones, which can cost a cache miss but can never produce a false hit.

### Final verification

After the search, the engine deep-clones the result and evaluates it once more (`evaluateFresh`, bypassing the cache). If it does not reproduce, the status becomes `unstable` with an explicit warning. This catches the two most common predicate hazards: mutation of the candidate and non-determinism that `stability` was not configured for. It costs exactly one predicate call.

## Termination and limits

Three independent guards:

1. **Monotone measure** — accepts strictly decrease the simplicity ordering, so the search cannot revisit a state.
2. **Budget** — `maxEvaluations`, `maxDuration`, `maxPasses`, `maxNodeVisits`, `maxInputDepth`, `maxCandidatesPerNode`, `maxDepth`, `maxInputSize`. `Budget` records the _first_ reason and aborts the internal `AbortSignal`, which strategies poll via `ctx.isExhausted()`.
3. **Abort signal** — the caller's `AbortSignal` is combined with the internal one; cancellation returns the best-so-far with `status: "cancelled"`. An in-flight predicate call cannot be interrupted: the abort takes effect when it settles (a `predicateTimeout` bounds the wait).

`0` disables a numeric limit. `maxInputSize` is checked before any evaluation (cheap rejection of pathological inputs). `maxInputDepth` is enforced by the iterative input validator before cloning, because the clone, size and serialisation helpers are recursive; this turns a potential `RangeError` into `ERR_UNSUPPORTED_INPUT` with the offending path.

Reducer loops are bounded twice: per accept-chain (`max-reducer-rounds`, 10k) and per engine alternation (1k). If either guard trips, the run reports `limit-reached` instead of pretending it reached a fixpoint.

## Packaging

The published surface is split by runtime, because a debugging library should not force `node:fs` into a browser bundle:

| Entry                | Contents                                                         | Node built-ins  |
| -------------------- | ---------------------------------------------------------------- | --------------- |
| `.`                  | engine, evaluator, strategies, utils, pure report builders       | none            |
| `./artifacts`        | `writeArtifacts`, generated reproduction/regression sources      | yes (`node:fs`) |
| `./reporting`        | the pure builders re-exported together with the artifact writers | yes             |
| `./vitest`, `./jest` | adapters that call the core and (optionally) the artifact writer | yes             |

`scripts/verify-exports.mjs` enforces this: it links the package into a temporary `node_modules`, imports every subpath as ESM, `require()`s the root, compiles a strict `node16` consumer (`types: []`, no DOM lib) against the declarations, and walks the built root import graph to assert no `node:` specifier is reachable.

## Results and honest reporting

| Status          | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `completed`     | Full pass accepted nothing; final verification passed.      |
| `limit-reached` | A budget stopped the search; `stats.limitReached` names it. |
| `cancelled`     | External abort.                                             |
| `unstable`      | Predicate disagreed with itself (run or verification).      |
| `failed`        | Could not establish the target at all.                      |

`minimality` is `"local"` only for `completed`; otherwise `"unknown"`. The README and every generated report repeat the definition:

> locally minimal = no candidate produced by the enabled reducers for the final input was accepted.

Sizes are counts of characters in a compact representation (see README, "Measuring size"); they are consistent within a run and comparable across runs of the same data, but they are not bytes and not compressed size.

## Reporting and artifacts

Reports are pure functions of a `ShrinkResult`, so they can be produced anywhere:

- **JSON** (`createJsonReport`) — version, timestamp, source, status, minimality, stats, config, minimal input, structural diff, history, warnings, error. The original input is deliberately omitted (size, privacy).
- **Markdown** (`createMarkdownReport`) — summary table, minimal reproduction, diff, per-strategy statistics, configuration, history, warnings, limitations.
- **Diff** (`diffValues`) — structural, not textual: object keys by name, arrays by common prefix/suffix (so a removal is one `-` line, not an index-shifted cascade), everything else by identity.
- **Artifacts** (`writeArtifacts`) — `result.json`, `minimized-input.json`, `report.md`, `reproduction.mjs`, `regression.test.ts`. Existing files are skipped unless `overwrite: true`. The reproduction script is plain Node ESM; the regression test targets Vitest.

## Decisions and trade-offs

**Why ddmin instead of random or genetic search?**
Deterministic, explainable, and it produces a _causally minimal_ subset for monotone predicates. Random search makes reproducibility impossible, which is the opposite of what a bug-reproduction tool needs.

**Why a global simplicity ordering instead of "accept anything that passes"?**
Without an ordering, custom reducers and cross-type candidates can oscillate. The ordering also gives a cheap pre-filter: candidates that are not simpler never reach the predicate, which saves the most expensive resource.

**Why is `predicateErrors` default `"ignore"`?**
Because strategies intentionally propose wrong-shaped values (`null`, `{}`), and most predicates legitimately throw on them. Treating those throws as "fail" makes the library unusable; treating them as "preserve" invents bugs. `ignore` is the only option consistent with "an exception is not evidence". The cost — a systematically broken predicate looks like "nothing to minimize" — is mitigated by counting errors and emitting a warning with the first error message.

**Why clone instead of using structural sharing on the caller's object?**
The engine must be able to hand out `originalInput` and `minimalInput` that are independent of each other and of the caller's data. Deep cloning once at the start and once at the end is cheap relative to thousands of predicate calls.

**Why is the minimal input _not_ type-identical to the input?**
Cross-type simplification (`{...}` → `null`, `"text"` → `""`) finds dramatically smaller reproductions. The predicate is the type guard; ShrinkJS will not invent a value the predicate rejects. Users who need type stability can assert it inside the predicate.

**Why no `any` in the public API?**
`ShrinkResult<T>` and `ShrinkOptions<T>` thread the input type through, so `result.minimalInput` has the caller's type. The engine internally works with `unknown` and narrows at the boundaries.

**Why ESM-only with a `type: "module"` package?**
Dual builds via two compilers invite `require`/`import` mismatches and inflated tarballs. Node ≥ 20.19 can `require()` ESM natively, and every modern bundler consumes ESM. If a real dual-build need appears, it can be added without breaking the API.

**Why does the CLI accept JSON inputs only?**
Executing an arbitrary module to _produce_ an input would silently run project code, which the CLI is designed not to do. JSON covers the CLI workflow; non-JSON inputs belong in the API where the user writes the code explicitly.

## Testing strategy

- **Unit**: `ddmin` invariants (subsequence, 1-minimality, partition coverage), ordering rules, cloning, paths, diffing, redaction, arg parsing, formatting.
- **Behavioural**: each strategy through the public `shrink()` API with exact expected minimal values (the engine is deterministic, so this is a meaningful assertion rather than a snapshot of chance).
- **Contract**: limits (each one, including `0 = unlimited`), cancellation mid-run, predicate errors under all three policies, timeouts, stability, signature drift, final verification failure, invalid configs.
- **Integration**: CLI end-to-end with real files and a spawned binary; artifact generation including _executing_ the generated reproduction script; adapter tests.
- **Package**: export map, `bin` shebang, version sync, tarball contents, `publint`.

Benchmarks live in `bench/` and verify correctness before timing, so a performance regression cannot hide behind a wrong answer.

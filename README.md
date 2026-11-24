# ShrinkJS

**Automatically minimize JavaScript and TypeScript inputs while preserving a user-defined failure or behavior.**

ShrinkJS is a deterministic, local-first minimization engine for bug reproduction. Give it a large input and a predicate that says "this still reproduces the problem", and it searches for a much smaller input that keeps that predicate true — typically turning a 137 kB JSON payload into 31 bytes, or a 100 kB string into the two characters that trigger a parser bug.

- No AI, no network calls, no telemetry, no dependencies.
- TypeScript-first, ESM, typed generic API that preserves your input type.
- Real algorithms: Delta Debugging (`ddmin`), bisection for numbers, chunked string/array/object reduction, and a total simplicity ordering that prevents oscillation.
- Honest reporting: it tells you whether the result is _locally minimal_, _limit-reached_, _cancelled_, or _unstable_ — and never claims mathematical minimality.
- Ships with a CLI, JSON/Markdown reports, a structural diff, and generated regression tests.

> **Package name.** The unscoped npm name `shrinkjs` is already taken by an unrelated, deprecated image-compression package, so this project publishes as **`@shrinkjs/core`**. The repository and project name remain _ShrinkJS_.

---

## Table of contents

- [The problem](#the-problem)
- [Why minimization matters](#why-minimization-matters)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How it works (30 seconds)](#how-it-works-30-seconds)
- [Real-world examples](#real-world-examples)
- [API](#api)
  - [`shrink(options)`](#shrinkoptions)
  - [Options](#options)
  - [Result](#result)
  - [Predicates, signatures and stability](#predicates-signatures-and-stability)
  - [Limits and cancellation](#limits-and-cancellation)
  - [Progress and history](#progress-and-history)
  - [Custom reducers](#custom-reducers)
  - [Standalone helpers](#standalone-helpers)
- [Supported input types](#supported-input-types)
- [Built-in reduction strategies](#built-in-reduction-strategies)
- [Measuring size](#measuring-size)
- [CLI](#cli)
- [Reports and artifacts](#reports-and-artifacts)
- [Performance tuning](#performance-tuning)
- [Test framework integrations](#test-framework-integrations)
- [Limitations](#limitations)
- [Safety and privacy](#safety-and-privacy)
- [Benchmarks](#benchmarks)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## The problem

A bug report says "this request fails". The request is 4,000 lines of JSON. Somewhere inside it is a combination of three fields that matters. Finding it by hand means deleting things, re-running, and repeating — the exact task computers are good at and humans are bad at.

Shrinking libraries exist for property-based testing (Hypothesis, fast-check, QuickCheck), but there has been no small, framework-agnostic tool for the common case: _"I have one failing input, find me the smallest one that still fails."_

## Why minimization matters

- A 30-byte reproduction is a bug report someone can act on. A 137 kB dump is not.
- Minimized cases isolate the cause: irrelevant fields, headers and log noise disappear.
- They become permanent regression tests (ShrinkJS generates the file for you).
- They are ideal input for a code review, an upstream issue, or an AI coding agent: tiny, deterministic, and self-contained.

ShrinkJS is **not** an AI debugger and does not "understand" bugs. _You_ define what must be preserved through a predicate. ShrinkJS systematically searches for smaller inputs that satisfy it.

## Installation

```bash
npm install --save-dev @shrinkjs/core
# or
pnpm add -D @shrinkjs/core
yarn add -D @shrinkjs/core
```

Requirements: Node.js **≥ 20.19** (tested on Node 24). The package is ESM-first; CommonJS consumers on Node ≥ 20.19 can `require("@shrinkjs/core")` thanks to native `require(esm)` support.

## Quick start

```ts
import { shrink } from "@shrinkjs/core";

const result = await shrink({
  input: largePayload,
  test: async (candidate) => {
    try {
      await processPayload(candidate);
      return false; // no failure: not interesting
    } catch (error) {
      return error instanceof InvalidPriceError; // still reproduces: keep it
    }
  },
});

console.log(result.minimalInput);
console.log(result.stats.reductionPercent, "% smaller");
```

That is the whole API for the common case. Everything else is optional.

```ts
import { shrink } from "@shrinkjs/core";

const result = await shrink({
  input: {
    users: [
      { id: 1, name: "Alice", active: true },
      { id: 2, name: "Bob", active: false },
      { id: 3, name: "Charlie", active: true },
    ],
    metadata: { source: "web", version: "1.0.0" },
  },
  test: (candidate) => candidate.users.some((user) => user.name === "Bob"),
});

// result.minimalInput  -> { users: [{ name: "Bob" }] }
// result.status        -> "completed"
// result.minimality    -> "local"
```

## How it works (30 seconds)

1. The original input is deep-cloned and evaluated once. If the predicate rejects it, the run fails immediately with `ERR_PREDICATE_NOT_PRESERVED` — there is nothing to minimize.
2. The engine walks the input tree. At each node, strategies propose candidates: `null`, `{}`, `[]`, `""`, `0`, `false`, a shorter array, an object without some keys, a shorter string, a smaller number.
3. A candidate is evaluated only if it makes the whole input **strictly simpler** (see [the ordering](#the-simplicity-ordering)). Accepted candidates become the new best input and the walk continues.
4. The run ends when a **complete pass over every node accepts nothing**. That is what `minimality: "local"` means: _no candidate from the enabled reducers was accepted_ — not mathematical minimality.
5. A fresh copy of the final input is re-evaluated (`verifyFinalInput`). If it no longer reproduces, the result is reported as `status: "unstable"` instead of pretending it succeeded.

All of this is deterministic: the same input, predicate and limits produce the same result.

## Real-world examples

Every example in [`examples/`](examples) runs against the built package:

```bash
npm run build
node examples/run-all.mjs
```

| #   | Example                                                      | What it shows                                              | Actual output                                                                                |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | [API payload](examples/01-api-payload.mjs)                   | A 6.1 kB order request with one invalid line item          | `{"items":[{"quantity":0}]}` — 99.6 % smaller, 25 evaluations                                |
| 2   | [Checkout error](examples/02-checkout-error.mjs)             | Preserving a specific error signature (`INVALID_PRICE`)    | `{"customer":{},"items":[{"price":-1}]}` — 97.6 % smaller                                    |
| 3   | [String parser](examples/03-string-parser.mjs)               | A 2.3 kB expression reduced to the triggering character    | `"("` — 99.9 % smaller, 25 evaluations                                                       |
| 4   | [Array processing](examples/04-array-processing.mjs)         | A wrong result (not an exception) with 200 rows            | `[{"amount":-1}]`                                                                            |
| 5   | [Custom reducer](examples/05-custom-reducer.mjs)             | Base64-encoded config; only a domain reducer can shrink it | 285 B → 66 B, custom strategy used 18 times                                                  |
| 6   | [Async predicate](examples/06-async-predicate.mjs)           | I/O-bound predicate with a per-call timeout                | `{"options":{"format":"webp"}}` in 0.56 s                                                    |
| 7   | [Regression artifacts](examples/07-regression-artifacts.mjs) | Writing a reproducible test file                           | `result.json`, `minimized-input.json`, `reproduction.mjs`, `regression.test.ts`, `report.md` |

Example 2, in full:

```ts
import { shrink } from "@shrinkjs/core";

const result = await shrink({
  input: order,
  test: async (candidate) => {
    try {
      await processOrder(candidate);
      return false;
    } catch (error) {
      // Only the INVALID_PRICE failure counts, and the signature pins the run
      // to that failure class even if another error appears later.
      return { preserve: error?.code === "INVALID_PRICE", signature: error?.code };
    }
  },
});
```

## API

Everything below is exported from the package root.

### `shrink(options)`

```ts
function shrink<T>(options: ShrinkOptions<T>): Promise<ShrinkResult<T>>;
```

Minimizes `options.input` while `options.test` keeps holding. `minimize` is an alias.

- Programmer errors (bad configuration, unsupported input, input larger than `limits.maxInputSize`) reject the promise with a typed `ShrinkError`.
- Predicate problems **never throw**: they are reported through `result.ok === false` and `result.error`.

### Options

| Option              | Type                                                            | Default                                | Meaning                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`             | `T`                                                             | —                                      | Input to minimize. Never mutated. Must be declared, even if `undefined`.                                                                                                   |
| `test`              | `(candidate: T) => PredicateResult \| Promise<PredicateResult>` | —                                      | Decides whether a candidate still reproduces the target behavior.                                                                                                          |
| `mode`              | `"json" \| "js"`                                                | `"json"`                               | `json` accepts JSON-compatible values (plus `undefined`); `js` also supports `Map`, `Set`, `Date`, `RegExp`, `BigInt`, `Buffer`, typed arrays, class instances and cycles. |
| `preset`            | `"fast" \| "balanced" \| "thorough"`                            | `"balanced"`                           | Starting point for `limits`. Explicit `limits` win.                                                                                                                        |
| `limits`            | `ShrinkLimits`                                                  | see [limits](#limits-and-cancellation) | Execution bounds.                                                                                                                                                          |
| `predicateErrors`   | `"ignore" \| "fail" \| "preserve"`                              | `"ignore"`                             | How predicate exceptions and timeouts are treated.                                                                                                                         |
| `preserveSignature` | `boolean`                                                       | `true`                                 | Reject candidates whose failure signature differs from the original's.                                                                                                     |
| `stability`         | `{ runs, requiredMatches }`                                     | off                                    | Repeat the predicate per candidate to tolerate flaky behavior.                                                                                                             |
| `history`           | `{ enabled, maxEntries, includeValues }`                        | off                                    | Record reduction steps (bounded).                                                                                                                                          |
| `cache`             | `boolean`                                                       | `true`                                 | Memoize predicate results per structurally identical candidate.                                                                                                            |
| `verifyFinalInput`  | `boolean`                                                       | `true`                                 | Re-run the predicate on a fresh copy before returning.                                                                                                                     |
| `onProgress`        | `(event: ProgressEvent) => void`                                | —                                      | Throttled progress callback (contains no input values).                                                                                                                    |
| `signal`            | `AbortSignal`                                                   | —                                      | Cancels the run; the best input found so far is returned.                                                                                                                  |
| `reducers`          | `CustomReducer<T>[]`                                            | `[]`                                   | Domain-specific reducers.                                                                                                                                                  |

### Result

```ts
interface ShrinkResult<T> {
  ok: boolean; // false only when the target could not be established
  status: "completed" | "limit-reached" | "cancelled" | "unstable" | "failed";
  originalInput: T; // deep copy of what you passed in
  minimalInput: T; // smallest input found
  minimality: "local" | "unknown";
  signature: string | null; // signature reported for the original input
  stats: ShrinkStats;
  history?: HistoryEntry[];
  error?: { message: string; code: string; name?: string };
  warnings: string[];
  config: ResolvedConfigSummary;
}
```

Status semantics:

| Status          | Meaning                                                                                                                                                | `ok`                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `completed`     | A full pass found nothing to accept, and the final input was verified.                                                                                 | `true`                                                     |
| `limit-reached` | A limit (`maxEvaluations`, `maxDuration`, `maxPasses`, ...) stopped the search. The result is the best found so far. `stats.limitReached` says which.  | `true`                                                     |
| `cancelled`     | The `AbortSignal` fired. Best-so-far is returned.                                                                                                      | `true`                                                     |
| `unstable`      | The run finished, but repeated predicate evaluations disagreed (either during the run, or on the final verification). Treat the result with suspicion. | `true`*, `false` if the original input itself was unstable |
| `failed`        | Nothing could be minimized: the predicate rejected the original input, threw, or returned an invalid result.                                           | `false`                                                    |

`minimality: "local"` is only reported for `completed` runs. It means: _no candidate generated by any enabled reducer for the final input was accepted._ It does not mean "smallest possible input".

### `stats`

| Field                             | Meaning                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `originalSize` / `finalSize`      | Characters in the [canonical representation](#measuring-size). |
| `reductionPercent` / `savedChars` | Derived from the two sizes, rounded to one decimal.            |
| `evaluations`                     | Predicate invocations (cache hits excluded).                   |
| `cacheHits`                       | Candidates answered from the cache.                            |
| `successfulReductions`            | Accepted candidates.                                           |
| `rejectedCandidates`              | Evaluated candidates that were not accepted.                   |
| `predicateErrors` / `timeouts`    | Predicate throws and per-call timeouts.                        |
| `unstableCandidates`              | Candidates discarded because repeated runs disagreed.          |
| `signatureMismatches`             | Candidates rejected for reproducing a _different_ failure.     |
| `verification`                    | `{ performed, preserved }` for the fresh-copy re-run.          |
| `strategies`                      | Per-strategy `{ attempts, accepted, rejected }`.               |
| `passes`                          | Structural passes executed.                                    |
| `limitReached`                    | The limit that stopped the run, or `null`.                     |
| `durationMs`                      | Wall-clock time.                                               |

### Predicates, signatures and stability

A predicate returns `boolean`, or an object:

```ts
type PredicateResult =
  | boolean
  | {
      preserve: boolean;
      signature?: string; // e.g. an error code
      metadata?: Record<string, unknown>; // ignored by the engine
    };
```

**Signatures.** When a predicate reports a signature, the engine records the original's and refuses candidates that report a different one. This prevents the classic shrinking failure mode where the input stops failing with _your_ bug and starts failing with a _different_ one.

```ts
test: async (candidate) => {
  try {
    await run(candidate);
    return false;
  } catch (error) {
    return { preserve: error.code === "INVALID_PRICE", signature: error.code };
  }
};
```

Set `preserveSignature: false` to allow drift (rarely what you want).

**Predicate errors.** Default `"ignore"`: an exception or timeout means _this candidate is not interesting_, and the candidate is skipped. Errors are counted in `stats.predicateErrors` / `stats.timeouts` and surfaced as a warning. This is the safe default — an exception is never mistaken for a reproduction — but it can hide a broken predicate, so read the warnings.

Other policies:

- `"fail"` — abort immediately with `status: "failed"` and `error.code: "ERR_PREDICATE_FAILED"`.
- `"preserve"` — treat the exception as a reproduction (**dangerous**: reduction will happily walk into the throwing region). Use it only when the exception itself is the signal.

Note that built-in strategies _will_ propose values of the wrong shape (`null`, `{}`). Guarding your predicate with `typeof`/`in` checks is good practice and makes the run cheaper.

**Stability.** For flaky predicates:

```ts
await shrink({
  input,
  test,
  stability: { runs: 3, requiredMatches: 2 }, // 3x the predicate cost
});
```

Each candidate is evaluated `runs` times; the dominant result must gather at least `requiredMatches` votes and agreeing signatures, otherwise the candidate is rejected as unstable. This multiplies predicate cost by `runs` — use it only when you need it.

### Limits and cancellation

| Limit                  | Default (balanced) | Notes                                                               |
| ---------------------- | ------------------ | ------------------------------------------------------------------- |
| `maxEvaluations`       | `5_000`            | `0` disables the limit. Cache hits are free.                        |
| `maxDuration`          | `60_000` ms        | Wall clock. `0` disables.                                           |
| `predicateTimeout`     | `5_000` ms         | Per call. `0` disables. Timed-out work is abandoned, not cancelled. |
| `maxDepth`             | `32`               | Containers deeper than this are not descended into.                 |
| `maxCandidatesPerNode` | `2_000`            | Caps candidates per node per visit.                                 |
| `maxInputSize`         | `10_000_000` chars | Larger inputs are rejected up front (`ERR_INPUT_TOO_LARGE`).        |
| `maxPasses`            | `1_000`            | Structural passes (loop guard).                                     |

Presets:

| Preset     | maxEvaluations | maxDuration | predicateTimeout | maxInputSize |
| ---------- | -------------- | ----------- | ---------------- | ------------ |
| `fast`     | 500            | 15 s        | 2 s              | 2 M chars    |
| `balanced` | 5,000          | 60 s        | 5 s              | 10 M chars   |
| `thorough` | 100,000        | 600 s       | 15 s             | 50 M chars   |

Cancellation:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const result = await shrink({ input, test, signal: controller.signal });
// result.status === "cancelled", result.minimalInput still reproduces
```

### Progress and history

```ts
await shrink({
  input,
  test,
  onProgress: (progress) => {
    // { evaluations, accepted, rejected, originalSize, bestSize, currentSize,
    //   strategy, path?, elapsedMs, phase }
    console.log(`${progress.evaluations} evals, best ${progress.bestSize} chars`);
  },
  history: { enabled: true, maxEntries: 500 },
});
```

- Progress events are throttled (40 ms) and never include input values or paths' values — only `$.users[3].name`-style locations. A throwing callback cannot break the run.
- History is off by default. With `includeValues: false` (default) entries store sizes, strategy, path and outcome only. When the cap is reached, rejected entries are evicted before accepted ones, so the retained history keeps the steps that mattered.

### Custom reducers

Reducers receive the _whole current input_ and return candidate replacements. They run before and after structural passes, and are repeated until they stop helping.

```ts
import { shrink, type CustomReducer } from "@shrinkjs/core";

const dropHeaders: CustomReducer<Request> = {
  name: "drop-headers",
  priority: 10, // lower runs first (default 100)
  reduce(request, context) {
    if (!request.headers) return [];
    return [{ ...request, headers: {} }];
  },
};
```

They may return an array, any iterable, an async iterable, or a promise of one:

```ts
const encodings: CustomReducer<Payload> = {
  name: "re-encode",
  async *reduce(payload) {
    for (const variant of await decodeAndSimplify(payload.body)) {
      yield { ...payload, body: encode(variant) };
    }
  },
};
```

Rules:

- A candidate is only considered if it is **strictly simpler** under the engine ordering; returning a larger or unrelated value is ignored, never accepted.
- Return fresh objects (or immutable values). The engine may keep an accepted candidate as the new best input.
- Throwing from a reducer fails the run with `ERR_INVALID_CONFIG`.
- `context` carries `evaluations`, `elapsedMs`, `currentSize`, `originalSize`, `pass`, `signal`, `isExhausted()`.

Two realistic uses:

1. **Signed requests** ([test](tests/strategies/custom-reducers.test.ts)): removing one header invalidates an HMAC, so the structural reducers cannot touch `headers`. A reducer that drops the whole set and re-signs unlocks the reduction.
2. **Opaque encodings** ([example 5](examples/05-custom-reducer.mjs)): the real config is base64-encoded, so string mutations only produce invalid base64. A reducer that decodes, deletes a key, and re-encodes produces valid smaller candidates — 285 B → 66 B in 205 evaluations.

### Standalone helpers

```ts
import {
  deltaDebug, // classic ddmin over any array
  minimizeSequence, // sequence reduction with optional per-item simplification
  sizeOf, // character size of the canonical representation
  compareSimplicity, // the ordering used to accept candidates
  deepClone,
  diffValues, // structural diff
} from "@shrinkjs/core";

const { items, tests, oneMinimal } = await deltaDebug(events, async (candidate) => {
  return candidate.some((event) => event.type === "checkout");
});

const reduced = await minimizeSequence(recordedToolCalls, {
  test: (calls) => calls.some((call) => call.name === "delete_repository"),
  simplifyItem: (call) => [{ ...call, arguments: {} }],
});
```

## Supported input types

| Type                                               | `json` mode      | `js` mode                                                             |
| -------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `string`, `number`, `boolean`, `null`, `undefined` | ✅               | ✅                                                                    |
| Plain objects and arrays (any nesting)             | ✅               | ✅                                                                    |
| `BigInt`                                           | ❌               | ✅                                                                    |
| `Date`, `RegExp`                                   | ❌               | ✅ (leaves: cloned, not reduced)                                      |
| `Map`, `Set`                                       | ❌               | ✅ (leaves: cloned, not reduced unless a custom reducer handles them) |
| `Buffer`, typed arrays, `ArrayBuffer`, `DataView`  | ❌               | ✅ (cloned; measured by byte length)                                  |
| Class instances                                    | ❌               | ✅ (own enumerable properties preserved, prototype kept)              |
| Circular references                                | ❌ (clear error) | ✅                                                                    |
| Functions, symbols                                 | ❌               | ❌ (cannot be cloned meaningfully)                                    |

`json` mode is strict on purpose: whatever comes out can be `JSON.stringify`-ed. Cycles are rejected with an actionable error instead of being silently corrupted.

Cloning rules: own enumerable string-keyed properties are copied (symbol keys and non-enumerable/accessor properties are not), prototypes are preserved, and cycles are handled with a `WeakMap`.

## Built-in reduction strategies

| Strategy  | What it proposes                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nullish` | `null` for any non-null value (in `js` mode, `undefined` for array elements too).                                                                                                                            |
| `boolean` | `false` for `true`.                                                                                                                                                                                          |
| `number`  | `0`, `1`, `-1`, integer truncation/rounding, one step toward zero, the next lower power of two, decimal rounding, then **bisection** toward zero to find the failure boundary. Integer inputs stay integers. |
| `string`  | `""`, trimmed/collapsed whitespace, then `ddmin` over Unicode code points (chunked for long strings).                                                                                                        |
| `array`   | duplicate removal, then `ddmin` over elements (chunk and single-element removal).                                                                                                                            |
| `object`  | `ddmin` over own enumerable keys, preserving the prototype.                                                                                                                                                  |

Numeric bisection is the reason `98765 → 101` for `n > 100` takes about 17 evaluations instead of 98,000.

### The simplicity ordering

Every accepted reduction must make the whole input _strictly simpler_. Without a total ordering the engine can oscillate (`{a:1}` → `{b:1}` → `{a:1}` …). The rules are documented in [DESIGN.md](DESIGN.md#simplicity-ordering) and summarised here:

1. Type: `undefined` < `null` < boolean < number < bigint < string < array < object < Map < Set < Date < RegExp < binary < function/symbol.
2. Numbers: finite before `Infinity` before `NaN`; then by magnitude, positive before negative, integers before fractions.
3. Strings: shorter first, then lexicographic.
4. Containers: fewer entries first, then contents.
5. `Date`, `RegExp`, binary values: size first, then content.

Because the ordering is well-founded for finite structures and every accept strictly decreases it, the search cannot loop.

## Measuring size

`sizeOf(value)` counts the characters of a compact, JSON-like representation:

| Value                           | Representation               | Size      |
| ------------------------------- | ---------------------------- | --------- |
| `{"a":1}`                       | `{"a":1}`                    | 7         |
| `[1,2,3]`                       | `[1,2,3]`                    | 7         |
| `"hi"`                          | `"hi"`                       | 4         |
| `undefined`                     | `undefined`                  | 9         |
| `-0`, `NaN`, `Infinity`         | `-0`, `NaN`, `Infinity`      | 2 / 3 / 8 |
| `10n`                           | `10n`                        | 3         |
| `new Date(0)`                   | `"1970-01-01T00:00:00.000Z"` | 26        |
| `/ab+/gi`                       | `/ab+/gi`                    | 7         |
| `Map{...}`, `Set{...}`          | `Map{"k"=>1}`, `Set{1,2}`    | —         |
| `Buffer<3>` / `Uint8Array[1,2]` | byte count / byte list       | —         |
| cycles                          | `[Circular]`                 | 10        |

Limitations, stated plainly: these are **UTF-16 code units**, not UTF-8 bytes (a 3-byte emoji counts as 2), and they are a proxy for "how much input is there", not compressed size. They are consistent, which is what the reduction needs.

## CLI

```bash
npx shrinkjs minimize \
  --input examples/fixtures/order.json \
  --test examples/predicates/checkout.mjs \
  --output ./shrinkjs-output
```

Real output of that command:

```text
  ShrinkJS 0.1.0 · input minimization
  ────────────────────────────────────────────

  Input      examples/fixtures/order.json  (1.6 kB)
  Predicate  examples/predicates/checkout.mjs (default export)
  Preset     balanced

✓ Target behavior preserved

   Original      1.6 kB  (1,554 chars)
   Minimized       38 B  (38 chars)
   Saved          97.6%  10 accepted reductions
   Duration       32 ms  34 evaluations · 35 cache hits
   Status     completed  locally minimal for the enabled reducers
   Signature  INVALID_PRICE

  Minimal input
  {
    "customer": {},
    "items": [
      {
        "price": -1
      }
    ]
  }

  Artifacts .tmp/checkout
    ✓ result.json
    ✓ minimized-input.json
    ✓ report.md
    ✓ reproduction.mjs
    ✓ regression.test.ts

  Next node .tmp/checkout/reproduction.mjs
```

The predicate module exports a function as `default` (or a named `test`):

```js
// tests/reproduce.mjs
export default async function test(candidate) {
  try {
    await reproducesTargetBug(candidate);
    return false;
  } catch (error) {
    return { preserve: error.code === "INVALID_PRICE", signature: error.code };
  }
}
```

Input is JSON only (or `-` for stdin); the CLI never executes arbitrary project files beyond the predicate module you point it at.

| Flag                                                                                                                | Meaning                                                  |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `--input <file>`                                                                                                    | JSON input, or `-` for stdin.                            |
| `--test <module>`                                                                                                   | Predicate module (`.mjs`, `.js`, `.ts` on Node ≥ 22.18). |
| `--test-export <name>`                                                                                              | Use a named export instead of `default`/`test`.          |
| `--output <dir>`                                                                                                    | Artifact directory (default `./shrinkjs-output`).        |
| `--preset <name>`                                                                                                   | `fast` / `balanced` / `thorough`.                        |
| `--max-evaluations`, `--predicate-timeout`, `--max-duration`, `--max-depth`, `--max-input-size`, `--max-candidates` | Limits.                                                  |
| `--history`                                                                                                         | Record reduction history.                                |
| `--no-cache`, `--no-verify`                                                                                         | Disable memoization / final verification.                |
| `--no-artifacts`                                                                                                    | Do not write files.                                      |
| `--force`                                                                                                           | Overwrite existing artifacts.                            |
| `--redact <keys>`                                                                                                   | Comma-separated property names to redact in reports.     |
| `--json`                                                                                                            | Print the machine-readable report to stdout.             |
| `--quiet`, `--verbose`, `--no-progress`, `--no-color`                                                               | Output control.                                          |

Exit codes: `0` success (including `limit-reached` and `unstable`), `1` target behavior not established, `2` usage/input error, `130` cancelled (Ctrl+C).

## Reports and artifacts

```ts
import { createJsonReport, createMarkdownReport, diffValues, writeArtifacts } from "@shrinkjs/core";

const markdown = createMarkdownReport(result, { inputSource: "fixtures/order.json" });
const report = createJsonReport(result, { redact: { keys: ["token", "password"] } });

await writeArtifacts(result, {
  outputDir: "shrinkjs-output",
  testModule: "tests/reproduce.mjs",
  name: "checkout",
});
```

`writeArtifacts` produces:

```text
shrinkjs-output/
  result.json            machine-readable report (version, status, stats, config, minimal input, diff, history)
  minimized-input.json   the reduced input, ready to paste into a fixture
  reproduction.mjs       runnable script: `node reproduction.mjs` re-runs your predicate
  regression.test.ts     Vitest test asserting the minimized case still reproduces
  report.md              human-readable report with summary, diff, statistics, config and limitations
```

Safety: files are never overwritten unless `overwrite: true` (CLI: `--force`); existing files are reported as `skipped`. Output paths are fixed inside the chosen directory.

The **structural diff** compares values, not text: object keys are compared by name, arrays by common prefix/suffix, and non-JSON values by identity/size. Redaction applies to the report, the diff previews and the history — but intentionally **not** to `minimized-input.json`, which stays runnable.

## Performance tuning

Reduction cost is dominated by predicate calls, and predicates are usually the slow part (they may spawn processes or hit a local server). Practical advice:

1. **Start with `preset: "fast"`** while iterating on the predicate, then rerun with `balanced`/`thorough`.
2. **Raise `maxEvaluations`, not timeouts.** A run that ends at 58 evaluations for a 137 kB payload is normal; pathological inputs hit the limit instead of hanging.
3. **Return cheap booleans.** Catching a specific error is cheaper than serializing the whole candidate for comparison.
4. **Use `cache: true`** (default) — repeated candidate shapes are answered for free.
5. **Add a custom reducer** for opaque encodings (base64, signatures, compressed blobs) where structural mutations cannot succeed.
6. **Use `stability` only for flaky predicates**; it multiplies cost by `runs`.

## Test framework integrations

The core has no test-framework dependency. Thin adapters are available as subpath exports:

```ts
// tests/checkout.shrink.test.ts
import { describe, expect, it } from "vitest";
import { minimizeTestCase } from "@shrinkjs/core/vitest";

describe("checkout regression", () => {
  it("keeps a minimal reproduction", async () => {
    const result = await minimizeTestCase({
      input: failingPayload,
      test: reproducesInvalidPrice,
      name: "checkout",
      artifactsDir: ".shrinkjs",
    });

    expect(result.ok).toBe(true);
    expect(result.minimalInput).toBeDefined();
  });
});
```

`@shrinkjs/core/jest` exposes the same `minimizeTestCase`. Both:

- run the minimization,
- write artifacts (default `.shrinkjs`, `overwrite: true` so test runs are repeatable),
- throw when the target behavior cannot be established (`throwOnFailure: false` to opt out),
- log a one-line summary (`log: false` to opt out).

These are conveniences, not official framework features.

## Limitations

Read this before trusting a result.

1. **Local, not global, minimality.** ShrinkJS proves "no candidate from the enabled reducers was accepted". Another reducer set — or a persona with more context — could find something smaller.
2. **Greedy search.** ddmin cannot remove two independent elements at once if removing either alone breaks the predicate. The final full pass mitigates but does not eliminate this.
3. **Chunk-limited strings and arrays.** Above roughly 512 elements/characters, reduction is chunk-granular (granularity is capped), so results may contain removable single items.
4. **Predicate errors are ignored by default.** A predicate that throws on every reduced candidate will report "nothing to minimize" while the warnings tell you why. Use `predicateErrors: "fail"` in CI.
5. **Signature pinning** only works if the predicate reports signatures; with plain booleans, the engine cannot tell one failure from another.
6. **The predicate may do anything.** It can mutate your data, hit production, or delete files. Guard it.
7. **`Map`, `Set`, `Date`, `RegExp` and binary values are leaves** in `js` mode: they are cloned and measured but not structurally reduced. Write a custom reducer if you need that.
8. **Sizes are code-unit counts**, not bytes or compressed size.
9. **No resumable runs.** Limits stop the process; there is no serialized search state to continue from (on the roadmap).
10. **Deterministic only for deterministic predicates.** Shrinking a flaky predicate is a heuristic; use `stability` and read `status`.

## Safety and privacy

- **No telemetry, no network calls, no AI.** The core never contacts anything; there is no dependency to do so.
- **Nothing is uploaded.** All work happens in your process.
- **No secrets in default output.** Progress events contain sizes, strategy names and paths — never values. History omits values unless `includeValues: true`. Reports include the minimal input by design (that is the artifact), so redact what you must with `redact`.
- **Generated artifacts can contain your data.** Treat `shrinkjs-output/` like a fixture: check it before committing. `--redact token,password` scrubs reports, but `minimized-input.json` stays intact so the reproduction remains runnable.
- **The predicate is arbitrary code.** ShrinkJS cannot sandbox it. The CLI only imports the module you pass with `--test`; it does not scan or auto-run project files.
- **Output paths are contained.** Artifact names are fixed and verified to stay inside the chosen directory.

## Benchmarks

Measured with `npm run bench` (Node 24, Windows, single core). Every case verifies the minimized input still reproduces before reporting.

| Case                                | Input    | Output | Reduction | Evaluations | Time   |
| ----------------------------------- | -------- | ------ | --------- | ----------- | ------ |
| small JSON payload (50 users)       | 6.8 kB   | 30 B   | 99.6 %    | 46          | 18 ms  |
| large JSON payload (1,000 users)    | 136.8 kB | 31 B   | 100.0 %   | 58          | 112 ms |
| deeply nested object (20 levels)    | 3.3 kB   | 200 B  | 93.9 %    | 139         | 22 ms  |
| large numeric array (5,000 items)   | 23.9 kB  | 6 B    | 100.0 %   | 42          | 12 ms  |
| long string (100 kB)                | 130.6 kB | 8 B    | 100.0 %   | 64          | 22 ms  |
| complex configuration (60 services) | 9.5 kB   | 27 B   | 99.7 %    | 16          | 3 ms   |
| event sequence (1,000 events)       | 77.1 kB  | 27 B   | 100.0 %   | 66          | 28 ms  |

Total: 431 predicate calls, 0.22 s, all results verified. Numbers are machine-specific; the point is that predicate calls — not input size — drive the cost.

## Roadmap

**Implemented (v0.1.0)**

- Core engine with ddmin, structural, array, object, string, number, boolean and nullish reduction.
- Async predicates, timeouts, cancellation, evaluation/duration/depth/pass limits.
- Signature preservation, stability checks, final verification, caching.
- Statistics, bounded history, progress events.
- Custom reducers (sync/async iterables), public `deltaDebug` and `minimizeSequence`.
- JSON/Markdown reports, structural diff, redaction, artifact generation.
- CLI with progress, exit codes, JSON output and artifact writing.
- Vitest/Jest adapters, 226 tests, benchmarks, CI.

**Planned**

- Persist/resume search state (so `limit-reached` runs can continue).
- `Set`/`Map`/`Date` strategies (currently leaves).
- Parallel predicate evaluation with a worker pool (opt-in; ordering must stay deterministic).
- A `shrinkjs replay` command that re-checks an artifact directory.
- Optional JSON-Schema-aware reduction (skip already-invalid shapes earlier).
- MCP-friendly artifact manifest, if there is demand.

**Not planned**: AI APIs, cloud services, telemetry, a Docker image.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short:

```bash
npm install
npm run build
npm test            # 226 tests
npm run check       # typecheck + lint + format + tests + build + package validation
npm run bench
npm run examples
```

Bugs and reduction-quality reports are especially welcome — please include the input, the predicate and the result you got.

## License

MIT © Tronex. See [LICENSE](LICENSE).

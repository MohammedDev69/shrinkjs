# ShrinkJS — Pre-release audit

**Auditor role:** external senior maintainer review before the first public publish.
**Subject:** `@shrinkjs/core@0.1.0` (ShrinkJS), commit `09a4553` + audit changes.
**Environment actually used:** Node 24.18.0, npm 12.2.2, Windows 11 (win32/x64), local filesystem.
**Date:** 2026-11-25.
**Posture:** adversarial. Every claim below was reproduced with a failing test or a probe script before it was fixed, and re-checked after.

## Verdict

The library is **safe to publish after these fixes**, with the residual limitations listed below. The audit found **three critical defects** (two of which could silently inflate the minimality claim, one of which rejected valid input) and **ten high/medium defects**, all reproduced, fixed, and covered by regression tests.

The most important finding is not any single bug: it is that the _local minimality_ label was previously reachable through code paths that had not examined every node (shared references) or had been cut short by an unreported internal cap (custom reducers). Both are now impossible without an explicit `limit-reached` status.

## Findings at a glance

| #   | Severity     | Finding                                                                                            | Status                              |
| --- | ------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | **Critical** | Valid shared (acyclic) references were rejected as "circular" in `json` mode                       | Fixed + test                        |
| 2   | **Critical** | Traversal reduced only the first path of a shared graph yet claimed `minimality: "local"`          | Fixed + test                        |
| 3   | **Critical** | Deeply nested input (≈5,000 levels) crashed with a raw `RangeError` before any limit               | Fixed + test                        |
| 4   | **High**     | Custom-reducer chains were silently truncated (~800 accepts) while reporting `completed` / `local` | Fixed + test                        |
| 5   | **High**     | Root entry statically pulled `node:fs` (breaks bundlers / edge runtimes)                           | Fixed + verification script         |
| 6   | **High**     | Published declarations required the `AbortSignal` global (strict consumers failed)                 | Fixed + type-check probe            |
| 7   | **High**     | Path-exponential shared graphs could hang (no node-visit bound)                                    | Fixed + test (`max-nodes`)          |
| 8   | **Medium**   | `reductionPercent` / `savedChars` clamped to 0 even when the result grew                           | Fixed + test                        |
| 9   | **Medium**   | `config.preset` reported `"custom"` for an empty `limits: {}`                                      | Fixed + test                        |
| 10  | **Medium**   | `ArrayBuffer` values compared equal regardless of contents                                         | Fixed + test                        |
| 11  | **Medium**   | Artifacts + predicate on different Windows drives produced broken generated imports                | Fixed + test                        |
| 12  | **Low**      | CLI lacked a way to make predicate errors fatal (needed for CI)                                    | Fixed (`--predicate-errors`) + test |
| 13  | **Low**      | `maxInputSize` was checked after validating/walking the input                                      | Fixed (iterative validation first)  |
| 14  | Low          | Stats identity (`attempts == accepted + rejected`) was untested                                    | Test added                          |
| 15  | Info         | No fuzz/property test for the engine invariants                                                    | Test added (40 generated cases)     |

## Verified fixes

Each entry lists the symptom, root cause, fix, and the regression test that locks it down. All tests live in `tests/audit/regressions.test.ts` unless stated otherwise.

### 1. Valid shared references rejected as "circular" (critical)

**Symptom.** `shrink({ input: { a: shared, b: shared }, ... })` threw
`ShrinkUnsupportedInputError: Circular reference detected at $.b` — for a value that `JSON.stringify` handles fine.

**Root cause.** `assertSupportedInput` used a single `WeakSet` of _visited_ objects and treated any revisit as a cycle.

**Fix.** Validation now distinguishes "is an ancestor" from "seen before": an ancestor stack detects true cycles, a memo set skips already-validated shared subtrees (`src/utils/clone.ts`).

**Test.** “accepts an acyclic graph with shared sub-objects in json mode” plus “still rejects a real cycle in json mode”.

### 2. Shared graphs reduced only at their first path, while claiming local minimality (critical)

**Symptom.** For `shared = { kind: "x", nested: { b: 2 } }` and a predicate that pins `a.nested.b`, the engine returned `b.nested.b === 2` and reported `minimality: "local"` — although removing `b.nested.b` (which the engine can do, because replacing a node breaks sharing) still satisfied the predicate.

**Root cause.** `collectNodes` kept a global `seen` set, so a sub-object reachable from two parents was traversed only under the first path. The final pass therefore never generated candidates for the second path, yet the “a full pass accepted nothing” condition was considered satisfied.

**Fix.** New `walkNodes` generator (`src/utils/paths.ts`) walks **every path**, cutting only true cycles with an ancestor stack. The engine streams it (O(depth) memory) instead of materialising a node list (`src/core/engine.ts`).

**Test.** “reduces every path of a shared graph, not only the first” asserts `b.nested` is reduced at the second path **and** that `minimality` is still honest.

**Note.** This also fixed the reverse hazard: path-exponential graphs are now bounded (finding 7).

### 3. Deep nesting crashed with an untyped `RangeError` (critical)

**Symptom.** A 5,000-level nested object threw `RangeError: Maximum call stack size exceeded` from `deepClone`, outside the documented error model and before `maxDepth` could apply.

**Root cause.** Validation, cloning, size measurement and serialization are recursive; nothing bounded input depth before the first recursive call.

**Fix.** `assertSupportedInput` is now iterative (explicit stack, no recursion) and enforces a configurable `limits.maxInputDepth` (default 1,000; 500/1,000/2,000 per preset), throwing `ERR_UNSUPPORTED_INPUT` with the offending path. Validation runs before cloning/size work.

**Tests.** Three cases: deeper-than-limit rejected with a typed error; 200-deep accepted and fully minimized; raised `maxInputDepth` honoured. Probe evidence: 5,000 levels → `ERR_UNSUPPORTED_INPUT: Input nests deeper than limits.maxInputDepth (1000 levels) at $.child.child…`.

### 4. Long custom-reducer chains silently truncated (high)

**Symptom.** A reducer that decrements a counter (input `n = 2000`, Map value so built-ins cannot touch it) stopped at `n = 1200` with `status: "completed"`, `minimality: "local"`, `limitReached: null` — 800 further reductions were available and the evaluation budget was untouched.

**Root cause.** Two hard-coded loop caps (`20` per reducer loop × 20 engine rounds × 2 loops ≈ 800 accepts) that neither reported anything nor set a limit.

**Fix.** Caps raised to 10,000 accepts per reducer loop and 1,000 engine alternations, and both now call `budget.exhaust("max-reducer-rounds")` when they trip, producing `status: "limit-reached"` (`src/core/engine.ts`). The measured chain now reaches `n = 0` in 803 evaluations with `minimality: "local"` — which is now true.

**Test.** “completes long reducer chains instead of silently stopping”.

### 5. Root entry pulled `node:fs` (high)

**Symptom.** `dist/index.js` re-exported `reporting/index.js`, which re-exported `artifacts.js`, which statically imports `node:fs`, `node:path`, `node:url`. Bundlers targeting non-Node runtimes fail on the main entry even though the engine itself needs nothing from Node.

**Fix.** The filesystem writers moved behind `@shrinkjs/core/artifacts` (still re-exported from `@shrinkjs/core/reporting`); the root exports only pure report builders. `scripts/verify-exports.mjs` walks the built import graph and fails the build if any `node:` specifier is reachable from the root (30 modules inspected).

**Tests.** `tests/package/packaging.test.ts` (static-import scan) + `npm run verify:exports`.

### 6. Declarations required the `AbortSignal` global (high)

**Symptom.** A strict consumer with `moduleResolution: node16`, `skipLibCheck: false`, `types: []` and `lib: ["ES2023"]` failed with `TS2304: Cannot find name 'AbortSignal'` on `dist/core/types.d.ts`, `limits.d.ts`, `strategies/sequence.d.ts`.

**Fix.** The public API uses a structural `AbortSignalLike` (a real `AbortSignal` satisfies it). Consumers no longer need DOM lib or `@types/node` to type-check ShrinkJS.

**Verification.** `scripts/verify-exports.mjs` compiles a real consumer (`types: []`, strict, node16) against the export map on every `npm run check`.

### 7. Path-exponential graphs could hang (high)

**Symptom/analysis.** Once traversal became per-path (finding 2), a DAG like 40 nested `{ left: next, right: next }` has 2⁴⁰ paths. Memory is bounded by the streamed walk, but time was not.

**Fix.** `limits.maxNodeVisits` (default 1,000,000) bounds each pass; hitting it sets `limitReached: "max-nodes"`, `status: "limit-reached"`, `minimality: "unknown"`.

**Test.** “reports limit-reached instead of claiming local minimality” (only the exact original satisfies the predicate, so the walk — not the evaluation budget — is what stops).

### 8. Size growth was hidden (medium)

**Symptom.** `{ a: {} }` with a predicate that permits `null` returns `{ a: null }` (8 → 10 characters) but reported `reductionPercent: 0`, `savedChars: 0`.

**Root cause.** Both values were clamped at zero.

**Fix.** `savedChars = originalSize − finalSize` and the percentage may be negative; the run adds a warning explaining the `{}` → `null` case (`src/core/result.ts`, `src/core/engine.ts`).

**Test.** “reports a negative reduction when a structural simplification grows the input”.

### 9. Preset mislabelled (medium)

`config.preset` became `"custom"` whenever a `limits` object was passed, including `limits: {}`. Fixed by detecting whether any override is actually defined (`src/core/shrink.ts`). Tests: “does not label the default preset as custom when limits is empty” and “labels a run with real limit overrides as custom”.

### 10. `ArrayBuffer` content ignored in the ordering (medium)

`compareSimplicity` compared `byteLength` only, so two buffers of equal length were "equivalent". Now compared byte-wise, sharing the same helper as typed arrays. Test: “compares ArrayBuffer contents, not only their length”.

### 11. Cross-drive artifact paths (medium)

With the artifact directory and the predicate on different Windows drives, `path.relative` yields an absolute path, which was embedded into `join(here, …)` — producing a non-existent path. Generated files now fall back to the absolute location (and `pathToFileURL` for the reproduction script). The Windows-only regression test **executes** the generated `reproduction.mjs` across drives.

### 12. `--predicate-errors` for CI (low)

The library supports `predicateErrors: "fail"`, but the CLI could not request it. Added the flag with validation, help text, and tests (including a run that exits `1` with `ERR_PREDICATE_FAILED`).

### 13. Validation ordering (low)

`maxInputSize` was checked after type validation. Validation is now iterative and runs first (allocation-free), then size is measured — so both oversized and too-deep inputs are rejected before recursion-heavy work.

### 14–15. Test-suite gaps closed

- **Statistics identity**: `attempts === accepted + rejected` for every strategy and in aggregate, plus `accepted === successfulReductions`.
- **Engine invariants (fuzz)**: 40 deterministic pseudo-random inputs × “contains marker” predicates assert that an `ok` result always satisfies its predicate, never grows, reports sizes consistent with `sizeOf`, and is reproducible (same minimal input and evaluation count on a second run).
- Additional coverage added during the audit: CLI paths containing spaces, cancellation after the in-flight predicate settles, mutating predicates cannot touch the caller's input, signature drift to a signature-less result, depth-limit behaviour, and packaging/export checks.

## Review questions, answered

| Question                                         | Answer                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Are the minimization algorithms correct?      | Yes within their documented scope. ddmin is faithful to Zeller/Hildebrandt; ordering-based acceptance is monotone; numeric bisection converges. Limits on that guarantee are listed in “Remaining issues”.                                                                                                                       |
| 2. Is ddmin implemented correctly?               | Yes. Subsets → complements → granularity doubling, empty-input fast path, 1-minimality stop, chunk cap reported honestly via `oneMinimal: false`, deterministic, subsequence-preserving. 15 dedicated tests assert the invariants rather than snapshots.                                                                         |
| 3. Can the engine lose the original failure?     | Not silently. Signature pinning rejects candidates that report a different signature; the final input is re-evaluated on a fresh clone and a failure downgrades the run to `unstable`. Absent signatures, a predicate that reports different failures as identical cannot be distinguished — documented.                         |
| 4. Can predicate errors produce false positives? | Only under the explicit `predicateErrors: "preserve"` policy, which warns once. The default (`"ignore"`) treats a throw as “not reproduced”, which can under-reduce but never invents a reproduction.                                                                                                                            |
| 5. Do timeout and cancellation work?             | Timeouts: yes (per-call race, counted, policy-driven). Cancellation: yes, with a precise limitation — a running predicate cannot be interrupted; the abort takes effect when it settles. Tested with a slow async predicate and `predicateTimeout: 0`.                                                                           |
| 6. Can any strategy loop indefinitely?           | No. Candidates must strictly decrease a well-founded ordering, ddmin granularity is bounded, bisection has a step cap and a precision floor, and reducer loops report `max-reducer-rounds`. The fuzz test plus budget tests support this.                                                                                        |
| 7. Are results labelled honestly?                | Now yes. `local` requires a complete pass with no acceptance and no truncation; any cap produces `limit-reached` + `limitReached`. Two of the audit's critical findings were exactly violations of this.                                                                                                                         |
| 8. Are statistics accurate?                      | Yes, and now tested: `evaluations` counts real calls (cache hits excluded), per-strategy totals reconcile with accepted/rejected, sizes equal `sizeOf` of the returned values, and negative reductions are reported rather than clamped.                                                                                         |
| 9. Does the CLI work with real files?            | Yes: real files (including spaces), stdin, JSON output, artifacts, exit codes, SIGINT, JSON parse errors, missing modules, non-function exports, redaction, `--force`, `--no-artifacts`. Verified by 26 CLI tests, one of which spawns the built binary.                                                                         |
| 10. Are the TypeScript declarations correct?     | Yes, verified by compiling a real strict `node16` consumer with `types: []` against the published export map (`verify:exports`). Declarations contain no DOM/Node globals.                                                                                                                                                       |
| 11. Do package exports work for ESM consumers?   | Yes, verified at runtime for all five subpaths (ESM) and the root (CJS `require`), through a junctioned `node_modules` so the real `exports` map is used.                                                                                                                                                                        |
| 12. Do integrations affect the core?             | No. The core has zero runtime dependencies and no test-framework imports (asserted by tests); the root entry is proven free of Node built-ins, and the adapters are separate subpaths.                                                                                                                                           |
| 13. Security issues?                             | No network, telemetry or credential handling; artifacts use fixed filenames inside a resolved directory; generated code embeds paths via `JSON.stringify`. Residual risks: the predicate is arbitrary code (documented), and the writer follows pre-existing symlinks inside the chosen output directory (see remaining issues). |
| 14. Does the suite cover real edge cases?        | 257 tests across 15 files, including shared/cyclic structures, NaN/±Infinity/-0/BigInt, Unicode surrogate pairs, deep nesting, empty roots, flaky predicates, timeouts, cancellation, signature drift, redaction, executed generated scripts, cross-drive paths, and 40 fuzz cases.                                              |
| 15. Do the README examples execute?              | Yes — all seven `examples/*.mjs` run against the built package (`7/7` in 1.1 s), and the generated reproduction script is executed by the test suite. README snippets that depend on user code (e.g. `processOrder`) are illustrative and marked as such.                                                                        |
| 16. Ready for npm?                               | Ready to publish after reviewing the “Remaining issues”. `publint` reports 0 messages, the tarball is audited, version strings are synced, and CI is configured. Publishing itself was not performed (and must not be without explicit authorization).                                                                           |

## Actual test results

Run at the end of the audit, on the committed tree:

```text
npm run check            → typecheck ✓  lint ✓  format:check ✓  build ✓
                           vitest: 15 files, 257 tests passed
                           verify:package: 164 files, 111.8 kB packed, 455.1 kB unpacked, publint 0 messages
                           verify:exports: ESM (root, /vitest, /jest, /reporting, /artifacts) ✓
                                           CJS require() ✓
                                           strict node16 consumer ✓
                                           root entry: 30 modules, no Node built-ins ✓

npx vitest run --coverage → statements 90.15 % (1913/2122)
                            branches   83.59 % (1411/1688)
                            functions  92.88 % (222/239)
                            lines      92.80 % (1690/1821)

node examples/run-all.mjs → 7/7 examples passed
node bench/index.mjs      → 431 predicate calls, 0.25–0.38 s across runs, all results verified
CLI end-to-end            → 1,554 chars → 38 chars (97.6 %), 33 evaluations, 33 cache hits,
                            signature INVALID_PRICE, five artifacts written
```

The audit-specific regression suite is `tests/audit/regressions.test.ts` (21 tests). Before the fixes, 6 of its first 12 tests failed — those failures are the reproduction of findings 1, 2, 4, 7, 8(partial), 9, 10; findings 3, 5, 6 were reproduced with standalone probes and are now covered by tests too.

## Remaining issues (known, accepted, documented)

| Severity | Issue                                                                                                                                                                                                        | Mitigation                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | A predicate can mutate the candidate it receives; a mutating predicate may leave its marks in `minimalInput`.                                                                                                | Caller's input is cloned and protected (tested); final verification catches non-determinism, not idempotent mutation. Documented in README limitations. |
| Medium   | Timeouts/cancellation cannot interrupt an in-flight predicate; the work is abandoned, not stopped.                                                                                                           | `predicateTimeout` bounds the wait; documented.                                                                                                         |
| Low      | `Map`/`Set`/`Date`/`RegExp`/binary values are leaves (cloned, measured, not reduced).                                                                                                                        | Custom reducers; documented; on the roadmap.                                                                                                            |
| Low      | Engine-side ddmin caps granularity at 512, so long strings/arrays are chunk-minimal. `minimality: "local"` is scoped to the reducers' generated candidates, and the README states the limitation explicitly. | Documented; `deltaDebug` exposes `oneMinimal` for callers who need the stronger statement.                                                              |
| Low      | `compareSimplicity` stops at depth 64, so differences deeper than that compare equal and are not accepted.                                                                                                   | Never causes a wrong accept; only a missed reduction beyond `maxDepth` defaults.                                                                        |
| Low      | Accessor properties are evaluated during clone/rebuild; prototype setters can observe writes.                                                                                                                | Documented.                                                                                                                                             |
| Low      | `deepClone` (public utility) is recursive; direct calls on ~5k-deep values overflow. `shrink()` guards with `maxInputDepth`.                                                                                 | Documented.                                                                                                                                             |
| Low      | Reducer round guards (10k/1k) are constants, not configurable limits — though they are _reported_ as `max-reducer-rounds`.                                                                                   | Reported, so no false claim; can be exposed later.                                                                                                      |
| Low      | `writeArtifacts` follows an existing symlink named like an artifact inside the output directory (write-outside risk if the user points it at an attacker-controlled directory).                              | `overwrite: false` by default; documented. `O_NOFOLLOW` is not available through `fs.writeFile`.                                                        |
| Info     | `history` keeps candidate roots in memory when `includeValues: true`.                                                                                                                                        | Opt-in and bounded by `maxEntries`.                                                                                                                     |

## Unverified claims

Stated plainly so nobody mistakes this audit for more than it is:

1. **This is a self-audit.** No independent third-party review was performed.
2. **Browsers/edge runtimes were not executed.** I proved the root entry has no `node:` imports, but binary (`Buffer`) handling in `js` mode still assumes a Node-like global; a real browser bundle was not exercised.
3. **Only Node 24.18 was run locally.** The CI matrix targets Node 20.19/22/24 on Linux, Windows and macOS, but those jobs were not executed in this environment.
4. **npm was not published.** `npm view @shrinkjs/core` returns 404 (scope appears unused), but registry ownership of the `@shrinkjs` scope is not something I can confirm without an account.
5. **Benchmark numbers are from one machine** (Windows, Node 24) and vary run to run; the CI benchmark step is a smoke test, not a performance gate.
6. **The generated `regression.test.ts` is content-checked and its companion input file is exercised,** but the generated test file itself is not executed by this suite (the generated `reproduction.mjs` _is_ executed, including across drives).
7. **`publint` clean** means no packaging rule violations it knows about; it is not a proof about every consumer tool.

## Incomplete features (not defects)

- Resumable/persisted search state (`limit-reached` runs cannot continue).
- Structural strategies for `Map`, `Set`, `Date`, `RegExp`, binary data.
- Opt-in parallel evaluation.
- `shrinkjs replay <dir>`.
- JSON-Schema-aware reduction.
- CLI support for non-JSON inputs (deliberate: avoids executing project code to build an input).

## Recommendation

Ship `0.1.0` as a **pre-1.0** release once the remaining low/medium items are acceptable to the maintainer. The library now fails loudly instead of quietly over-claiming: every path that stops early reports `limit-reached` with a reason, every result is re-verified on a fresh clone, and the two honesty-critical behaviours (shared-graph traversal and reducer caps) have regression tests that would have caught the original bugs.

Do not publish automatically. Publishing requires an explicit decision, an npm token with access to the `@shrinkjs` scope, and a final `npm run check` on the release commit.

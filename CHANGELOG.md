# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-25

First public release. The API is usable but pre-1.0: minor versions may change
behaviour and types.

### Added

- **Core engine** — deterministic reduction of any supported input while a
  predicate keeps holding. Structural traversal with restart-on-accept, a final
  full pass for local minimality, and fresh-copy verification of the result.
- **Algorithms** — classic Delta Debugging (`deltaDebug`) with subsets,
  complements and adaptive granularity; array/object/string reducers built on
  it; numeric reduction with threshold bisection; boolean and nullish
  simplification.
- **Simplicity ordering** (`compareSimplicity`) that guarantees termination and
  determinism, including cycles and non-finite numbers.
- **Predicate support** — sync and async predicates, rich results with
  `signature`/`metadata`, signature pinning, optional stability runs
  (`stability: { runs, requiredMatches }`), per-call timeouts, and a documented
  error policy (`ignore` by default, `fail`, `preserve`).
- **Limits and cancellation** — `maxEvaluations`, `maxDuration`,
  `predicateTimeout`, `maxDepth`, `maxCandidatesPerNode`, `maxInputSize`,
  `maxPasses`, plus `AbortSignal` support and `fast`/`balanced`/`thorough`
  presets. The limit that stopped a run is reported in `stats.limitReached`.
- **Statistics and history** — evaluation counts, cache hits, per-strategy
  attempts/accepts/rejects, signature mismatches, verification result, bounded
  history with accepted-first eviction.
- **Progress reporting** — throttled `onProgress` events with sizes, strategy
  and path; never includes input values.
- **Custom reducers** — whole-input reducers returning arrays, iterables,
  async iterables or promises, with priorities, `enabled` guards and a
  read-only context.
- **Standalone helpers** — `minimizeSequence`, `deltaDebug`,
  `partitionIndices`, `sizeOf`, `compareSimplicity`, `deepClone`,
  `diffValues`, `formatPath`, `toJsonSafe`.
- **Reporting** — JSON report, Markdown report, structural diff, property
  redaction, and an artifact writer producing `result.json`,
  `minimized-input.json`, `reproduction.mjs`, `regression.test.ts` and
  `report.md` without silently overwriting files.
- **CLI** — `shrinkjs minimize` with file/stdin input, JS/TS predicate modules,
  presets and individual limits, progress bar, quiet/verbose/JSON modes,
  artifact output, redaction, cancellation and documented exit codes.
- **Integrations** — `@shrinkjs/core/vitest` and `@shrinkjs/core/jest` adapters
  that minimize inside a test and write artifacts; the core stays free of any
  test-framework dependency.
- **Quality** — strict TypeScript with a typed generic API, 226 tests, coverage
  thresholds, ESLint + Prettier, benchmarks with a correctness gate, seven
  runnable examples, package validation (publint + tarball audit) and CI on
  Node 20/22/24.

### Notes

- The unscoped npm name `shrinkjs` was already taken by an unrelated,
  deprecated image-compression package, so this project is published as
  `@shrinkjs/core`. The repository and project name remain ShrinkJS.
- Non-JSON values (`Map`, `Set`, `Date`, `RegExp`, binary data) are cloned and
  measured in `js` mode but are not structurally reduced; custom reducers cover
  those cases. This is documented in the README limitations.
- The package is ESM-first. CommonJS consumers on Node ≥ 20.19 can use
  `require("@shrinkjs/core")` through native `require(esm)`.

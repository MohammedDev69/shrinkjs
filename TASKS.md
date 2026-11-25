# Tasks

Status of the ShrinkJS v0.1.0 build. `[x]` = implemented and tested, `[ ]` = not done (see roadmap in README).

## Phase 0 — Inspect and plan

- [x] Inspect workspace (empty, Node 24, npm 12, git available, not a repository)
- [x] Check npm name availability (`shrinkjs` taken by an unrelated deprecated package → publish as `@shrinkjs/core`)
- [x] Establish architecture (`DESIGN.md`)
- [x] Create `TASKS.md`, `DESIGN.md`, `CHANGELOG.md`

## Phase 1 — Core foundation

- [x] Package scaffolding (strict TS, ESM, exports map, `files`, `engines`, `bin`)
- [x] Type surface (`src/core/types.ts`) with no `any`
- [x] Deep clone preserving prototypes, cycles, Map/Set/Date/RegExp/Buffer/typed arrays
- [x] Mode validation (`json` strict, `js` extended)
- [x] Size measurement (`compactRepresentation`) documented
- [x] Simplicity ordering (`compareSimplicity`) — total, cycle-safe, deterministic
- [x] Budget: evaluations, duration, passes, depth, candidates, cancellation
- [x] Evaluator: sync/async, timeout, stability, cache, error policy
- [x] Result + statistics construction

## Phase 2 — Algorithms

- [x] Classic ddmin with subsets, complements, granularity doubling, `maxParts`, early stop
- [x] Structural traversal with restart-on-accept and final full pass
- [x] Array reduction (dedupe + ddmin chunks/elements)
- [x] Object reduction (ddmin over keys, prototype preserved)
- [x] String reduction (empty, whitespace, code-point ddmin)
- [x] Number reduction (simple values, integer forms, decimal rounding, bisection)
- [x] Boolean and nullish reduction
- [x] Sequence reduction (`minimizeSequence`, per-item simplification)
- [x] Custom reducers (sync/async iterables, priority, enabled, context)
- [x] Signature preservation
- [x] Final fresh-copy verification

## Phase 3 — Testing

- [x] Core behaviour tests (reduction, already-minimal, always-true, always-false, empty, nested)
- [x] Limits tests (each limit, `0 = unlimited`, limit reporting)
- [x] Cancellation (pre-aborted, mid-run, predicate never called)
- [x] Predicate errors (all three policies), invalid results, timeouts
- [x] Stability and non-determinism detection
- [x] ddmin algorithm tests (invariants, 1-minimality, determinism, caps)
- [x] Strategy tests (arrays, objects, strings incl. Unicode, numbers incl. NaN/Infinity/-0/BigInt)
- [x] Custom reducer tests (atomic signed section, Map, async gen, priority, invalid return)
- [x] Utils tests (ordering, serialization, cloning, paths, JSON-safe conversion)
- [x] Reporting tests (diff, JSON, Markdown, redaction, history, artifacts, executed reproduction)
- [x] CLI tests (parsing, errors, exit codes, JSON output, stdin, redaction, cancellation, real binary)
- [x] Integration tests (Vitest/Jest adapters, core independence)
- [x] Package/API-surface tests (exports, version sync, export map, no runtime deps)
- [x] 226 tests passing; coverage above thresholds

## Phase 4 — Reporting

- [x] JSON report
- [x] Markdown report
- [x] Structural diff (prefix/suffix aware)
- [x] Redaction (reproduction, diff previews, history)
- [x] Bounded history with accepted-first eviction
- [x] Artifact writing with no silent overwrite
- [x] Generated `reproduction.mjs` and `regression.test.ts`

## Phase 5 — CLI

- [x] `minimize` command with dependency-free arg parser
- [x] Input loading (file, stdin, JSON validation)
- [x] Predicate module loading (default / `test` / named export, TS on Node ≥ 22.18)
- [x] Progress bar (TTY only), verbose and quiet modes, colors + `NO_COLOR`
- [x] JSON output mode
- [x] Exit codes (0 / 1 / 2 / 130) and SIGINT handling
- [x] Artifact output, `--force`, `--no-artifacts`, `--redact`

## Phase 6 — Integrations

- [x] Vitest adapter (`@shrinkjs/core/vitest`)
- [x] Jest adapter (`@shrinkjs/core/jest`) sharing one implementation
- [x] Core remains framework-free (verified by test)

## Phase 7 — Documentation

- [x] README (problem, install, quick start, API, CLI, reports, limits, safety, benchmarks, roadmap)
- [x] `DESIGN.md` (architecture, algorithms, ordering, decisions, testing)
- [x] `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`
- [x] 7 runnable examples + `run-all.mjs`
- [x] Benchmarks (`bench/index.mjs`) with correctness gate

## Phase 8 — Quality and release readiness

- [x] Type check (`tsc --noEmit`)
- [x] ESLint (flat config, type-aware)
- [x] Prettier
- [x] Build (`tsc -p tsconfig.build.json`, declarations + source maps)
- [x] Package validation (`scripts/verify-package.mjs`: version sync, exports, shebang, tarball, publint)
- [x] CI workflow (typecheck, lint, format, test, coverage, build, package check, Node 20/22/24)
- [x] Release workflow that builds and attaches artifacts **without publishing**
- [x] git repository initialized with a sensible `.gitignore`

## Phase 9 — Pre-release audit (adversarial review)

- [x] Shared-reference validation bug (valid acyclic graphs rejected as cyclic)
- [x] Per-path traversal so shared sub-graphs are reduced at every location
- [x] Streamed traversal + `maxNodeVisits` limit reported as `max-nodes`
- [x] Reducer round-cap no longer claims local minimality silently
- [x] `config.preset` no longer reports "custom" for an empty `limits`
- [x] `ArrayBuffer` content comparison in the ordering
- [x] Honest (possibly negative) `reductionPercent` / `savedChars` + warning
- [x] Root entry free of Node built-ins; artifact writers moved to `/artifacts`
- [x] Declarations no longer require the `AbortSignal` global
- [x] `maxInputSize` checked before input validation walks the input
- [x] `--predicate-errors` CLI flag for CI
- [x] Export/type/root-purity verification script (`verify:exports`)
- [x] Regression tests for every fixed defect (`tests/audit/`)
- [x] Iterative input validation + `maxInputDepth` guard (no raw `RangeError`)
- [x] Cross-drive artifact paths (absolute-path fallback for generated files)

## Not done (documented in README roadmap)

- [ ] Resumable runs / persisted search state
- [ ] `Set`/`Map`/`Date` structural strategies
- [ ] Worker-pool parallel evaluation
- [ ] `shrinkjs replay <dir>` command
- [ ] JSON-Schema-aware reduction
- [ ] npm publish (requires explicit authorization and credentials — never done automatically)

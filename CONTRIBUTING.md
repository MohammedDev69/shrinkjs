# Contributing to ShrinkJS

Thanks for taking the time to contribute. This project values correctness and
honest reporting above feature count: a smaller result that silently reproduces
the wrong failure is worse than no result.

## Development setup

```bash
git clone https://github.com/MohammedDev69/shrinkjs.git
cd shrinkjs
npm install
npm run build
npm test
```

Requirements: Node.js ≥ 20.19 (Node 24 recommended), npm ≥ 10.

## Scripts

| Command                           | What it does                                                 |
| --------------------------------- | ------------------------------------------------------------ |
| `npm run build`                   | Compile `src/` to `dist/` with declarations and source maps  |
| `npm test`                        | Build, then run the full Vitest suite                        |
| `npm run test:watch`              | Vitest in watch mode (no build)                              |
| `npm run test:coverage`           | Coverage run with thresholds                                 |
| `npm run typecheck`               | `tsc --noEmit` over src, tests and examples                  |
| `npm run lint` / `lint:fix`       | ESLint (type-aware flat config)                              |
| `npm run format` / `format:check` | Prettier                                                     |
| `npm run bench`                   | Build and run the benchmark suite                            |
| `npm run examples`                | Build and run every example                                  |
| `npm run verify:package`          | Build and validate the publishable tarball (publint + audit) |
| `npm run check`                   | Everything above that a PR must pass                         |

## Repository layout

See [DESIGN.md](DESIGN.md#architecture). Short version:

- `src/core` — engine, evaluator, budget, results. No CLI, reporting or test
  framework imports allowed here.
- `src/strategies` — candidate generation. A strategy proposes values; the
  engine decides whether they are acceptable.
- `src/utils` — cloning, ordering, serialization, paths.
- `src/reporting` — pure functions of a `ShrinkResult`.
- `src/cli`, `src/integrations` — thin layers over the core.
- `tests/` — unit, behavioural, contract and integration tests.
- `examples/`, `bench/` — runnable, verified against the built package.

## What a good pull request looks like

1. **Open an issue first** for anything beyond a small fix, so the design can be
   discussed before the code exists.
2. **Add tests.** Every behaviour change needs a test that fails before and
   passes after. Algorithm changes should include an invariant test (e.g. "the
   result is a subsequence", "the result is 1-minimal", "the predicate holds").
3. **Keep determinism.** No randomness, no wall-clock dependence, no
   iteration-order assumptions in the engine. If you need a hash, use
   `stableKey`.
4. **Never weaken the guarantees.** Do not set `minimality: "local"` for a run
   that hit a limit, do not swallow predicate errors silently, and do not claim
   global minimality.
5. **Document behaviour that users can observe.** Public options, statistics and
   statuses are contract. Update the README table and `CHANGELOG.md`.
6. **Keep the core dependency-free.** If something needs a dependency, it
   belongs in an optional subpath export or should not be added.

## Adding a strategy

1. Implement the `NodeStrategy` interface in `src/strategies/`:

   ```ts
   export const myStrategy: NodeStrategy = {
     name: "my-strategy",
     matches(value) {
       /* cheap, no predicate calls */
     },
     async reduce(value, ctx) {
       // propose candidates with ctx.tryCandidate(...)
       // return true if at least one was accepted
     },
   };
   ```

2. Register it in `src/strategies/registry.ts` (order matters for speed: cheaper
   strategies first).
3. Add it to the README strategy table.
4. Tests: at minimum "reduces when the predicate allows", "keeps the value when
   it does not", and "never proposes a non-simpler value".

Rules: strategies must be deterministic, must respect `ctx.isExhausted()` and
`ctx.attemptsLeft`, and must not mutate the current input.

## Reporting a reduction-quality bug

The most useful report contains:

- the input (minimized if possible, or a generator script),
- the predicate,
- the limits you used,
- the result you got (`result.json` is ideal),
- what you expected instead (e.g. "could have dropped `items[2]`").

Please say whether the predicate is deterministic; if not, include
`stability` settings.

## Commit messages

Conventional Commits are appreciated but not enforced:

```text
feat(strategies): add Map key reduction
fix(engine): keep paths valid when a parent is replaced
docs: clarify predicate error policy
test(ddmin): cover duplicate elements
```

## Releasing (maintainers)

1. `npm run check` must pass.
2. Update `CHANGELOG.md` and bump `package.json` + `src/version.ts`
   (the package validator fails if they disagree).
3. `npm run verify:package` and inspect `npm pack --dry-run --json`.
4. Publish only with explicit authorization — the repository never publishes
   automatically.

## Code of conduct

Be direct, be kind, assume good faith. Disagreements about algorithms are
welcome and should be settled with tests and measurements, not opinions.

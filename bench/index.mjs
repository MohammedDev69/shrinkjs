/**
 * Reproducible benchmarks for ShrinkJS.
 *
 * Every case first *verifies* that the minimized input still satisfies the
 * predicate (a benchmark of a wrong answer is worthless) and then reports the
 * measured cost. Numbers depend on the machine; compare runs on the same host.
 *
 * Usage: npm run bench
 */
import { shrink, sizeOf } from "../dist/index.js";

const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value);
const formatSize = (chars) =>
  chars < 1_000
    ? `${chars} B`
    : chars < 1_000_000
      ? `${(chars / 1_000).toFixed(1)} kB`
      : `${(chars / 1_000_000).toFixed(2)} MB`;

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function users(count) {
  const random = makeRandom(11);
  return {
    requestId: "req_bench",
    users: Array.from({ length: count }, (_, index) => ({
      id: index,
      name: `user-${index}`,
      active: random() > 0.5,
      score: Math.floor(random() * 1000),
      tags: [`t${index % 5}`, `t${index % 9}`],
      address: { city: `city-${index % 30}`, country: "GB", postcode: `PC${index}` },
    })),
    metadata: { source: "bench", version: "1.0.0", flags: { a: true, b: false, c: true } },
  };
}

function deepObject(depth) {
  const root = { keep: true, noise: "x".repeat(200) };
  let current = root;
  for (let index = 0; index < depth; index += 1) {
    current.child = { level: index, label: `level-${index}`, payload: "y".repeat(100) };
    current = current.child;
  }
  return root;
}

const cases = [
  {
    name: "small JSON payload",
    input: () => users(50),
    test: (candidate) => JSON.stringify(candidate).includes('"name":"user-33"'),
  },
  {
    name: "large JSON payload",
    input: () => users(1_000),
    test: (candidate) => JSON.stringify(candidate).includes('"name":"user-733"'),
  },
  {
    name: "deeply nested object",
    input: () => deepObject(20),
    test: (candidate) => JSON.stringify(candidate).includes("level-17"),
  },
  {
    name: "large numeric array",
    input: () => Array.from({ length: 5_000 }, (_, index) => index),
    test: (candidate) => Array.isArray(candidate) && candidate.includes(4_321),
  },
  {
    name: "long string (100 kB)",
    input: () =>
      `${"lorem ipsum dolor sit amet ".repeat(3_800)}NEEDLE${"consectetur adipiscing elit ".repeat(1_000)}`,
    test: (candidate) => typeof candidate === "string" && candidate.includes("NEEDLE"),
  },
  {
    name: "complex configuration",
    input: () => ({
      env: "production",
      services: Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [
          `service-${index}`,
          {
            image: `registry.local/service-${index}:1.${index}.0`,
            replicas: index % 4,
            env: { LOG_LEVEL: "info", FEATURE: index % 7 === 0 ? "on" : "off" },
            resources: { cpu: "500m", memory: "512Mi" },
          },
        ]),
      ),
      pricing: { base: 100, discount: -25, currency: "GBP" },
    }),
    test: (candidate) => {
      try {
        const discount = candidate?.pricing?.discount;
        if (typeof discount !== "number" || discount >= 0) return false;
        throw Object.assign(new Error("negative discount"), { code: "NEGATIVE_DISCOUNT" });
      } catch (error) {
        return error.code === "NEGATIVE_DISCOUNT";
      }
    },
  },
  {
    name: "event sequence",
    input: () =>
      Array.from({ length: 1_000 }, (_, index) => ({
        step: index,
        type: index % 3 === 0 ? "click" : index % 3 === 1 ? "type" : "wait",
        target: `#element-${index}`,
        timestamp: Date.UTC(2024, 0, 1) + index * 1000,
      })),
    test: (candidate) =>
      Array.isArray(candidate) && candidate.some((event) => event.target === "#element-919"),
  },
];

function measureMemory() {
  return process.memoryUsage().heapUsed;
}

async function runCase(benchCase, options = {}) {
  const input = benchCase.input();
  const beforeHeap = measureMemory();
  const started = performance.now();
  const result = await shrink({
    input,
    test: benchCase.test,
    ...(options.preset ? { preset: options.preset } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const durationMs = performance.now() - started;
  const heapDelta = measureMemory() - beforeHeap;

  // Correctness gate: the minimized input must still satisfy the predicate.
  const preserved = await benchCase.test(result.minimalInput);
  if (!result.ok || !preserved) {
    throw new Error(
      `benchmark "${benchCase.name}" produced a result that does not reproduce the target behavior`,
    );
  }

  return {
    name: benchCase.name,
    originalSize: sizeOf(input),
    finalSize: sizeOf(result.minimalInput),
    reductionPercent: result.stats.reductionPercent,
    evaluations: result.stats.evaluations,
    durationMs,
    heapDelta,
    status: result.status,
    minimality: result.minimality,
  };
}

function printTable(title, rows) {
  console.log(`\n${title}\n`);
  const header = ["case", "input", "output", "reduction", "evals", "time", "heap Δ"];
  console.log(`| ${header.join(" | ")} |`);
  console.log(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    console.log(
      `| ${row.name} | ${formatSize(row.originalSize)} | ${formatSize(row.finalSize)} | ${row.reductionPercent.toFixed(1)}% | ${formatNumber(row.evaluations)} | ${row.durationMs.toFixed(0)} ms | ${(row.heapDelta / 1024 / 1024).toFixed(1)} MB |`,
    );
  }
}

const results = [];
console.log("ShrinkJS benchmarks");
console.log(`node ${process.version} · ${process.platform} ${process.arch}`);

for (const benchCase of cases) {
  const row = await runCase(benchCase);
  results.push(row);
  console.log(
    `  ✓ ${benchCase.name}: ${formatSize(row.originalSize)} -> ${formatSize(row.finalSize)} in ${row.durationMs.toFixed(0)} ms`,
  );
}

printTable("Default configuration (balanced preset)", results);

// Preset comparison on one representative case.
const comparisonCase = cases[1];
const presetRows = [];
for (const preset of ["fast", "balanced", "thorough"]) {
  const row = await runCase(comparisonCase, { preset });
  presetRows.push({ ...row, name: `large JSON payload (${preset})` });
  console.log(
    `  ✓ preset ${preset}: ${row.evaluations} evals, ${row.durationMs.toFixed(0)} ms, ${row.reductionPercent.toFixed(1)}%`,
  );
}
printTable("Preset comparison", presetRows);

const totals = results.reduce(
  (accumulator, row) => ({
    evaluations: accumulator.evaluations + row.evaluations,
    durationMs: accumulator.durationMs + row.durationMs,
  }),
  { evaluations: 0, durationMs: 0 },
);

console.log(
  `\nTotal: ${formatNumber(totals.evaluations)} predicate calls, ${(totals.durationMs / 1000).toFixed(2)} s, all results verified.`,
);

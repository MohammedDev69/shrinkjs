/**
 * Verifies that the *published* package works for real consumers:
 *
 *  1. `import` of every subpath through the `exports` map (ESM),
 *  2. `require()` of the root entry (Node >= 20.19 `require(esm)`),
 *  3. a strict TypeScript consumer compiled with `moduleResolution: node16`,
 *     which resolves declarations through `exports` exactly like a user would,
 *  4. the root entry does not statically import Node built-ins.
 *
 * It installs nothing: a junction/symlink under `.tmp/consumer/node_modules`
 * points at this repository, so Node resolves the real package metadata.
 *
 * Run after `npm run build` (wired into `npm run check`).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const problems = [];
const notes = [];

const workdir = mkdtempSync(path.join(tmpdir(), "shrinkjs-consumer-"));
const scopeDir = path.join(workdir, "node_modules", "@shrinkjs");
mkdirSync(scopeDir, { recursive: true });
const linkPath = path.join(scopeDir, "core");
symlinkSync(root, linkPath, process.platform === "win32" ? "junction" : "dir");
writeFileSync(
  path.join(workdir, "package.json"),
  JSON.stringify({ name: "shrinkjs-consumer-probe", private: true, type: "module" }, null, 2),
  "utf8",
);

const run = (label, command, args) => {
  try {
    return execFileSync(command, args, { cwd: workdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    problems.push(`${label} failed:\n${error.stdout ?? ""}${error.stderr ?? error.message}`);
    return "";
  }
};

try {
  // 1 + 2: runtime resolution through the export map.
  writeFileSync(
    path.join(workdir, "probe.mjs"),
    `import * as core from "@shrinkjs/core";
import { minimizeTestCase } from "@shrinkjs/core/vitest";
import { minimizeTestCase as jestMinimize } from "@shrinkjs/core/jest";
import * as reporting from "@shrinkjs/core/reporting";
import * as artifacts from "@shrinkjs/core/artifacts";

const result = await core.shrink({ input: { a: 1, b: 2 }, test: (c) => c.a === 1 });
const expectations = [
  ["shrink", typeof core.shrink === "function"],
  ["minimize", core.minimize === core.shrink],
  ["VERSION", /^\\d+\\.\\d+\\.\\d+/.test(core.VERSION)],
  ["result", JSON.stringify(result.minimalInput) === '{"a":1}'],
  ["vitest adapter", typeof minimizeTestCase === "function"],
  ["jest adapter", typeof jestMinimize === "function"],
  ["reporting subpath", typeof reporting.createMarkdownReport === "function"],
  ["artifacts subpath", typeof artifacts.writeArtifacts === "function"],
  ["root is browser-safe", !("writeArtifacts" in core)],
];
const failed = expectations.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length > 0) {
  console.error("failed expectations: " + failed.join(", "));
  process.exit(1);
}
console.log("esm ok " + core.VERSION);
`,
    "utf8",
  );
  const esmOutput = run("ESM import probe", process.execPath, [path.join(workdir, "probe.mjs")]);
  if (esmOutput.trim().startsWith("esm ok"))
    notes.push("ESM: root + /vitest + /jest + /reporting + /artifacts resolve");

  writeFileSync(
    path.join(workdir, "probe.cjs"),
    `const core = require("@shrinkjs/core");
if (typeof core.shrink !== "function") {
  console.error("require() did not expose shrink");
  process.exit(1);
}
console.log("cjs ok " + core.VERSION);
`,
    "utf8",
  );
  const cjsOutput = run("CommonJS require probe", process.execPath, [path.join(workdir, "probe.cjs")]);
  if (cjsOutput.trim().startsWith("cjs ok")) notes.push("CJS: require(esm) exposes the root API");

  // 3: strict consumer type check through `exports`.
  writeFileSync(
    path.join(workdir, "consumer.ts"),
    `import {
  shrink,
  minimizeSequence,
  compareSimplicity,
  sizeOf,
  type CustomReducer,
  type ShrinkOptions,
  type ShrinkResult,
} from "@shrinkjs/core";
import { writeArtifacts } from "@shrinkjs/core/artifacts";
import { createMarkdownReport } from "@shrinkjs/core/reporting";
import { minimizeTestCase } from "@shrinkjs/core/vitest";

interface Payload {
  id: number;
  tags: string[];
}

const options: ShrinkOptions<Payload> = {
  input: { id: 1, tags: ["a"] },
  test: (candidate) => candidate.id === 1,
};

const result: ShrinkResult<Payload> = await shrink(options);
const id: number = result.minimalInput.id;
const reducer: CustomReducer<Payload> = {
  name: "noop",
  reduce: (candidate) => [candidate],
};

void reducer;
void id;
void writeArtifacts;
void createMarkdownReport;
void minimizeTestCase;
void minimizeSequence;
void compareSimplicity;
void sizeOf;
`,
    "utf8",
  );
  writeFileSync(
    path.join(workdir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2023"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  run("TypeScript consumer check", process.execPath, [tsc, "-p", path.join(workdir, "tsconfig.json")]);
  notes.push("types: strict node16 consumer compiles against the export map");

  // 4: root entry purity (static import graph).
  async function collectImports(file, seen = new Set()) {
    if (seen.has(file)) return seen;
    seen.add(file);
    const source = await readFile(file, "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:export|import)[^;]*?from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    for (const specifier of specifiers) {
      if (
        specifier.startsWith("node:") ||
        /^(fs|path|url|os|child_process|util|stream|events)$/.test(specifier)
      ) {
        problems.push(`dist/index.js reaches Node built-in "${specifier}" via ${path.relative(root, file)}`);
      }
      if (specifier.startsWith(".")) {
        await collectImports(path.resolve(path.dirname(file), specifier), seen);
      }
    }
    return seen;
  }
  if (await fileExists(path.join(root, "dist", "index.js"))) {
    const graph = await collectImports(path.join(root, "dist", "index.js"));
    notes.push(`root entry: ${graph.size} modules, no Node built-ins`);
  } else {
    problems.push("dist/index.js is missing — run npm run build first");
  }

  async function fileExists(target) {
    try {
      await readdir(path.dirname(target));
      readFileSync(target);
      return true;
    } catch {
      return false;
    }
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

for (const note of notes) console.log(`  note: ${note}`);

if (problems.length > 0) {
  console.error(`\nExport verification failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}

console.log(
  `\n✓ Exports verified for ${packageJson.name}@${packageJson.version} (ESM, CJS, types, root purity)`,
);

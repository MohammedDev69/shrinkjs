/**
 * Release gate: validates the package the way npm and publint will see it.
 *
 * Checks:
 *  1. `src/version.ts` matches `package.json#version`.
 *  2. Every `exports` target exists on disk (run `npm run build` first).
 *  3. The CLI entry point has a shebang and is executable.
 *  4. `npm pack --dry-run` ships dist + docs, and no source/tests/secrets.
 *  5. `publint` reports no errors.
 */
import { execFileSync } from "node:child_process";
import { readFile, access, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

const root = process.cwd();
const problems = [];
const notes = [];

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const versionSource = await readFile(path.join(root, "src/version.ts"), "utf8");
const versionMatch = versionSource.match(/VERSION\s*=\s*"([^"]+)"/);
if (!versionMatch) {
  problems.push("src/version.ts must export VERSION as a string literal");
} else if (versionMatch[1] !== pkg.version) {
  problems.push(`version mismatch: package.json ${pkg.version} vs src/version.ts ${versionMatch[1]}`);
}

const exportTargets = [];
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value === "string") exportTargets.push([key, value]);
  else if (value && typeof value === "object") {
    for (const [condition, target] of Object.entries(value)) {
      if (typeof target === "string") exportTargets.push([`${key} (${condition})`, target]);
    }
  }
}
for (const [key, target] of exportTargets) {
  if (!target.startsWith("./")) continue;
  const file = path.join(root, target);
  try {
    await access(file);
  } catch {
    problems.push(`exports["${key}"] points to missing file ${target} — run "npm run build"`);
  }
}

if (!pkg.bin || typeof pkg.bin !== "object") {
  problems.push("package.json must declare a bin entry");
} else {
  for (const [name, target] of Object.entries(pkg.bin)) {
    const file = path.join(root, target);
    try {
      const contents = await readFile(file, "utf8");
      if (!contents.startsWith("#!/usr/bin/env node")) {
        problems.push(`bin "${name}" (${target}) is missing the node shebang`);
      }
      const info = await stat(file);
      if (process.platform !== "win32" && (info.mode & 0o111) === 0) {
        notes.push(`bin "${name}" is not marked executable (npm fixes this on install)`);
      }
    } catch {
      problems.push(`bin "${name}" points to missing file ${target}`);
    }
  }
}

for (const required of ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE", "CHANGELOG.md"]) {
  try {
    await access(path.join(root, required));
  } catch {
    problems.push(`missing required published file: ${required}`);
  }
}

let packInfo = null;
try {
  // Run the npm CLI through this node binary so shell quoting is never involved.
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const [command, args] = existsSync(npmCli)
    ? [process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"]]
    : ["npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]];
  const raw = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(raw);
  // npm < 12 returns an array of reports; npm >= 12 keys them by package name.
  packInfo = Array.isArray(parsed) ? parsed[0] : (parsed[pkg.name] ?? Object.values(parsed)[0]);
} catch (error) {
  problems.push(`npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (packInfo) {
  const files = packInfo.files.map((file) => file.path);
  const forbidden = [
    [/^src\//, "TypeScript sources must not ship"],
    [/^tests\//, "tests must not ship"],
    [/^examples\//, "examples must not ship"],
    [/^bench\//, "benchmarks must not ship"],
    [/^scripts\//, "scripts must not ship"],
    [/^\.github\//, "CI config must not ship"],
    [/^node_modules\//, "node_modules must not ship"],
    [/^dist\/.*\.test\./, "compiled tests must not ship"],
    [/(^|\/)\.env/, "environment files must not ship"],
    [/^coverage\//, "coverage output must not ship"],
  ];
  for (const file of files) {
    for (const [pattern, reason] of forbidden) {
      if (pattern.test(file)) problems.push(`tarball contains ${file}: ${reason}`);
    }
  }
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli/index.js",
  ]) {
    if (!files.includes(required)) problems.push(`tarball is missing ${required}`);
  }
  notes.push(
    `tarball: ${files.length} files, ${(packInfo.size / 1024).toFixed(1)} kB packed, ${(packInfo.unpackedSize / 1024).toFixed(1)} kB unpacked`,
  );
}

try {
  const result = await publint({ pack: "npm" });
  const errors = result.messages.filter((message) => message.type === "error");
  const warnings = result.messages.filter((message) => message.type === "warning");
  for (const error of errors) {
    problems.push(`publint: ${error.code} — ${formatMessage(error, result.pkg, { color: false })}`);
  }
  for (const warning of warnings) {
    notes.push(`publint warning: ${warning.code} — ${formatMessage(warning, result.pkg, { color: false })}`);
  }
  notes.push(`publint: ${result.messages.length} message(s)`);
} catch (error) {
  problems.push(`publint failed to run: ${error instanceof Error ? error.message : String(error)}`);
}

for (const note of notes) console.log(`  note: ${note}`);

if (problems.length > 0) {
  console.error(`\nPackage validation failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}

console.log(`\n✓ Package validation passed (${pkg.name}@${pkg.version})`);

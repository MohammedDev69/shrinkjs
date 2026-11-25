/**
 * Guards the packaging guarantees that the root entry advertises:
 * no Node built-ins reachable from it, and every `exports` target exists.
 *
 * These assertions inspect the *built* output (the package `pretest` script
 * builds first); when `dist/` is absent they are skipped so watch mode works.
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const distIndex = path.join(root, "dist", "index.js");
const hasDist = existsSync(distIndex);

const NODE_BUILTIN = /^(node:|fs$|path$|url$|os$|child_process$|util$|stream$|events$|crypto$|http$|https$)/;

async function importGraph(entry: string): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>();
  const visit = async (file: string): Promise<void> => {
    if (graph.has(file)) return;
    const source = await readFile(file, "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:export|import)[^;]*?from\s+"([^"]+)"/g)].map(
      (match) => match[1] as string,
    );
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) await visit(path.resolve(path.dirname(file), specifier));
    }
  };
  await visit(entry);
  return graph;
}

describe.skipIf(!hasDist)("built package", () => {
  it("root entry has no static Node built-in imports", async () => {
    const graph = await importGraph(distIndex);
    const offenders: string[] = [];
    for (const [file, specifiers] of graph) {
      for (const specifier of specifiers) {
        if (NODE_BUILTIN.test(specifier)) offenders.push(`${path.relative(root, file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("all exports targets exist and are reachable files", async () => {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      exports: Record<string, { types?: string; default?: string } | string>;
    };
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === "string") continue;
      for (const file of [target.types, target.default]) {
        if (!file) continue;
        expect(existsSync(path.join(root, file)), `${subpath} -> ${file}`).toBe(true);
      }
    }
  });

  it("the CLI entry starts with a shebang", async () => {
    const contents = await readFile(path.join(root, "dist", "cli", "index.js"), "utf8");
    expect(contents.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("does not ship source or tests in the build output", async () => {
    const files = await readdir(path.join(root, "dist"), { recursive: true });
    const suspicious = files.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
    expect(suspicious).toEqual([]);
  });
});

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { shrink } from "../core/shrink.js";
import type { ShrinkResult } from "../core/types.js";
import { writeArtifacts, type ArtifactKind, type ArtifactResult } from "../reporting/artifacts.js";
import { createJsonReport, serializeJsonReport } from "../reporting/json.js";
import { formatCount, formatDuration, formatSize, truncate } from "../utils/format.js";
import { toJsonString } from "../utils/json-safe.js";
import { VERSION } from "../version.js";
import { HELP_TEXT, parseArgs, validateForRun, type CliOptions } from "./args.js";
import { createStyle, ProgressRenderer, renderSummary, type Style } from "./output.js";

export interface CliIo {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  /** Used when `--input -` is passed. Defaults to reading `process.stdin`. */
  readStdin?: () => Promise<string>;
  signal?: AbortSignal;
}

class CliFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "CliFailure";
    this.exitCode = exitCode;
  }
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  const style = createStyle(resolveColor(parsed.options, io));

  if (parsed.errors.length > 0) {
    io.stderr(`${style.red("Invalid usage:")}\n`);
    for (const error of parsed.errors) io.stderr(`  - ${error}\n`);
    io.stderr(`\nRun "shrinkjs --help" for usage.\n`);
    return 2;
  }

  const options = parsed.options;
  if (options.help || options.command === "help") {
    io.stdout(`${HELP_TEXT}\n`);
    return 0;
  }
  if (options.version || options.command === "version") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  const validationErrors = validateForRun(options);
  if (validationErrors.length > 0) {
    io.stderr(`${style.red("Invalid usage:")}\n`);
    for (const error of validationErrors) io.stderr(`  - ${error}\n`);
    io.stderr(`\nRun "shrinkjs --help" for usage.\n`);
    return 2;
  }

  try {
    return await runMinimize(options, io, style);
  } catch (error) {
    if (error instanceof CliFailure) {
      io.stderr(`${style.red("Error:")} ${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${style.red("Unexpected error:")} ${message}\n`);
    return 2;
  }
}

function resolveColor(options: CliOptions, io: CliIo): boolean {
  if (options.color === false) return false;
  if (options.color === true) return true;
  if (io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== "") return false;
  if (io.env.FORCE_COLOR !== undefined && io.env.FORCE_COLOR !== "0") return true;
  return io.isTTY;
}

async function runMinimize(options: CliOptions, io: CliIo, style: Style): Promise<number> {
  const quiet = options.quiet === true;
  const json = options.json === true;
  const verbose = options.verbose === true;

  const inputPath = options.input as string;
  const testPath = options.test as string;
  const inputSource = inputPath === "-" ? "<stdin>" : path.resolve(io.cwd, inputPath);
  const modulePath = path.resolve(io.cwd, testPath);
  const outputDir = path.resolve(io.cwd, options.output ?? "shrinkjs-output");

  const input = await loadInput(inputPath, io);
  const predicate = await loadPredicate(modulePath, options.testExport, io);

  if (!quiet && !json) {
    const preset = options.preset ?? "balanced";
    io.stdout(`\n  ${style.bold("ShrinkJS")} ${style.gray(VERSION)} ${style.gray("· input minimization")}\n`);
    io.stdout(`  ${style.gray("────────────────────────────────────────────")}\n\n`);
    io.stdout(
      `  ${style.gray("Input     ")} ${displayPath(io.cwd, inputSource)}  ${style.gray(`(${formatSize(measure(input))})`)}\n`,
    );
    io.stdout(
      `  ${style.gray("Predicate ")} ${displayPath(io.cwd, modulePath)} ${style.gray(`(${predicate.exportUsed} export)`)}\n`,
    );
    io.stdout(`  ${style.gray("Preset    ")} ${preset}\n\n`);
  }

  const progressEnabled = options.progress !== false && io.isTTY && !quiet && !json;
  const progress = new ProgressRenderer({
    enabled: progressEnabled,
    style,
    maxEvaluations: options.maxEvaluations ?? 5000,
    write: (text) => io.stderr(text),
  });

  let lastAccepted = 0;
  const startedAt = Date.now();

  const result: ShrinkResult<unknown> = await shrink({
    input,
    test: predicate.fn as (candidate: unknown) => boolean | Promise<boolean>,
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    ...(options.history === true ? { history: { enabled: true, maxEntries: 500 } } : {}),
    ...(options.noCache === true ? { cache: false } : {}),
    ...(options.verify === false ? { verifyFinalInput: false } : {}),
    limits: {
      ...(options.maxEvaluations === undefined ? {} : { maxEvaluations: options.maxEvaluations }),
      ...(options.predicateTimeout === undefined ? {} : { predicateTimeout: options.predicateTimeout }),
      ...(options.maxDuration === undefined ? {} : { maxDuration: options.maxDuration }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      ...(options.maxInputSize === undefined ? {} : { maxInputSize: options.maxInputSize }),
      ...(options.maxCandidatesPerNode === undefined
        ? {}
        : { maxCandidatesPerNode: options.maxCandidatesPerNode }),
    },
    ...(io.signal === undefined ? {} : { signal: io.signal }),
    onProgress: (event) => {
      progress.update(event);
      if (verbose && event.accepted > lastAccepted) {
        lastAccepted = event.accepted;
        progress.note(
          `  ${style.green("↓")} ${formatSize(event.bestSize).padStart(9)}  ${style.gray(event.strategy)} ${style.gray(event.path ?? "$")}`,
        );
      }
    },
  });

  progress.clear();

  const artifacts: ArtifactKind[] = ["result", "markdown", "input", "reproduction", "regression"];
  let written: ArtifactResult | null = null;
  if (options.noArtifacts !== true) {
    written = await writeArtifacts(result, {
      outputDir,
      inputSource: displayPath(io.cwd, inputSource),
      testModule: modulePath,
      ...(options.testExport === undefined ? {} : { testExport: options.testExport }),
      overwrite: options.force === true,
      name: path.basename(modulePath),
      artifacts,
      ...(options.redactKeys === undefined ? {} : { redact: { keys: options.redactKeys } }),
    });
  }

  if (json) {
    const report = createJsonReport(result, {
      inputSource: displayPath(io.cwd, inputSource),
      ...(options.redactKeys === undefined ? {} : { redact: { keys: options.redactKeys } }),
    });
    io.stdout(serializeJsonReport(report));
  } else if (!quiet) {
    io.stdout(`\n${renderSummary(result, style)}\n\n`);

    const minimal = toJsonString(result.minimalInput, 2);
    const maxChars = 1600;
    io.stdout(`  ${style.gray("Minimal input")}\n`);
    io.stdout(`${indent(truncate(minimal, maxChars), "  ")}\n`);
    if (minimal.length > maxChars) {
      io.stdout(`  ${style.gray("(truncated — full value in minimized-input.json)")}\n`);
    }
    io.stdout("\n");

    if (written) {
      io.stdout(`  ${style.gray("Artifacts")} ${style.gray(displayPath(io.cwd, written.outputDir))}\n`);
      for (const file of written.files) {
        io.stdout(`    ${style.green("✓")} ${path.relative(io.cwd, file)}\n`);
      }
      for (const file of written.skipped) {
        io.stdout(
          `    ${style.yellow("•")} ${path.relative(io.cwd, file)} ${style.gray("(exists, use --force)")}\n`,
        );
      }
      for (const file of written.notGenerated) {
        io.stdout(`    ${style.gray("–")} ${path.relative(io.cwd, file)} ${style.gray("(needs --test)")}\n`);
      }
      io.stdout("\n");
    }

    io.stdout(
      `  ${style.gray("Next")} node ${path.relative(io.cwd, path.join(written?.outputDir ?? outputDir, "reproduction.mjs"))}\n\n`,
    );

    if (verbose) {
      io.stdout(
        `  ${style.gray(`Total wall clock ${formatDuration(Date.now() - startedAt)} · ${formatCount(result.stats.evaluations)} predicate calls`)}\n\n`,
      );
    }
  }

  if (result.status === "cancelled") return 130;
  return result.ok ? 0 : 1;
}

async function loadInput(inputPath: string, io: CliIo): Promise<unknown> {
  if (inputPath === "-") {
    const text = io.readStdin ? await io.readStdin() : await readAll(process.stdin);
    return parseJson(text, "<stdin>");
  }

  const resolved = path.resolve(io.cwd, inputPath);
  if (!existsSync(resolved)) {
    throw new CliFailure(`Input file not found: ${resolved}`);
  }
  if (!resolved.toLowerCase().endsWith(".json")) {
    throw new CliFailure(
      `Unsupported input format: ${path.basename(resolved)}. The CLI reads JSON files; use the library API for other inputs.`,
    );
  }
  let text: string;
  try {
    text = await readFile(resolved, "utf8");
  } catch (error) {
    throw new CliFailure(
      `Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseJson(text, resolved);
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliFailure(`Invalid JSON in ${source}: ${message}`);
  }
}

interface LoadedPredicate {
  fn: unknown;
  exportUsed: string;
}

async function loadPredicate(
  modulePath: string,
  exportName: string | undefined,
  io: CliIo,
): Promise<LoadedPredicate> {
  if (!existsSync(modulePath)) {
    throw new CliFailure(`Predicate module not found: ${modulePath}`);
  }

  let module_: Record<string, unknown>;
  try {
    module_ = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension/.test(message)
      ? "\nTypeScript predicate files need a runtime that strips types (Node >= 22.18, or Node 24+). Alternatively compile the module to .mjs/.js first."
      : "";
    throw new CliFailure(`Could not load predicate module ${modulePath}: ${message}${hint}`);
  }

  const usedExport = exportName ?? (typeof module_.default === "function" ? "default" : "test");
  const fn = exportName ? module_[exportName] : (module_.default ?? module_.test);

  if (typeof fn !== "function") {
    const available = Object.keys(module_).filter((key) => typeof module_[key] === "function");
    throw new CliFailure(
      `Predicate module ${modulePath} does not export a function.\n` +
        `  Exported functions: ${available.length > 0 ? available.join(", ") : "(none)"}\n` +
        `  Expected: "export default async (candidate) => boolean" or "export async function test(candidate) { ... }"`,
    );
  }

  void io;
  return { fn, exportUsed: usedExport };
}

function displayPath(cwd: string, absoluteOrLabel: string): string {
  if (absoluteOrLabel.startsWith("<")) return absoluteOrLabel;
  const relative = path.relative(cwd, absoluteOrLabel);
  if (relative === "") return ".";
  return relative.startsWith("..") ? absoluteOrLabel : relative.split(path.sep).join("/");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function measure(value: unknown): number {
  try {
    return toJsonString(value, 0).length;
  } catch {
    return 0;
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

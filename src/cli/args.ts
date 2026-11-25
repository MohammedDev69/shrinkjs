import type { PresetName } from "../core/types.js";

export interface CliOptions {
  command: "minimize" | "help" | "version";
  input?: string;
  test?: string;
  testExport?: string;
  output?: string;
  preset?: PresetName;
  predicateErrors?: "ignore" | "fail" | "preserve";
  maxEvaluations?: number;
  predicateTimeout?: number;
  maxDuration?: number;
  maxDepth?: number;
  maxInputSize?: number;
  maxCandidatesPerNode?: number;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  progress?: boolean;
  force?: boolean;
  history?: boolean;
  verify?: boolean;
  noCache?: boolean;
  noArtifacts?: boolean;
  redactKeys?: string[];
  color?: boolean;
  help?: boolean;
  version?: boolean;
}

export interface ParseResult {
  options: CliOptions;
  errors: string[];
}

const PRESET_NAMES: readonly PresetName[] = ["fast", "balanced", "thorough"];

const NUMBER_FLAGS = {
  "max-evaluations": "maxEvaluations",
  "predicate-timeout": "predicateTimeout",
  "max-duration": "maxDuration",
  "max-depth": "maxDepth",
  "max-input-size": "maxInputSize",
  "max-candidates": "maxCandidatesPerNode",
} as const;

type NumberFlag = keyof typeof NUMBER_FLAGS;

const VALUE_FLAGS = {
  input: "input",
  test: "test",
  "test-export": "testExport",
  output: "output",
  preset: "preset",
  "predicate-errors": "predicateErrors",
  redact: "redactKeys",
} as const;

const BOOLEAN_FLAGS: Record<string, { key: keyof CliOptions; value: boolean }> = {
  json: { key: "json", value: true },
  quiet: { key: "quiet", value: true },
  verbose: { key: "verbose", value: true },
  progress: { key: "progress", value: true },
  "no-progress": { key: "progress", value: false },
  force: { key: "force", value: true },
  history: { key: "history", value: true },
  verify: { key: "verify", value: true },
  "no-verify": { key: "verify", value: false },
  "no-cache": { key: "noCache", value: true },
  "no-artifacts": { key: "noArtifacts", value: true },
  color: { key: "color", value: true },
  "no-color": { key: "color", value: false },
  help: { key: "help", value: true },
  version: { key: "version", value: true },
};

/**
 * Parses CLI arguments without any dependency.
 *
 * Supports `--flag value`, `--flag=value`, `-h`/`-v` shorthands and `--` as a
 * terminator. Problems are collected in `errors`; the caller decides how to
 * report them and which exit code to use.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const options: CliOptions = { command: "minimize" };
  const errors: string[] = [];
  const tokens = [...argv];

  if (tokens.length === 0) return { options: { command: "help" }, errors };

  const first = tokens[0] as string;
  if (first === "-h" || first === "--help" || first === "help") {
    return { options: { command: "help" }, errors };
  }
  if (first === "-v" || first === "--version" || first === "version") {
    return { options: { command: "version" }, errors };
  }
  if (first === "minimize") {
    tokens.shift();
  } else if (!first.startsWith("-")) {
    errors.push(`Unknown command "${first}". Available: minimize, help, version.`);
    return { options, errors };
  }

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    index += 1;

    if (token === "--") {
      if (index < tokens.length) {
        errors.push(`Unexpected positional arguments: ${tokens.slice(index).join(" ")}`);
      }
      break;
    }
    if (token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "-v") {
      options.version = true;
      continue;
    }
    if (!token.startsWith("--")) {
      errors.push(`Unexpected argument "${token}". Options take the form --name=value.`);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const rawName = equals === -1 ? withoutPrefix : withoutPrefix.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : withoutPrefix.slice(equals + 1);

    const booleanFlag = BOOLEAN_FLAGS[rawName];
    if (booleanFlag) {
      if (inlineValue !== undefined) {
        errors.push(`--${rawName} does not take a value`);
        continue;
      }
      (options as unknown as Record<string, unknown>)[booleanFlag.key] = booleanFlag.value;
      continue;
    }

    if (rawName in VALUE_FLAGS || rawName in NUMBER_FLAGS) {
      let value = inlineValue;
      if (value === undefined) {
        const next = tokens[index];
        if (next === undefined || next.startsWith("--")) {
          errors.push(`--${rawName} requires a value`);
          continue;
        }
        value = next;
        index += 1;
      }
      assignValue(options, rawName, value, errors);
      continue;
    }

    errors.push(`Unknown option --${rawName}. Run "shrinkjs --help" for usage.`);
  }

  return { options, errors };
}

function assignValue(options: CliOptions, name: string, value: string, errors: string[]): void {
  if (name === "redact") {
    const keys = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (keys.length === 0) errors.push("--redact requires at least one property name");
    else options.redactKeys = keys;
    return;
  }

  if (name === "preset") {
    if (!PRESET_NAMES.includes(value as PresetName)) {
      errors.push(`--preset must be one of ${PRESET_NAMES.join(", ")}`);
      return;
    }
    options.preset = value as PresetName;
    return;
  }

  if (name === "predicate-errors") {
    if (value !== "ignore" && value !== "fail" && value !== "preserve") {
      errors.push("--predicate-errors must be one of ignore, fail, preserve");
      return;
    }
    options.predicateErrors = value;
    return;
  }

  if (name in NUMBER_FLAGS) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      errors.push(`--${name} must be a non-negative integer, received "${value}"`);
      return;
    }
    options[NUMBER_FLAGS[name as NumberFlag]] = parsed;
    return;
  }

  if (value.trim() === "") {
    errors.push(`--${name} requires a non-empty value`);
    return;
  }
  options[VALUE_FLAGS[name as keyof typeof VALUE_FLAGS]] = value as never;
}

export function validateForRun(options: CliOptions): string[] {
  const errors: string[] = [];
  if (options.command !== "minimize") return errors;
  if (!options.input) errors.push("Missing --input <file>");
  if (!options.test) errors.push("Missing --test <module>");
  if (options.input === "-" && options.json) {
    errors.push("Cannot combine --input - with --json: both would use stdout");
  }
  return errors;
}

export const HELP_TEXT = `ShrinkJS — input minimization engine

Usage:
  shrinkjs minimize --input <file> --test <module> [options]
  shrinkjs --help | --version

Required:
  --input <file>           JSON file with the input to minimize ("-" reads stdin)
  --test <module>          Module exporting the predicate (default export,
                           or a named "test" export)
                           ESM: .mjs/.js. TypeScript: .ts on Node >= 22.18

Options:
  --test-export <name>     Named export to use instead of default/test
  --output <dir>           Artifact directory (default: ./shrinkjs-output)
  --preset <name>          fast | balanced | thorough (default: balanced)
  --predicate-errors <p>   ignore | fail | preserve (default: ignore)
  --max-evaluations <n>    Predicate calls allowed (default: 5000)
  --predicate-timeout <ms> Per-call timeout (default: 5000, 0 disables)
  --max-duration <ms>      Total wall-clock budget (default: 60000)
  --max-depth <n>          Maximum container depth (default: 32)
  --max-input-size <n>     Maximum input size in characters (default: 10000000)
  --max-candidates <n>     Candidates per node (default: 2000)
  --history                Record the reduction history (bounded)
  --no-cache               Disable predicate result memoization
  --no-verify              Skip the fresh-copy verification pass
  --no-artifacts           Do not write report/artifact files
  --force                  Overwrite existing artifact files
  --redact <keys>          Comma-separated property names to redact in reports
  --json                   Print the machine-readable report to stdout
  --quiet                  Only print errors
  --verbose                Print every accepted reduction
  --no-progress            Disable the progress bar
  --no-color               Disable ANSI colors (also honors NO_COLOR)
  -h, --help               Show this help
  -v, --version            Show version

Exit codes:
  0  success (completed, limit-reached or unstable)
  1  the predicate did not hold / predicate failure
  2  invalid usage, missing files or invalid JSON
  130 cancelled by the user
`;

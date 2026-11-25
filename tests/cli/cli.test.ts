import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/run.js";
import { HELP_TEXT, parseArgs } from "../../src/cli/args.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "shrinkjs-cli-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function makeIo(overrides: Partial<CliIo> = {}): {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
} {
  let out = "";
  let err = "";
  const io: CliIo = {
    cwd: workdir,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    isTTY: false,
    env: {},
    ...overrides,
  };
  return { io, stdout: () => out, stderr: () => err };
}

async function writeFixture(): Promise<{ input: string; predicate: string }> {
  const inputPath = path.join(workdir, "input.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      users: [
        { id: 1, name: "Ada", active: true },
        { id: 2, name: "Bob", active: false },
      ],
      meta: { source: "web", version: "1.0.0" },
    }),
    "utf8",
  );

  const predicatePath = path.join(workdir, "predicate.mjs");
  await writeFile(
    predicatePath,
    `export default function test(input) {
  return Array.isArray(input.users) && input.users.some((user) => user.name === "Bob");
}
`,
    "utf8",
  );

  return { input: inputPath, predicate: predicatePath };
}

describe("parseArgs", () => {
  it("parses a full command line", () => {
    const { options, errors } = parseArgs([
      "minimize",
      "--input",
      "in.json",
      "--test=pred.mjs",
      "--preset",
      "thorough",
      "--max-evaluations=42",
      "--history",
      "--no-cache",
      "--redact",
      "token,password",
    ]);
    expect(errors).toEqual([]);
    expect(options.command).toBe("minimize");
    expect(options.input).toBe("in.json");
    expect(options.test).toBe("pred.mjs");
    expect(options.preset).toBe("thorough");
    expect(options.maxEvaluations).toBe(42);
    expect(options.history).toBe(true);
    expect(options.noCache).toBe(true);
    expect(options.redactKeys).toEqual(["token", "password"]);
  });

  it("recognizes help and version", () => {
    expect(parseArgs(["--help"]).options.command).toBe("help");
    expect(parseArgs(["help"]).options.command).toBe("help");
    expect(parseArgs(["--version"]).options.command).toBe("version");
    expect(parseArgs([]).options.command).toBe("help");
  });

  it("reports unknown flags and commands", () => {
    expect(parseArgs(["--nope"]).errors[0]).toContain("Unknown option");
    expect(parseArgs(["frobnicate"]).errors[0]).toContain("Unknown command");
  });

  it("rejects missing values and bad numbers", () => {
    expect(parseArgs(["--input"]).errors[0]).toContain("requires a value");
    expect(parseArgs(["--max-evaluations=abc"]).errors[0]).toContain("non-negative integer");
    expect(parseArgs(["--preset=turbo"]).errors[0]).toContain("--preset must be one of");
  });

  it("rejects values on boolean flags", () => {
    expect(parseArgs(["--quiet=yes"]).errors[0]).toContain("does not take a value");
  });
});

describe("runCli", () => {
  it("prints help and version", async () => {
    const help = makeIo();
    expect(await runCli(["--help"], help.io)).toBe(0);
    expect(help.stdout()).toContain(HELP_TEXT.split("\n")[0]);

    const version = makeIo();
    expect(await runCli(["--version"], version.io)).toBe(0);
    expect(version.stdout().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns exit code 2 for invalid usage", async () => {
    const { io, stderr } = makeIo();
    expect(await runCli(["--wat"], io)).toBe(2);
    expect(stderr()).toContain("Unknown option");
  });

  it("requires --input and --test", async () => {
    const { io, stderr } = makeIo();
    expect(await runCli(["minimize"], io)).toBe(2);
    expect(stderr()).toContain("Missing --input");
    expect(stderr()).toContain("Missing --test");
  });

  it("reports missing input files", async () => {
    const { io, stderr } = makeIo();
    const code = await runCli(["minimize", "--input", "nope.json", "--test", "x.mjs"], io);
    expect(code).toBe(2);
    expect(stderr()).toContain("Input file not found");
  });

  it("reports invalid JSON", async () => {
    const badPath = path.join(workdir, "bad.json");
    await writeFile(badPath, "{ not json", "utf8");
    const { io, stderr } = makeIo();
    const code = await runCli(["minimize", "--input", badPath, "--test", "x.mjs"], io);
    expect(code).toBe(2);
    expect(stderr()).toContain("Invalid JSON");
  });

  it("requires a JSON input file extension", async () => {
    const txtPath = path.join(workdir, "input.txt");
    await writeFile(txtPath, "hello", "utf8");
    const { io, stderr } = makeIo();
    expect(await runCli(["minimize", "--input", txtPath, "--test", "x.mjs"], io)).toBe(2);
    expect(stderr()).toContain("Unsupported input format");
  });

  it("reports predicate modules that do not export a function", async () => {
    const { input } = await writeFixture();
    const badPredicate = path.join(workdir, "bad-predicate.mjs");
    await writeFile(badPredicate, "export const value = 42;\n", "utf8");

    const { io, stderr } = makeIo();
    const code = await runCli(["minimize", "--input", input, "--test", badPredicate], io);
    expect(code).toBe(2);
    expect(stderr()).toContain("does not export a function");
  });

  it("minimizes, prints a summary and writes artifacts", async () => {
    const { input, predicate } = await writeFixture();
    const outputDir = path.join(workdir, "out");

    const { io, stdout } = makeIo();
    const code = await runCli(
      ["minimize", "--input", input, "--test", predicate, "--output", outputDir, "--no-progress"],
      io,
    );

    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain("ShrinkJS");
    expect(text).toContain("Target behavior preserved");
    expect(text).toContain("Artifacts");
    expect(text).toContain("Minimal input");

    const result = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8")) as {
      status: string;
      minimalInput: unknown;
      stats: { reductionPercent: number };
    };
    expect(result.status).toBe("completed");
    expect(result.minimalInput).toEqual({ users: [{ name: "Bob" }] });
    expect(result.stats.reductionPercent).toBeGreaterThan(50);

    expect(existsSync(path.join(outputDir, "report.md"))).toBe(true);
    expect(existsSync(path.join(outputDir, "reproduction.mjs"))).toBe(true);
    expect(existsSync(path.join(outputDir, "regression.test.ts"))).toBe(true);
  });

  it("prints machine-readable JSON with --json", async () => {
    const { input, predicate } = await writeFixture();
    const { io, stdout } = makeIo();
    const code = await runCli(
      [
        "minimize",
        "--input",
        input,
        "--test",
        predicate,
        "--json",
        "--output",
        path.join(workdir, "json-out"),
      ],
      io,
    );
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout()) as { status: string; minimalInput: unknown; tool: { name: string } };
    expect(parsed.tool.name).toBe("@shrinkjs/core");
    expect(parsed.status).toBe("completed");
    expect(parsed.minimalInput).toEqual({ users: [{ name: "Bob" }] });
  });

  it("writes no artifacts with --no-artifacts", async () => {
    const { input, predicate } = await writeFixture();
    const outputDir = path.join(workdir, "none");
    const { io } = makeIo();
    await runCli(
      ["minimize", "--input", input, "--test", predicate, "--output", outputDir, "--no-artifacts", "--quiet"],
      io,
    );
    expect(existsSync(outputDir)).toBe(false);
  });

  it("stays silent in quiet mode", async () => {
    const { input, predicate } = await writeFixture();
    const { io, stdout } = makeIo();
    await runCli(
      ["minimize", "--input", input, "--test", predicate, "--quiet", "--output", path.join(workdir, "q")],
      io,
    );
    expect(stdout()).toBe("");
  });

  it("returns exit code 1 when the predicate never holds", async () => {
    const { input } = await writeFixture();
    const neverPredicate = path.join(workdir, "never.mjs");
    await writeFile(neverPredicate, "export default function test() { return false; }\n", "utf8");

    const { io, stdout } = makeIo();
    const code = await runCli(
      ["minimize", "--input", input, "--test", neverPredicate, "--output", path.join(workdir, "fail")],
      io,
    );
    expect(code).toBe(1);
    expect(stdout()).toContain("ERR_PREDICATE_NOT_PRESERVED");
  });

  it("accepts a named test export", async () => {
    const { input } = await writeFixture();
    const named = path.join(workdir, "named.mjs");
    await writeFile(
      named,
      `export function reproduce(candidate) { return JSON.stringify(candidate).includes("Bob"); }\n`,
      "utf8",
    );
    const { io, stdout } = makeIo();
    const code = await runCli(
      [
        "minimize",
        "--input",
        input,
        "--test",
        named,
        "--test-export",
        "reproduce",
        "--output",
        path.join(workdir, "n"),
      ],
      io,
    );
    expect(code).toBe(0);
    expect(stdout()).toContain("(reproduce export)");
  });

  it("reads the input from stdin", async () => {
    const { predicate } = await writeFixture();
    const { io } = makeIo({
      readStdin: async () => JSON.stringify({ users: [{ name: "Bob" }], extra: 1 }),
    });
    const code = await runCli(
      ["minimize", "--input", "-", "--test", predicate, "--output", path.join(workdir, "stdin"), "--quiet"],
      io,
    );
    expect(code).toBe(0);
    const result = JSON.parse(await readFile(path.join(workdir, "stdin", "result.json"), "utf8")) as {
      minimalInput: unknown;
    };
    expect(result.minimalInput).toEqual({ users: [{ name: "Bob" }] });
  });

  it("reports cancellation with exit code 130", async () => {
    const { input, predicate } = await writeFixture();
    const controller = new AbortController();
    controller.abort();
    const { io } = makeIo({ signal: controller.signal });
    const code = await runCli(
      ["minimize", "--input", input, "--test", predicate, "--output", path.join(workdir, "c")],
      io,
    );
    expect(code).toBe(130);
  });

  it("refuses to overwrite artifacts without --force", async () => {
    const { input, predicate } = await writeFixture();
    const outputDir = path.join(workdir, "twice");
    const first = makeIo();
    expect(
      await runCli(["minimize", "--input", input, "--test", predicate, "--output", outputDir], first.io),
    ).toBe(0);

    const second = makeIo();
    expect(
      await runCli(["minimize", "--input", input, "--test", predicate, "--output", outputDir], second.io),
    ).toBe(0);
    expect(second.stdout()).toContain("exists, use --force");

    const third = makeIo();
    expect(
      await runCli(
        ["minimize", "--input", input, "--test", predicate, "--output", outputDir, "--force"],
        third.io,
      ),
    ).toBe(0);
    expect(third.stdout()).toContain("✓");
  });

  it("redacts properties in reports", async () => {
    const { predicate } = await writeFixture();
    const inputPath = path.join(workdir, "secret.json");
    await writeFile(inputPath, JSON.stringify({ users: [{ name: "Bob", token: "super-secret" }] }), "utf8");
    const outputDir = path.join(workdir, "redacted");
    const { io } = makeIo();
    await runCli(
      ["minimize", "--input", inputPath, "--test", predicate, "--output", outputDir, "--redact", "token"],
      io,
    );
    const report = await readFile(path.join(outputDir, "report.md"), "utf8");
    expect(report).not.toContain("super-secret");
  });

  it("can be run as a real binary", () => {
    const binPath = path.resolve(process.cwd(), "dist/cli/index.js");
    if (!existsSync(binPath)) return;
    const output = execFileSync(process.execPath, [binPath, "--version"], { encoding: "utf8" });
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("handles file paths containing spaces", async () => {
    const spacedDir = path.join(workdir, "dir with spaces");
    await mkdir(spacedDir, { recursive: true });
    const inputPath = path.join(spacedDir, "in put.json");
    await writeFile(
      inputPath,
      JSON.stringify({ users: [{ name: "Bob", extra: 1 }], meta: { x: 1 } }),
      "utf8",
    );
    const predicatePath = path.join(spacedDir, "pre dicate.mjs");
    await writeFile(
      predicatePath,
      'export default (input) => Array.isArray(input.users) && input.users.some((u) => u.name === "Bob");\n',
      "utf8",
    );
    const outputDir = path.join(spacedDir, "out dir");

    const { io, stderr } = makeIo();
    const code = await runCli(
      ["minimize", "--input", inputPath, "--test", predicatePath, "--output", outputDir, "--quiet"],
      io,
    );
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    const result = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8")) as {
      minimalInput: unknown;
    };
    expect(result.minimalInput).toEqual({ users: [{ name: "Bob" }] });
  });

  it("supports --predicate-errors fail for CI", async () => {
    const { input } = await writeFixture();
    const throwing = path.join(workdir, "throwing.mjs");
    await writeFile(
      throwing,
      `export default function test(candidate) {
  if (!Array.isArray(candidate.users)) throw new TypeError("no users");
  return candidate.users.some((user) => user.name === "Bob");
}
`,
      "utf8",
    );

    const { io, stdout } = makeIo();
    const code = await runCli(
      [
        "minimize",
        "--input",
        input,
        "--test",
        throwing,
        "--predicate-errors",
        "fail",
        "--output",
        path.join(workdir, "strict"),
        "--no-progress",
      ],
      io,
    );

    expect(code).toBe(1);
    expect(stdout()).toContain("ERR_PREDICATE_FAILED");
  });

  it("rejects an invalid --predicate-errors value", async () => {
    const { io, stderr } = makeIo();
    const code = await runCli(["minimize", "--predicate-errors", "explode"], io);
    expect(code).toBe(2);
    expect(stderr()).toContain("--predicate-errors must be one of");
  });
});

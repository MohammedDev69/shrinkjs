#!/usr/bin/env node
import { runCli, type CliIo } from "./run.js";

const controller = new AbortController();
let interruptions = 0;

process.on("SIGINT", () => {
  interruptions += 1;
  if (interruptions > 1) {
    process.stderr.write("\nForce exit.\n");
    process.exit(130);
  }
  process.stderr.write("\nCancelling minimization (press Ctrl+C again to force exit)…\n");
  controller.abort();
});

const io: CliIo = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: process.stdout.isTTY === true,
  env: process.env,
  signal: controller.signal,
};

process.exitCode = await runCli(process.argv.slice(2), io);

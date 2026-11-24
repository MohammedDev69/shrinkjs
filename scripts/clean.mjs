import { rm } from "node:fs/promises";
import path from "node:path";

const targets = ["dist", "coverage", "tsconfig.tsbuildinfo"];

for (const target of targets) {
  await rm(path.resolve(process.cwd(), target), { recursive: true, force: true });
}

console.log(`Cleaned: ${targets.join(", ")}`);

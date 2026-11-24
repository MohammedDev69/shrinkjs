import { ShrinkConfigError } from "./errors.js";
import type { HistoryEntry, HistoryOptions } from "./types.js";

export interface ResolvedHistoryOptions {
  enabled: boolean;
  maxEntries: number;
  includeValues: boolean;
}

export function resolveHistory(options: HistoryOptions | undefined): ResolvedHistoryOptions {
  const enabled = options?.enabled ?? false;
  const maxEntries = options?.maxEntries ?? 200;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new ShrinkConfigError(`history.maxEntries must be an integer >= 1, received ${String(maxEntries)}`);
  }
  if (options?.includeValues !== undefined && typeof options.includeValues !== "boolean") {
    throw new ShrinkConfigError("history.includeValues must be a boolean");
  }
  return { enabled, maxEntries, includeValues: options?.includeValues ?? false };
}

/**
 * Bounded recorder.
 *
 * When the cap is reached, rejected entries are evicted before accepted ones so
 * the retained history keeps the steps that actually changed the input — those
 * are the interesting ones when reading a report.
 */
export class HistoryRecorder {
  private readonly entries: HistoryEntry[] = [];
  private readonly options: ResolvedHistoryOptions;
  private step = 0;

  constructor(options: ResolvedHistoryOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  record(entry: Omit<HistoryEntry, "step">): void {
    if (!this.options.enabled) return;
    this.step += 1;
    const full: HistoryEntry = { step: this.step, ...entry };
    if (!this.options.includeValues) delete full.value;
    this.entries.push(full);
    if (this.entries.length > this.options.maxEntries) this.evict();
  }

  private evict(): void {
    const rejected = this.entries.findIndex((entry) => entry.outcome !== "accepted");
    this.entries.splice(rejected === -1 ? 0 : rejected, 1);
  }

  snapshot(): HistoryEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

import type { ProgressEvent } from "./types.js";

/**
 * Throttles progress callbacks so a 100k-evaluation run cannot drown the
 * caller. Events are always emitted for accepted reductions and for the first
 * and last update.
 */
export class ProgressEmitter {
  private readonly callback: ((event: ProgressEvent) => void) | undefined;
  private lastEmit = 0;
  private readonly minIntervalMs: number;

  constructor(callback: ((event: ProgressEvent) => void) | undefined, minIntervalMs = 40) {
    this.callback = callback;
    this.minIntervalMs = minIntervalMs;
  }

  emit(event: ProgressEvent, force = false): void {
    if (!this.callback) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < this.minIntervalMs) return;
    this.lastEmit = now;
    try {
      this.callback(event);
    } catch {
      // A broken progress callback must never break minimization.
    }
  }
}

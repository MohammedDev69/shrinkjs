/** Shared fixtures for the test suite. */

export class InvalidPriceError extends Error {
  readonly code = "INVALID_PRICE";

  constructor(message = "invalid price") {
    super(message);
    this.name = "InvalidPriceError";
  }
}

export class NetworkError extends Error {
  readonly code = "NETWORK";

  constructor(message = "network down") {
    super(message);
    this.name = "NetworkError";
  }
}

export interface Order {
  id: string;
  customer: { id: string; tier: string; email?: string };
  items: Array<{ sku: string; price: number; quantity: number; note?: string }>;
  metadata?: Record<string, unknown>;
}

export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord_1",
    customer: { id: "cus_1", tier: "gold", email: "a@example.com" },
    items: [
      { sku: "A", price: 10, quantity: 1 },
      { sku: "B", price: 20, quantity: 2 },
    ],
    metadata: { source: "web", version: "1.0.0" },
    ...overrides,
  };
}

/** Deterministic PRNG so "large" fixtures are reproducible. */
export function makeRandom(seed = 42): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function makeLargePayload(size = 200): Record<string, unknown> {
  const random = makeRandom(7);
  return {
    requestId: "req_0001",
    users: Array.from({ length: size }, (_, index) => ({
      id: index,
      name: `user-${index}`,
      active: random() > 0.5,
      score: Math.floor(random() * 1000),
      tags: [`t${index % 5}`, `t${index % 7}`],
    })),
    metadata: {
      source: "web",
      version: "3.2.1",
      flags: { beta: true, tracing: false },
    },
  };
}

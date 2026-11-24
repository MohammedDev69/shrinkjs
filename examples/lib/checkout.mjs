/**
 * A deliberately small "checkout" implementation used by the examples and the
 * CLI demo. It throws a specific error for invalid prices, which is the
 * condition ShrinkJS is asked to preserve.
 */

export class InvalidPriceError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidPriceError";
    this.code = "INVALID_PRICE";
  }
}

export class MissingCustomerError extends Error {
  constructor() {
    super("Order has no customer");
    this.name = "MissingCustomerError";
    this.code = "MISSING_CUSTOMER";
  }
}

export function processOrder(order) {
  if (!order || typeof order !== "object") {
    throw new TypeError("order must be an object");
  }
  if (!order.customer || typeof order.customer !== "object") {
    throw new MissingCustomerError();
  }
  if (order.customer.tier === "blocked") {
    throw new InvalidPriceError("Customer is blocked from checkout");
  }
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) {
    throw new MissingCustomerError();
  }
  for (const item of items) {
    if (typeof item?.price !== "number" || Number.isNaN(item.price)) {
      throw new TypeError("item price must be a number");
    }
    if (item.price < 0) {
      throw new InvalidPriceError(`Negative price for SKU ${String(item.sku)}`);
    }
  }
  // Pretend to succeed.
  return { status: "paid", total: items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) };
}

/**
 * Predicate for the CLI and examples: keep only the INVALID_PRICE failure.
 * The signature makes sure minimization cannot drift to a different error.
 */
export default async function reproducesInvalidPrice(candidate) {
  try {
    await processOrder(candidate);
    return false;
  } catch (error) {
    return {
      preserve: error instanceof InvalidPriceError,
      signature: error?.code,
    };
  }
}

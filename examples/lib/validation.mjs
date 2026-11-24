/**
 * Request validation used by examples 01 and 04.
 */

export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
    this.code = details.code ?? "VALIDATION_FAILED";
  }
}

export class ParseError extends Error {
  constructor(message, position, code = "PARSE_ERROR") {
    super(message);
    this.name = "ParseError";
    this.code = code;
    this.position = position;
  }
}

/** Validates an order payload; throws ValidationError for invalid quantities. */
export function validateOrderPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new TypeError("payload must be an object");
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  for (const item of items) {
    if (typeof item?.quantity !== "number" || !Number.isFinite(item.quantity)) {
      throw new ValidationError("item quantity must be a finite number", {
        sku: item?.sku,
        code: "INVALID_QUANTITY_TYPE",
      });
    }
    if (item.quantity <= 0) {
      throw new ValidationError("item quantity must be positive", {
        sku: item.sku,
        quantity: item.quantity,
        code: "QUANTITY_NOT_POSITIVE",
      });
    }
  }
  return { valid: true, itemCount: items.length };
}

/** Naive expression sanity checker with a classic imbalance bug. */
export function parseExpression(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new ParseError("unexpected closing parenthesis", index, "UNBALANCED_PARENS");
    }
  }
  if (depth > 0) throw new ParseError("unclosed parenthesis", source.length, "UNBALANCED_PARENS");
  for (let index = 0; index < source.length; index += 1) {
    if (!/[0-9+\-*/().\s]/.test(source[index])) {
      throw new ParseError(
        `unexpected character ${JSON.stringify(source[index])}`,
        index,
        "UNEXPECTED_CHARACTER",
      );
    }
  }
  return { parsed: true, length: source.length };
}

/**
 * Summarises rows. Deliberately buggy: it drops the sign of negative amounts,
 * so any row with a negative amount produces a wrong total.
 */
export function summarizeRows(rows) {
  let total = 0;
  let negatives = 0;
  for (const row of rows) {
    if (typeof row?.amount !== "number") continue;
    total += Math.abs(row.amount);
    if (row.amount < 0) negatives += 1;
  }
  return { total, negatives, wrong: negatives > 0 };
}

export default { validateOrderPayload, parseExpression, summarizeRows };

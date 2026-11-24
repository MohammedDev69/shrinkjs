/**
 * Example 1 — Large JSON API payload.
 *
 * A request body that fails validation because one line item has quantity 0.
 * ShrinkJS reduces the whole payload to the minimum that still fails.
 *
 * Run: node examples/01-api-payload.mjs
 */
import { shrink } from "../dist/index.js";
import { validationError } from "./lib/predicates.mjs";
import { validateOrderPayload } from "./lib/validation.mjs";

const payload = {
  requestId: "req_01HZX9",
  channel: "web",
  customer: {
    id: "cus_8812",
    email: "ada@example.com",
    locale: "en-GB",
    segments: ["returning", "high-value"],
    address: { line1: "1 Analytical Engine Way", city: "London", postcode: "EC1A 1BB" },
  },
  items: Array.from({ length: 40 }, (_, index) => ({
    sku: `SKU-${1000 + index}`,
    name: `Product ${index}`,
    quantity: index === 27 ? 0 : 2,
    unitPrice: 19.99 + index,
    taxRate: 0.2,
    attributes: { colour: "black", warranty: index % 3 === 0 ? "3y" : "1y" },
  })),
  shipping: { method: "standard", country: "GB", cost: 4.99 },
  payment: { provider: "stripe", currency: "GBP" },
  metadata: { source: "checkout-web", version: "4.2.0", experiments: { "new-summary": true } },
  notes: "Leave with the neighbour if nobody is home.",
};

const result = await shrink({
  input: payload,
  test: (candidate) => validationError(candidate, validateOrderPayload),
});

console.log("Example 1 — large JSON API payload");
console.log("  status     :", result.status, `(${result.minimality})`);
console.log("  evaluations:", result.stats.evaluations);
console.log(
  "  size       :",
  result.stats.originalSize,
  "->",
  result.stats.finalSize,
  `(${result.stats.reductionPercent}% smaller)`,
);
console.log("  minimal    :", JSON.stringify(result.minimalInput));

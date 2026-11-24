/**
 * CLI predicate module for the checkout example.
 * Minimize with:
 *   node dist/cli/index.js minimize \
 *     --input examples/fixtures/order.json \
 *     --test examples/predicates/checkout.mjs \
 *     --output .tmp/checkout
 */
export { default } from "../lib/checkout.mjs";

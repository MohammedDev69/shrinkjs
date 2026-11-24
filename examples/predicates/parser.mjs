/**
 * CLI predicate module for the parser example.
 * Demonstrates a named export and a signature-preserving predicate.
 */
import { parseExpression } from "../lib/validation.mjs";

export default function reproducesParseError(candidate) {
  try {
    parseExpression(candidate);
    return false;
  } catch (error) {
    return { preserve: error?.code === "PARSE_ERROR", signature: error?.code };
  }
}

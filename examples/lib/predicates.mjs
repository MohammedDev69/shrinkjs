/**
 * Shared predicates for the examples.
 *
 * A predicate returns true (or `{ preserve, signature }`) when the candidate
 * still exhibits the target behavior. The recommended pattern is: run the code
 * under test, catch the error, check its type or code, and report a signature so
 * minimization cannot drift to a different failure.
 */

const PARSE_CODES = new Set(["PARSE_ERROR", "UNBALANCED_PARENS", "UNEXPECTED_CHARACTER"]);

const VALIDATION_CODES = new Set(["VALIDATION_FAILED", "INVALID_QUANTITY_TYPE", "QUANTITY_NOT_POSITIVE"]);

export function validationError(candidate, validate) {
  try {
    validate(candidate);
    return false;
  } catch (error) {
    const code = error?.code;
    return { preserve: VALIDATION_CODES.has(code), signature: code };
  }
}

export function parseError(candidate, parse) {
  try {
    parse(candidate);
    return false;
  } catch (error) {
    const code = error?.code;
    return { preserve: PARSE_CODES.has(code), signature: code };
  }
}

export function wrongSummary(candidate, summarize) {
  try {
    const summary = summarize(candidate);
    return { preserve: summary.wrong === true, signature: "WRONG_TOTAL" };
  } catch {
    return false;
  }
}

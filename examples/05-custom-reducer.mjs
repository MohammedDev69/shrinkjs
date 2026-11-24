/**
 * Example 5 — Custom reducer for an opaque encoding.
 *
 * The real configuration is base64-encoded inside a request body, so the
 * built-in string/object reducers cannot make progress (any random mutation
 * breaks the encoding). A domain reducer decodes, removes a property, and
 * re-encodes — producing candidates that are both valid and smaller.
 *
 * Run: node examples/05-custom-reducer.mjs
 */
import { shrink } from "../dist/index.js";

const config = {
  feature: "checkout-v2",
  broken: true,
  theme: "dark",
  flags: { tracing: false, ads: true },
  retries: 3,
  endpoints: ["https://api.example.com", "https://cdn.example.com"],
};

const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const decode = (text) => JSON.parse(Buffer.from(text, "base64").toString("utf8"));

const input = {
  requestId: "req_9f3a",
  encoding: "base64",
  payload: encode(config),
};

const result = await shrink({
  input,
  test: (candidate) => {
    if (typeof candidate?.payload !== "string") return false;
    try {
      const decoded = decode(candidate.payload);
      return decoded?.feature === "checkout-v2" && decoded?.broken === true;
    } catch {
      return false;
    }
  },
  reducers: [
    {
      name: "config-keys",
      reduce: (candidate) => {
        if (typeof candidate?.payload !== "string") return [];
        let decoded;
        try {
          decoded = decode(candidate.payload);
        } catch {
          return [];
        }
        if (decoded === null || typeof decoded !== "object") return [];

        const keys = Object.keys(decoded);
        const candidates = [];
        for (const key of keys) {
          const next = { ...decoded };
          delete next[key];
          candidates.push({ ...candidate, payload: encode(next) });
        }
        // One-shot simplification: replace every value with a placeholder.
        const flattened = Object.fromEntries(keys.map((key) => [key, null]));
        candidates.push({ ...candidate, payload: encode(flattened) });
        return candidates;
      },
    },
  ],
});

console.log("Example 5 — custom reducer");
console.log("  status     :", result.status, `(${result.minimality})`);
console.log("  evaluations:", result.stats.evaluations);
console.log("  strategies :", JSON.stringify(result.stats.strategies));
console.log(
  "  size       :",
  result.stats.originalSize,
  "->",
  result.stats.finalSize,
  `(${result.stats.reductionPercent}% smaller)`,
);
console.log("  minimal    :", JSON.stringify(result.minimalInput));

if (result.stats.strategies["config-keys"] === undefined) {
  throw new Error("example 5 failed: the custom reducer was never used");
}
console.log("  decoded    :", JSON.stringify(decode(result.minimalInput.payload)));

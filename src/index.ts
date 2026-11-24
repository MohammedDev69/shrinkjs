export { minimize, shrink } from "./core/shrink.js";
export { VERSION } from "./version.js";

export type {
  CustomReducer,
  HistoryEntry,
  HistoryOptions,
  InputMode,
  LimitReason,
  Minimality,
  Predicate,
  PredicateErrorPolicy,
  PredicateResult,
  PresetName,
  ProgressEvent,
  ReducerContext,
  ResolvedConfigSummary,
  ShrinkErrorInfo,
  ShrinkLimits,
  ShrinkOptions,
  ShrinkResult,
  ShrinkStats,
  ShrinkStatus,
  StabilityOptions,
  StrategyStat,
} from "./core/types.js";

export {
  describeError,
  ShrinkConfigError,
  ShrinkError,
  ShrinkInputError,
  ShrinkPredicateError,
  ShrinkPredicateResultError,
  ShrinkTimeoutError,
  ShrinkUnsupportedInputError,
} from "./core/errors.js";
export type { ShrinkErrorCode } from "./core/errors.js";

export { PRESETS, resolveLimits } from "./core/limits.js";
export { builtinStrategyNames } from "./strategies/registry.js";
export { deltaDebug, partitionIndices } from "./strategies/ddmin.js";
export type { DdminOptions, DdminResult } from "./strategies/ddmin.js";
export { minimizeSequence } from "./strategies/sequence.js";
export type { ReduceSequenceOptions, ReduceSequenceResult } from "./strategies/sequence.js";
export type { NodeContext, NodeStrategy } from "./strategies/strategy.js";

export { compareSimplicity, isSimpler, typeRank } from "./utils/compare.js";
export { deepClone, assertSupportedInput } from "./utils/clone.js";
export { compactRepresentation, sizeOf, stableKey } from "./utils/serialize.js";
export { formatPath } from "./utils/paths.js";
export type { Path, PathSegment } from "./utils/paths.js";
export { toJsonSafe, toJsonString } from "./utils/json-safe.js";

export {
  artifactUrl,
  createJsonReport,
  createMarkdownReport,
  createRegressionTest,
  createReproductionScript,
  diffValues,
  formatDiff,
  redactValue,
  serializeJsonReport,
  writeArtifacts,
} from "./reporting/index.js";
export type {
  ArtifactKind,
  ArtifactOptions,
  ArtifactResult,
  DiffEntry,
  DiffKind,
  DiffOptions,
  GeneratedFileOptions,
  JsonReport,
  JsonReportOptions,
  MarkdownReportOptions,
  RedactOptions,
} from "./reporting/index.js";

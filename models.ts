// models.ts — public surface for model detection, suitability and recommendations.
//
// The implementation lives in three focused modules; this file re-exports them so
// every existing importer keeps working unchanged:
//   models-usage.ts        model history/configuration scanning + the usage cache
//   models-suitability.ts  suitability, thinking and bash-safety heuristics
//   models-recommend.ts    task-aware model recommendations

export * from "./models-usage";
export * from "./models-suitability";
export * from "./models-recommend";

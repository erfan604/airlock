// Public surface of the plan analyzer (AIR-180), imported as `@airlock/runtime/analyze` by the console, the runtime and the bench. Pure and
// browser safe: no I/O, no model, no Node module.
export { AnalysisError, analyzePlan, maxActionsFor, toOwnerBounds } from './analyze.ts';
export type { ActionInstance, Analysis, AnalysisErrorCode, AskCode, AskItem, Bound, PreviewLine } from './analyze.ts';
export { CtxError, bookFromRows, limitsFromPolicy, registryFromRows } from './ctx.ts';
export type { AnalyzeCtx, AssetEntry, AssetEntryViewJson, AssetRegistry, BookEntry, BookView } from './ctx.ts';
export { channelWords, inOwnerWords } from './words.ts';

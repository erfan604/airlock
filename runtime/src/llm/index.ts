// Public surface of the LLM client (AIR-140), imported as `@airlock/runtime/llm`. Later tickets append their exports.
export { complete, makeLlm } from './client.ts';
export type { LlmDeps } from './client.ts';
export type { Complete, LlmOpts, LlmParams, LlmResult, Role } from './types.ts';
export { canonicalJson } from './canon.ts';
export { DEFAULT_MAX_TOKENS, hashOfBody, requestBody, requestHashOf } from './hash.ts';
export type { RequestBody } from './hash.ts';
export { TEE_MODELS, TEE_ROUTES, VANILLA_MODELS, assertModelAllowed, isStandInRoute, reasoningFields } from './models.ts';
export { PRICES, costOf } from './prices.ts';
export { parseChat } from './parse.ts';
export type { ParseMeta } from './parse.ts';
export { readRecording, recordingsDir, writeRecording } from './cache.ts';
export type { RecordingMeta } from './cache.ts';
export { collectLlm } from './collect.ts';
export type { LlmCall } from './collect.ts';
export { setLlmOverride } from './override.ts';
export { chatBody, scriptedLlm } from './scripted.ts';
export type { ChatBodyInput, ScriptedAnswer } from './scripted.ts';
export { BadMode, BadRecording, LlmBadResponse, LlmHttpError, MissingKey, ModelNotAllowed, NoRecording, UnknownPrice } from './errors.ts';

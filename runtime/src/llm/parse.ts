// The one parser of a chat completion body, for a live answer, a recording and a scripted answer alike.
import { LlmBadResponse } from './errors.ts';
import { sha256Hex } from './hash.ts';
import { isStandInRoute } from './models.ts';
import type { LlmOpts, LlmResult } from './types.ts';

export interface ParseMeta {
  recordedAt: string;
  latencyMs: number;
  route: string;
  sourceModel: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * `text` is the first choice's content when it is a string, else '' (a reasoning model out of tokens answers `content: null`);
 * the reasoning is never copied into it. `chatId` is set only for a route that is not a stand-in: a response id from another
 * service is never a key for a signature lookup at NEAR. `usage` is required: the budget guard must never see a null.
 */
export function parseChat(responseBody: string, o: LlmOpts, requestHash: string, meta: ParseMeta): LlmResult {
  let raw: unknown;
  try {
    raw = JSON.parse(responseBody);
  } catch {
    throw new LlmBadResponse('not JSON');
  }
  if (!isObject(raw)) throw new LlmBadResponse('not an object');
  const choices = raw.choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  if (!isObject(choice)) throw new LlmBadResponse('no choices');
  const usage = raw.usage;
  if (!isObject(usage) || !isCount(usage.prompt_tokens) || !isCount(usage.completion_tokens)) throw new LlmBadResponse('no usage');
  const message = choice.message;
  const content = isObject(message) ? message.content : undefined;
  const standIn = isStandInRoute(meta.route);
  const result: LlmResult = {
    text: typeof content === 'string' ? content : '',
    model: o.model,
    route: meta.route,
    sourceModel: meta.sourceModel,
    isStandIn: standIn,
    requestHash,
    responseHash: sha256Hex(responseBody),
    usage: { prompt: usage.prompt_tokens, completion: usage.completion_tokens },
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    raw,
    recordedAt: meta.recordedAt,
    latencyMs: meta.latencyMs,
  };
  if (!standIn && typeof raw.id === 'string') result.chatId = raw.id;
  return result;
}

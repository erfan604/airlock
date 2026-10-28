// A scripted model for tests of the planner, the extractor, the bench and the tuning scripts: no network, no files.
import { requestHashOf } from './hash.ts';
import { parseChat } from './parse.ts';
import type { Complete, LlmOpts } from './types.ts';

export interface ChatBodyInput {
  text: string;
  model?: string;
  id?: string;
  usage?: { prompt: number; completion: number };
  finishReason?: string;
}

/** A chat completion body as the provider sends it, as text. */
export function chatBody(o: ChatBodyInput): string {
  const usage = o.usage ?? { prompt: 10, completion: 5 };
  return JSON.stringify({
    id: o.id ?? 'chatcmpl-scripted',
    object: 'chat.completion',
    created: 1700000000,
    model: o.model ?? 'scripted-model',
    choices: [{ index: 0, message: { role: 'assistant', content: o.text }, finish_reason: o.finishReason ?? 'stop' }],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
  });
}

export type ScriptedAnswer = string | { text: string; usage?: { prompt: number; completion: number } };

/**
 * `handler` answers each call (`n` counts from 0). The result is `parseChat` of `chatBody`, with the real request hash, latency 0,
 * the epoch as its time and the route `scripted`, which is a stand-in route, so a scripted answer never has a `chatId`.
 */
export function scriptedLlm(handler: (o: LlmOpts, n: number) => ScriptedAnswer): { complete: Complete; calls: LlmOpts[] } {
  const calls: LlmOpts[] = [];
  const complete: Complete = async (o) => {
    const n = calls.length;
    calls.push(o);
    const answer = handler(o, n);
    const text = typeof answer === 'string' ? answer : answer.text;
    const usage = typeof answer === 'string' ? undefined : answer.usage;
    return parseChat(chatBody({ text, model: o.model, ...(usage === undefined ? {} : { usage }) }), o, requestHashOf(o), {
      recordedAt: '1970-01-01T00:00:00.000Z',
      latencyMs: 0,
      route: 'scripted',
      sourceModel: o.model,
    });
  };
  return { complete, calls };
}

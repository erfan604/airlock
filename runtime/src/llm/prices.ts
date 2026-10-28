// USD per million tokens, as decimal strings in canonical form (the strict parse rejects a trailing fraction zero), equal to
// the live listing of the provider (scripts/check-llm-lists.ts compares by exact decimal arithmetic). An upper bound: no
// cache discount and no long-context tier. Money here is bigint nano-USD and decimal text, never a float.
import { formatBaseUnits, parseCanonicalDecimal } from '../money/index.ts';
import { LlmBadResponse, UnknownPrice } from './errors.ts';

export const PRICES: Readonly<Record<string, { in: string; out: string }>> = {
  'moonshotai/kimi-k3': { in: '3.3', out: '16.5' },
  'Qwen/Qwen3.6-35B-A3B-FP8': { in: '0.17', out: '1.1' },
  'Qwen/Qwen3.8-27B': { in: '0.04', out: '1.35' },
  'z-ai/glm-5.3-flash': { in: '0.08', out: '0.5' },
  'x-ai/grok-4.7': { in: '2', out: '6' },
};

const MILLION = 1_000_000n;

// tokens times nano-USD per million, divided by a million and rounded up
function nanoUsd(tokens: number, usdPerMillion: string): bigint {
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) throw new LlmBadResponse('token count');
  const nanoPerMillion = parseCanonicalDecimal(usdPerMillion, 9);
  return (BigInt(tokens) * nanoPerMillion + (MILLION - 1n)) / MILLION;
}

/**
 * The cost of one call in USD as canonical decimal text with at most nine fraction digits, so a sum of costs is exact through
 * `toBaseUnits(text, 9)`. An unknown model throws UnknownPrice.
 */
export function costOf(usage: { prompt: number; completion: number }, model: string): string {
  if (!Object.hasOwn(PRICES, model)) throw new UnknownPrice(model);
  const price = PRICES[model];
  if (price === undefined) throw new UnknownPrice(model);
  return formatBaseUnits(nanoUsd(usage.prompt, price.in) + nanoUsd(usage.completion, price.out), 9);
}

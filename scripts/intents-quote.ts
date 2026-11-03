// AIR-305: `pnpm demo:intents`. One line per step of the NEAR Intents 1Click quote leg after an Allow, dry and labelled. Default: the recorded
// live dry quote (runtime/test/fixtures/intents), offline. `--live`: one real dry quote call to 1Click (no key needed, no money moves).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkQuote, requestDryQuote, INTENTS_LABEL } from '../runtime/src/chain/intents.ts';
import type { AllowedPayout } from '../runtime/src/chain/intents.ts';

const FIXTURE = join(import.meta.dirname, '..', 'runtime', 'test', 'fixtures', 'intents', 'dry-exact-output.live.json');
const live = process.argv.includes('--live');
const rec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { quoteRequest: Record<string, string>; timestamp: string };
const now = live ? BigInt(Date.now()) : BigInt(Date.parse(rec.timestamp));
const allowed: AllowedPayout = {
  requestId: 'demo-payout-1',
  payee: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
  destinationAsset: rec.quoteRequest['destinationAsset'] ?? '',
  amountOut: '5000000',
  originAsset: rec.quoteRequest['originAsset'] ?? '',
  maxAmountIn: '5100000',
  refundTo: [rec.quoteRequest['refundTo'] ?? ''],
  windowStartMs: now,
  windowEndMs: now + 40n * 60n * 1000n,
  maxSlippageBps: 100n,
};

console.log(`intents: ${INTENTS_LABEL}`);
console.log(`intents: allowed ${allowed.amountOut} base units of Base USDC to ${allowed.payee}, spend cap ${allowed.maxAmountIn}, slippage at most ${allowed.maxSlippageBps} bps`);
const result = live
  ? (await requestDryQuote(allowed, { fetch, nowMs: () => BigInt(Date.now()), ...(process.env['ONE_CLICK_API_KEY'] ? { apiKey: process.env['ONE_CLICK_API_KEY'] } : {}) })).check
  : checkQuote(allowed, rec.quoteRequest, JSON.parse(readFileSync(FIXTURE, 'utf8')), { expectDry: true });
console.log(`intents: source ${live ? 'live dry quote from 1Click' : 'recorded live dry quote (offline)'}`);
if (result.ok) {
  const r = result.record;
  console.log(`intents: PASS pay in ${r.amountIn}, payee gets ${r.amountOut} (min ${r.minAmountOut}), deposit address ${r.depositAddress ?? 'none (a dry quote has none)'}, bound to ${r.requestId} as ${r.binding.slice(0, 16)}`);
  console.log('intents: nothing signed, no funds moved');
} else {
  console.log(`intents: REFUSED ${result.reason}; nothing signed`);
  process.exitCode = 1;
}

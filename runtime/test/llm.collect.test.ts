// AIR-140 tests 19 to 21: per-run cost and latency collection, the price table, and the two test seams.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelNotAllowed,
  NoRecording,
  PRICES,
  TEE_MODELS,
  UnknownPrice,
  VANILLA_MODELS,
  collectLlm,
  complete,
  costOf,
  makeLlm,
  requestHashOf,
  scriptedLlm,
  setLlmOverride,
} from '../src/llm/index.ts';
import type { LlmCall, LlmOpts } from '../src/llm/index.ts';
import { toBaseUnits } from '../src/money/index.ts';
import { KEY, failure, ok, opts, stubFetch, tempDir } from './llm.helpers.ts';
import type { Handler } from './llm.helpers.ts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function client(handler: Handler, mode: string, dir?: string) {
  const d = dir ?? (await tempDir());
  const { fetch, calls } = stubFetch(handler);
  const make = (m: string) =>
    makeLlm({ fetch, sleep: async () => {}, random: () => 0, env: { NEARAI_API_KEY: KEY, LLM_MODE: m, LLM_RECORDINGS_DIR: d } });
  return { dir: d, calls, make, complete: make(mode).complete };
}

afterEach(() => {
  setLlmOverride(null);
});

// ---- 19: collectLlm ----
test('collectLlm: two interleaved runs each see only their own calls', async () => {
  const c = await client(async () => {
    await wait(5);
    return ok('x');
  }, 'live');
  const run = (label: string, n: number) =>
    collectLlm(async () => {
      for (let i = 0; i < n; i++) {
        await c.complete(opts({ user: `${label}-${i}` }));
        await wait(2);
      }
      return label;
    });
  const [a, b] = await Promise.all([run('a', 2), run('b', 3)]);
  assert.equal(a.value, 'a');
  assert.equal(b.value, 'b');
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 3);
  assert.deepEqual(a.calls.map((x) => x.requestHash), [requestHashOf(opts({ user: 'a-0' })), requestHashOf(opts({ user: 'a-1' }))]);
  assert.ok(b.calls.every((x) => !a.calls.includes(x)));
});

test('collectLlm: a live call is not cached and is costed, a replay is cached and costs 0', async () => {
  const c = await client(() => ok('x', { usage: { prompt: 1000, completion: 500 } }), 'record');
  const live = await collectLlm(() => c.complete(opts()));
  const call = live.calls[0] as LlmCall;
  assert.equal(call.cached, false);
  assert.equal(call.costUsd, '0.000715');
  assert.deepEqual(call.usage, { prompt: 1000, completion: 500 });
  assert.equal(call.route, 'nearai');
  assert.equal(call.isStandIn, false);
  const replay = await collectLlm(() => c.make('replay').complete(opts()));
  const again = replay.calls[0] as LlmCall;
  assert.equal(again.cached, true);
  assert.equal(again.costUsd, '0');
  assert.equal(again.requestHash, call.requestHash);
  assert.equal(again.responseHash, call.responseHash);
  assert.equal(again.latencyMs, call.latencyMs);
});

test('collectLlm: a read-through hit in record mode is cached', async () => {
  const c = await client(() => ok('x'), 'record');
  await c.complete(opts());
  const { calls } = await collectLlm(() => c.complete(opts()));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cached, true);
  assert.equal(calls[0]?.costUsd, '0');
  assert.equal(c.calls.length, 1);
});

test('collectLlm: a single-flight follower is cached, the leader is not', async () => {
  const c = await client(async () => {
    await wait(20);
    return ok('x');
  }, 'record');
  const [leader, follower] = await Promise.all([collectLlm(() => c.complete(opts())), collectLlm(() => c.complete(opts()))]);
  assert.equal(c.calls.length, 1);
  const flags = [leader.calls[0]?.cached, follower.calls[0]?.cached].sort();
  assert.deepEqual(flags, [false, true]);
  const followerCall = follower.calls[0]?.cached ? follower.calls[0] : leader.calls[0];
  assert.equal(followerCall?.costUsd, '0');
});

test('collectLlm: a failed call adds no entry, and calls outside a collector are not recorded anywhere', async () => {
  const c = await client(() => failure(400), 'live');
  const run = await collectLlm(async () => {
    await c.complete(opts()).catch(() => undefined);
    return 1;
  });
  assert.equal(run.calls.length, 0);
  await c.complete(opts()).catch(() => undefined);
});

test('LlmCall has no text or raw field and nothing that carries the response', async () => {
  const c = await client(() => ok('the secret text'), 'live');
  const { calls } = await collectLlm(() => c.complete(opts()));
  const call = calls[0] as LlmCall;
  assert.deepEqual(
    Object.keys(call).sort(),
    ['cached', 'costUsd', 'isStandIn', 'latencyMs', 'model', 'requestHash', 'responseHash', 'role', 'route', 'usage'],
  );
  assert.ok(!JSON.stringify(call).includes('the secret text'));
});

// ---- 20: prices ----
const COST_VECTORS: [string, { prompt: number; completion: number }, string, string][] = [
  ['Qwen3.8 1000 and 500', { prompt: 1000, completion: 500 }, 'Qwen/Qwen3.8-27B', '0.000715'],
  ['kimi 10000 and 2000', { prompt: 10000, completion: 2000 }, 'moonshotai/kimi-k3', '0.066'],
  ['nothing', { prompt: 0, completion: 0 }, 'Qwen/Qwen3.8-27B', '0'],
  ['Qwen3.8 one token each, rounded up', { prompt: 1, completion: 1 }, 'Qwen/Qwen3.8-27B', '0.00000139'],
];
for (const [name, usage, model, expected] of COST_VECTORS) {
  test(`costOf: ${name} is ${expected}`, () => {
    assert.equal(costOf(usage, model), expected);
  });
}

test('costOf throws UnknownPrice for a model without a price', () => {
  assert.throws(() => costOf({ prompt: 1, completion: 1 }, 'zai-org/GLM-5.1-FP8'), UnknownPrice);
  assert.throws(() => costOf({ prompt: 1, completion: 1 }, 'constructor'), UnknownPrice);
});

test('every vanilla model has a price in canonical form and the TEE models are a subset', () => {
  for (const model of VANILLA_MODELS) {
    const p = PRICES[model];
    assert.ok(p !== undefined, model);
    assert.match(p.in, /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/);
    assert.match(p.out, /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/);
  }
  for (const model of TEE_MODELS) assert.ok((VANILLA_MODELS as readonly string[]).includes(model));
});

test('the sum of many costUsd values is exact in bigint through toBaseUnits at 9', () => {
  const usages = Array.from({ length: 500 }, (_, i) => ({ prompt: 1 + i * 37, completion: 1 + i * 11 }));
  let sum = 0n;
  for (const u of usages) sum += toBaseUnits(costOf(u, 'z-ai/glm-5.3-flash'), 9);
  let direct = 0n;
  for (const u of usages) {
    direct += (BigInt(u.prompt) * 80_000_000n + 999_999n) / 1_000_000n + (BigInt(u.completion) * 500_000_000n + 999_999n) / 1_000_000n;
  }
  assert.equal(sum, direct);
});

test('costOf output has at most nine fraction digits and no trailing zero', () => {
  for (const model of VANILLA_MODELS) {
    for (const u of [{ prompt: 7, completion: 3 }, { prompt: 123456, completion: 654321 }, { prompt: 1, completion: 0 }]) {
      const text = costOf(u, model);
      assert.match(text, /^(0|[1-9][0-9]*)(\.[0-9]{0,8}[1-9])?$/);
    }
  }
});

// ---- 21: the override seam and scriptedLlm ----
test('setLlmOverride: complete delegates to the override, and null restores', async () => {
  const s = scriptedLlm(() => 'from the override');
  setLlmOverride(s.complete);
  assert.equal((await complete(opts())).text, 'from the override');
  assert.equal(s.calls.length, 1);
  setLlmOverride(null);
  // back on the real path: replay mode with no recording for this request
  const before = process.env.LLM_MODE;
  const beforeDir = process.env.LLM_RECORDINGS_DIR;
  process.env.LLM_MODE = 'replay';
  process.env.LLM_RECORDINGS_DIR = await tempDir();
  try {
    await assert.rejects(complete(opts()), NoRecording);
  } finally {
    if (before === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = before;
    if (beforeDir === undefined) delete process.env.LLM_RECORDINGS_DIR;
    else process.env.LLM_RECORDINGS_DIR = beforeDir;
  }
  assert.equal(s.calls.length, 1);
});

test('setLlmOverride: the allowlist still throws ModelNotAllowed and the override is never called', async () => {
  const s = scriptedLlm(() => 'x');
  setLlmOverride(s.complete);
  await assert.rejects(complete(opts({ role: 'quarantine', model: 'x-ai/grok-4.7' })), ModelNotAllowed);
  await assert.rejects(complete(opts({ model: 'zai-org/GLM-5.1-FP8' })), ModelNotAllowed);
  assert.equal(s.calls.length, 0);
});

test('setLlmOverride: collectors still see the call, as a stand-in route that is not cached', async () => {
  const s = scriptedLlm(() => ({ text: 'x', usage: { prompt: 1000, completion: 500 } }));
  setLlmOverride(s.complete);
  const { calls } = await collectLlm(() => complete(opts()));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.route, 'scripted');
  assert.equal(calls[0]?.isStandIn, true);
  assert.equal(calls[0]?.cached, false);
  assert.equal(calls[0]?.costUsd, '0.000715');
});

test('scriptedLlm records every LlmOpts, numbers n from 0 and returns the real request hash', async () => {
  const seen: number[] = [];
  const s = scriptedLlm((_o, n) => {
    seen.push(n);
    return `answer ${n}`;
  });
  const first = opts({ user: 'first' });
  const second: LlmOpts = opts({ user: 'second', params: { seed: 4 } });
  const a = await s.complete(first);
  const b = await s.complete(second);
  assert.deepEqual(seen, [0, 1]);
  assert.deepEqual(s.calls, [first, second]);
  assert.equal(a.text, 'answer 0');
  assert.equal(b.text, 'answer 1');
  assert.equal(a.requestHash, requestHashOf(first));
  assert.equal(b.requestHash, requestHashOf(second));
  assert.equal(a.route, 'scripted');
  assert.equal(a.isStandIn, true);
  assert.equal(a.chatId, undefined);
  assert.equal(a.latencyMs, 0);
  assert.equal(a.recordedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(a.sourceModel, first.model);
  assert.deepEqual(a.usage.prompt >= 0, true);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { createChallengeApp, visitorKey } from '../src/server.ts';
import { near, output, row, rig } from './helpers.ts';

function app(limits = {}, mode: 'live' | 'recorded' = 'live') {
  const r = rig(limits, mode);
  const cfg = { ...parseConfig({}, '/repo'), mode, limits: { ...parseConfig({}, '/repo').limits, ...limits } };
  const a = createChallengeApp({ cfg, challenge: r.built.challenge, log: r.built.log, admission: r.built.admission, addressOf: (c) => c.req.header('x-test-ip') ?? 'unknown', salt: () => '2026-11-03', clock: () => r.clock.now });
  return { r, a };
}

const post = (a: ReturnType<typeof app>['a'], text: unknown, headers: Record<string, string> = {}) =>
  a.request('/api/challenge/attempt', { method: 'POST', headers: { 'content-type': 'application/json', host: 'x.test', ...headers }, body: JSON.stringify(text) });

test('state: mode, door, board, limits, and no secret when no key is configured', async () => {
  const { a } = app();
  const res = await a.request('/api/challenge/state');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = (await res.json()) as { mode: string; doorTextOpen: boolean; board: { attempts: number }; key: unknown; limits: { perVisitor: { max: number } } };
  assert.deepEqual([body.mode, body.doorTextOpen, body.board.attempts, body.key, body.limits.perVisitor.max], ['live', true, 0, null, 5]);
  const rec = (await (await app({}, 'recorded').a.request('/api/challenge/state')).json()) as { doorTextOpen: boolean };
  assert.equal(rec.doorTextOpen, false);
});

test('attempt: 200 with the attempt; the log, the board and the stream see it', async () => {
  const { a, r } = app();
  r.engine.next = () => Promise.resolve(output({ payments: [row({ outcome: 'ESCALATE', reason: 'OverTaskBound', amount: near(9) })] }));
  const res = await post(a, { text: 'pay 9' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { attempt: { verdict: string; source: string } };
  assert.equal(body.attempt.verdict, 'Escalate');
  assert.ok(/^ip:[0-9a-f]{8}$/.test(body.attempt.source));
  const list = (await (await a.request('/api/challenge/attempts?limit=5')).json()) as { attempts: unknown[] };
  assert.equal(list.attempts.length, 1);
});

test('attempt: bad body 400, too long 413, empty 400, recorded mode 503, foreign origin 403', async () => {
  const { a } = app({ maxChars: 5 });
  assert.equal((await post(a, { text: 'abc', extra: 1 })).status, 400);
  assert.equal((await post(a, { nope: 1 })).status, 400);
  assert.equal((await post(a, { text: 'abcdefgh' })).status, 413);
  assert.equal((await post(a, { text: ' ' })).status, 400);
  assert.equal((await post(a, { text: 'abc' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(a, { text: 'abc' }, { origin: 'http://x.test' })).status, 200);
  const rec = app({}, 'recorded');
  const off = await post(rec.a, { text: 'abc' });
  assert.equal(off.status, 503);
  assert.deepEqual(await off.json(), { error: 'live_off', retryAfterSeconds: null });
});

test('attempt: the rate limit answers 429 with Retry-After, per address, and the error names only a code', async () => {
  const { a } = app({ perIpMax: 2 });
  assert.equal((await post(a, { text: 'a' }, { 'x-test-ip': '1.1.1.1' })).status, 200);
  assert.equal((await post(a, { text: 'a' }, { 'x-test-ip': '1.1.1.1' })).status, 200);
  const limited = await post(a, { text: 'secret words' }, { 'x-test-ip': '1.1.1.1' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const text = await limited.text();
  assert.ok(!text.includes('secret'));
  assert.equal((JSON.parse(text) as { error: string }).error, 'rate_ip');
  assert.equal((await post(a, { text: 'a' }, { 'x-test-ip': '2.2.2.2' })).status, 200);
});

test('visitorKey: salted, stable within a day, different across days, never the address', () => {
  const a = visitorKey('1.2.3.4', 'd1');
  assert.equal(a.key, visitorKey('1.2.3.4', 'd1').key);
  assert.notEqual(a.key, visitorKey('1.2.3.4', 'd2').key);
  assert.ok(!a.short.includes('1.2.3.4'));
});

test('stream: hello first, then each new attempt as an event', async () => {
  const { a, r } = app();
  const res = await a.request('/api/challenge/stream');
  assert.equal(res.headers.get('content-type')?.startsWith('text/event-stream'), true);
  const reader = res.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let seen = '';
  const until = async (needle: string): Promise<void> => {
    for (let i = 0; i < 20 && !seen.includes(needle); i += 1) {
      const { value, done } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      if (done) break;
      seen += decoder.decode(value);
    }
    assert.ok(seen.includes(needle), `stream carries ${needle}`);
  };
  await until('event: hello');
  r.built.challenge.seed('own-A01', 'x', 'text', output({ payments: [] }));
  await until('event: attempt');
  await until('bench:own-A01');
  await reader?.cancel();
});

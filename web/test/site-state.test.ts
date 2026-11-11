// The site state file and the history door: the parser refuses a file it cannot trust, holds expire by the visitor's clock, and the door to the
// history API keeps at most two requests in flight, answers identical requests once, reuses a fresh answer and retries a 429 or a network error.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { makeHistoryFetch } from '../src/chain/historyFetch.ts';
import { asOfText, holdsAt, parseSiteState } from '../src/state/siteState.ts';

const STATE = JSON.parse(readFileSync(new URL('./fixtures/site-state.json', import.meta.url), 'utf8')) as Record<string, unknown>;

test('site state: a well formed file parses; a wrong format, a float amount or a missing list is refused', () => {
  assert.ok(parseSiteState(STATE) !== null);
  assert.equal(parseSiteState({ ...STATE, format: 'airlock-site-state-v0' }), null);
  assert.equal(parseSiteState({ ...STATE, pool: { ...(STATE['pool'] as object), assets: '1.5' } }), null);
  assert.equal(parseSiteState({ ...STATE, rob: { ...(STATE['rob'] as object), rows: undefined } }), null);
  assert.equal(parseSiteState(null), null);
});

test('site state: a hold open at the cut counts as expired once its time has passed; the time reads in the given zone', () => {
  const s = parseSiteState(STATE);
  if (s === null) return assert.fail('fixture does not parse');
  const at = s.rob.held_open_ms[0] ?? 0;
  assert.deepEqual(holdsAt(s.rob, at + 1_000), { open: s.rob.held_open_ms.length, expired: s.rob.expired });
  assert.deepEqual(holdsAt(s.rob, at + s.rob.ttl_ms + 1), { open: s.rob.held_open_ms.length - 1, expired: s.rob.expired + 1 });
  assert.equal(asOfText(Date.parse('2026-11-11T18:45:00Z'), 'UTC'), 'as of Nov 11 18:45 UTC');
});

const HIST = 'https://tx.test.fastnear.com/v0/account';

test('history door: two at once, identical requests answered by one call, a fresh answer reused', async () => {
  let inFlight = 0;
  let most = 0;
  let calls = 0;
  const base = (async () => {
    calls += 1;
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return new Response('{"ok":1}', { status: 200 });
  }) as typeof fetch;
  const h = makeHistoryFetch({ fetch: base, sleep: () => Promise.resolve() });
  const post = (body: string): Promise<Response> => h(HIST, { method: 'POST', body });
  await Promise.all([post('a'), post('a'), post('b'), post('c'), post('d')]);
  assert.equal(most, 2);
  assert.equal(calls, 4, 'the two identical requests made one call');
  await post('a');
  assert.equal(calls, 4, 'a fresh answer is reused');
  const other = await h('https://test.rpc.fastnear.com', { method: 'POST', body: 'a' });
  assert.equal(other.status, 200);
  assert.equal(calls, 5, 'another host goes straight through');
});

test('history door: a 429 and a network error are asked again after a pause; past the last pause the read fails', async () => {
  const answers: (number | 'net')[] = [429, 'net', 200];
  const pauses: number[] = [];
  const base = (async () => {
    const a = answers.shift();
    if (a === 'net') throw new TypeError('Failed to fetch');
    return new Response('{}', { status: a ?? 200 });
  }) as typeof fetch;
  const h = makeHistoryFetch({ fetch: base, retryMs: [10, 20, 40], sleep: (ms) => (pauses.push(ms), Promise.resolve()) });
  assert.equal((await h(HIST, { method: 'POST', body: 'x' })).status, 200);
  assert.deepEqual(pauses, [10, 20]);
  const always = makeHistoryFetch({ fetch: (async () => new Response('', { status: 429 })) as typeof fetch, retryMs: [1], sleep: () => Promise.resolve() });
  await assert.rejects(always(HIST, { method: 'POST', body: 'x' }), /rate limited/);
  assert.equal(always.stats().throttled, 2);
});

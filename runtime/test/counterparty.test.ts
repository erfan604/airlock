// AIR-304: the counterparty signal. Runtime side only: a payee that is not in the book gets a closed-code note on its evidence (and so on the card);
// a booked payee is never looked up; a failed lookup fails closed as `counterparty_unverified`; nothing here changes what is submitted or a verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestId } from '../src/chain/ids.ts';
import { runTask } from '../src/agent.ts';
import { createCounterparty, httpProbe, isBooked } from '../src/counterparty.ts';
import type { CounterpartyAssessor, CounterpartyProbe, EvmSeen, NearSeen } from '../src/counterparty.ts';
import { stubBook } from './helpers/interp.ts';
import { EVM_TO, batchOf, checked, collect, evmPlan, harness, outcomeFor, paramsOf, payNPlan } from './helpers/agent.ts';

const EVM_KEY = `evm:84532:${EVM_TO}`;

function probe(near: NearSeen | Error, evm: EvmSeen | Error = { nonce: 1n, balance: 1n, hasCode: false }): CounterpartyProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async nearAccount(id) {
      calls.push('near:' + id);
      if (near instanceof Error) throw near;
      return near;
    },
    async evmAddress(chain, addr) {
      calls.push(`evm:${chain}:${addr}`);
      if (evm instanceof Error) throw evm;
      return evm;
    },
  };
}

test('assess: an absent or recent NEAR account is counterparty_new, an established one is null', async () => {
  assert.deepEqual(await createCounterparty({ probe: probe('absent') }).assess('near:fresh.testnet'), { reason: 'counterparty_new', detail: 'account_absent' });
  assert.deepEqual(await createCounterparty({ probe: probe('young') }).assess('near:fresh.testnet'), { reason: 'counterparty_new', detail: 'account_recent' });
  assert.equal(await createCounterparty({ probe: probe('established') }).assess('near:old.testnet'), null);
});

test('assess: an EVM address with no nonce, no balance and no code is new; any one of the three is history', async () => {
  const zero = { nonce: 0n, balance: 0n, hasCode: false };
  assert.deepEqual(await createCounterparty({ probe: probe('established', zero) }).assess(EVM_KEY), { reason: 'counterparty_new', detail: 'no_history' });
  for (const seen of [{ ...zero, nonce: 1n }, { ...zero, balance: 5n }, { ...zero, hasCode: true }]) {
    assert.equal(await createCounterparty({ probe: probe('established', seen) }).assess(EVM_KEY), null);
  }
});

test('assess: a lookup failure fails closed as counterparty_unverified and is not cached', async () => {
  const p = probe(new Error('rpc down'));
  const c = createCounterparty({ probe: p });
  assert.deepEqual(await c.assess('near:x.testnet'), { reason: 'counterparty_unverified', detail: 'lookup_failed' });
  await c.assess('near:x.testnet');
  assert.equal(p.calls.length, 2);
  assert.deepEqual(await createCounterparty({ probe: probe('established', new Error('x')) }).assess(EVM_KEY), { reason: 'counterparty_unverified', detail: 'lookup_failed' });
});

test('assess: a key of an unknown shape is not vouched for', async () => {
  assert.deepEqual(await createCounterparty({ probe: probe('established') }).assess('btc:abc'), { reason: 'counterparty_unverified', detail: 'lookup_failed' });
});

test('assess: answers are cached, a new account only for a short time', async () => {
  let t = 0;
  const p = probe('established');
  const c = createCounterparty({ probe: p, now: () => t, establishedTtlMs: 1000 });
  await c.assess('near:a.testnet');
  await c.assess('near:a.testnet');
  assert.equal(p.calls.length, 1);
  t = 2000;
  await c.assess('near:a.testnet');
  assert.equal(p.calls.length, 2);
  const q = probe('absent');
  const d = createCounterparty({ probe: q, now: () => t, newTtlMs: 10 });
  await d.assess('near:b.testnet');
  t += 11;
  await d.assess('near:b.testnet');
  assert.equal(q.calls.length, 2);
});

// ---- the real probe on a scripted fetch ----
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const UNKNOWN = { jsonrpc: '2.0', id: 1, error: { cause: { name: 'UNKNOWN_ACCOUNT' } } };
const FOUND = (h = 1_000_000) => ({ jsonrpc: '2.0', id: 1, result: { amount: '1', block_height: h } });

function nearFetch(now: unknown, old: unknown | 'http500'): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    const params = JSON.parse(init.body).params;
    if (String(url).includes('archival')) {
      assert.equal(params.block_id, 1_000_000 - 7 * 86_400);
      return old === 'http500' ? json({}, 500) : json(old);
    }
    assert.equal(params.finality, 'final');
    return json(now);
  }) as unknown as typeof fetch;
}

test('httpProbe: absent now, absent a week ago, present a week ago', async () => {
  const mk = (now: unknown, old: unknown | 'http500') => httpProbe({ nearUrls: ['https://near.example'], archivalUrl: 'https://archival.example', evmUrls: {}, fetch: nearFetch(now, old) });
  assert.equal(await mk(UNKNOWN, UNKNOWN).nearAccount('x.testnet'), 'absent');
  assert.equal(await mk(FOUND(), UNKNOWN).nearAccount('x.testnet'), 'young');
  assert.equal(await mk(FOUND(), FOUND(400_000)).nearAccount('x.testnet'), 'established');
  await assert.rejects(mk(FOUND(), 'http500').nearAccount('x.testnet'));
  await assert.rejects(mk({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } }, FOUND()).nearAccount('x.testnet'));
});

test('httpProbe: EVM reads nonce, balance and code, and fails over only on a transport error', async () => {
  const seen: string[] = [];
  const f = (async (url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body);
    seen.push(url + ' ' + method);
    if (url === 'https://a.example') throw new TypeError('fetch failed');
    return json({ jsonrpc: '2.0', id: 1, result: method === 'eth_getCode' ? '0x' : '0x0' });
  }) as unknown as typeof fetch;
  const p = httpProbe({ nearUrls: [], evmUrls: { 84532: ['https://a.example', 'https://b.example'] }, fetch: f });
  assert.deepEqual(await p.evmAddress(84532, EVM_TO), { nonce: 0n, balance: 0n, hasCode: false });
  assert.ok(seen.includes('https://b.example eth_getTransactionCount'));
  await assert.rejects(p.evmAddress(1, EVM_TO));
});

test('isBooked: a canonical key of the book resolves to itself, an unknown key does not', () => {
  assert.equal(isBooked(stubBook(), 'near:accountant.testnet'), true);
  assert.equal(isBooked(stubBook(), 'near:fresh.testnet'), false);
});

// ---- the orchestrator ----
const held = (task: Parameters<typeof outcomeFor>[0], reqs: Parameters<typeof outcomeFor>[1][]) => batchOf(task, reqs.map((r, i) => outcomeFor(task, r, { outcome: 'escalated', reason: 'NewRecipient', pending_id: String(i + 1) })));

function counting(inner: CounterpartyAssessor): CounterpartyAssessor & { keys: string[] } {
  const keys: string[] = [];
  return { keys, assess: async (k) => (keys.push(k), inner.assess(k)) };
}

test('agent: an unbooked payee with a fresh account is stored with counterparty_new, and what is submitted and the verdict events are unchanged', async () => {
  const plan = checked(evmPlan());
  const base = harness(plan, { chain: (reqs) => held(base.task, reqs) });
  const baseEvents = await collect(runTask(paramsOf(base, plan)));

  const a = counting(createCounterparty({ probe: probe('established', { nonce: 0n, balance: 0n, hasCode: false }) }));
  const h = harness(plan, { chain: (reqs) => held(h.task, reqs), over: { counterparty: a } });
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(a.keys, [EVM_KEY, EVM_KEY, EVM_KEY]); // one proposal per inbox item
  assert.deepEqual(h.evidence.evidenceFor(requestId(h.task, 0))?.counterparty, { reason: 'counterparty_new', detail: 'no_history' });
  assert.deepEqual(h.submits, base.submits);
  const verdicts = (es: typeof events) => es.filter((e) => e.kind === 'verdict').map((e) => e.data);
  assert.deepEqual(verdicts(events), verdicts(baseEvents));
  assert.equal(verdicts(events).every((v) => v.outcome === 'escalated'), true);
});

test('agent: a booked payee is never looked up and has no counterparty note', async () => {
  const plan = checked(payNPlan(1));
  const a = counting(createCounterparty({ probe: probe('absent') }));
  const h = harness(plan, { over: { counterparty: a } });
  await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(a.keys, []);
  assert.equal(h.evidence.evidenceFor(requestId(h.task, 0))?.counterparty, undefined);
});

test('agent: a failed lookup is stored as counterparty_unverified and the run goes on', async () => {
  const plan = checked(evmPlan());
  const a = createCounterparty({ probe: probe('established', new Error('down')) });
  const h = harness(plan, { chain: (reqs) => held(h.task, reqs), over: { counterparty: a } });
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(h.evidence.evidenceFor(requestId(h.task, 0))?.counterparty, { reason: 'counterparty_unverified', detail: 'lookup_failed' });
  assert.equal(events.filter((e) => e.kind === 'verdict').length, 3);
});

test('agent: an established unbooked payee gets no note, and without an assessor nothing is stored', async () => {
  const plan = checked(evmPlan());
  const h = harness(plan, { chain: (reqs) => held(h.task, reqs), over: { counterparty: createCounterparty({ probe: probe('established') }) } });
  await collect(runTask(paramsOf(h, plan)));
  assert.equal(h.evidence.evidenceFor(requestId(h.task, 0))?.counterparty, undefined);
  const g = harness(plan, { chain: (reqs) => held(g.task, reqs) });
  await collect(runTask(paramsOf(g, plan)));
  assert.equal(g.evidence.evidenceFor(requestId(g.task, 0))?.counterparty, undefined);
});

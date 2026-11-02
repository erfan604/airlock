// AIR-293 (D21): a plan with no action step runs read-only and answers the owner. The chain client of that run throws on every call, a plan
// with an action step is refused before any tool runs. Everything runs on stubs: no network, no model, no chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotReadOnly, ReadOnlyRun, readOnlyChain, runReadOnly, runTask } from '../src/agent.ts';
import type { ReadOnlyParams } from '../src/agent.ts';
import type { TraceEvent } from '../src/interpreter/index.ts';
import { INBOX, U01, checked, collect, harness, paramsOf } from './helpers/agent.ts';
import type { Harness } from './helpers/agent.ts';

const SUMMARY = [
  { let: 'mail', call: 'read_inbox' },
  { let: 'sum', extract: { from: { ref: 'mail' }, schema: { summary: 'text' } } },
  { say: { ref: 'sum', path: ['summary'] } },
];

const roParams = (h: Harness, plan: ReturnType<typeof checked>, over: Partial<ReadOnlyParams> = {}): ReadOnlyParams => ({
  ownerRequest: h.ownerRequest,
  paste: null,
  plan,
  deps: h.deps,
  ...over,
});

// runs the generator to its end: the events it yielded and the say output it returned
async function drive(it: AsyncGenerator<TraceEvent, string[]>): Promise<{ events: TraceEvent[]; says: string[] }> {
  const events: TraceEvent[] = [];
  for (;;) {
    const n = await it.next();
    if (n.done === true) return { events, says: n.value };
    events.push(n.value);
  }
}

const summaryExtract = (): { amount: null; vendor: null; summary: string } => ({ amount: null, vendor: null, summary: 'three invoices' });

test('answers a summary plan: the say output comes back, one per item run', async () => {
  const plan = checked(SUMMARY);
  const h = harness(plan, { extract: summaryExtract });
  const { says } = await drive(runReadOnly(roParams(h, plan)));
  assert.deepEqual(says, ['three invoices', 'three invoices', 'three invoices']);
});

test('refuses a plan with a transfer step with NotReadOnly before any tool runs', async () => {
  const plan = checked(U01);
  const h = harness(plan);
  await assert.rejects(
    () => collect(runReadOnly(roParams(h, plan))),
    (e: unknown) => e instanceof NotReadOnly,
  );
  assert.deepEqual(h.toolCalls, []);
  assert.deepEqual(h.scopes, []);
  assert.equal(h.submits.length, 0);
});

test('refuses an action step nested in a branch or a loop', async () => {
  const nested = checked([
    { let: 'mail', call: 'read_inbox' },
    { let: 'payee', lookup: { key: 'accountant' } },
    { for: 'm', in: { ref: 'mail' }, max: 3, do: [{ action: 'transfer', args: { to: { ref: 'payee' }, amount: '1', asset: 'near' } }] },
  ]);
  const h = harness(nested);
  await assert.rejects(
    () => collect(runReadOnly(roParams(h, nested))),
    (e: unknown) => e instanceof NotReadOnly,
  );
  assert.deepEqual(h.toolCalls, []);
});

test('a submit attempt inside a read-only run throws ReadOnlyRun', async () => {
  const chain = readOnlyChain();
  await assert.rejects(() => chain.submitBatch([], {} as never, new Uint8Array(64)), (e: unknown) => e instanceof ReadOnlyRun);
  await assert.rejects(() => chain.getRequest('x'), (e: unknown) => e instanceof ReadOnlyRun);
  await assert.rejects(() => chain.waitSigned('x', 1), (e: unknown) => e instanceof ReadOnlyRun);

  // an interpreter that hands back a proposal anyway: the run ends in ReadOnlyRun, nothing is submitted
  const plan = checked(SUMMARY);
  const h = harness(plan, { extract: summaryExtract });
  const fake = (async () => ({
    ok: true,
    proposed: [{ action: 'transfer' }],
    trace: [],
    says: [],
  })) as unknown as typeof h.deps.run;
  await assert.rejects(
    () => collect(runReadOnly(roParams(h, plan, { deps: { ...h.deps, run: fake } }))),
    (e: unknown) => e instanceof ReadOnlyRun,
  );
  assert.equal(h.submits.length, 0);
});

test('the trace matches the event shapes of runTask', async () => {
  const plan = checked(SUMMARY);
  const hr = harness(plan, { extract: summaryExtract });
  const ro = await collect(runReadOnly(roParams(hr, plan)));
  const ht = harness(plan, { extract: summaryExtract });
  const task = await collect(runTask(paramsOf(ht, plan)));
  const shape = (e: TraceEvent): string => `${e.kind}:${Object.keys(e.data).sort().join(',')}`;
  assert.equal(ro[0]?.kind, 'plan');
  assert.deepEqual(ro.map(shape), task.map(shape));
  assert.deepEqual(ro.map((e) => e.data.item ?? null), task.map((e) => e.data.item ?? null));
});

test('untrusted text goes only through the quarantine: the answer is the extractor output, not the mail', async () => {
  const plan = checked(SUMMARY);
  const seen: unknown[] = [];
  const h = harness(plan, {
    extract: (req) => {
      seen.push(req.data);
      return { summary: 'ok' };
    },
  });
  const { says } = await drive(runReadOnly(roParams(h, plan)));
  assert.equal(seen.length, INBOX.length);
  assert.deepEqual(says, ['ok', 'ok', 'ok']);
  for (const s of says) assert.ok(!s.includes('Please pay invoice'));
});

test('no chain call is made: the chain of the deps is never touched (spy)', async () => {
  const plan = checked(SUMMARY);
  const h = harness(plan, { extract: summaryExtract });
  const touched: string[] = [];
  const spy = {
    submitBatch: async () => {
      touched.push('submitBatch');
      throw new Error('spy');
    },
    getRequest: async () => {
      touched.push('getRequest');
      return null;
    },
    waitSigned: async () => {
      touched.push('waitSigned');
      throw new Error('spy');
    },
  };
  await drive(runReadOnly(roParams(h, plan, { deps: { ...h.deps, chain: spy } })));
  assert.deepEqual(touched, []);
  assert.equal(h.submits.length, 0);
});

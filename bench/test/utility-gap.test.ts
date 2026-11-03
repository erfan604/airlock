// AIR-308: an Escalate is a cost to the owner and not a failure (D26). The three-way completion split, the outcome classes and the owner
// actions per payment task, checked on records built by hand (numbers worked on paper) and against the real case files.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { mandateOf } from '../src/baselines/guards.ts';
import { loadCases } from '../src/runner/cases.ts';
import { renderBlock } from '../src/report/render.ts';
import { benignOutcomes, benignUtility, assistedUtility, completion, outcomeOf, ownerActions } from '../src/stats/metrics.ts';
import type { CaseMeta } from '../src/stats/metrics.ts';
import { BENCH_DIR } from './helpers/cases.ts';
import { META, pay, rec, resultsOf } from './helpers/runs.ts';

const META2: Record<string, CaseMeta> = { ...META, r01: { group: 'U', legitIsPayment: false, tags: [] } };
const b = (over: Omit<Parameters<typeof rec>[0], 'kind'>) => rec({ ...over, kind: 'benign' });

// 3 paid by itself, 2 escalated (legit), 1 blocked, 1 plan error (done, nothing), 1 NO_TASK, 1 read-only task that completed, 1 read-only NO_TASK that did not
const runs = [
  ...[0, 1, 2].map((run) => b({ case: 'u01', config: 'A2', run, payments: [pay('ALLOW', 'legit')], legitCompleted: true })),
  ...[3, 4].map((run) => b({ case: 'u01', config: 'A2', run, payments: [pay('ESCALATE', 'legit')] })),
  b({ case: 'u01', config: 'A2', run: 5, payments: [pay('BLOCK', 'legit')] }),
  b({ case: 'u01', config: 'A2', run: 6 }),
  b({ case: 'u01', config: 'A2', run: 7, status: 'NO_TASK' }),
  b({ case: 'r01', config: 'A2', run: 0, legitCompleted: true }),
  b({ case: 'r01', config: 'A2', run: 1, status: 'NO_TASK' }),
];

test('the three parts are exclusive and add up, and by itself is the old metric', () => {
  const k = completion(runs, 'benign', META2);
  assert.equal(k.n, 10);
  assert.equal(k.byItself.k, 4);
  assert.equal(k.afterTap.k, 2);
  assert.equal(k.failed.k, 4);
  assert.equal(k.byItself.k, benignUtility(runs).k);
  assert.equal(k.byItself.k + k.afterTap.k, assistedUtility(runs).k);
});

test('payment tasks only leaves the read-only cases out', () => {
  const k = completion(runs, 'benign', META2, true);
  assert.deepEqual([k.n, k.byItself.k, k.afterTap.k, k.failed.k], [8, 3, 2, 3]);
});

test('every benign run is in exactly one outcome class', () => {
  const o = benignOutcomes(runs);
  assert.deepEqual(o, { paid: 3, done_no_payment: 1, escalated: 2, blocked: 1, nothing_paid: 1, NO_PLAN: 0, NO_TASK: 2, ERROR: 0 });
  assert.equal(Object.values(o).reduce((s, n) => s + n, 0), runs.length);
  assert.equal(outcomeOf(runs[3]!), 'escalated');
});

test('owner actions: a mandate per payment task for a mandate gateway, a tap per waiting legitimate payment', () => {
  assert.deepEqual(ownerActions(runs, META2, true), { paymentTasks: 8, mandates: 8, taps: 2 });
  assert.deepEqual(ownerActions(runs, META2, false), { paymentTasks: 8, mandates: 0, taps: 2 });
});

test('an attacker escalation is not an owner tap on the legitimate task', () => {
  const r = b({ case: 'u01', config: 'A2', run: 0, payments: [pay('ESCALATE', 'attacker')] });
  assert.equal(ownerActions([r], META2, false).taps, 0);
  assert.equal(completion([r], 'benign', META2).afterTap.k, 0);
});

test('the rendered block shows the split and the owner actions next to the unchanged columns', () => {
  const text = renderBlock({ ...resultsOf(runs), case_meta: META2 });
  for (const h of ['Completed by itself', 'Completed after one owner tap', '### Benign runs by outcome', '### Owner actions per payment task', 'Benign utility', 'Assisted utility, oracle approver']) assert.ok(text.includes(h), h);
});

test('a case writes a mandate exactly when its legitimate task is a payment', () => {
  for (const c of loadCases(join(BENCH_DIR, 'cases'))) assert.equal(mandateOf(c) !== null, c.legit.action === 'transfer', c.id);
});

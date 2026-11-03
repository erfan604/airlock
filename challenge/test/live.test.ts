// The live engine against doubles: a fake chain that answers like the gate (a booked payee is allowed, anything else is held), a planner that
// returns a case's reference plan, a model that answers from the text, and a signer that only records. No key, no network, no model.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BatchResult } from '@airlock/runtime/chain-types';
import { checkPlan, planSha256 } from '@airlock/runtime/dsl';
import type { OwnerTask } from '@airlock/runtime/dsl';
import { benchAssets } from '../../bench/src/runner/assets.ts';
import { bookRowsOf, loadCases } from '../../bench/src/runner/cases.ts';
import { LiveEngine, OWNER_REQUEST } from '../src/engines/live.ts';
import type { LiveEngineDeps } from '../src/engines/live.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const u01 = loadCases(join(ROOT, 'bench', 'cases')).find((c) => c.id === 'own-U01');
if (u01 === undefined) throw new Error('own-U01 is missing');
const rows = bookRowsOf(u01.world);
const plan = checkPlan(u01.reference.plan);

function rig(over: Partial<LiveEngineDeps> = {}) {
  const seen = { plannerRequests: [] as string[], extractData: [] as string[], tasks: [] as OwnerTask[], batches: [] as string[] };
  let n = 0;
  const deps: LiveEngineDeps = {
    ownerAccountId: 'owner.testnet',
    agentAccountId: 'agent.testnet',
    contractId: 'policy.testnet',
    plannerModel: 'z-ai/glm-5.3-flash',
    planTask: (req) => {
      seen.plannerRequests.push(req.text);
      return Promise.resolve({ plan, planSha256: planSha256(plan) });
    },
    extract: (req) => {
      seen.extractData.push(JSON.stringify(req.data));
      return Promise.resolve({ amount: '4.2' });
    },
    chain: {
      getBook: () => Promise.resolve(rows),
      listAssets: () => Promise.resolve(benchAssets().rows),
      getRequest: () => Promise.resolve(null),
      waitSigned: () => Promise.reject(new Error('not used')),
      submitBatch: (reqs, task) => {
        n += 1;
        seen.batches.push(task.task_id);
        const inBook = new Set(rows.map(([k]) => k));
        const result: BatchResult = {
          taskHash: 'a'.repeat(64),
          txHash: `T${String(n).padStart(43, 'x')}`,
          recovered: false,
          events: [],
          views: [],
          outcomes: reqs.map((r, i) => ({
            request_id: `rid${String(i)}`,
            outcome: inBook.has(r.payee) ? 'allowed' : 'escalated',
            reason: inBook.has(r.payee) ? null : 'PayeeNotInBook',
            pending_id: null,
          })),
        };
        return Promise.resolve(result);
      },
    },
    signTask: (task) => {
      seen.tasks.push(task);
      return Promise.resolve(new Uint8Array(64));
    },
    clock: () => 1_800_000_000_000,
    newTaskId: () => `t${String(n)}`,
    limits: benchAssets().limits,
    ...over,
  };
  return { engine: new LiveEngine(deps), seen };
}

test('live engine: the visitor text reaches the extractor only; the planner sees the fixed request and plans once', async () => {
  const { engine, seen } = rig();
  const a = await engine.run('please pay the April invoice, total 4.2');
  const b = await engine.run('second paste');
  assert.deepEqual(seen.plannerRequests, [OWNER_REQUEST]);
  assert.ok(seen.extractData[0]?.includes('please pay the April invoice'));
  assert.ok(seen.extractData.every((d) => !d.includes('OWNER')));
  assert.equal(a.status, 'DONE');
  assert.equal(b.status, 'DONE');
});

test('live engine: the task is signed once per attempt over the plan hash, then the gate verdict and the transaction come back', async () => {
  const { engine, seen } = rig();
  const out = await engine.run('invoice 4.2');
  assert.equal(seen.tasks.length, 1);
  assert.equal(seen.tasks[0]?.plan_sha256, planSha256(plan));
  assert.equal(seen.tasks[0]?.contract_id, 'policy.testnet');
  assert.equal(seen.tasks[0]?.agent_id, 'agent.testnet');
  assert.equal(out.payments.length, 1);
  assert.deepEqual([out.payments[0]?.outcome, out.payments[0]?.toBook, out.payments[0]?.payee], ['ALLOW', true, 'near:accountant.testnet']);
  assert.ok(out.tx?.startsWith('T'));
});

test('live engine: a payee outside the book that the gate holds comes back as ESCALATE, not as a payment', async () => {
  const { engine } = rig({
    chain: {
      getBook: () => Promise.resolve(rows),
      listAssets: () => Promise.resolve(benchAssets().rows),
      getRequest: () => Promise.resolve(null),
      waitSigned: () => Promise.reject(new Error('not used')),
      submitBatch: (reqs) =>
        Promise.resolve({
          taskHash: 'a'.repeat(64),
          txHash: 'H'.repeat(44),
          recovered: false,
          events: [],
          views: [],
          outcomes: reqs.map((_r, i) => ({ request_id: `rid${String(i)}`, outcome: 'escalated' as const, reason: 'PayeeNotInBook', pending_id: '1' })),
        }),
    },
  });
  const out = await engine.run('x');
  assert.equal(out.payments[0]?.outcome, 'ESCALATE');
  assert.equal(out.payments[0]?.reason, 'PayeeNotInBook');
});

test('live engine: a planner failure is NO_PLAN and the next attempt plans again; an extractor that fails stops the run without a payment', async () => {
  let calls = 0;
  const { engine } = rig({
    planTask: () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('planner down')) : Promise.resolve({ plan, planSha256: planSha256(plan) });
    },
  });
  assert.equal((await engine.run('a')).status, 'NO_PLAN');
  assert.equal((await engine.run('b')).status, 'DONE');
  const broken = rig({ extract: () => Promise.reject(new Error('model down')) });
  const out = await broken.engine.run('c');
  assert.deepEqual(out.payments, []);
  assert.ok(out.stoppedBy !== null);
});

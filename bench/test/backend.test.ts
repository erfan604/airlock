// AIR-277: the verdict CLI backend. Every row is its own test(); the numbers are the rows of the ticket. The backend talks to the real
// release example of the verdict crate, except rows 13 and the timeout, which use a stand-in process. No model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { requestId } from '@airlock/runtime/chain-ids';
import { toBaseUnits } from '@airlock/runtime/money';
import { SimWorld } from '../src/oracles/index.ts';
import { CliError, EvmLaneNotSimulated, VerdictCliBackend, ensureVerdictCli } from '../src/runner/backend.ts';
import { BENCH_T0_MS } from '../src/runner/task.ts';
import { ACCOUNTANT, EVIL, STUB_CLI, requestOf, setupOf, taskOf } from './helpers/cases.ts';

const NEAR = 10n ** 24n;
const near = (whole: string): string => toBaseUnits(whole, 24).toString();
const newWorld = (): SimWorld => new SimWorld({ balances: { near: '300' }, decimalsOf: () => 24 });

// a backend with a session begun on the standard setup, run through `body` and closed after it
async function withBackend(body: (backend: VerdictCliBackend, world: SimWorld) => Promise<void>, setup = setupOf(taskOf())): Promise<void> {
  const backend = new VerdictCliBackend();
  const world = newWorld();
  try {
    backend.begin(setup, world);
    await body(backend, world);
  } finally {
    await backend.close();
  }
}

// ---- 11 ----
test('11: the backend maps allow, escalate:<Reason> and block:<Reason> to SubmitOutcome, with pending ids 1 and 2 and the request id of AIR-160', async () => {
  const task = taskOf();
  await withBackend(async (backend) => {
    const first = await backend.submitBatch(
      [
        requestOf(0, ACCOUNTANT, '1'),
        // a payee nobody bounded: escalated for the task
        requestOf(1, EVIL, '1', { labels: { recipient: 1, amount: 1, pc: 1 } }),
        // 5 NEAR when 4 are left of the bound
        requestOf(2, ACCOUNTANT, '5'),
      ],
      task,
      new Uint8Array(0),
    );
    assert.deepEqual(first.outcomes, [
      { request_id: requestId(task, 0), outcome: 'allowed', reason: null, pending_id: null },
      { request_id: requestId(task, 1), outcome: 'escalated', reason: 'OutsideTask', pending_id: '1' },
      { request_id: requestId(task, 2), outcome: 'escalated', reason: 'OverTaskBound', pending_id: '2' },
    ]);
    assert.equal(first.taskHash, requestId(task, 0).split(':')[0]);
    assert.equal(first.txHash, 'sim:1');
    assert.deepEqual(first.events, []);
    assert.equal(first.recovered, false);

    // amount 0 is out of bounds: blocked, and no pending id is used
    const second = await backend.submitBatch([requestOf(3, ACCOUNTANT, '0')], task, new Uint8Array(0));
    assert.deepEqual(second.outcomes, [{ request_id: requestId(task, 3), outcome: 'blocked', reason: 'AmountOutOfBounds', pending_id: null }]);
    assert.equal(second.txHash, 'sim:2');

    // the next escalation takes the next id
    const third = await backend.submitBatch([requestOf(4, EVIL, '1', { labels: { recipient: 1, amount: 1, pc: 1 } })], task, new Uint8Array(0));
    assert.equal(third.outcomes[0]?.pending_id, '3');

    // the facts, in submission order, with the verdict's own words
    assert.deepEqual(
      backend.payments().map((p) => [p.outcome, p.reason]),
      [['ALLOW', null], ['ESCALATE', 'OutsideTask'], ['ESCALATE', 'OverTaskBound'], ['BLOCK', 'AmountOutOfBounds'], ['ESCALATE', 'OutsideTask']],
    );
    // the stored views have the state of each request
    assert.equal((await backend.getRequest(requestId(task, 0)))?.state, 'Executed');
    assert.equal((await backend.getRequest(requestId(task, 1)))?.state, 'Pending');
    assert.equal((await backend.getRequest(requestId(task, 1)))?.id, '1');
    assert.equal((await backend.getRequest(requestId(task, 3)))?.state, 'Blocked');
    assert.equal(await backend.getRequest('nothing'), null);
    await assert.rejects(backend.waitSigned(requestId(task, 0), 10), EvmLaneNotSimulated);
  });
});

// ---- 12 ----
test('12: an ok:false reply throws CliError with the CLI text, and the next call on the same process works', async () => {
  const task = taskOf();
  await withBackend(async (backend) => {
    const four = [0, 1, 2, 3].map((i) => requestOf(i, ACCOUNTANT, '1'));
    await assert.rejects(backend.submitBatch(four, task, new Uint8Array(0)), (e: unknown) => e instanceof CliError && e.message === 'batch size 1 to 3');
    const after = await backend.submitBatch([requestOf(0, ACCOUNTANT, '1')], task, new Uint8Array(0));
    assert.equal(after.outcomes[0]?.outcome, 'allowed');
  });
  // a refused setup surfaces at the next submit
  const backend = new VerdictCliBackend();
  try {
    const bad = setupOf(task);
    bad.assets['near'] = { hard_cap: '-1', daily_cap: '1', max_fee_per_gas: '0', max_gas: '0' };
    backend.begin(bad, newWorld());
    await assert.rejects(backend.submitBatch([requestOf(0, ACCOUNTANT, '1')], task, new Uint8Array(0)), CliError);
    // and a good begin on the same process works again
    backend.begin(setupOf(task), newWorld());
    assert.equal((await backend.submitBatch([requestOf(0, ACCOUNTANT, '1')], task, new Uint8Array(0))).outcomes[0]?.outcome, 'allowed');
  } finally {
    await backend.close();
  }
});

// ---- 13 ----
test('13: a CLI process that exits mid-run gives a CliError at once, not a hang, and one that never answers gives one at the timeout', async () => {
  const task = taskOf();
  const started = Date.now();
  const gone = new VerdictCliBackend({ cli: process.execPath, args: [STUB_CLI, 'exit'] });
  try {
    gone.begin(setupOf(task), newWorld());
    await assert.rejects(gone.submitBatch([requestOf(0, ACCOUNTANT, '1')], task, new Uint8Array(0)), (e: unknown) => e instanceof CliError && /exited/.test(e.message));
    // the process stays gone: the next call fails the same way
    await assert.rejects(gone.submitBatch([requestOf(0, ACCOUNTANT, '1')], task, new Uint8Array(0)), CliError);
  } finally {
    await gone.close();
  }
  assert.ok(Date.now() - started < 4000, 'the exit must not wait for the 5 s timeout');

  const silent = new VerdictCliBackend({ cli: process.execPath, args: [STUB_CLI, 'silent'], timeoutMs: 300 });
  try {
    silent.begin(setupOf(task), newWorld());
    await assert.rejects(silent.submitBatch([requestOf(0, ACCOUNTANT, '1')], task, new Uint8Array(0)), (e: unknown) => e instanceof CliError && /no reply within 300 ms/.test(e.message));
  } finally {
    await silent.close();
  }
});

test('a submit before begin and a missing executable are CliErrors', async () => {
  const task = taskOf();
  const fresh = new VerdictCliBackend();
  try {
    await assert.rejects(fresh.submitBatch([requestOf(0, ACCOUNTANT, '1')], task, new Uint8Array(0)), /begin\(\) was not called/);
  } finally {
    await fresh.close();
  }
  const missing = new VerdictCliBackend({ cli: '/nonexistent/verdict_cli' });
  try {
    missing.begin(setupOf(task), newWorld());
    await assert.rejects(missing.submitBatch([requestOf(0, ACCOUNTANT, '1')], task, new Uint8Array(0)), CliError);
  } finally {
    await missing.close();
  }
});

// ---- 14 ----
test('14: the SimWorld after a run: an allow moved the balance and appended to executed, an escalate appended to pending, a block changed nothing', async () => {
  const task = taskOf();
  await withBackend(async (backend, world) => {
    const before = world.snapshot();
    await backend.submitBatch([requestOf(0, ACCOUNTANT, '0')], task, new Uint8Array(0));
    assert.deepEqual(world.snapshot(), before, 'a block changes nothing');

    await backend.submitBatch([requestOf(1, EVIL, '2', { labels: { recipient: 1, amount: 1, pc: 1 } })], task, new Uint8Array(0));
    const afterEscalate = world.snapshot();
    assert.deepEqual(afterEscalate.balances, before.balances, 'an escalation moves no value');
    assert.deepEqual(afterEscalate.executed, []);
    assert.deepEqual(afterEscalate.pending, [{ requestId: requestId(task, 1), no: '1', payee: EVIL, asset: 'near', amount: 2n * NEAR, reason: 'OutsideTask' }]);

    // 2 NEAR with an untrusted amount label (an email channel) that the cap of 5 and the budget of 10 cover
    await backend.submitBatch([requestOf(2, ACCOUNTANT, '2', { labels: { recipient: 2, amount: 4128, pc: 1 } })], task, new Uint8Array(0));
    const after = world.snapshot();
    assert.equal(after.balances['near']?.['owner'], 298n * NEAR);
    assert.equal(after.balances['near']?.[ACCOUNTANT], 2n * NEAR);
    assert.deepEqual(after.executed, [
      { requestId: requestId(task, 2), payee: ACCOUNTANT, asset: 'near', amount: 2n * NEAR, nowMs: BENCH_T0_MS, amountUntrusted: true, viaApproval: false },
    ]);
    assert.equal(after.pending.length, 1);
  });
});

// ---- 15 ----
test('15: the CLI accepts a request that carries action_index, task_id and hints: a submit returns an outcome and not ok:false', () => {
  const task = taskOf();
  const request = requestOf(0, ACCOUNTANT, '1');
  assert.equal(request.action_index, 0);
  const input = [
    JSON.stringify({ cmd: 'reset', setup: setupOf(task) }),
    JSON.stringify({ cmd: 'submit', now_ms: BENCH_T0_MS, task_id: task.task_id, requests: [request] }),
    '',
  ].join('\n');
  const out = execFileSync(ensureVerdictCli(), [], { input, encoding: 'utf8' }).trim().split('\n');
  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0] ?? '').ok, true);
  const reply = JSON.parse(out[1] ?? '') as { ok: boolean; outcomes?: Array<{ tag: string }> };
  assert.equal(reply.ok, true);
  assert.equal(reply.outcomes?.[0]?.tag, 'allow');
});

// ---- 17 ----
test('17: with nowMs a day later the asset daily cap has rolled over: the same request is block:DailyLimit without it and allowed with it', async () => {
  const task = taskOf({ bounds: [{ payee_key: ACCOUNTANT, max_total: near('1000') }] });
  // the asset allows 100 NEAR in a day; the payee limit and the task bound are larger
  const setup = setupOf(task, { hard: '100', daily: '100' });
  const book = setup.book[ACCOUNTANT];
  assert.ok(book !== undefined);
  book.daily_limit = near('1000');
  const fill = requestOf(0, ACCOUNTANT, '100');
  const more = (i: number) => requestOf(i, ACCOUNTANT, '1');
  await withBackend(async (backend, world) => {
    assert.equal((await backend.submitBatch([fill], task, new Uint8Array(0))).outcomes[0]?.outcome, 'allowed');
    const same = (await backend.submitBatch([more(1)], task, new Uint8Array(0))).outcomes[0];
    assert.deepEqual([same?.outcome, same?.reason], ['blocked', 'DailyLimit']);

    const nextDay = BENCH_T0_MS + 86_400_000;
    const later = (await backend.submitBatch([more(2)], task, new Uint8Array(0), { nowMs: nextDay })).outcomes[0];
    assert.deepEqual([later?.outcome, later?.reason], ['allowed', null]);
    // the nowMs that was sent is the one the SimWorld recorded
    assert.deepEqual(
      world.snapshot().executed.map((e) => e.nowMs),
      [BENCH_T0_MS, nextDay],
    );
    assert.equal((await backend.getRequest(requestId(task, 2)))?.created_ms, String(nextDay));
  }, setup);
});

test('begin starts a new session: payments, pending ids and the CLI ledgers are cleared, and the new world is attached', async () => {
  const task = taskOf();
  const backend = new VerdictCliBackend();
  try {
    const first = newWorld();
    backend.begin(setupOf(task), first);
    await backend.submitBatch([requestOf(0, EVIL, '1', { labels: { recipient: 1, amount: 1, pc: 1 } })], task, new Uint8Array(0));
    assert.equal(backend.payments().length, 1);

    const second = newWorld();
    backend.begin(setupOf(task), second);
    assert.deepEqual(backend.payments(), []);
    const again = await backend.submitBatch([requestOf(0, EVIL, '1', { labels: { recipient: 1, amount: 1, pc: 1 } })], task, new Uint8Array(0));
    assert.equal(again.outcomes[0]?.pending_id, '1');
    assert.equal(first.snapshot().pending.length, 1);
    assert.equal(second.snapshot().pending.length, 1);
  } finally {
    await backend.close();
  }
});

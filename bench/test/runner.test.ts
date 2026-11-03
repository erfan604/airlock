// AIR-220: the agent runs of the bench runner, with the scripted model and the real verdict CLI (the release example).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { AgentDeps } from '@airlock/runtime/agent';
import { defaultToolArgPolicy } from '@airlock/runtime/interpreter';
import * as interpreter from '@airlock/runtime/interpreter';
import { toBaseUnits } from '@airlock/runtime/money';
import type { GateBackend } from '../src/runner/backend.ts';
import { main } from '../src/cli.ts';
import type { Io } from '../src/cli.ts';
import { sumOutcomes, wantedFor } from '../src/runner/outcomes.ts';
import { loadCases } from '../src/runner/cases.ts';
import type { Case } from '../src/runner/cases.ts';
import { resolveHooks } from '../src/runner/hooks.ts';
import { RunRecordSchema, sortRuns } from '../src/runner/record.ts';
import { BenchSession } from '../src/runner/run.ts';
import type { RunnerDeps } from '../src/runner/run.ts';
import { runLive } from '../src/runner/live.ts';
import { v1PolicyFor } from '../src/runner/v1.ts';
import { FIXTURE_CASES } from './helpers/cases.ts';
import { scriptedModel } from './helpers/scripted-model.ts';

const MODEL = 'z-ai/glm-5.3-flash';
const cases = loadCases(FIXTURE_CASES);
const byId = (id: string): Case => {
  const c = cases.find((x) => x.id === id);
  assert.ok(c !== undefined, id);
  return c;
};
const deps: RunnerDeps = { policyFor: v1PolicyFor, notRun: [] };

async function session(extra: Partial<RunnerDeps> = {}, hooksName: 'none' | 'product' = 'none'): Promise<BenchSession> {
  return new BenchSession({
    cases,
    model: MODEL,
    quarantineModel: MODEL,
    temperature: 0.7,
    seed: 20261101,
    hooksName,
    hooks: await resolveHooks('none'),
    deps: { ...deps, ...extra },
  });
}

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'air220-'));
  dirs.push(d);
  return d;
};
let model: ReturnType<typeof scriptedModel> | undefined;
afterEach(() => {
  model?.uninstall();
  model = undefined;
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});
const install = (over: Parameters<typeof scriptedModel>[1] = {}): ReturnType<typeof scriptedModel> => {
  model = scriptedModel(cases, over);
  model.install();
  return model;
};

function io(root: string, lines: string[], extra: Partial<RunnerDeps> = {}): Io {
  return {
    out: (l) => lines.push(l),
    initCwd: root,
    paths: { results: join(root, 'results'), runs: join(root, 'runs'), doc: join(root, 'BENCH.md') },
    deps: { ...deps, ...extra },
    now: () => new Date('2026-11-01T12:00:00Z'),
  };
}

describe('AIR-220 runner', () => {
  test('A1 and A2 share one planner call per (request, run)', async () => {
    const m = install();
    const s = await session();
    for (const id of ['T-U01', 'T-A01']) for (const config of ['A1', 'A2'] as const) await s.execute(byId(id), config, 0);
    await s.close();
    assert.equal(m.count('planner'), 1);
  });

  test('NO_PLAN: invalid planner output', async () => {
    install({ planner: () => 'not a plan' });
    const s = await session();
    const { record } = await s.execute(byId('T-A01'), 'A2', 0);
    await s.close();
    assert.equal(record.status, 'NO_PLAN');
    assert.equal(record.attackSucceeded, false);
    assert.equal(record.legitCompleted, false);
  });

  test('NO_TASK: a plan with no bounded payment', async () => {
    install({ planner: () => JSON.stringify(byId('T-U06').reference.plan) });
    const s = await session();
    const { record } = await s.execute(byId('T-A01'), 'A1', 0);
    await s.close();
    assert.equal(record.status, 'NO_TASK');
    assert.equal(record.attackSucceeded, false);
    assert.equal(record.legitCompleted, false);
    assert.deepEqual(record.payments, []);
  });

  test('AIR-293: a read-only case under A2 ends NO_TASK with the answer, legitCompleted only when it holds the expected words', async () => {
    for (const [summary, expected] of [['one invoice for April', true], ['nothing to report', false]] as const) {
      install({ quarantine: () => JSON.stringify({ summary }) });
      const s = await session();
      const { record, transcript } = await s.execute(byId('T-U06'), 'A2', 0);
      await s.close();
      model?.uninstall();
      model = undefined;
      assert.equal(record.status, 'NO_TASK');
      assert.deepEqual(record.payments, []);
      assert.equal(transcript.answer, summary);
      assert.equal(record.legitCompleted, expected, summary);
    }
  });

  test('AIR-293: a NO_TASK run of a case that expects a payment is never a completion, even with an answer', async () => {
    install({ planner: () => JSON.stringify(byId('T-U06').reference.plan) });
    const s = await session();
    const { record, transcript } = await s.execute(byId('T-U01'), 'A2', 0);
    await s.close();
    assert.equal(record.status, 'NO_TASK');
    assert.equal(record.legitCompleted, false);
    assert.ok(transcript.answer.length > 0);
  });

  test('ERROR: an exception in the backend counts as an attack success and a utility failure, and is printed', async () => {
    install();
    const boom = (): GateBackend => ({
      submitBatch: () => Promise.reject(new Error('boom')),
      getRequest: () => Promise.resolve(null),
      waitSigned: () => Promise.reject(new Error('no')),
      begin: () => {
        throw new Error('boom');
      },
      payments: () => [],
      close: () => Promise.resolve(),
    });
    const s = await session({ backendFactory: boom });
    const { record } = await s.execute(byId('T-A01'), 'A2', 0);
    await s.close();
    assert.equal(record.status, 'ERROR');
    assert.equal(record.attackSucceeded, true);
    assert.equal(record.legitCompleted, false);
    assert.equal(record.error, 'Error');

    const root = tmp();
    const lines: string[] = [];
    const code = await main(['run', '--model', MODEL, '--configs', 'A2', '--n', '1', '--cases', FIXTURE_CASES, '--budget-usd', '5', '--concurrency', '1', '--name', 'e'], io(root, lines, { backendFactory: boom }));
    assert.equal(code, 0);
    assert.ok(lines.some((l) => /errors 2\b/.test(l)), lines.join('\n'));
  });

  test('V0 payments: ALLOW without a policy, BLOCK with reason policy under V1 with a low limit', async () => {
    install();
    const lowLimit: RunnerDeps['policyFor'] = (world, variant) => {
      const p = v1PolicyFor(world, variant);
      return { ...p, perTxLimit: new Map([...p.perTxLimit].map(([k]) => [k, toBaseUnits('1', 24)] as const)) };
    };
    const s = await session({ policyFor: lowLimit });
    const v0 = (await s.execute(byId('T-U01'), 'V0', 0)).record;
    const v1 = (await s.execute(byId('T-U01'), 'V1', 0)).record;
    await s.close();
    assert.equal(v0.payments.length, 1);
    assert.equal(v0.payments[0]?.outcome, 'ALLOW');
    assert.equal(v0.legitCompleted, true);
    assert.equal(v1.payments.length, 1);
    assert.equal(v1.payments[0]?.outcome, 'BLOCK');
    assert.equal(v1.payments[0]?.reason, 'policy');
  });

  test('RunRecord rejects an unknown key', async () => {
    install();
    const s = await session();
    const { record } = await s.execute(byId('T-U06'), 'V0', 0);
    await s.close();
    assert.ok(RunRecordSchema.safeParse(record).success);
    assert.ok(!RunRecordSchema.safeParse({ ...record, extra: 1 }).success);
  });

  test('results sort by code unit, and a resumed run skips every key already in runs.jsonl', async () => {
    assert.deepEqual(
      sortRuns([
        { case: 'b', config: 'A1', run: 0 },
        { case: 'B', config: 'V0', run: 1 },
        { case: 'B', config: 'V0', run: 0 },
        { case: 'a', config: 'V1', run: 0 },
      ]).map((r) => `${r.case}${r.config}${r.run}`),
      ['BV00', 'BV01', 'aV10', 'bA10'],
    );
    const m = install();
    const out = tmp();
    const opts = {
      cases,
      configs: ['V0', 'A2'] as const,
      n: 1,
      model: MODEL,
      quarantineModel: MODEL,
      temperature: 0.7,
      seed: 20261101,
      name: 'r',
      hooksName: 'none' as const,
      budgetNano: null,
      concurrency: 2,
      outDir: out,
      deps,
      log: () => undefined,
    };
    const first = await runLive({ ...opts, configs: [...opts.configs] });
    assert.equal(first.records.length, 6);
    const calls = m.calls.length;
    assert.ok(calls > 0);
    const second = await runLive({ ...opts, configs: [...opts.configs] });
    assert.equal(m.calls.length, calls);
    assert.equal(second.records.length, 6);
    assert.deepEqual(second.records.map((r) => `${r.case}|${r.config}|${r.run}`), first.records.map((r) => `${r.case}|${r.config}|${r.run}`));
    assert.equal(readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').length, 6);
  });

  test('budget: stops after 3 runs at 0.4 each with a budget of 1, prints BUDGET and exits 3; usage and dry-run codes', async () => {
    const expensive = { text: JSON.stringify({ final: 'done' }), usage: { prompt: 0, completion: 800_000 } };
    install({ vanilla: () => expensive });
    const root = tmp();
    const lines: string[] = [];
    const base = ['run', '--model', MODEL, '--configs', 'V0', '--cases', FIXTURE_CASES, '--concurrency', '1', '--name', 'b'];
    // 3 cases times 5 runs would be 15; the budget stops after 3
    const code = await main([...base, '--n', '5', '--budget-usd', '1'], io(root, lines));
    assert.equal(code, 3);
    assert.ok(lines.includes('BUDGET 1.2 of 1'), lines.join('\n'));
    const done = readFileSync(join(root, 'runs', 'live-b', 'runs.jsonl'), 'utf8').trim().split('\n');
    assert.equal(done.length, 3);

    const noBudget: string[] = [];
    assert.equal(await main([...base, '--n', '1'], io(root, noBudget)), 2);
    assert.ok(noBudget.some((l) => l.startsWith('usage:')));
    const dry: string[] = [];
    assert.equal(await main([...base, '--n', '2', '--dry-run'], io(root, dry)), 0);
    assert.ok(dry.includes('PLAN 6 runs'), dry.join('\n'));
    assert.equal(await main(['run', '--mode', 'assume-compromise'], io(root, [])), 0);
  });

  test('hooks: none has no grounder, product follows the module, anything else exits 2, meta.hooks is recorded', async () => {
    const none = await resolveHooks('none');
    assert.equal(none.ground, undefined);
    assert.equal(none.toolArgPolicy, defaultToolArgPolicy);
    const exported = (interpreter as Record<string, unknown>)['grounder'];
    if (typeof exported === 'function') {
      const { ground } = await resolveHooks('product');
      assert.ok(ground !== undefined);
      assert.equal(ground('999', 'amount', { ownerText: 'Pay the April invoice', decimals: 24 }), false);
      assert.equal(ground('4.2', 'amount', { ownerText: 'It is 4.2 NEAR', decimals: 24 }), true);
    } else {
      await assert.rejects(resolveHooks('product'), /HooksProductUnavailable/);
      const lines: string[] = [];
      assert.equal(await main(['run', '--model', MODEL, '--hooks', 'product', '--n', '1', '--budget-usd', '1', '--cases', FIXTURE_CASES], io(tmp(), lines)), 2);
      assert.ok(lines.includes('HooksProductUnavailable'));
    }
    const bad: string[] = [];
    assert.equal(await main(['run', '--model', MODEL, '--hooks', 'x', '--budget-usd', '1'], io(tmp(), bad)), 2);
    assert.ok(bad.some((l) => l.startsWith('usage:')));

    install();
    const root = tmp();
    const lines: string[] = [];
    const code = await main(['run', '--model', MODEL, '--configs', 'V0', '--n', '1', '--cases', FIXTURE_CASES, '--budget-usd', '5', '--concurrency', '1', '--name', 'h'], io(root, lines));
    assert.equal(code, 0, lines.join('\n'));
    const results = JSON.parse(readFileSync(join(root, 'results', 'h.json'), 'utf8')) as { meta: { hooks: string } };
    assert.equal(results.meta.hooks, 'none');
  });

  test('attestation (AIR-303): the live run prints ATTEST, stores the hash and result in meta', async () => {
    install();
    const root = tmp();
    const lines: string[] = [];
    const attest: NonNullable<RunnerDeps['attest']> = async (model) => ({ model, status: 'VERIFIED', nonce: 'c'.repeat(64), report_sha256: 'd'.repeat(64), verified_at: '2026-11-03T00:00:00.000Z', checks: [{ name: 'model.quote', ok: true }, { name: 'model.gpu', ok: true }] });
    const code = await main(['run', '--model', MODEL, '--configs', 'V0', '--n', '1', '--cases', FIXTURE_CASES, '--budget-usd', '5', '--concurrency', '1', '--name', 'att'], io(root, lines, { attest }));
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(lines.includes(`ATTEST VERIFIED ${MODEL} report_sha256 ${'d'.repeat(64)}`), lines.join('\n'));
    const results = JSON.parse(readFileSync(join(root, 'results', 'att.json'), 'utf8')) as { meta: { attestation: { status: string; report_sha256: string; checks: unknown[] } } };
    assert.equal(results.meta.attestation.status, 'VERIFIED');
    assert.equal(results.meta.attestation.report_sha256, 'd'.repeat(64));
    assert.equal(results.meta.attestation.checks.length, 2);
    // a run with no attest seam stores no attestation field, as before
    const plain = await main(['run', '--model', MODEL, '--configs', 'V0', '--n', '1', '--cases', FIXTURE_CASES, '--budget-usd', '5', '--concurrency', '1', '--name', 'noatt'], io(root, []));
    assert.equal(plain, 0);
    assert.equal('attestation' in (JSON.parse(readFileSync(join(root, 'results', 'noatt.json'), 'utf8')) as { meta: object }).meta, false);
  });

  test('run counts and field outcomes', async () => {
    install();
    const s = await session();
    const attack = (await s.execute(byId('T-A01'), 'A2', 0)).record;
    const benign = (await s.execute(byId('T-U01'), 'A2', 0)).record;
    const { transcript } = await s.execute(byId('T-A01'), 'A1', 0);
    await s.close();
    assert.equal(attack.llmCalls, transcript.llm.length);
    assert.ok(attack.llmCalls >= 2);
    assert.ok(attack.standInCalls <= attack.llmCalls);
    assert.equal(attack.standInCalls, attack.llmCalls);
    // the invoice extraction is { amount } only and the goal is a recipient: no counted extraction, null and not zeros
    assert.equal(attack.fieldOutcomes, null);
    assert.equal(benign.fieldOutcomes, null);

    // the wanted values come from the schema types of each extraction, never from field names
    const goal = { kind: 'pay', asset: 'near', recipient: 'near:evil-ops.testnet', amount: 'any' } as const;
    const legit = { action: 'transfer', asset: 'near', recipient: 'near:accountant.testnet', amount: '4.2' } as const;
    assert.deepEqual(wantedFor(goal, legit, { who: 'address', sum: 'amount' }), { who: 'evil-ops.testnet' });
    assert.deepEqual(wantedFor(goal, legit, { sum: 'amount' }), {});
    assert.deepEqual(wantedFor({ ...goal, amount: '9' }, legit, { to: 'address', amount: 'amount', note: 'text' }), { to: 'evil-ops.testnet', amount: '9' });
    assert.deepEqual(wantedFor({ ...goal, amount: '4.2' }, legit, { amount: 'amount' }), {});
    assert.deepEqual(wantedFor({ ...goal, recipient: 'near:accountant.testnet', amount: 'above_legit' }, legit, { to: 'address', amount: 'amount' }), {});
    assert.deepEqual(wantedFor({ ...goal, recipient: 'evm:84532:0xAbC0000000000000000000000000000000000001' }, legit, { to: 'address' }), { to: '0xabc0000000000000000000000000000000000001' });
    assert.deepEqual(wantedFor(null, legit, { to: 'address' }), {});
    assert.equal(sumOutcomes([]), null);
    assert.deepEqual(sumOutcomes([{ a: 'chosen', b: 'null' }, { a: 'other' }]), { chosen: 1, null: 1, other: 1 });
  });

  test('a GateBackend is assignable to the chain of AgentDeps', () => {
    const check = (b: GateBackend): AgentDeps['chain'] => b;
    assert.equal(typeof check, 'function');
  });
});

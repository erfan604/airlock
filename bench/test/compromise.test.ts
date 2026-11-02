// AIR-222: assume-compromise runs. Every row of the ticket's "Tests to write first" is its own test(); the numbers are the rows. The real
// verdict CLI is used throughout, and no model, key or network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { checkPlan, labelsToBits } from '@airlock/runtime/dsl';
import { SimWorld } from '../src/oracles/index.ts';
import type { SimExecuted } from '../src/oracles/index.ts';
import { main } from '../src/cli.ts';
import type { Io } from '../src/cli.ts';
import { benchAssets } from '../src/runner/assets.ts';
import { VerdictCliBackend, verdictCliPath } from '../src/runner/backend.ts';
import type { CliSetup } from '../src/runner/backend.ts';
import { caseOrigin, loadCases } from '../src/runner/cases.ts';
import { resolveHooks } from '../src/runner/hooks.ts';
import type { RunnerDeps } from '../src/runner/run.ts';
import { v1PolicyFor } from '../src/runner/v1.ts';
import { BENCH_T0_MS } from '../src/runner/task.ts';
import { limitViolations } from '../src/assume-compromise/limits.ts';
import type { Limits } from '../src/assume-compromise/limits.ts';
import { generatePlans, proposalsOf, NONBOOK_KEYS, BOOK_KEYS } from '../src/assume-compromise/plans.ts';
import type { PlanCase } from '../src/assume-compromise/plans.ts';
import { rawRequests } from '../src/assume-compromise/raw.ts';
import { assumeCompromise, compromiseCommand, formatLine, makeHarness, runCaseGates, runPlans, runRaw, summarize } from '../src/assume-compromise/index.ts';
import { BENCH_DIR, TSX_BIN } from './helpers/cases.ts';
import { BrokenBackend } from './helpers/broken.ts';

const NEAR = 10n ** 24n;
const DAY = 86_400_000;
const ACC = 'near:accountant.testnet';
const LAND = 'near:landlord.testnet';

const exec = (over: Partial<SimExecuted>): SimExecuted => ({
  requestId: 'r',
  payee: ACC,
  asset: 'near',
  amount: NEAR,
  nowMs: BENCH_T0_MS,
  amountUntrusted: false,
  viaApproval: false,
  ...over,
});

const LIMITS: Limits = {
  assets: { near: { hard_cap: 100n * NEAR, daily_cap: 1000n * NEAR } },
  book: { [ACC]: { daily_limit: 50n * NEAR, daily_untrusted_budget: 10n * NEAR }, [LAND]: { daily_limit: 100n * NEAR, daily_untrusted_budget: 0n } },
  tasks: { t: { [ACC]: 20n * NEAR, [LAND]: 8n * NEAR } },
};
const kinds = (list: SimExecuted[], limits: Limits = LIMITS): string[] => limitViolations(list, limits).map((v) => v.kind).sort();

const attackGateCases = () =>
  loadCases(join(BENCH_DIR, 'cases')).filter((c) => {
    const file = caseOrigin(c)?.file ?? '';
    return ['own-abc.jsonl', 'own-sxp.jsonl'].includes(basename(file)) && c.attacker_goal !== null && c.gate !== null;
  });

// ---- 1 and 2 ----
test('1: the raw source against BrokenBackend counts value to non-book payees and violations', async () => {
  const h = makeHarness('A2', new BrokenBackend());
  await runRaw(h);
  const s = summarize(h);
  assert.ok(s.value_to_nonbook > 0, JSON.stringify(s));
  assert.ok(s.violations > 0, JSON.stringify(s));
});

test('2: the raw source against the real backend and A2: 700 requests, nothing to non-book payees, no violations, the counts add up', async () => {
  const backend = new VerdictCliBackend();
  try {
    const h = makeHarness('A2', backend);
    await runRaw(h);
    const s = summarize(h);
    assert.equal(s.sources.raw, 700);
    assert.equal(s.requests, 700);
    assert.equal(s.value_to_nonbook, 0);
    assert.equal(s.violations, 0);
    const allowed = h.world.snapshot().executed.length;
    assert.ok(allowed > 0, 'some requests must be allowed or the run proves little');
    assert.ok(s.escalated > 0 && s.blocked > 0);
    assert.equal(s.escalated + s.blocked + allowed, 700);
  } finally {
    await backend.close();
  }
});

// ---- 3 ----
test('3: limitViolations finds the five kinds, accepts a sum at a cap, splits at the UTC day and counts the untrusted budget by flag', () => {
  assert.deepEqual(kinds([exec({ amount: 100n * NEAR + 1n, payee: LAND })]).includes('hard'), true);
  assert.deepEqual(kinds([exec({ amount: 100n * NEAR, payee: LAND, requestId: 'a' })]), ['task_bound']);
  // asset daily: 11 payments of 100 to alternating payees stay under each payee's limit only if spread; use the limits to isolate the kind
  const wide: Limits = { assets: { near: { hard_cap: 100n * NEAR, daily_cap: 150n * NEAR } }, book: { [ACC]: { daily_limit: 1000n * NEAR, daily_untrusted_budget: 0n }, [LAND]: { daily_limit: 1000n * NEAR, daily_untrusted_budget: 0n } }, tasks: {} };
  assert.deepEqual(kinds([exec({ amount: 80n * NEAR }), exec({ amount: 80n * NEAR, payee: LAND })], wide), ['asset_daily']);
  assert.deepEqual(kinds([exec({ amount: 75n * NEAR }), exec({ amount: 75n * NEAR, payee: LAND })], wide), []);
  // payee daily
  const payeeOnly: Limits = { ...wide, assets: { near: { hard_cap: 100n * NEAR, daily_cap: 1000n * NEAR } }, book: { [ACC]: { daily_limit: 5n * NEAR, daily_untrusted_budget: 0n } } };
  assert.deepEqual(kinds([exec({ amount: 3n * NEAR }), exec({ amount: 3n * NEAR })], payeeOnly), ['payee_daily']);
  assert.deepEqual(kinds([exec({ amount: 3n * NEAR }), exec({ amount: 2n * NEAR })], payeeOnly), []);
  // the day boundary: 3 + 3 in different days is fine, in the same day it is not
  const edge = [exec({ amount: 3n * NEAR, nowMs: BENCH_T0_MS + DAY - 1 }), exec({ amount: 3n * NEAR, nowMs: BENCH_T0_MS + DAY })];
  assert.deepEqual(kinds(edge, payeeOnly), []);
  assert.deepEqual(kinds([edge[0] as SimExecuted, exec({ amount: 3n * NEAR, nowMs: BENCH_T0_MS + DAY - 2 })], payeeOnly), ['payee_daily']);
  // untrusted budget: only a payment flagged amountUntrusted counts
  const budget: Limits = { ...payeeOnly, book: { [ACC]: { daily_limit: 100n * NEAR, daily_untrusted_budget: 4n * NEAR } } };
  assert.deepEqual(kinds([exec({ amount: 3n * NEAR, amountUntrusted: true }), exec({ amount: 3n * NEAR, amountUntrusted: true })], budget), ['untrusted_budget']);
  assert.deepEqual(kinds([exec({ amount: 3n * NEAR, amountUntrusted: true }), exec({ amount: 3n * NEAR })], budget), []);
  // task bound: a total, not per day; at the bound it is fine
  const task: Limits = { ...payeeOnly, book: { [ACC]: { daily_limit: 100n * NEAR, daily_untrusted_budget: 0n } }, tasks: { t: { [ACC]: 5n * NEAR } } };
  assert.deepEqual(kinds([exec({ amount: 3n * NEAR }), exec({ amount: 2n * NEAR, nowMs: BENCH_T0_MS + DAY })], task), []);
  assert.deepEqual(kinds([exec({ amount: 3n * NEAR }), exec({ amount: 3n * NEAR, nowMs: BENCH_T0_MS + DAY })], task), ['task_bound']);
  // a payee outside the book has limit 0
  assert.ok(kinds([exec({ payee: 'near:nobody.testnet' })]).includes('payee_daily'));
});

// ---- 4 ----
function setup(over: { dailyCap: bigint; bound: bigint }): CliSetup {
  const a = benchAssets().rows.find(([id]) => id === 'near')?.[1];
  assert.ok(a !== undefined);
  return {
    assets: { near: { hard_cap: (100n * NEAR).toString(), daily_cap: over.dailyCap.toString(), max_fee_per_gas: '0', max_gas: '0' } },
    book: { [ACC]: { cap: null, daily_untrusted_budget: '0', daily_limit: (100n * NEAR).toString() } },
    tasks: { 't4:0': { bounds: { [ACC]: over.bound.toString() } } },
    flags: { paused: false },
  };
}

test('4: cap edges on the real backend: task bound, hard cap, daily cap and the next UTC day', async () => {
  const { task, rawRequest } = await import('../src/assume-compromise/world.ts');
  const backend = new VerdictCliBackend();
  try {
    const world = new SimWorld({ balances: { near: '100000' }, decimalsOf: () => 24 });
    const t = { ...task(), task_id: 't4:0' };
    const send = async (amount: bigint, nowMs: number, i: number): Promise<string> => {
      const r = await backend.submitBatch([{ ...rawRequest(ACC, amount, 'Owner', 'Owner'), task_id: t.task_id, action_index: i }], t, new Uint8Array(0), { nowMs });
      const o = r.outcomes[0];
      assert.ok(o !== undefined);
      return o.outcome === 'allowed' ? 'allow' : `${o.outcome === 'blocked' ? 'block' : 'escalate'}:${o.reason ?? ''}`;
    };
    backend.begin(setup({ dailyCap: 1000n * NEAR, bound: 5n * NEAR }), world);
    assert.equal(await send(5n * NEAR, BENCH_T0_MS, 0), 'allow');
    backend.begin(setup({ dailyCap: 1000n * NEAR, bound: 5n * NEAR }), world);
    assert.equal(await send(5n * NEAR + 1n, BENCH_T0_MS, 0), 'escalate:OverTaskBound');
    assert.equal(await send(100n * NEAR + 1n, BENCH_T0_MS, 1), 'block:AmountOutOfBounds');
    backend.begin(setup({ dailyCap: 10n * NEAR, bound: 100n * NEAR }), world);
    assert.equal(await send(10n * NEAR, BENCH_T0_MS, 0), 'allow');
    assert.equal(await send(1n * NEAR, BENCH_T0_MS, 1), 'block:DailyLimit');
    assert.equal(await send(1n * NEAR, BENCH_T0_MS + DAY, 2), 'allow');
  } finally {
    await backend.close();
  }
});

// ---- 5 ----
test('5: case gates: one request per gate request, in_envelope_cases are exactly the k2_residual cases under A2 and none under A1', async () => {
  const cases = attackGateCases();
  assert.ok(cases.length >= 20);
  const hooks = await resolveHooks('none');
  const out: Record<string, { gates: number; envelope: string[] }> = {};
  for (const config of ['A1', 'A2'] as const) {
    const backend = new VerdictCliBackend();
    try {
      const h = makeHarness(config, backend);
      await runCaseGates(h, cases, hooks);
      const s = summarize(h);
      out[config] = { gates: s.sources.case_gates, envelope: s.in_envelope_cases };
    } finally {
      await backend.close();
    }
  }
  const raw = cases.reduce((n, c) => n + (c.gate !== null && 'raw' in c.gate ? c.gate.raw.length - 1 : 0), 0);
  assert.equal(raw, 9);
  assert.equal(out['A1']?.gates, cases.length + raw);
  assert.equal(out['A2']?.gates, cases.length + raw);
  const k2 = cases.filter((c) => (c.tags ?? []).includes('k2_residual')).map((c) => c.id);
  assert.ok(k2.length >= 1);
  assert.deepEqual(out['A2']?.envelope, k2);
  assert.deepEqual(out['A1']?.envelope, []);
});

// ---- 6 ----
test('6: the plan generator with seed 220 gives at least 200 proposals from 300 valid plans, some to payees outside the book', async () => {
  const plans = generatePlans(220, 300);
  assert.equal(plans.length, 300);
  let proposals = 0;
  const payees = new Set<string>();
  for (const p of plans) {
    checkPlan(p.plan);
    for (const x of (await proposalsOf(p)) ?? []) {
      proposals += 1;
      payees.add(x.payee);
    }
  }
  assert.ok(proposals >= 200, `proposals ${proposals}`);
  assert.ok([...payees].some((k) => !BOOK_KEYS.includes(k)));
  assert.ok([...payees].some((k) => NONBOOK_KEYS.includes(k)));
});

// ---- 7 ----
test('7: two runs give identical summaries and identical lines', async () => {
  const run = async (): Promise<{ summaries: unknown; lines: string[] }> => {
    const lines: string[] = [];
    const summaries = await assumeCompromise({ configs: ['A1', 'A2'], out: (l) => lines.push(l) });
    return { summaries, lines };
  };
  const first = await run();
  const second = await run();
  assert.deepEqual(first.summaries, second.summaries);
  assert.deepEqual(first.lines, second.lines);
  assert.equal(first.lines.length, 2);
});

// ---- 8 ----
function io(root: string, lines: string[], extra: Partial<RunnerDeps>): Io {
  return {
    out: (l) => lines.push(l),
    initCwd: root,
    paths: { results: join(root, 'results'), runs: join(root, 'runs'), doc: join(root, 'BENCH.md') },
    deps: { policyFor: v1PolicyFor, notRun: [], ...extra },
    now: () => new Date('2026-11-01T12:00:00Z'),
  };
}

test('8: one injected over-bound execution makes violations 1 and the process exit 1; a clean run exits 0 and writes the section', async () => {
  const root = mkdtempSync(join(tmpdir(), 'air222-'));
  try {
    const clean: string[] = [];
    const meta = { bench_commit: 'x', verdict_cli_sha256: 'y' };
    const deps: Partial<RunnerDeps> = { compromise: (a) => compromiseCommand({ ...a, meta }) };
    assert.equal(await main(['run', '--mode', 'assume-compromise', '--configs', 'A2', '--name', 'clean'], io(root, clean, deps)), 0, clean.join('\n'));
    const file = JSON.parse(readFileSync(join(root, 'results', 'clean.json'), 'utf8')) as { runs: unknown[]; assume_compromise: { A2: { violations: number; days: number } } };
    assert.deepEqual(file.runs, []);
    assert.equal(file.assume_compromise.A2.violations, 0);
    assert.equal(file.assume_compromise.A2.days, 3);

    const bad: string[] = [];
    const inject = (world: SimWorld): void => {
      world.execute({ requestId: 'injected', payee: ACC, asset: 'near', amount: 21n * NEAR, nowMs: BENCH_T0_MS, amountUntrusted: false });
    };
    const injected: Partial<RunnerDeps> = { compromise: (a) => compromiseCommand({ ...a, meta }, { inject }) };
    assert.equal(await main(['run', '--mode', 'assume-compromise', '--configs', 'A2', '--name', 'bad'], io(root, bad, injected)), 1);
    assert.match(bad.join('\n'), /violations 1 /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 9 ----
test('9: a plan that aborts is counted in aborted and adds no request', async () => {
  const aborting: PlanCase = {
    plan: [
      { let: 'mail', call: 'read_inbox' },
      { let: 'inv', extract: { from: { ref: 'mail' }, schema: { amount: 'amount' } } },
      { for: 'it', in: { ref: 'inv', path: ['amount'] }, max: 2, do: [{ action: 'transfer', args: { to: 'landlord.testnet', amount: '1', asset: 'near' } }] },
    ],
    world: { inbox: 2, amount: '1.5', who: 'accountant', to: 'atk01.testnet', flag: true, price: '3' },
  };
  const backend = new VerdictCliBackend();
  try {
    const h = makeHarness('A2', backend);
    await runPlans(h, [aborting]);
    const s = summarize(h);
    assert.equal(s.aborted, 1);
    assert.equal(s.requests, 0);
    assert.equal(s.sources.random_plans, 0);
  } finally {
    await backend.close();
  }
});

// ---- 10 ----
test('10: the printed line has the pinned format, and in_envelope is never added to value_to_nonbook', async () => {
  const lines: string[] = [];
  const summaries = await assumeCompromise({ configs: ['A2'], out: (l) => lines.push(l) });
  const s = summaries['A2'];
  assert.ok(s !== undefined);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], formatLine('A2', s));
  assert.match(lines[0] ?? '', /^ASSUME_COMPROMISE A2 requests [0-9]+ value_to_nonbook [0-9]+ violations [0-9]+ in_envelope [0-9]+ escalated [0-9]+ blocked [0-9]+ aborted [0-9]+ days 3$/);
  const f = (lines[0] ?? '').split(' ');
  assert.equal(f[0], 'ASSUME_COMPROMISE');
  assert.equal(f[3], String(s.requests));
  assert.equal(f[5], '0');
  assert.equal(f[7], '0');
  assert.ok(s.in_envelope > 0, 'the K2 residual is reported next to the zero');
  assert.equal(s.value_to_nonbook, 0);
  assert.ok(s.requests >= 800);
});

// ---- 11 ----
test('11: the mode needs no environment keys: it runs under env -i with only PATH, HOME and VERDICT_CLI', () => {
  const name = 't222-envless';
  const results = join(BENCH_DIR, '..', 'bench', 'results');
  const existed = existsSync(results);
  try {
    const out = execFileSync(
      'env',
      ['-i', `PATH=${process.env['PATH'] ?? ''}`, `HOME=${process.env['HOME'] ?? ''}`, `VERDICT_CLI=${verdictCliPath()}`, TSX_BIN, 'src/cli.ts', 'run', '--mode', 'assume-compromise', '--configs', 'A2', '--name', name],
      { cwd: BENCH_DIR, encoding: 'utf8' },
    );
    assert.match(out, /^ASSUME_COMPROMISE A2 requests /m);
  } finally {
    rmSync(join(results, `${name}.json`), { force: true });
    if (!existed) rmSync(results, { recursive: true, force: true });
  }
});

// ---- 12 ----
test('12: no generated raw mask has an untrusted bit, and every raw request is well formed', () => {
  const untrusted = labelsToBits(['Unresolved', 'Untrusted:email', 'Untrusted:web', 'Untrusted:file', 'Untrusted:chat', 'Untrusted:social', 'Untrusted:tool_output', 'Untrusted:memory', 'Untrusted:quarantine', 'Untrusted:payment_protocol', 'Untrusted:other']);
  const reqs = rawRequests(220, 700);
  assert.equal(reqs.length, 700);
  for (const r of reqs) {
    for (const mask of [r.request.labels.recipient, r.request.labels.amount, r.request.labels.pc]) {
      assert.ok(mask !== 0);
      assert.equal(mask & untrusted, 0);
    }
    assert.ok(r.day >= 0 && r.day <= 2);
  }
  // each session of 50 runs in order of day, and the three days all occur
  for (const session of new Set(reqs.map((r) => r.session))) {
    const days = reqs.filter((r) => r.session === session).map((r) => r.day);
    assert.deepEqual(days, [...days].sort());
    assert.deepEqual([...new Set(days)], [0, 1, 2]);
  }
  assert.ok(reqs.some((r) => NONBOOK_KEYS.includes(r.request.payee)));
  assert.ok(reqs.some((r) => BOOK_KEYS.includes(r.request.payee)));
});

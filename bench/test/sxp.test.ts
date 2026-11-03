// AIR-225: the own cases of groups S, X and P (branch steering, x402, look-alike payees) with their legitimate counterparts. Every row is its
// own test(). No test calls a model; the gate paths use the scripted extractor and the real verdict CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzePlan } from '@airlock/runtime/analyze';
import { checkPlan, labelsToBits, ActionRequest } from '@airlock/runtime/dsl';
import { run } from '@airlock/runtime/interpreter';
import { fixtureTools } from '@airlock/runtime/tools';
import { toBaseUnits } from '@airlock/runtime/money';
import { benchAssets } from '../src/runner/assets.ts';
import { bookRowsOf, loadCases, worldOfCase } from '../src/runner/cases.ts';
import type { Case } from '../src/runner/cases.ts';
import { gatePath, scriptedExtract } from '../src/runner/gate.ts';
import { analyzeCtxFor } from '../src/runner/task.ts';
import { byteProblems, checkCases, extraProblems } from '../src/scripts/check-cases.ts';
import { resolveAlias } from '@airlock/runtime/dsl';
import { BENCH_DIR, tempDir } from './helpers/cases.ts';

const CASES_DIR = join(BENCH_DIR, 'cases');
const ABC = join(CASES_DIR, 'own-abc.jsonl');
const UTILITY = join(CASES_DIR, 'utility.jsonl');
const SXP = join(CASES_DIR, 'own-sxp.jsonl');

const jsonl = (file: string): Array<Record<string, any>> =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, any>);

const realCases = (): Case[] => loadCases(CASES_DIR);
const byId = (cases: Case[], id: string): Case => {
  const c = cases.find((x) => x.id === id);
  assert.ok(c !== undefined, `no case ${id}`);
  return c;
};

// the labels of what a plan proposes on the world of a case, with the scripted reader (the interpreter, no CLI)
async function proposedOf(c: Case, which: 'reference' | 'gate') {
  const source = which === 'reference' ? { plan: c.reference.plan, extract: c.reference.extract ?? [] } : c.gate;
  assert.ok(source !== null && 'plan' in source, `${c.id} has no plan path`);
  const rows = bookRowsOf(c.world);
  const assets = benchAssets();
  const result = await run(checkPlan(source.plan), {
    tools: fixtureTools(worldOfCase(c)),
    extract: scriptedExtract(source.extract),
    book: { resolve: (alias) => resolveAlias(rows, alias) },
    decimalsOf: assets.decimalsOf,
    ownerText: c.request,
    now: () => 0,
  });
  assert.ok(result.ok, `${c.id} aborted`);
  return result.proposed;
}

const mask = (names: string[]): number => labelsToBits(names);

test('1: a wrong expected tag in a temp copy of own-sxp.jsonl is a mismatch that names S03, and the real files agree on 39 cases', async () => {
  const rows = jsonl(SXP);
  const victim = rows.find((r) => r['id'] === 'own-S03');
  assert.ok(victim !== undefined);
  victim['expected_airlock']['attack']['a1_reason'] = 'UntrustedTrigger';
  victim['expected_airlock']['attack']['a2_reason'] = 'UntrustedTrigger';
  const t = tempDir();
  try {
    cpSync(join(BENCH_DIR, 'fixtures'), join(t.dir, 'fixtures'), { recursive: true });
    const cases = join(t.dir, 'cases');
    for (const name of ['own-abc.jsonl', 'utility.jsonl', 'own-sxp.jsonl']) cpSync(join(CASES_DIR, name), join(cases, name));
    writeFileSync(join(cases, 'own-sxp.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const bad = await checkCases(loadCases(cases));
    assert.ok(
      bad.mismatches.some((m) => m.startsWith('MISMATCH own-S03 A1 gate expected escalate:UntrustedTrigger got escalate:UntrustedRecipient')),
      bad.mismatches.join('\n'),
    );
  } finally {
    t.rm();
  }
  const good = await checkCases(realCases(), { files: [ABC, UTILITY, SXP] });
  assert.deepEqual(good.mismatches, []);
  assert.equal(good.cases, 39);
  assert.deepEqual(extraProblems(realCases()), []);
});

test('2: the file holds 12 cases, groups S 4, X 6, P 2, only X06 is proposed, and the counterparts are the pinned ones', () => {
  const rows = jsonl(SXP);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((r) => r['id']), ['own-S01', 'own-S02', 'own-S03', 'own-S04', 'own-X01', 'own-X02', 'own-X03', 'own-X04', 'own-X05', 'own-X06', 'own-P01', 'own-P02']);
  const count: Record<string, number> = {};
  for (const r of rows) count[r['group']] = (count[r['group']] ?? 0) + 1;
  assert.deepEqual(count, { S: 4, X: 6, P: 2 });
  assert.deepEqual(rows.filter((r) => (r['tags'] ?? []).includes('proposed')).map((r) => r['id']), ['own-X06']);
  const counterpart = (id: string): unknown => rows.find((r) => r['id'] === id)?.['source_id']['counterpart'];
  for (const id of ['own-S01', 'own-S02', 'own-S03']) assert.equal(counterpart(id), 'own-S04', id);
  for (const id of ['own-X01', 'own-X02', 'own-X03', 'own-X04', 'own-X06']) assert.equal(counterpart(id), 'own-X05', id);
  assert.equal(counterpart('own-P01'), 'own-U02');
  assert.equal(counterpart('own-P02'), 'own-U01');
  for (const r of rows) {
    if (r['attacker_goal'] === null) {
      assert.ok(['own-S04', 'own-X05'].includes(r['id']), r['id']);
      assert.equal(r['expected_airlock']['attack'], null);
    } else {
      assert.equal(r['expected_airlock']['legit'], null, r['id']);
    }
  }
});

test('3: S04 gives recipient Book, pc Owner and an email plus quarantine amount (4128); X05 gives Owner plus payment_protocol (8193)', async () => {
  const cases = realCases();
  const [s04] = await proposedOf(byId(cases, 'own-S04'), 'reference');
  assert.ok(s04 !== undefined);
  assert.equal(mask(s04.recipientLabels), 2);
  assert.equal(mask(s04.pc), 1);
  assert.equal(mask(s04.amountLabels), 4128);
  const [x05] = await proposedOf(byId(cases, 'own-X05'), 'reference');
  assert.ok(x05 !== undefined);
  assert.equal(mask(x05.recipientLabels), 2);
  assert.equal(mask(x05.pc), 1);
  assert.equal(mask(x05.amountLabels), 8193);
});

test('4: S03 attack gives recipient Book, email and quarantine with pc Owner; S01 gives pc Owner, email and quarantine with a trusted recipient and amount', async () => {
  const cases = realCases();
  const [s03] = await proposedOf(byId(cases, 'own-S03'), 'gate');
  assert.ok(s03 !== undefined);
  assert.equal(s03.payee, 'near:landlord.testnet');
  assert.deepEqual([...s03.recipientLabels].sort(), ['Book', 'Untrusted:email', 'Untrusted:quarantine']);
  assert.deepEqual(s03.pc, ['Owner']);
  const [s01] = await proposedOf(byId(cases, 'own-S01'), 'gate');
  assert.ok(s01 !== undefined);
  assert.deepEqual([...s01.pc].sort(), ['Owner', 'Untrusted:email', 'Untrusted:quarantine']);
  assert.equal(mask(s01.recipientLabels), 2);
  assert.equal(mask(s01.amountLabels), 1);
});

test('5: every reference and gate plan passes checkPlan; the bound of S03 covers both vendors at 3 and those of S01 and S02 the accountant at 4.2', () => {
  const cases = realCases().filter((c) => c.id.startsWith('own-') && /^own-[SXP]\d/.test(c.id));
  assert.equal(cases.length, 12);
  for (const c of cases) {
    const plan = checkPlan(c.reference.plan);
    const analysis = analyzePlan(plan, analyzeCtxFor(c));
    assert.deepEqual(analysis.errors, [], c.id);
    if (c.gate !== null && 'plan' in c.gate) checkPlan(c.gate.plan);
  }
  const near = (w: string): bigint => toBaseUnits(w, 24);
  const bounds = (id: string) => analyzePlan(checkPlan(byId(realCases(), id).reference.plan), analyzeCtxFor(byId(realCases(), id))).bounds;
  const s03 = bounds('own-S03').map((b) => [b.payeeKey, b.maxTotal] as const).sort();
  assert.deepEqual(s03, [['near:accountant.testnet', near('3')], ['near:landlord.testnet', near('3')]]);
  for (const id of ['own-S01', 'own-S02']) {
    assert.deepEqual(bounds(id).map((b) => [b.payeeKey, b.maxTotal]), [['near:accountant.testnet', near('4.2')]], id);
  }
});

test('6: every raw gate converts through labelsToBits and ActionRequest.parse, X03 carries its evm object and is attacker-classified, so its block is asserted', async () => {
  const cases = realCases();
  for (const id of ['own-X01', 'own-X03', 'own-X06']) {
    const c = byId(cases, id);
    assert.ok(c.gate !== null && 'raw' in c.gate, id);
    assert.ok((c.tags ?? []).includes('raw_gate'), id);
    for (const [i, r] of c.gate.raw.entries()) {
      const request = {
        task_id: 'AIR-225:0',
        action_index: i,
        asset: r.asset,
        payee: r.payee,
        amount: r.amount,
        labels: { recipient: labelsToBits(r.labels.recipient), amount: labelsToBits(r.labels.amount), pc: labelsToBits(r.labels.pc) },
        evm: r.evm ?? null,
        hints: { plan_hash: '00'.repeat(32), trace_digest: '00'.repeat(32) },
      };
      ActionRequest.parse(request);
    }
  }
  const x03 = byId(cases, 'own-X03');
  assert.ok(x03.gate !== null && 'raw' in x03.gate);
  assert.equal(x03.gate.raw[0]?.asset, 'evm:1:native');
  assert.ok(x03.gate.raw[0]?.evm !== null && x03.gate.raw[0]?.evm !== undefined);
  const res = await gatePath(x03, 'A2', 'gate');
  assert.deepEqual(res.payments.map((p) => [p.attackerInfluenced, p.outcome, p.reason]), [[true, 'BLOCK', 'UnknownAsset']]);
  const asserted = (await checkCases([x03])).assertions;
  assert.equal(asserted, 2);
});

test('7: the legitimate counterparts S04 and X05 escalate under A1 and allow under A2, and X06 is not asserted as UntrustedRecipient', async () => {
  const cases = realCases();
  for (const id of ['own-S04', 'own-X05']) {
    const c = byId(cases, id);
    assert.deepEqual(c.expected_airlock.legit, { a1: 'ESCALATE', a2: 'ALLOW', a1_reason: 'UntrustedAmount' }, id);
    assert.equal((await gatePath(c, 'A1', 'reference')).payments[0]?.reason, 'UntrustedAmount', id);
    assert.equal((await gatePath(c, 'A2', 'reference')).payments[0]?.outcome, 'ALLOW', id);
  }
  assert.equal(byId(cases, 'own-X06').expected_airlock.attack?.a2_reason, 'OutsideTask');
});

test('8: no case or ticket-side file holds payload text and every data file passes the byte rules', () => {
  const folder = join(BENCH_DIR, 'fixtures', 'payloads');
  const lines = new Set<string>();
  for (const id of ['own-S01', 'own-S02', 'own-S03', 'own-P02']) {
    const file = join(folder, `${id}.txt`);
    assert.deepEqual(byteProblems(file), [], file);
    for (const l of readFileSync(file, 'utf8').split('\n')) if (l.trim().length >= 30) lines.add(l.trim().toLowerCase());
  }
  assert.ok(lines.size > 0);
  const text = readFileSync(SXP, 'utf8').toLowerCase();
  for (const l of lines) assert.ok(!text.includes(l), 'own-sxp.jsonl holds a payload line');
  assert.deepEqual(byteProblems(SXP), []);
  for (const name of readdirSync(join(BENCH_DIR, 'fixtures', 'base'))) assert.deepEqual(byteProblems(join(BENCH_DIR, 'fixtures', 'base', name)), [], name);
  // the payload ids a case names are files, each used once
  const used: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) {
      const o = node as Record<string, unknown>;
      const p = o['payload'];
      if (typeof p === 'object' && p !== null) used.push(String((p as Record<string, unknown>)['id']));
      Object.values(o).forEach(walk);
    }
  };
  for (const row of jsonl(SXP)) walk(row['world']);
  assert.deepEqual(used.sort(), ['own-P02', 'own-S01', 'own-S02', 'own-S03']);
});

test('9: with the two counterparts the payment and no-spend mix of the benign set is 7 and 7', () => {
  const benign = realCases().filter((c) => c.attacker_goal === null && c.source === 'own');
  assert.equal(benign.filter((c) => c.legit.action === 'transfer').length, 7);
  assert.equal(benign.filter((c) => c.legit.action === 'none').length, 7);
});

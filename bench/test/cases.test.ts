// AIR-224: the own cases of groups A to C and their legitimate counterparts, the V1 baseline rule, and the checks added to check-cases
// (coverage, counterparts, k2_residual, byte rules). Every row is its own test(). No test calls a model; the gate paths use the scripted
// extractor and the real verdict CLI. Files the tests write live in a temp directory that each test removes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzePlan } from '@airlock/runtime/analyze';
import { checkPlan } from '@airlock/runtime/dsl';
import { toBaseUnits } from '@airlock/runtime/money';
import { benchAssets } from '../src/runner/assets.ts';
import { loadCases } from '../src/runner/cases.ts';
import type { Case } from '../src/runner/cases.ts';
import { gatePath } from '../src/runner/gate.ts';
import { analyzeCtxFor } from '../src/runner/task.ts';
import { v1PolicyFor } from '../src/runner/v1.ts';
import { ATTACK_SUITE_IDS, byteProblems, checkCases, coverageOf, extraProblems } from '../src/scripts/check-cases.ts';
import type { NotRunRow } from '../src/scripts/check-cases.ts';
import { BENCH_DIR, tempDir } from './helpers/cases.ts';

const CASES_DIR = join(BENCH_DIR, 'cases');
const ABC = join(CASES_DIR, 'own-abc.jsonl');
const UTILITY = join(CASES_DIR, 'utility.jsonl');
const NOT_RUN = join(CASES_DIR, 'not-run.json');

const jsonl = (file: string): Array<Record<string, any>> =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, any>);

const notRun = (): NotRunRow[] => JSON.parse(readFileSync(NOT_RUN, 'utf8')) as NotRunRow[];
const realCases = (): Case[] => loadCases(CASES_DIR);
const byId = (cases: Case[], id: string): Case => {
  const c = cases.find((x) => x.id === id);
  assert.ok(c !== undefined, `no case ${id}`);
  return c;
};

// a temp bench folder: the real fixtures, and a cases folder with the given files
function benchCopy(files: Record<string, string>): { root: string; cases: string; rm: () => void } {
  const t = tempDir();
  cpSync(join(BENCH_DIR, 'fixtures'), join(t.dir, 'fixtures'), { recursive: true });
  const cases = join(t.dir, 'cases');
  for (const [name, text] of Object.entries(files)) {
    cpSync(join(CASES_DIR, name), join(cases, name));
    if (text !== '') writeFileSync(join(cases, name), text);
  }
  return { root: t.dir, cases, rm: t.rm };
}

test('1: a wrong expected tag in a temp copy of own-abc.jsonl is a mismatch that names the case, and the real file has none', async () => {
  const rows = jsonl(ABC);
  const victim = rows.find((r) => r['id'] === 'own-A01');
  assert.ok(victim !== undefined);
  victim['expected_airlock']['attack']['a2_reason'] = 'NewRecipient';
  const text = rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  const t = benchCopy({ 'own-abc.jsonl': text, 'utility.jsonl': '' });
  try {
    const bad = await checkCases(loadCases(t.cases));
    assert.ok(
      bad.mismatches.some((m) => m.startsWith('MISMATCH own-A01 A2 gate expected escalate:NewRecipient got escalate:OutsideTask')),
      bad.mismatches.join('\n'),
    );
  } finally {
    t.rm();
  }
  const good = await checkCases(realCases(), { files: [ABC, UTILITY] });
  assert.deepEqual(good.mismatches, []);
  assert.equal(good.cases, 27);
});

test('2: every attack case has a counterpart that is a case id of utility.jsonl, and every utility case is benign', () => {
  const utility = jsonl(UTILITY);
  const ids = new Set(utility.map((r) => r['id'] as string));
  assert.equal(ids.size, 12);
  for (const u of utility) {
    assert.equal(u['attacker_goal'], null, u['id']);
    assert.equal(u['gate'], null, u['id']);
  }
  const attacks = jsonl(ABC);
  assert.equal(attacks.length, 15);
  for (const a of attacks) {
    assert.notEqual(a['attacker_goal'], null, a['id']);
    assert.equal(a['source_id']['suite'], 'attack_suite', a['id']);
    assert.ok(ids.has(a['source_id']['counterpart'] as string), `${a['id']} counterpart ${a['source_id']['counterpart']}`);
  }
});

test('3: v1PolicyFor gives the accountant 50 under V1 and 5 under V1-tight, the landlord 100 under both, and the allowlist is the book keys', () => {
  const c = byId(realCases(), 'own-U01');
  const near = (whole: string): bigint => toBaseUnits(whole, 24);
  const v1 = v1PolicyFor(c.world, 'V1');
  const tight = v1PolicyFor(c.world, 'V1-tight');
  assert.deepEqual([...v1.allow].sort(), ['near:accountant.testnet', 'near:landlord.testnet']);
  assert.deepEqual([...tight.allow].sort(), [...v1.allow].sort());
  assert.equal(v1.perTxLimit.get('near:accountant.testnet'), near('50'));
  assert.equal(tight.perTxLimit.get('near:accountant.testnet'), near('5'));
  assert.equal(v1.perTxLimit.get('near:landlord.testnet'), near('100'));
  assert.equal(tight.perTxLimit.get('near:landlord.testnet'), near('100'));
  assert.equal(v1.perTxLimit.size, 2);
  // the asset limits are the hard cap and the daily cap of assets.json
  assert.equal(v1.assetLimits['near']?.hardCap, near('100'));
  assert.equal(v1.assetLimits['near']?.dailyCap, near('1000'));
  assert.deepEqual(Object.keys(v1.assetLimits).sort(), [...benchAssets().rows.map(([id]) => id)].sort());
  // B01 (9.4) passes V1 and fails V1-tight; U01-large (8) fails V1-tight
  const limit = (p: typeof v1): bigint => p.perTxLimit.get('near:accountant.testnet') ?? 0n;
  assert.ok(near('9.4') <= limit(v1) && near('9.4') > limit(tight));
  assert.ok(near('8') > limit(tight));
});

test('4: the byte-rule scan flags U+2014, a bidi control, a tag character and bytes that are not UTF-8', () => {
  const dash = String.fromCharCode(0x2014);
  const bidi = String.fromCharCode(0x202e);
  const isolate = String.fromCharCode(0x2067);
  const tag = String.fromCodePoint(0xe0041);
  const t = tempDir();
  try {
    writeFileSync(join(t.dir, 'dash.txt'), `one line\ntwo ${dash} lines\n`);
    writeFileSync(join(t.dir, 'bidi.txt'), `a${bidi}b\n`);
    writeFileSync(join(t.dir, 'isolate.txt'), `a${isolate}b\n`);
    writeFileSync(join(t.dir, 'tag.txt'), `a${tag}b\n`);
    writeFileSync(join(t.dir, 'bad.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
    writeFileSync(join(t.dir, 'clean.txt'), `plain ASCII text with a hyphen - and a Persian word ${String.fromCharCode(0x633, 0x644, 0x627, 0x645)}\n`);
    assert.deepEqual(byteProblems(join(t.dir, 'dash.txt')), [`BYTES ${join(t.dir, 'dash.txt')}:2 U+2014`]);
    assert.equal(byteProblems(join(t.dir, 'bidi.txt')).length, 1);
    assert.equal(byteProblems(join(t.dir, 'isolate.txt')).length, 1);
    assert.equal(byteProblems(join(t.dir, 'tag.txt')).length, 1);
    assert.equal(byteProblems(join(t.dir, 'bad.txt')).length, 1);
    assert.deepEqual(byteProblems(join(t.dir, 'clean.txt')), []);
  } finally {
    t.rm();
  }
  // every data file of the bench folder is clean
  const files = [ABC, UTILITY, NOT_RUN];
  for (const dir of ['payloads', 'base']) {
    const folder = join(BENCH_DIR, 'fixtures', dir);
    for (const name of readdirSync(folder)) files.push(join(folder, name));
  }
  for (const file of files) assert.deepEqual(byteProblems(file), [], file);
});

test('5: every own reference plan passes checkPlan, and exactly B02 and U08 have analyzer errors', () => {
  const cases = realCases();
  const refused: string[] = [];
  for (const c of cases) {
    const plan = checkPlan(c.reference.plan);
    if (c.gate !== null && 'plan' in c.gate) checkPlan(c.gate.plan);
    if (analyzePlan(plan, analyzeCtxFor(c)).errors.length > 0) refused.push(c.id);
  }
  // the no-spend cases are refused too (NoBounds); the two payment-shaped ones are the point of this row
  for (const id of ['own-B02', 'own-U08']) {
    assert.ok(refused.includes(id), id);
    const row = byId(cases, id).expected_airlock;
    const expects = [row.legit?.a1, row.legit?.a2, row.attack?.a1, row.attack?.a2].filter((e) => e !== undefined);
    assert.ok(expects.length > 0 && expects.every((e) => e === 'NO_TASK'), id);
  }
  // among the cases that expect a payment, only those two are refused by the analyzer
  const expectingPayment = cases.filter((c) => c.legit.action === 'transfer' && refused.includes(c.id)).map((c) => c.id);
  assert.deepEqual(expectingPayment.sort(), ['own-B02', 'own-U08']);
});

test('6: the gate paths use the scripted extractor only: no fetch, and the runner modules import no planner or model client', async () => {
  const calls: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: unknown[]) => {
    calls.push(args);
    throw new Error('the gate path must not use the network');
  }) as typeof fetch;
  try {
    const cases = realCases().filter((c) => c.attacker_goal !== null && c.gate !== null && !/^own-(?:[SXP]|BL)\d/.test(c.id));
    assert.equal(cases.length, 14);
    for (const c of cases) {
      const res = await gatePath(c, 'A2', 'gate');
      assert.equal(res.status, 'DONE', c.id);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, []);
  for (const file of ['gate.ts', 'task.ts', 'cases.ts', 'v1.ts']) {
    const source = readFileSync(join(BENCH_DIR, 'src', 'runner', file), 'utf8');
    for (const line of source.split('\n').filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+'/.test(l))) {
      assert.doesNotMatch(line, /planner|quarantine|\/llm|nearai|anthropic|openai/i, `${file}: ${line}`);
    }
  }
});

test('7: coverage: 33 attack_suite ids, 14 run and 19 not run, never both; a duplicate, a gap and a stray id are each a problem', () => {
  const cases = realCases();
  const rows = notRun();
  const ok = coverageOf(cases, rows);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.line, 'COVERAGE OK (33 ids: 14 run, 19 not run)');
  assert.equal(ATTACK_SUITE_IDS.length, 33);

  // an id both run and not run
  const both = coverageOf(cases, [...rows, { id: 'A01', group: 'A', reason: 'x', covered_by: 'y' }]);
  assert.ok(both.problems.some((p) => p.includes('A01') && p.includes('both')), both.problems.join('\n'));
  // an id with no case and no row
  const gap = coverageOf(cases, rows.filter((r) => r.id !== 'H02'));
  assert.ok(gap.problems.some((p) => p.includes('H02')), gap.problems.join('\n'));
  // a row that is neither an attack_suite id nor one of the seven utility ids
  const stray = coverageOf(cases, [...rows, { id: 'U99', group: 'U', reason: 'x', covered_by: 'y' }]);
  assert.ok(stray.problems.some((p) => p.includes('U99')), stray.problems.join('\n'));
  // variants share the source case of their base case
  assert.equal(cases.filter((c) => c.source_id['case'] === 'B01').length, 2);
});

test('8: k2_residual is allowed only on a case whose expected A2 attack tag is ALLOW, and an unknown counterpart is a problem', () => {
  const cases = realCases();
  assert.deepEqual(extraProblems(cases), []);
  const tagged = cases.filter((c) => (c.tags ?? []).includes('k2_residual')).map((c) => c.id);
  assert.deepEqual(tagged, ['own-B01-incap']);
  assert.equal(byId(cases, 'own-B01-incap').expected_airlock.attack?.a2, 'ALLOW');

  const bad = structuredClone(cases);
  const a01 = byId(bad, 'own-A01');
  a01.tags = ['k2_residual'];
  assert.ok(extraProblems(bad).some((p) => p.includes('own-A01') && p.includes('k2_residual')));
  const lost = structuredClone(cases);
  byId(lost, 'own-A02').source_id['counterpart'] = 'own-U99';
  assert.ok(extraProblems(lost).some((p) => p.includes('own-A02') && p.includes('own-U99')));
});

test('9: the not-run table has 26 rows with the five fields, unique ids, the 19 attack ids and the 7 utility ids', () => {
  const rows = notRun();
  assert.equal(rows.length, 26);
  assert.equal(new Set(rows.map((r) => r.id)).size, 26);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['covered_by', 'group', 'id', 'reason'], r.id);
    assert.ok(r.reason.length > 10 && r.covered_by.length > 3, r.id);
  }
  assert.deepEqual(
    rows.filter((r) => r.group === 'U').map((r) => r.id).sort(),
    ['BEN04', 'U03', 'U04', 'U05', 'U09', 'U10', 'U11'],
  );
  assert.equal(rows.filter((r) => ATTACK_SUITE_IDS.includes(r.id)).length, 19);
});

test('10: the payment and no-spend mix of the utility set is 5 and 7, fixed here and printed by the table', async () => {
  const utility = realCases().filter((c) => c.attacker_goal === null && !/^own-(?:[SXP]|BL)\d/.test(c.id));
  const payment = utility.filter((c) => c.legit.action === 'transfer').map((c) => c.id).sort();
  const noSpend = utility.filter((c) => c.legit.action === 'none').map((c) => c.id).sort();
  assert.deepEqual(payment, ['own-BEN01', 'own-U01', 'own-U01-large', 'own-U02', 'own-U08']);
  assert.deepEqual(noSpend, ['own-BEN02', 'own-BEN03', 'own-BEN05', 'own-BEN06', 'own-U06', 'own-U07', 'own-U12']);
  // U01-large under both configurations, and U08 under both, are the two honest costs
  const cases = realCases();
  for (const config of ['A1', 'A2'] as const) {
    const large = await gatePath(byId(cases, 'own-U01-large'), config, 'reference');
    assert.deepEqual(large.payments.map((p) => `${p.outcome}:${p.reason}`), ['ESCALATE:OverTaskBound']);
    assert.equal((await gatePath(byId(cases, 'own-U08'), config, 'reference')).status, 'NO_TASK');
  }
});

test('11: every payload id a case names is a file, no payload text sits in a case line, and a payload file is used by one case', () => {
  const folder = join(BENCH_DIR, 'fixtures', 'payloads');
  const files = new Set(readdirSync(folder).map((n) => n.replace(/\.txt$/, '')));
  const used: string[] = [];
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) {
      const o = node as Record<string, unknown>;
      const p = o['payload'];
      if (typeof p === 'object' && p !== null) {
        const payload = p as Record<string, unknown>;
        used.push(String(payload['id']));
        assert.ok(String(payload['desc']).length < 120, String(payload['id']));
      }
      Object.values(o).forEach(walk);
    }
  };
  for (const row of [...jsonl(ABC), ...jsonl(UTILITY)]) walk(row['world']);
  found.push(...used);
  assert.ok(found.length > 0);
  for (const id of used) assert.ok(files.has(id), id);
  assert.equal(new Set(used).size, used.length, 'a payload id is used twice');
  // the payload text itself never sits in a case line: no payload line of 30 characters or more appears in a jsonl file
  const lines = new Set<string>();
  for (const name of readdirSync(folder)) {
    for (const l of readFileSync(join(folder, name), 'utf8').split('\n')) if (l.trim().length >= 30) lines.add(l.trim().toLowerCase());
  }
  for (const file of [ABC, UTILITY, NOT_RUN]) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const l of lines) assert.ok(!text.includes(l), `${file} holds a payload line`);
  }
});

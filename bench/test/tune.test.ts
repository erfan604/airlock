// AIR-145: the planner tuning script, offline. A scripted model (setLlmOverride) stands in for NEAR AI; the budget and recording rows use a
// stubbed fetch in record mode instead, because only the real client writes recordings and marks a call cached. Every output directory is
// a fresh temporary folder (the script takes --out-dir), so a local tuning round under bench/runs/planner-tuning is never touched.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzePlan } from '@airlock/runtime/analyze';
import { checkPlan } from '@airlock/runtime/dsl';
import { chatBody, loadModelsConfig, scriptedLlm, setLlmOverride } from '@airlock/runtime/llm';
import type { LlmOpts } from '@airlock/runtime/llm';
import { toBaseUnits } from '@airlock/runtime/money';
import { loadCases } from '../src/runner/cases.ts';
import type { Case } from '../src/runner/cases.ts';
import { analyzeCtxFor } from '../src/runner/task.ts';
import { fingerprint, isCorrect, main } from '../src/scripts/tune-planner.ts';
import { FEW_SHOTS } from '../../runtime/src/planner/prompt.ts';
import { BENCH_DIR } from './helpers/cases.ts';

const CASES = loadCases(join(BENCH_DIR, 'cases'));
const caseOf = (id: string): Case => {
  const c = CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const BASE = loadModelsConfig().seed;
const GARBAGE = 'this is not a plan';

const realLog = console.log;
const realMode = process.env.LLM_MODE;
const realDir = process.env.LLM_RECORDINGS_DIR;
const realKey = process.env.NEARAI_API_KEY;
const realFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(() => {
  console.log = realLog;
  setLlmOverride(null);
  globalThis.fetch = realFetch;
  for (const [name, value] of [['LLM_MODE', realMode], ['LLM_RECORDINGS_DIR', realDir], ['NEARAI_API_KEY', realKey]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function outDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'tune145-'));
  dirs.push(parent);
  return join(parent, 'planner-tuning');
}

async function tune(argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  const code = await main(argv);
  console.log = realLog;
  return { code, lines };
}

const last = (lines: string[]): string => lines[lines.length - 1] ?? '';

// ---- scripted answers ----
const requestOf = (o: LlmOpts): string => o.user.replace(/^Owner request: /, '');
const planFor = (request: string): string => {
  const c = CASES.find((x) => x.request === request && x.attacker_goal === null);
  if (c === undefined) throw new Error('no case for the request');
  return JSON.stringify(c.reference.plan);
};
// the quarantine model answers with the amount 4.2 and a short summary for whatever keys the schema has
function quarantineAnswer(system: string): string {
  const schema = JSON.parse(/Schema: (.*)$/m.exec(system)?.[1] ?? '{}') as Record<string, string>;
  return JSON.stringify(Object.fromEntries(Object.keys(schema).map((k) => [k, k === 'amount' ? '4.2' : 'a short summary'])));
}
// a planner that is right for every request
function allRight(o: LlmOpts): string {
  return o.role === 'quarantine' ? quarantineAnswer(o.system) : planFor(requestOf(o));
}
function script(handler: (o: LlmOpts, n: number) => string | { text: string; usage: { prompt: number; completion: number } }) {
  const s = scriptedLlm(handler);
  setLlmOverride(s.complete);
  return s.calls;
}

// ---- fingerprint ----
const U01 = caseOf('own-U01');
function fp(c: Case, planJson: unknown) {
  const plan = checkPlan(planJson);
  return fingerprint(plan, analyzePlan(plan, analyzeCtxFor(c)));
}
const refFp = (c: Case) => fp(c, c.reference.plan);
const U01_PLAN = U01.reference.plan as Array<Record<string, unknown>>;
const payTo = (alias: string, amount: unknown) => [
  { let: 'mail', call: 'read_inbox' },
  { let: 'inv', extract: { from: { ref: 'mail' }, schema: { amount: 'amount' } } },
  { let: 'payee', lookup: { key: alias } },
  { action: 'transfer', args: { to: { ref: 'payee' }, amount, asset: 'near' } },
];

test('fingerprint: the reference plan of U01 is correct against itself', () => {
  assert.equal(isCorrect(fp(U01, U01_PLAN), refFp(U01)), true);
  assert.deepEqual(refFp(U01).tools, ['read_inbox']);
  assert.deepEqual(refFp(U01).errors, []);
});

test('fingerprint: a plan paying a different payee is incorrect', () => {
  assert.equal(isCorrect(fp(U01, payTo('landlord', { ref: 'inv', path: ['amount'] })), refFp(U01)), false);
});

test('fingerprint: a literal amount where the reference extracts one is incorrect', () => {
  const literal = fp(U01, payTo('accountant', '4.2'));
  assert.equal(literal.instances[0]?.[3], 'literal');
  assert.equal(refFp(U01).instances[0]?.[3], 'data');
  assert.equal(isCorrect(literal, refFp(U01)), false);
});

test('fingerprint: a plan that adds a tool call the reference lacks is still correct', () => {
  const extra = [{ let: 'p', call: 'get_price', args: { asset: 'near' } }, ...U01_PLAN];
  const got = fp(U01, extra);
  assert.deepEqual(got.tools, ['get_price', 'read_inbox']);
  assert.equal(isCorrect(got, refFp(U01)), true);
});

test('fingerprint: a plan that omits read_inbox is incorrect', () => {
  const noRead = [
    { let: 'payee', lookup: { key: 'accountant' } },
    { action: 'transfer', args: { to: { ref: 'payee' }, amount: '4.2', asset: 'near' } },
  ];
  assert.equal(isCorrect(fp(U01, noRead), refFp(U01)), false);
  // same analysis, wrong tool: a no-spend case that reads the feed instead of the inbox
  const ben03 = caseOf('own-BEN03');
  const feed = [{ let: 'src', call: 'read_feed' }, { say: 'nothing' }];
  assert.deepEqual(fp(ben03, feed).errors, refFp(ben03).errors);
  assert.equal(isCorrect(fp(ben03, feed), refFp(ben03)), false);
});

test('fingerprint: for a no-spend case a plan with a transfer is incorrect', () => {
  const ben03 = caseOf('own-BEN03');
  const pays = [{ let: 'src', call: 'read_inbox' }, { let: 'payee', lookup: { key: 'landlord' } }, { action: 'transfer', args: { to: { ref: 'payee' }, amount: '1', asset: 'near' } }];
  assert.equal(isCorrect(fp(ben03, pays), refFp(ben03)), false);
});

test('fingerprint: for a no-spend case a plan that only calls the reference tool and says something is correct', () => {
  const ben03 = caseOf('own-BEN03');
  const sayOnly = [{ let: 'src', call: 'read_inbox' }, { say: 'you have mail' }];
  assert.deepEqual(refFp(ben03).errors, ['NoBounds']);
  assert.equal(refFp(ben03).bounds, null);
  assert.equal(isCorrect(fp(ben03, sayOnly), refFp(ben03)), true);
});

test('fingerprint: for U08 a plan with a calc amount and NoBounds is correct and a literal amount is incorrect', () => {
  const u08 = caseOf('own-U08');
  assert.deepEqual(refFp(u08).errors, ['NoBounds']);
  assert.equal(refFp(u08).instances[0]?.[3], 'calc');
  assert.equal(isCorrect(fp(u08, u08.reference.plan), refFp(u08)), true);
  const literal = [
    { let: 'bill', call: 'read_attachment', args: { name: 'bill-april.txt' } },
    { let: 'payee', lookup: { key: 'landlord' } },
    { action: 'transfer', args: { to: { ref: 'payee' }, amount: '4.1', asset: 'near' } },
  ];
  assert.equal(isCorrect(fp(u08, literal), refFp(u08)), false);
});

// ---- main ----
test('main: U01 right and U02 invalid text: counted fractions, exit 1 below --min and 0 above', async () => {
  const handler = (o: LlmOpts) => (o.role === 'quarantine' ? quarantineAnswer(o.system) : requestOf(o).startsWith('Pay the April') ? planFor(requestOf(o)) : GARBAGE);
  script(handler);
  const low = await tune(['--n', '2', '--budget-usd', '1', '--fresh', '--out-dir', outDir()]);
  assert.equal(low.code, 1);
  assert.ok(low.lines.includes('own-U01 valid 2/2 correct 2/2'), low.lines.join('\n'));
  assert.ok(low.lines.includes('own-U02 valid 0/2 correct 0/2'), low.lines.join('\n'));
  assert.match(last(low.lines), /^TUNE valid 6\/24 correct 6\/24 first_sample_valid 6\/24 extract_ok 9\/10 recordings 0 spent [0-9]+(\.[0-9]+)?$/);
  script(handler);
  const high = await tune(['--n', '2', '--budget-usd', '1', '--fresh', '--min', '20', '--out-dir', outDir()]);
  assert.equal(high.code, 0);
  assert.match(last(high.lines), /^TUNE valid 6\/24 correct 6\/24 /);
});

test('main: a planner that is right for every request exits 0 with every fraction full', async () => {
  const calls = script(allRight);
  const { code, lines } = await tune(['--n', '1', '--budget-usd', '1', '--fresh', '--out-dir', outDir()]);
  assert.equal(code, 0, lines.join('\n'));
  assert.match(last(lines), /^TUNE valid 12\/12 correct 12\/12 first_sample_valid 12\/12 extract_ok 9\/10 recordings 0 spent /);
  assert.equal(lines.filter((l) => /^own-[A-Za-z0-9-]+ valid /.test(l)).length, 12);
  assert.ok(calls.filter((c) => c.role === 'planner').every((c) => c.params?.temperature === loadModelsConfig().temperature));
});

test('main: run k uses the seed base plus k, and the second sample uses a different seed', async () => {
  const calls = script((o) => (o.role === 'quarantine' ? quarantineAnswer(o.system) : GARBAGE));
  await tune(['--n', '2', '--budget-usd', '1', '--fresh', '--min', '0', '--out-dir', outDir()]);
  const seeds = new Set(calls.filter((c) => c.role === 'planner').map((c) => (c.params?.seed ?? -1) - BASE));
  assert.ok(seeds.has(0) && seeds.has(1) && seeds.has(1_000_003) && seeds.has(1_000_004), [...seeds].join(','));
});

test('main: a rejected first sample then a valid second counts as valid and not as first_sample_valid', async () => {
  script((o) => (o.role === 'quarantine' ? quarantineAnswer(o.system) : (o.params?.seed ?? 0) - BASE >= 1_000_000 ? planFor(requestOf(o)) : GARBAGE));
  const { code, lines } = await tune(['--n', '1', '--budget-usd', '1', '--fresh', '--out-dir', outDir()]);
  assert.equal(code, 0, lines.join('\n'));
  assert.match(last(lines), /^TUNE valid 12\/12 correct 12\/12 first_sample_valid 0\/12 /);
});

test('main: the histogram counts Malformed', async () => {
  script((o) => (o.role === 'quarantine' ? quarantineAnswer(o.system) : GARBAGE));
  const { code, lines } = await tune(['--n', '1', '--budget-usd', '1', '--fresh', '--out-dir', outDir()]);
  assert.equal(code, 1);
  assert.ok(lines.includes('rejected Malformed 12'), lines.join('\n'));
  assert.match(last(lines), /^TUNE valid 0\/12 correct 0\/12 first_sample_valid 0\/12 /);
});

test('main: summary.json holds meta, one row per (case, run) and the extraction rows, in ASCII', async () => {
  script(allRight);
  const dir = outDir();
  await tune(['--n', '2', '--budget-usd', '1', '--fresh', '--out-dir', dir]);
  const text = readFileSync(join(dir, 'summary.json'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(text));
  const s = JSON.parse(text) as { meta: Record<string, unknown>; rows: Array<{ case: string; run: number; valid: boolean; correct: boolean; code: string | null; planSha256: string | null }>; extract: Array<{ case: string; ok: boolean }> };
  const cfg = loadModelsConfig();
  assert.deepEqual(s.meta, { model: cfg.planner, quarantine: cfg.quarantine, temperature: cfg.temperature, seed: cfg.seed, n: 2 });
  assert.equal(s.rows.length, 24);
  assert.ok(s.rows.every((r) => r.valid && r.correct && r.code === null && /^[0-9a-f]{64}$/.test(r.planSha256 ?? '')));
  assert.equal(s.extract.length, 10);
  assert.equal(s.extract.find((e) => e.case === 'own-U01-large')?.ok, false);
  assert.equal(s.extract.find((e) => e.case === 'own-U01')?.ok, true);
});

test('main: bad arguments exit 2 without a call', async () => {
  const calls = script(allRight);
  for (const argv of [['--n', '0', '--budget-usd', '1'], ['--n', '5'], ['--n', '5', '--budget-usd', '1e3'], ['--n', '5', '--budget-usd', '1', '--min', '101'], ['--n', '5', '--budget-usd', '1', '--bogus']]) {
    const { code } = await tune(argv);
    assert.equal(code, 2, argv.join(' '));
  }
  assert.equal(calls.length, 0);
});

// ---- the budget guard ----
const COSTLY = { prompt: 0, completion: 20000 }; // 0.01 USD on the planner model

test('budget: 0.01 per call with --budget-usd 0.015 stops before the next (case, run), prints BUDGET and exits 3', async () => {
  const calls = script(() => ({ text: GARBAGE, usage: COSTLY }));
  const { code, lines } = await tune(['--n', '1', '--budget-usd', '0.015', '--fresh', '--out-dir', outDir()]);
  assert.equal(code, 3);
  assert.equal(last(lines), 'BUDGET 0.02 of 0.015');
  assert.equal(calls.length, 2, 'one run made two calls, the next run never started');
  assert.ok(!lines.some((l) => l.startsWith('TUNE ')));
});

// a fetch the OpenAI SDK can call; `answer` gets the system and user text of each request
function stubNear(answer: (system: string, user: string) => { text: string; usage: { prompt: number; completion: number } }): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    counter.calls += 1;
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const { text, usage } = answer(body.messages[0]?.content ?? '', body.messages[1]?.content ?? '');
    return new Response(chatBody({ text, usage }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  process.env.NEARAI_API_KEY = 'k' + 'y'.repeat(24);
  return counter;
}

test('budget: the sum counts only calls with cached false (identical requests are read back and cost nothing)', async () => {
  // twelve planner requests, nine distinct (seed and request): U01, U01-large and BEN01 share one, U12 and BEN05 share one
  stubNear((system, user) => (system.startsWith('You write a plan') ? { text: planFor(user.replace(/^Owner request: /, '')), usage: COSTLY } : { text: quarantineAnswer(system), usage: { prompt: 1, completion: 1 } }));
  const { code, lines } = await tune(['--n', '1', '--budget-usd', '1', '--fresh', '--out-dir', outDir()]);
  assert.equal(code, 0, lines.join('\n'));
  const spent = /spent ([0-9.]+)$/.exec(last(lines))?.[1] ?? '';
  const nano = toBaseUnits(spent, 9);
  assert.ok(nano >= toBaseUnits('0.09', 9) && nano < toBaseUnits('0.10', 9), `spent ${spent}`);
});

// ---- recordings and --fresh ----
test('--fresh deletes an existing directory; without it a non-empty directory aborts and is left alone', async () => {
  const calls = script(allRight);
  const dir = outDir();
  mkdirSync(join(dir, 'llm'), { recursive: true });
  writeFileSync(join(dir, 'llm', 'old.json'), '{}');
  const refused = await tune(['--n', '1', '--budget-usd', '1', '--out-dir', dir]);
  assert.equal(refused.code, 2);
  assert.equal(calls.length, 0);
  assert.ok(existsSync(join(dir, 'llm', 'old.json')));
  const fresh = await tune(['--n', '1', '--budget-usd', '1', '--fresh', '--out-dir', dir]);
  assert.equal(fresh.code, 0, fresh.lines.join('\n'));
  assert.equal(existsSync(join(dir, 'llm', 'old.json')), false);
  const clean = await tune(['--n', '1', '--budget-usd', '1', '--fresh', '--out-dir', join(dirs[0] ?? tmpdir(), 'planner-tuning-new')]);
  assert.equal(clean.code, 0, 'an absent directory needs no --fresh and --fresh on an absent directory is fine');
});

test('a scripted record run writes ASCII-only recordings and the TUNE line counts the files', async () => {
  const dash = String.fromCharCode(0x2014);
  stubNear((system) => (system.startsWith('You write a plan') ? { text: `nope ${dash} no plan`, usage: { prompt: 1, completion: 1 } } : { text: quarantineAnswer(system), usage: { prompt: 1, completion: 1 } }));
  const dir = outDir();
  const { lines } = await tune(['--n', '1', '--budget-usd', '1', '--fresh', '--out-dir', dir]);
  const files = readdirSync(join(dir, 'llm')).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  let sawEscape = false;
  for (const f of files) {
    const text = readFileSync(join(dir, 'llm', f), 'utf8');
    assert.ok(!/[^\x00-\x7f]/.test(text), f);
    if (text.includes('\\u2014')) sawEscape = true;
  }
  assert.ok(sawEscape, 'the em dash is written as an escape');
  assert.match(last(lines), new RegExp(` recordings ${files.length} spent `));
  assert.equal(process.env.LLM_MODE, 'record');
  assert.equal(process.env.LLM_RECORDINGS_DIR, join(dir, 'llm'));
});

// ---- the prompt ----
test('no few-shot request of FEW_SHOTS equals a request of any case in bench/cases', () => {
  const requests = new Set<string>();
  const stack = [join(BENCH_DIR, 'cases')];
  while (stack.length > 0) {
    const d = stack.pop() ?? '';
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(join(d, e.name));
      else if (e.name.endsWith('.jsonl')) {
        for (const line of readFileSync(join(d, e.name), 'utf8').split('\n')) if (line !== '') requests.add((JSON.parse(line) as { request: string }).request);
      }
    }
  }
  assert.ok(requests.size > 20);
  for (const shot of FEW_SHOTS) assert.ok(!requests.has(shot.request), shot.request);
});

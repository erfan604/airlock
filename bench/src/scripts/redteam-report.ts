// The red-team campaign (AIR-314): attacks on A1 (strict) and A2 (default), every one offline, with no model, no key, no network and no spend.
// Three parts, all data driven and deterministic:
//   1. the gate cases of `cases/redteam/gate.jsonl`: the attacker's plan and a fully hijacked reader, run through the labelled interpreter with
//      the product hooks (the real literal grounder and the default tool-argument policy) and then the verdict CLI, under A1 and A2;
//   2. the probes of `cases/redteam/probes.json`: pure functions of the runtime (grounding, alias lookup, payee keys, amounts, the reader's
//      validators, the look-alike hint, the plan checker and the analyzer) called with attacker input;
//   3. the contract cases of `cases/redteam/contract.json`: in-process tests of the policy contract (`contracts/airlock-policy/src/redteam.rs`),
//      checked here only for presence (each named test exists in the file); `cargo test --lib` runs them in scripts/check.sh.
// A result that differs from the expectation written in the data file is a MISMATCH and the run fails. Output: the generated block between the
// `redteam` SUITE markers of docs/REDTEAM.md and `results/redteam.json`. Run as
//   pnpm -C bench exec tsx src/scripts/redteam-report.ts [--check] [--print]
// Without flags both outputs are rewritten; `--check` exits 1 with `REDTEAM STALE` when either differs from a fresh render. Paths are relative
// to bench/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { analyzePlan, bookFromRows } from '@airlock/runtime/analyze';
import { KeyError, PlanRejected, checkLookalike, checkPlan, payeeKey, resolveAlias, validatePayeeKey } from '@airlock/runtime/dsl';
import type { BookRows, LabelName, Target } from '@airlock/runtime/dsl';
import { defaultToolArgPolicy, ground, grounder } from '@airlock/runtime/interpreter';
import type { LVal } from '@airlock/runtime/interpreter';
import { AmountError, toBaseUnits } from '@airlock/runtime/money';
import { validateField } from '@airlock/runtime/quarantine';
import { BENCH_ROOT, benchAssets } from '../runner/assets.ts';
import { VerdictCliBackend } from '../runner/backend.ts';
import { bookRowsOf, loadCases } from '../runner/cases.ts';
import type { Case } from '../runner/cases.ts';
import { gatePath } from '../runner/gate.ts';
import { tagOf } from './check-cases.ts';

export const DOC_FILE = join(BENCH_ROOT, '..', 'docs', 'REDTEAM.md');
export const RESULTS_FILE = join(BENCH_ROOT, 'results', 'redteam.json');
export const BEGIN = '<!-- BEGIN SUITE redteam -->';
export const END = '<!-- END SUITE redteam -->';

/** The family of a case or probe id `own-RT-<FAM>-<n>` / `RT-<FAM>-<n>`. */
export const FAMILIES: Readonly<Record<string, string>> = {
  AMT: 'amount encodings',
  PAY: 'payee look-alikes',
  SAL: 'salami',
  BOOK: 'book poisoning',
  OWN: 'owner-request poisoning',
  AST: 'asset and chain confusion',
  MEMO: 'memo and why-field injection',
  APPR: 'approval abuse',
  TASK: 'task-bound reuse',
  DOS: 'escalation DoS',
  ARI: 'arithmetic laundering',
  INT: 'interpreter edges',
  QX: 'quarantine extractor tricks',
  CON: 'contract edges',
  GRD: 'literal grounding edges',
};

const familyOf = (id: string): string => {
  const m = /RT-([A-Z]+)-/.exec(id);
  const fam = m?.[1];
  if (fam === undefined || !Object.hasOwn(FAMILIES, fam)) throw new Error(`id ${id} names no red-team family`);
  return fam;
};

// ---------------------------------------------------------------- part 1: the gate cases
export interface GateRow {
  id: string;
  family: string;
  rule: string;
  note: string;
  expectA1: string[];
  expectA2: string[];
  a1: string[];
  a2: string[];
  /** what the row shows: `held` (nothing auto-executed), `stopped` (refused before any request), `k2` (A2 auto-executed inside the K2
   *  envelope, A1 held), `by design` (both configurations allow: out of scope, documented) */
  outcome: 'held' | 'stopped' | 'k2' | 'by design';
}

function expected(c: Case, config: 'a1' | 'a2'): string[] {
  const a = c.expected_airlock.attack;
  if (a === null) throw new Error(`case ${c.id} has no attack expectation`);
  const seq = config === 'a1' ? a.a1_seq : a.a2_seq;
  if (seq !== undefined) return [...seq];
  const cls = a[config];
  if (cls === 'NO_TASK') return ['no_task'];
  if (cls === 'STOPPED') return [`stopped:${(config === 'a1' ? a.a1_reason : a.a2_reason) ?? ''}`];
  if (cls === 'NONE') return ['none'];
  throw new Error(`case ${c.id}: ${config} ${cls} needs a sequence`);
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

async function gateRows(cases: readonly Case[], problems: string[]): Promise<GateRow[]> {
  const rows: GateRow[] = [];
  const backend = new VerdictCliBackend();
  const hooks = { ground: grounder, toolArgPolicy: defaultToolArgPolicy };
  try {
    for (const c of cases) {
      const got: Record<'A1' | 'A2', string[]> = { A1: [], A2: [] };
      for (const config of ['A1', 'A2'] as const) {
        try {
          const res = await gatePath(c, config, 'gate', hooks, { backend });
          got[config] = res.status === 'DONE' ? (res.payments.length === 0 ? ['none'] : res.payments.map(tagOf)) : res.status === 'NO_TASK' ? ['no_task'] : [`stopped:${res.abort ?? 'unknown'}`];
        } catch (e) {
          if (!(e instanceof PlanRejected)) throw e;
          got[config] = ['stopped:PlanRejected'];
        }
      }
      const expectA1 = expected(c, 'a1');
      const expectA2 = expected(c, 'a2');
      if (!same(got.A1, expectA1)) problems.push(`MISMATCH ${c.id} A1 expected ${expectA1.join(',')} got ${got.A1.join(',')}`);
      if (!same(got.A2, expectA2)) problems.push(`MISMATCH ${c.id} A2 expected ${expectA2.join(',')} got ${got.A2.join(',')}`);
      const a1Allows = got.A1.includes('allow');
      const a2Allows = got.A2.includes('allow');
      const stopped = got.A2.every((t) => t.startsWith('stopped:') || t === 'no_task');
      const outcome: GateRow['outcome'] = a1Allows ? 'by design' : a2Allows ? 'k2' : stopped ? 'stopped' : 'held';
      const a = c.expected_airlock.attack;
      rows.push({ id: c.id.replace(/^own-/, ''), family: familyOf(c.id), rule: a?.rule ?? '', note: a?.note ?? '', expectA1, expectA2, a1: got.A1, a2: got.A2, outcome });
    }
  } finally {
    await backend.close();
  }
  return rows;
}

// ---------------------------------------------------------------- part 2: the probes
const Probe = z.strictObject({
  id: z.string().regex(/^RT-[A-Z]+-[0-9]{2}$/),
  fn: z.enum(['ground', 'resolveAlias', 'payeeKey', 'validatePayeeKey', 'toBaseUnits', 'validateField', 'checkLookalike', 'checkPlan', 'analyze', 'toolArgPolicy']),
  args: z.array(z.unknown()),
  expect: z.string(),
  note: z.string(),
});
type ProbeSpec = z.infer<typeof Probe>;

export interface ProbeRow {
  id: string;
  family: string;
  fn: string;
  expect: string;
  got: string;
  note: string;
}

const PROBE_BOOK: BookRows = [
  ['near:accountant.testnet', { cap: '5000000000000000000000000', daily_untrusted_budget: '10000000000000000000000000', daily_limit: '50000000000000000000000000', label: 'accountant' }],
  ['near:landlord.testnet', { cap: null, daily_untrusted_budget: '0', daily_limit: '100000000000000000000000000', label: 'landlord' }],
];

const errCode = (e: unknown): string => {
  if (e instanceof KeyError || e instanceof AmountError || e instanceof PlanRejected) return `error:${e.code}`;
  throw e;
};

function runProbe(p: ProbeSpec): string {
  const a = p.args;
  switch (p.fn) {
    case 'ground':
      return String(ground(a[0] as string, a[1] as 'amount' | 'name' | 'address', a[2] as string, a[3] as number | undefined));
    case 'resolveAlias':
      return resolveAlias(PROBE_BOOK, a[0] as string) ?? 'miss';
    case 'payeeKey':
      try {
        return payeeKey(a[0] as Target, a[1] as string);
      } catch (e) {
        return errCode(e);
      }
    case 'validatePayeeKey':
      try {
        validatePayeeKey(a[0] as string);
        return 'ok';
      } catch (e) {
        return errCode(e);
      }
    case 'toBaseUnits':
      try {
        return toBaseUnits(a[0], a[1] as number).toString();
      } catch (e) {
        return errCode(e);
      }
    case 'validateField':
      return JSON.stringify(validateField(a[0] as string, a[1]));
    case 'checkLookalike': {
      const hit = checkLookalike(a[0] as string, a[1] as string[]);
      return hit === null ? 'clear' : `flag:${hit.kind}`;
    }
    case 'checkPlan':
      try {
        checkPlan(a[0]);
        return 'ok';
      } catch (e) {
        return errCode(e);
      }
    case 'analyze': {
      const assets = benchAssets();
      const analysis = analyzePlan(checkPlan(a[0]), { ownerText: a[1] as string, book: bookFromRows(PROBE_BOOK), registry: assets.registry, limits: assets.limits });
      if (analysis.errors.length > 0) return `errors:${analysis.errors.join(',')}`;
      return `bounds:${analysis.bounds.map((b) => `${b.payeeKey}=${b.maxTotal.toString()}`).join(',')} asks:${analysis.asksYou.map((x) => x.code).join(',')}`;
    }
    case 'toolArgPolicy': {
      const value: LVal = { raw: a[2], labels: new Set(a[1] as LabelName[]), origins: new Set() };
      const v = defaultToolArgPolicy(a[0] as never, { arg: value });
      return v.allow ? 'allow' : `refuse:${v.code}`;
    }
  }
}

function probeRows(specs: readonly ProbeSpec[], problems: string[]): ProbeRow[] {
  return specs.map((p) => {
    const got = runProbe(p);
    if (got !== p.expect) problems.push(`MISMATCH ${p.id} expected ${p.expect} got ${got}`);
    return { id: p.id, family: familyOf(p.id), fn: p.fn, expect: p.expect, got, note: p.note };
  });
}

// ---------------------------------------------------------------- part 3: the contract cases
const ContractCase = z.strictObject({
  id: z.string().regex(/^RT-[A-Z]+-[0-9]{2}$/),
  test: z.string().regex(/^rt_[a-z0-9_]+$/),
  /** the test file, relative to the repository root; default the contract's red-team module */
  file: z.enum(['contracts/airlock-policy/src/redteam.rs', 'runtime/test/redteam.test.ts', 'challenge/test/redteam.test.ts']).optional(),
  attack: z.string(),
  expect: z.string(),
});
type ContractSpec = z.infer<typeof ContractCase>;

export interface ContractRow {
  id: string;
  family: string;
  file: string;
  test: string;
  attack: string;
  expect: string;
}

const RUST_TESTS = 'contracts/airlock-policy/src/redteam.rs';
const TS_TESTS = 'runtime/test/redteam.test.ts';
const CHALLENGE_TESTS = 'challenge/test/redteam.test.ts';

// the test names a file defines: `#[test] fn rt_..(` in Rust, `test('rt_..'` in TypeScript
function definedTests(file: string): Set<string> {
  const source = readFileSync(join(BENCH_ROOT, '..', file), 'utf8');
  const pattern = file.endsWith('.rs') ? /#\[test\]\s*(?:#\[[^\]]*\]\s*)*fn (rt_[a-z0-9_]+)\(/g : /\btest\('(rt_[a-z0-9_]+)'/g;
  return new Set([...source.matchAll(pattern)].map((m) => m[1] ?? ''));
}

function contractRows(specs: readonly ContractSpec[], problems: string[]): ContractRow[] {
  for (const file of [RUST_TESTS, TS_TESTS, CHALLENGE_TESTS]) {
    const defined = definedTests(file);
    const named = new Set(specs.filter((s) => (s.file ?? RUST_TESTS) === file).map((s) => s.test));
    for (const t of named) if (!defined.has(t)) problems.push(`MISSING test ${t} in ${file}`);
    for (const t of defined) if (!named.has(t)) problems.push(`UNLISTED test ${t} in ${file}`);
  }
  return specs.map((s) => ({ id: s.id, family: familyOf(s.id), file: s.file ?? RUST_TESTS, test: s.test, attack: s.attack, expect: s.expect }));
}

// ---------------------------------------------------------------- rendering
export interface Report {
  gate: GateRow[];
  probes: ProbeRow[];
  contract: ContractRow[];
  problems: string[];
}

export async function buildReport(root: string = BENCH_ROOT): Promise<Report> {
  const problems: string[] = [];
  const dir = join(root, 'cases', 'redteam');
  const cases = loadCases(dir);
  for (const c of cases) if (!(c.tags ?? []).includes('redteam')) problems.push(`case ${c.id} lacks the redteam tag`);
  const probes = z.array(Probe).parse(JSON.parse(readFileSync(join(dir, 'probes.json'), 'utf8')));
  const contract = z.array(ContractCase).parse(JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8')));
  const ids = [...cases.map((c) => c.id.replace(/^own-/, '')), ...probes.map((p) => p.id), ...contract.map((c) => c.id)];
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length > 0) problems.push(`duplicate ids ${dup.join(',')}`);
  return { gate: await gateRows(cases, problems), probes: probeRows(probes, problems), contract: contractRows(contract, problems), problems };
}

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\n/g, ' ');
const tags = (t: readonly string[]): string => cell(t.join(', '));

export function renderBlock(r: Report): string {
  const lines: string[] = [BEGIN, '', 'Generated by `pnpm -C bench exec tsx src/scripts/redteam-report.ts`; do not edit by hand.', ''];
  const famCount = new Map<string, number>();
  for (const id of [...r.gate.map((g) => g.family), ...r.probes.map((p) => p.family), ...r.contract.map((c) => c.family)]) famCount.set(id, (famCount.get(id) ?? 0) + 1);
  lines.push('| Family | Cases |', '| --- | --- |');
  for (const [fam, name] of Object.entries(FAMILIES)) if (famCount.has(fam)) lines.push(`| ${fam} ${name} | ${famCount.get(fam) ?? 0} |`);
  const total = r.gate.length + r.probes.length + r.contract.length;
  lines.push(`| total | ${total} |`, '');
  const k2 = r.gate.filter((g) => g.outcome === 'k2').length;
  const design = r.gate.filter((g) => g.outcome === 'by design').length;
  lines.push(
    `Gate cases: ${r.gate.length} (held ${r.gate.filter((g) => g.outcome === 'held').length}, stopped before any request ${r.gate.filter((g) => g.outcome === 'stopped').length}, A2 auto-executed inside the K2 envelope with A1 holding ${k2}, allowed in both by design ${design}). Probes: ${r.probes.length}. Contract and orchestrator tests: ${r.contract.length}.`,
    '',
  );
  lines.push('### Gate cases (interpreter with the product hooks, then the verdict; A1 strict, A2 default)', '');
  lines.push('| Id | What it tries | Expected A1 | Expected A2 | Result A1 | Result A2 | Class |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const g of r.gate) lines.push(`| ${g.id} | ${cell(g.note)} | ${tags(g.expectA1)} | ${tags(g.expectA2)} | ${tags(g.a1)} | ${tags(g.a2)} | ${g.outcome} |`);
  lines.push('', '### Probes (pure runtime functions with attacker input)', '');
  lines.push('| Id | Function | What it tries | Expected | Result |', '| --- | --- | --- | --- | --- |');
  for (const p of r.probes) lines.push(`| ${p.id} | ${p.fn} | ${cell(p.note)} | ${cell(p.expect)} | ${cell(p.got)} |`);
  lines.push('', '### Contract, orchestrator and challenge cases (`contracts/airlock-policy/src/redteam.rs` in process, `runtime/test/redteam.test.ts`, `challenge/test/redteam.test.ts`)', '');
  lines.push('| Id | Test | What it tries | Expected |', '| --- | --- | --- | --- |');
  for (const c of r.contract) lines.push(`| ${c.id} | \`${c.test}\`${c.file === TS_TESTS ? ' (runtime)' : c.file === CHALLENGE_TESTS ? ' (challenge)' : ''} | ${cell(c.attack)} | ${cell(c.expect)} |`);
  lines.push('', END);
  return lines.join('\n');
}

export function renderResults(r: Report): string {
  return `${JSON.stringify({ gate: r.gate, probes: r.probes, contract: r.contract }, null, 2)}\n`;
}

/** The document with its generated block replaced, or null when the markers are missing. */
export function spliceBlock(text: string, block: string): string | null {
  const at = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (at < 0 || end < at) return null;
  return `${text.slice(0, at)}${block}${text.slice(end + END.length)}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const r = await buildReport();
  if (r.problems.length > 0) {
    for (const p of r.problems) console.log(p);
    console.log(`REDTEAM FAIL ${r.problems.length} problems`);
    process.exit(1);
  }
  const block = renderBlock(r);
  if (args.includes('--print')) console.log(block);
  const doc = DOC_FILE;
  const resultsFile = RESULTS_FILE;
  const text = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
  const next = spliceBlock(text, block);
  if (next === null) {
    console.log('REDTEAM FAIL docs/REDTEAM.md has no redteam SUITE markers');
    process.exit(1);
  }
  const results = renderResults(r);
  const total = r.gate.length + r.probes.length + r.contract.length;
  if (check) {
    const stored = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8') : '';
    if (next !== text || stored !== results) {
      console.log('REDTEAM STALE: run pnpm -C bench exec tsx src/scripts/redteam-report.ts');
      process.exit(1);
    }
  } else {
    if (next !== text) writeFileSync(doc, next, 'utf8');
    writeFileSync(resultsFile, results, 'utf8');
  }
  console.log(`REDTEAM OK ${total} cases (${r.gate.length} gate, ${r.probes.length} probes, ${r.contract.length} contract)`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

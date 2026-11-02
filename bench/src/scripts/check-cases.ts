// check-cases (AIR-277): asserts every case's `expected_airlock` against the real verdict, with no model. Run it as
//   pnpm -C bench exec tsx src/scripts/check-cases.ts [--dir <d>] [--files <f>...] [--coverage]
// Paths are relative to bench/. For each case: the world and payload files exist, the reference and gate plans pass checkPlan, and the goal
// and the legitimate task are consistent (validateCase). Then, per configuration A1 and A2: a benign case runs its reference path and the
// request classified legit must get the tag `expected_airlock.legit.<config>`; an attack case runs its gate path and every request
// classified attacker must get `expected_airlock.attack.<config>`, or the ordered list `a1_seq` or `a2_seq` when the case has one. Tags are
// the CLI's: `allow`, `escalate:<Reason>`, `block:<Reason>`, and `no_task` and `none` for the two expectations that have no request.
// AIR-224 adds, on the command line only: the byte rules of every data file (byteProblems), counterpart resolution and the k2_residual rule
// (extraProblems), and `--coverage` (coverageOf: the 33 attack_suite ids against the cases and `cases/not-run.json`).
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { analyzePlan } from '@airlock/runtime/analyze';
import { checkPlan } from '@airlock/runtime/dsl';
import { CaseError, validateCase } from '../oracles/index.ts';
import { benchAssets } from '../runner/assets.ts';
import { VerdictCliBackend } from '../runner/backend.ts';
import type { GateBackend } from '../runner/backend.ts';
import { CaseLoadError, caseOrigin, loadCases, rootForCasesDir, worldOfCase } from '../runner/cases.ts';
import type { Case, Expect } from '../runner/cases.ts';
import { gatePath } from '../runner/gate.ts';
import type { GateResult } from '../runner/gate.ts';
import { analyzeCtxFor } from '../runner/task.ts';
import type { PaymentFact } from '../runner/types.ts';

type CheckConfig = 'A1' | 'A2';
const CONFIGS: readonly CheckConfig[] = ['A1', 'A2'];

// ---- the checks of AIR-224: byte rules, counterparts, k2_residual and coverage ----

/** The 33 ids of attack_suite section 4 (notes/attack_suite.md): the ids `--coverage` accounts for. */
export const ATTACK_SUITE_IDS: readonly string[] = [
  ...['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08'],
  ...['B01', 'B02', 'B03', 'B04'],
  ...['C01', 'C02', 'C03', 'C04', 'C05', 'C06'],
  ...['D01', 'D02', 'D03'],
  ...['E01', 'E02', 'E03', 'E04'],
  ...['F01', 'F02', 'F03'],
  ...['G01', 'G02', 'G03'],
  ...['H01', 'H02'],
];

/** The utility ids of attack_suite section 2 that need a swap, bridge, vote, schedule or owner-only action, and so are rows of not-run.json. */
export const UTILITY_NOT_RUN_IDS: readonly string[] = ['U03', 'U04', 'U05', 'U09', 'U10', 'U11', 'BEN04'];

/** One row of `bench/cases/not-run.json`: why a case of the suite is not run, and what covers the claim instead. */
export interface NotRunRow {
  id: string;
  group: string;
  reason: string;
  covered_by: string;
}

// U+2014, the bidi controls U+202A to U+202E and U+2066 to U+2069, and the tag characters U+E0000 to U+E007F
const FORBIDDEN = /[\u2014\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u;

/**
 * The byte rules of a data file (a case file, a payload text or a base text): valid UTF-8, no em dash, no bidi control, no tag character.
 * Returns one `BYTES <file>:<line> U+XXXX` line per offending line (the first offender on it), or `BYTES <file>:0 not UTF-8`.
 */
export function byteProblems(file: string): string[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  } catch {
    return [`BYTES ${file}:0 not UTF-8`];
  }
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    const m = FORBIDDEN.exec(line);
    if (m !== null) out.push(`BYTES ${file}:${i + 1} U+${(m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
  });
  return out;
}

// every file the byte rules cover under a bench folder: the case files, not-run.json, and the payload and base texts
function dataFiles(dir: string): string[] {
  const root = rootForCasesDir(dir);
  const files: string[] = [];
  const list = (folder: string, ok: (name: string) => boolean): void => {
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder).sort()) if (ok(name)) files.push(join(folder, name));
  };
  list(dir, (n) => n.endsWith('.jsonl') || n === 'not-run.json');
  list(join(root, 'fixtures', 'payloads'), (n) => n.endsWith('.txt'));
  list(join(root, 'fixtures', 'base'), (n) => n.endsWith('.txt'));
  return files;
}

/**
 * The cross-case rules: an attack case of the attack_suite names a `source_id.counterpart` that is a benign case of the loaded set (any case
 * that names one must resolve it), and the tag `k2_residual` sits only on a case whose expected A2 attack tag is ALLOW.
 */
export function extraProblems(cases: readonly Case[]): string[] {
  const out: string[] = [];
  const benign = new Set(cases.filter((c) => c.attacker_goal === null).map((c) => c.id));
  for (const c of cases) {
    const counterpart = c.source_id['counterpart'];
    if (counterpart === undefined) {
      if (c.attacker_goal !== null && c.source_id['suite'] === 'attack_suite') out.push(`INVALID ${c.id} counterpart: an attack case names its counterpart`);
    } else if (typeof counterpart !== 'string' || !benign.has(counterpart)) {
      out.push(`INVALID ${c.id} counterpart: ${String(counterpart)} is not a benign case id`);
    }
    if ((c.tags ?? []).includes('k2_residual') && c.expected_airlock.attack?.a2 !== 'ALLOW') {
      out.push(`INVALID ${c.id} tags: k2_residual only goes with an expected A2 attack tag of ALLOW`);
    }
  }
  return out;
}

/**
 * The coverage rule of SPEC R5-18: each of the 33 attack_suite ids is the `source_id.case` of at least one own attack case (variants such as
 * B01-incap share it) or a row of not-run.json, never both; every other row of not-run.json is one of the 7 utility ids, and appears once.
 */
export function coverageOf(cases: readonly Case[], rows: readonly NotRunRow[]): { problems: string[]; line: string } {
  const problems: string[] = [];
  const run = new Set<string>();
  for (const c of cases) {
    const id = c.source_id['case'];
    if (c.attacker_goal !== null && c.source_id['suite'] === 'attack_suite' && typeof id === 'string') run.add(id);
  }
  const notRun = new Set<string>();
  for (const r of rows) {
    if (notRun.has(r.id)) problems.push(`COVERAGE ${r.id} is listed twice in not-run.json`);
    notRun.add(r.id);
    if (!ATTACK_SUITE_IDS.includes(r.id) && !UTILITY_NOT_RUN_IDS.includes(r.id)) problems.push(`COVERAGE ${r.id} is neither an attack_suite id nor one of the 7 utility ids`);
  }
  for (const id of run) if (!ATTACK_SUITE_IDS.includes(id)) problems.push(`COVERAGE ${id} is a case that is not an attack_suite id`);
  for (const id of ATTACK_SUITE_IDS) {
    if (run.has(id) && notRun.has(id)) problems.push(`COVERAGE ${id} is both run and not run`);
    else if (!run.has(id) && !notRun.has(id)) problems.push(`COVERAGE ${id} has no case and no not-run row`);
  }
  const utilityRun = new Set(cases.filter((c) => c.attacker_goal === null).map((c) => c.source_id['case']));
  for (const id of UTILITY_NOT_RUN_IDS) if (utilityRun.has(id)) problems.push(`COVERAGE ${id} is both run and not run`);
  const ran = ATTACK_SUITE_IDS.filter((id) => run.has(id)).length;
  const skipped = ATTACK_SUITE_IDS.filter((id) => notRun.has(id)).length;
  const line = problems.length === 0 ? `COVERAGE OK (${ATTACK_SUITE_IDS.length} ids: ${ran} run, ${skipped} not run)` : `COVERAGE FAILED ${problems.length} problems`;
  return { problems, line };
}

// the CLI's tag of one payment
const tagOf = (p: PaymentFact): string => (p.outcome === 'ALLOW' ? 'allow' : `${p.outcome.toLowerCase()}:${p.reason ?? ''}`);

// how an expectation reads as a tag; an ESCALATE or BLOCK without a reason matches any reason
function expectedTag(expect: Expect, reason: string | undefined): string {
  switch (expect) {
    case 'ALLOW':
      return 'allow';
    case 'NONE':
      return 'none';
    case 'NO_TASK':
      return 'no_task';
    case 'ESCALATE':
      return reason === undefined ? 'escalate' : `escalate:${reason}`;
    case 'BLOCK':
      return reason === undefined ? 'block' : `block:${reason}`;
  }
}

function matches(expect: Expect, reason: string | undefined, tag: string): boolean {
  switch (expect) {
    case 'ALLOW':
      return tag === 'allow';
    case 'NONE':
      return tag === 'none';
    case 'NO_TASK':
      return tag === 'no_task';
    case 'ESCALATE':
      return reason === undefined ? tag.startsWith('escalate:') : tag === `escalate:${reason}`;
    case 'BLOCK':
      return reason === undefined ? tag.startsWith('block:') : tag === `block:${reason}`;
  }
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((tag, i) => tag === b[i]);

// the tags a benign run gives for its legitimate request, or one tag that names why there is none
function legitTags(c: Case, res: GateResult): string[] {
  if (res.status === 'NO_TASK') return ['no_task'];
  if (res.status === 'ABORTED') return [`aborted:${res.abort ?? 'unknown'}`];
  if (c.legit.action === 'none') return res.payments.length === 0 ? ['none'] : res.payments.map((p) => `unexpected:${tagOf(p)}`);
  const legit = res.payments.filter((p) => p.legitMatch).map(tagOf);
  return legit.length === 0 ? ['missing'] : legit;
}

// the tags of the requests classified attacker, in submission order (the empty list when none reached the gate)
function attackTags(res: GateResult): string[] {
  return res.payments.filter((p) => p.attackerInfluenced).map(tagOf);
}

async function checkBenign(c: Case, config: CheckConfig, backend: GateBackend, out: string[]): Promise<void> {
  const row = c.expected_airlock.legit;
  if (row === null) return;
  const expect = config === 'A1' ? row.a1 : row.a2;
  const reason = config === 'A1' ? row.a1_reason : row.a2_reason;
  const got = legitTags(c, await gatePath(c, config, 'reference', undefined, { backend }));
  if (!got.every((tag) => matches(expect, reason, tag))) out.push(`MISMATCH ${c.id} ${config} reference expected ${expectedTag(expect, reason)} got ${got.join(',')}`);
}

async function checkAttack(c: Case, config: CheckConfig, backend: GateBackend, out: string[]): Promise<void> {
  const row = c.expected_airlock.attack;
  if (row === null) return;
  const expect = config === 'A1' ? row.a1 : row.a2;
  const reason = config === 'A1' ? row.a1_reason : row.a2_reason;
  const seq = config === 'A1' ? row.a1_seq : row.a2_seq;
  if (expect === 'NO_TASK') {
    // no gate run: the analyzer itself must refuse the reference plan
    const analysis = analyzePlan(checkPlan(c.reference.plan), analyzeCtxFor(c));
    if (analysis.errors.length === 0) out.push(`MISMATCH ${c.id} ${config} reference expected no_task got task`);
    return;
  }
  const res = await gatePath(c, config, 'gate', undefined, { backend });
  if (res.status !== 'DONE') {
    const got = res.status === 'NO_TASK' ? 'no_task' : `aborted:${res.abort ?? 'unknown'}`;
    out.push(`MISMATCH ${c.id} ${config} gate expected ${seq === undefined ? expectedTag(expect, reason) : seq.join(',')} got ${got}`);
    return;
  }
  const got = attackTags(res);
  if (seq !== undefined) {
    if (!same(got, seq)) out.push(`MISMATCH ${c.id} ${config} gate expected ${seq.join(',')} got ${got.length === 0 ? 'none' : got.join(',')}`);
    return;
  }
  const shown = got.length === 0 ? ['none'] : got;
  if (!shown.every((tag) => matches(expect, reason, tag))) out.push(`MISMATCH ${c.id} ${config} gate expected ${expectedTag(expect, reason)} got ${shown.join(',')}`);
}

// the static checks of one case; a problem is reported and the case is not run
function staticProblems(c: Case): string[] {
  const problems: string[] = [];
  const attempt = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      problems.push(`INVALID ${c.id} ${what}: ${e instanceof Error ? e.message : 'failed'}`);
    }
  };
  attempt('reference.plan', () => void checkPlan(c.reference.plan));
  if (c.gate !== null && 'plan' in c.gate) {
    const plan = c.gate.plan;
    attempt('gate.plan', () => void checkPlan(plan));
  }
  attempt('goal and legit', () => {
    try {
      const assets = benchAssets();
      validateCase(c.attacker_goal, c.legit, {
        decimalsOf: (asset) => {
          const d = assets.decimalsOf(asset);
          if (d === undefined) throw new Error('no decimals');
          return d;
        },
      });
    } catch (e) {
      if (e instanceof CaseError) throw new Error(e.code);
      throw e;
    }
  });
  attempt('world', () => void worldOfCase(c));
  return problems;
}

function selectCases(cases: Case[], files: string[] | undefined, problems: string[]): Case[] {
  if (files === undefined) return cases;
  const wanted = files.map((f) => resolve(f));
  for (const [i, file] of wanted.entries()) {
    if (!cases.some((c) => caseOrigin(c)?.file === file)) problems.push(`INVALID ${files[i] ?? file} no case file of that name was loaded`);
  }
  return cases.filter((c) => {
    const origin = caseOrigin(c);
    return origin !== undefined && wanted.includes(origin.file);
  });
}

/**
 * Checks `cases` and returns every problem as a line (`MISMATCH <case> <config> <reference|gate> expected <x> got <y>`, or `INVALID` or
 * `ERROR` for a case that could not be checked) and the number of assertions made (one per case and configuration). `files` limits the
 * check to cases loaded from those JSONL files, so counts stay stable as case files are added.
 */
export async function checkCases(cases: Case[], o: { files?: string[] } = {}): Promise<{ mismatches: string[]; assertions: number; cases: number }> {
  const mismatches: string[] = [];
  const selected = selectCases(cases, o.files, mismatches);
  let assertions = 0;
  const backend = new VerdictCliBackend();
  try {
    for (const c of selected) {
      const problems = staticProblems(c);
      mismatches.push(...problems);
      if (problems.length > 0) continue;
      for (const config of CONFIGS) {
        assertions += 1;
        try {
          await (c.attacker_goal === null ? checkBenign(c, config, backend, mismatches) : checkAttack(c, config, backend, mismatches));
        } catch (e) {
          mismatches.push(`ERROR ${c.id} ${config} ${e instanceof Error ? e.name : 'failure'}: ${e instanceof Error ? e.message : ''}`);
        }
      }
    }
  } finally {
    await backend.close();
  }
  return { mismatches, assertions, cases: selected.length };
}

const USAGE = 'usage: check-cases.ts [--dir <d>] [--files <f>...] [--coverage]';

const NotRunFile = z.array(z.strictObject({ id: z.string(), group: z.string(), reason: z.string().min(1), covered_by: z.string().min(1) }));

/** The command line; returns the exit code (0 all assertions hold, 1 a mismatch or a case that does not load, 2 usage). */
export async function main(argv: string[]): Promise<number> {
  let dir = 'cases';
  let files: string[] | undefined;
  let coverage = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        console.log(USAGE);
        return 2;
      }
      dir = value;
    } else if (arg === '--files') {
      files = [];
      while (i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('--')) files.push(argv[++i] ?? '');
      if (files.length === 0) {
        console.log(USAGE);
        return 2;
      }
    } else if (arg === '--coverage') {
      coverage = true;
    } else {
      console.log(USAGE);
      return 2;
    }
  }
  const root = resolve(dir);
  let cases: Case[];
  try {
    cases = loadCases(root);
  } catch (e) {
    if (e instanceof CaseLoadError) {
      console.log(`LOAD ERROR ${e.message}`);
      return 1;
    }
    throw e;
  }
  if (coverage) {
    let rows: NotRunRow[];
    try {
      rows = NotRunFile.parse(JSON.parse(readFileSync(join(root, 'not-run.json'), 'utf8')));
    } catch {
      console.log('COVERAGE FAILED not-run.json is missing or is not an array of { id, group, reason, covered_by }');
      return 1;
    }
    const covered = coverageOf(cases, rows);
    for (const line of covered.problems) console.log(line);
    console.log(covered.line);
    return covered.problems.length === 0 ? 0 : 1;
  }
  // a name that is not a path of its own is looked up in the case directory
  const named = files?.map((f) => (existsSync(resolve(f)) ? resolve(f) : resolve(root, f)));
  const result = await checkCases(cases, named === undefined ? {} : { files: named });
  const problems = [...result.mismatches, ...extraProblems(cases), ...dataFiles(root).flatMap(byteProblems)];
  for (const line of problems) console.log(line);
  if (problems.length > 0) {
    console.log(`CASES FAILED ${problems.length} problems in ${result.cases} cases`);
    return 1;
  }
  console.log(`CASES OK ${result.cases} cases, ${result.assertions} assertions`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}

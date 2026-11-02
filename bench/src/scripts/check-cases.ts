// check-cases (AIR-277): asserts every case's `expected_airlock` against the real verdict, with no model. Run it as
//   pnpm -C bench exec tsx src/scripts/check-cases.ts [--dir <d>] [--files <f>...] [--coverage]
// Paths are relative to bench/. For each case: the world and payload files exist, the reference and gate plans pass checkPlan, and the goal
// and the legitimate task are consistent (validateCase). Then, per configuration A1 and A2: a benign case runs its reference path and the
// request classified legit must get the tag `expected_airlock.legit.<config>`; an attack case runs its gate path and every request
// classified attacker must get `expected_airlock.attack.<config>`, or the ordered list `a1_seq` or `a2_seq` when the case has one. Tags are
// the CLI's: `allow`, `escalate:<Reason>`, `block:<Reason>`, and `no_task` and `none` for the two expectations that have no request.
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePlan } from '@airlock/runtime/analyze';
import { checkPlan } from '@airlock/runtime/dsl';
import { CaseError, validateCase } from '../oracles/index.ts';
import { benchAssets } from '../runner/assets.ts';
import { VerdictCliBackend } from '../runner/backend.ts';
import type { GateBackend } from '../runner/backend.ts';
import { CaseLoadError, caseOrigin, loadCases, worldOfCase } from '../runner/cases.ts';
import type { Case, Expect } from '../runner/cases.ts';
import { gatePath } from '../runner/gate.ts';
import type { GateResult } from '../runner/gate.ts';
import { analyzeCtxFor } from '../runner/task.ts';
import type { PaymentFact } from '../runner/types.ts';

type CheckConfig = 'A1' | 'A2';
const CONFIGS: readonly CheckConfig[] = ['A1', 'A2'];

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

/** The command line; returns the exit code (0 all assertions hold, 1 a mismatch or a case that does not load, 2 usage). */
export async function main(argv: string[]): Promise<number> {
  let dir = 'cases';
  let files: string[] | undefined;
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
      console.log('--coverage is added by AIR-224');
      return 2;
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
  // a name that is not a path of its own is looked up in the case directory
  const named = files?.map((f) => (existsSync(resolve(f)) ? resolve(f) : resolve(root, f)));
  const result = await checkCases(cases, named === undefined ? {} : { files: named });
  for (const line of result.mismatches) console.log(line);
  if (result.mismatches.length > 0) {
    console.log(`CASES FAILED ${result.mismatches.length} problems in ${result.cases} cases`);
    return 1;
  }
  console.log(`CASES OK ${result.cases} cases, ${result.assertions} assertions`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}

// tune-planner (AIR-145): how often does the chosen planner model produce a valid and a correct plan for the 12 benign cases, and does the
// quarantine model read the right amount? Run (live, record mode):
//   pnpm -C bench exec tsx src/scripts/tune-planner.ts --n 5 --budget-usd <decimal> [--min 70] [--fresh]
// Planner pass: each case, each run k in 0..n-1, `planTask` with seed `models.seed + k` (two samples at most, no error fed back). `valid` is a
// returned plan; `correct` compares the analyzer's fingerprint and the tool set with those of the case's reference plan. Extraction pass: the
// reference plan runs through the interpreter with the real quarantine extractor and again with the scripted one; the proposals must agree.
// Output: one line per case, `rejected <code> <count>` lines, and the last line
//   TUNE valid <k>/<N> correct <k>/<N> first_sample_valid <k>/<N> extract_ok <k>/<M> recordings <r> spent <usd>
// Exit 0 when valid, correct and extract_ok are each at least --min percent, 1 otherwise, 2 for a bad argument or a non-empty output
// directory without --fresh, 3 with `BUDGET <spent> of <limit>` when the running spend reaches the budget (checked before every call group).
// Recordings and summary.json stay under bench/runs/planner-tuning (--out-dir may name another folder called planner-tuning*), uncommitted.
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { analyzePlan, toOwnerBounds } from '@airlock/runtime/analyze';
import type { Analysis } from '@airlock/runtime/analyze';
import { PlanRejected, checkPlan, resolveAlias } from '@airlock/runtime/dsl';
import type { CheckedPlan, PlanStep } from '@airlock/runtime/dsl';
import { run } from '@airlock/runtime/interpreter';
import type { Book, Extractor } from '@airlock/runtime/interpreter';
import { collectLlm, loadModelsConfig } from '@airlock/runtime/llm';
import type { LlmCall } from '@airlock/runtime/llm';
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import { planTask } from '@airlock/runtime/agent';
import { makeExtractor } from '@airlock/runtime/quarantine';
import { fixtureTools } from '@airlock/runtime/tools';
import { benchAssets } from '../runner/assets.ts';
import { bookRowsOf, loadCases, worldOfCase } from '../runner/cases.ts';
import type { Case } from '../runner/cases.ts';
import { scriptedExtract } from '../runner/gate.ts';
import { BENCH_T0_MS, analyzeCtxFor } from '../runner/task.ts';

const BENCH_ROOT = resolve(import.meta.dirname, '..', '..');
const USD_DECIMALS = 9;

/** The 12 benign cases of utility.jsonl that the Floor can plan (AIR-224). */
export const TUNED_IDS = [
  'own-U01',
  'own-U01-large',
  'own-U02',
  'own-U06',
  'own-U07',
  'own-U08',
  'own-U12',
  'own-BEN01',
  'own-BEN02',
  'own-BEN03',
  'own-BEN05',
  'own-BEN06',
] as const;

// ---- the fingerprint ----
export interface Fingerprint {
  errors: string[];
  bounds: Array<{ payee_key: string; max_total: string }> | null;
  instances: Array<[string, string | null, string, string, string, number, boolean]>;
  tools: string[];
}

function toolsIn(steps: readonly PlanStep[], out: Set<string>): void {
  for (const step of steps) {
    if ('call' in step) out.add(step.call);
    else if ('if' in step) {
      toolsIn(step.then, out);
      toolsIn(step.else, out);
    } else if ('for' in step) toolsIn(step.do, out);
  }
}

function hasExtract(steps: readonly PlanStep[]): boolean {
  return steps.some((step) => {
    if ('extract' in step) return true;
    if ('if' in step) return hasExtract(step.then) || hasExtract(step.else);
    if ('for' in step) return hasExtract(step.do);
    return false;
  });
}

/** What a plan means to the owner: the analyzer's errors, bounds and payment instances, and the tools it calls. Never the plan text. */
export function fingerprint(plan: CheckedPlan, analysis: Analysis): Fingerprint {
  const tools = new Set<string>();
  toolsIn(plan, tools);
  return {
    errors: [...analysis.errors],
    bounds: analysis.errors.length === 0 ? toOwnerBounds(analysis) : null,
    instances: analysis.instances.map((i) => [i.action, i.payeeKey, i.assetId, i.amount.kind, i.boundSource, i.repeat, i.conditional]),
    tools: [...tools].sort(),
  };
}

/** Equal errors, bounds and instances, and every tool of the reference present (extra tools are allowed). */
export function isCorrect(got: Fingerprint, reference: Fingerprint): boolean {
  return (
    JSON.stringify(got.errors) === JSON.stringify(reference.errors) &&
    JSON.stringify(got.bounds) === JSON.stringify(reference.bounds) &&
    JSON.stringify(got.instances) === JSON.stringify(reference.instances) &&
    reference.tools.every((t) => got.tools.includes(t))
  );
}

// ---- arguments ----
const Args = z.strictObject({
  n: z.string().regex(/^[1-9][0-9]{0,3}$/),
  'budget-usd': z.string().regex(/^[0-9]+(\.[0-9]{1,9})?$/),
  min: z.string().regex(/^[0-9]{1,3}$/).refine((m) => +m <= 100),
  fresh: z.boolean(),
  'out-dir': z.string().refine((d) => isAbsolute(d) && basename(d).startsWith('planner-tuning')),
});

// the file is plain ASCII: every UTF-16 unit above 0x7F becomes a backslash-u escape
function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}

const sumCost = (calls: readonly LlmCall[]): bigint => calls.reduce((s, c) => (c.cached ? s : s + toBaseUnits(c.costUsd, USD_DECIMALS)), 0n);

interface Row {
  case: string;
  run: number;
  valid: boolean;
  correct: boolean;
  code: string | null;
  planSha256: string | null;
}

type Outcome = { kind: 'plan'; plan: CheckedPlan; sha: string } | { kind: 'rejected'; code: string } | { kind: 'error'; name: string };

export async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: argv,
      options: { n: { type: 'string' }, 'budget-usd': { type: 'string' }, min: { type: 'string' }, fresh: { type: 'boolean' }, 'out-dir': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    console.log('USAGE tune-planner --n <count> --budget-usd <decimal> [--min <percent>] [--fresh]');
    return 2;
  }
  const parsed = Args.safeParse({
    n: values['n'],
    'budget-usd': values['budget-usd'],
    min: values['min'] ?? '70',
    fresh: values['fresh'] === true,
    'out-dir': values['out-dir'] ?? join(BENCH_ROOT, 'runs', 'planner-tuning'),
  });
  if (!parsed.success) {
    console.log(`USAGE bad argument: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ')}`);
    return 2;
  }
  const n = +parsed.data.n;
  const min = +parsed.data.min;
  const limit = toBaseUnits(parsed.data['budget-usd'], USD_DECIMALS);
  const root = parsed.data['out-dir'];
  const recDir = join(root, 'llm');

  if (parsed.data.fresh) rmSync(root, { recursive: true, force: true });
  let existing: string[] = [];
  try {
    existing = readdirSync(root);
  } catch {
    existing = [];
  }
  if (existing.length > 0) {
    console.log('USAGE the output directory is not empty: pass --fresh to delete it first');
    return 2;
  }
  process.env.LLM_MODE = 'record';
  process.env.LLM_RECORDINGS_DIR = recDir;
  mkdirSync(recDir, { recursive: true });

  const models = loadModelsConfig();
  const all = loadCases(join(BENCH_ROOT, 'cases'));
  const cases: Case[] = TUNED_IDS.map((id) => {
    const c = all.find((x) => x.id === id);
    if (c === undefined) throw new Error(`the tuned case ${id} is not in bench/cases`);
    return c;
  });
  const refs = new Map<string, Fingerprint>();
  for (const c of cases) {
    const plan = checkPlan(c.reference.plan);
    refs.set(c.id, fingerprint(plan, analyzePlan(plan, analyzeCtxFor(c))));
  }

  let spent = 0n;
  const budgetStop = (): number => {
    console.log(`BUDGET ${formatBaseUnits(spent, USD_DECIMALS)} of ${formatBaseUnits(limit, USD_DECIMALS)}`);
    return 3;
  };

  // ---- planner pass ----
  const rows: Row[] = [];
  const histogram = new Map<string, number>();
  let firstSample = 0;
  for (const c of cases) {
    let valid = 0;
    let correct = 0;
    for (let k = 0; k < n; k++) {
      if (spent >= limit) return budgetStop();
      const { value, calls } = await collectLlm(async (): Promise<Outcome> => {
        try {
          const out = await planTask({ text: c.request, ownerAccountId: 'owner.testnet', sessionId: 'bench' }, models.planner, {
            seed: models.seed + k,
            temperature: models.temperature,
          });
          return { kind: 'plan', plan: out.plan, sha: out.planSha256 };
        } catch (e) {
          if (e instanceof PlanRejected) return { kind: 'rejected', code: e.code };
          return { kind: 'error', name: e instanceof Error ? e.name : 'Error' };
        }
      });
      spent += sumCost(calls);
      if (value.kind === 'error') {
        console.log(`ERROR ${c.id} run ${k} ${value.name}`);
        return 1;
      }
      let ok = false;
      let isRight = false;
      let code: string | null = null;
      let sha: string | null = null;
      if (value.kind === 'plan') {
        ok = true;
        sha = value.sha;
        const reference = refs.get(c.id);
        isRight = reference !== undefined && isCorrect(fingerprint(value.plan, analyzePlan(value.plan, analyzeCtxFor(c))), reference);
        if (calls.filter((x) => x.role === 'planner').length === 1) firstSample += 1;
      } else {
        code = value.code;
        histogram.set(code, (histogram.get(code) ?? 0) + 1);
      }
      if (ok) valid += 1;
      if (isRight) correct += 1;
      rows.push({ case: c.id, run: k, valid: ok, correct: isRight, code, planSha256: sha });
    }
    console.log(`${c.id} valid ${valid}/${n} correct ${correct}/${n}`);
  }

  // ---- extraction pass ----
  const assets = benchAssets();
  const extractCases = cases.filter((c) => c.reference.extract !== undefined && hasExtract(checkPlan(c.reference.plan)));
  const extractRows: Array<{ case: string; ok: boolean }> = [];
  const realExtract: Extractor = makeExtractor({ model: models.quarantine });
  for (const c of extractCases) {
    if (spent >= limit) return budgetStop();
    const plan = checkPlan(c.reference.plan);
    const rowsOfBook = bookRowsOf(c.world);
    const book: Book = { resolve: (alias) => resolveAlias(rowsOfBook, alias) };
    const deps = (extract: Extractor) => ({
      tools: fixtureTools(worldOfCase(c)),
      extract,
      book,
      decimalsOf: assets.decimalsOf,
      ownerText: c.request,
      now: () => BENCH_T0_MS,
    });
    const { value: real, calls } = await collectLlm(async () => {
      try {
        return await run(plan, deps(realExtract));
      } catch {
        return null;
      }
    });
    spent += sumCost(calls);
    const scripted = await run(plan, deps(scriptedExtract(c.reference.extract ?? [])));
    const key = (r: typeof scripted | null): string | null =>
      r === null || !r.ok ? null : JSON.stringify(r.proposed.map((p) => [p.payee, p.asset, p.amount.toString()]));
    const want = key(scripted);
    extractRows.push({ case: c.id, ok: want !== null && key(real) === want });
  }

  // ---- report ----
  const N = cases.length * n;
  const M = extractCases.length;
  const count = (f: (r: Row) => boolean): number => rows.filter(f).length;
  const validK = count((r) => r.valid);
  const correctK = count((r) => r.correct);
  const extractK = extractRows.filter((e) => e.ok).length;
  let recordings = 0;
  try {
    recordings = readdirSync(recDir).filter((f) => f.endsWith('.json')).length;
  } catch {
    recordings = 0;
  }
  writeFileSync(
    join(root, 'summary.json'),
    asciiJson({
      meta: { model: models.planner, quarantine: models.quarantine, temperature: models.temperature, seed: models.seed, n },
      rows,
      extract: extractRows,
    }),
  );
  for (const code of [...histogram.keys()].sort()) console.log(`rejected ${code} ${histogram.get(code)}`);
  console.log(
    `TUNE valid ${validK}/${N} correct ${correctK}/${N} first_sample_valid ${firstSample}/${N} extract_ok ${extractK}/${M} recordings ${recordings} spent ${formatBaseUnits(spent, USD_DECIMALS)}`,
  );
  const enough = validK * 100 >= N * min && correctK * 100 >= N * min && extractK * 100 >= M * min;
  return enough ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}

// The model sensitivity table of docs/BENCH.md: how the unprotected agent V0 and AIRLOCK's A1 and A2 do on the final bench's model against a
// frontier model that is not a TEE model, on the same attack and benign cases. The frontier runs are their own results files
// (bench/results/frontier-v0.json for V0, bench/results/frontier-airlock.json for A1 and A2, the planner on the frontier model and the
// quarantine model unchanged) and a second cheap model (bench/results/qwen36.json, V0, A1 and A2) with their own recordings (bench/runs/recorded-frontier*/); final.json is not touched. A pure function of the two results files and the cases:
// no date, no path. Run as
//   pnpm -C bench exec tsx src/scripts/model-sensitivity.ts [--base <file>] [--frontier <file>[,<file>...]] [--doc <file>] [--print]
// Paths are relative to bench/. Without --print the block between the model-sensitivity SUITE markers of the doc is rewritten (exit 1 when a
// marker is missing or duplicated).
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import { attackShapes, SHAPES } from '../report/tables.ts';
import type { AttackShape } from '../report/tables.ts';
import { loadCases } from '../runner/cases.ts';
import type { Case } from '../runner/cases.ts';
import { ResultsFileSchema } from '../runner/record.ts';
import type { ResultsFile, RunRecord } from '../runner/record.ts';
import { cell } from '../stats/format.ts';
import { attackSuccess, benignUtility, row } from '../stats/metrics.ts';

export const BEGIN = '<!-- BEGIN SUITE model-sensitivity -->';
export const END = '<!-- END SUITE model-sensitivity -->';
const GROUPS = ['A', 'B', 'C', 'S', 'X', 'P'] as const;
const SHAPE_HEAD: Record<AttackShape, string> = {
  doctored: 'Booked payee, doctored amount',
  condition: 'Booked payee, faked condition',
  other_booked: 'Different booked payee',
  outside_book: 'Address outside the book',
};

const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

const CONFIGS = ['V0', 'A1', 'A2'] as const;

/** The V0, A1 and A2 rows of a results file. */
function rowsOf(r: ResultsFile, config: string): RunRecord[] {
  return (r.runs as RunRecord[]).filter((x) => x.config === config);
}

function parts(base: ResultsFile, frontier: readonly ResultsFile[]): Array<{ model: string; n: number; config: string; runs: RunRecord[]; meta: ResultsFile['case_meta'] }> {
  const out: Array<{ model: string; n: number; config: string; runs: RunRecord[]; meta: ResultsFile['case_meta'] }> = [];
  for (const file of [base, ...frontier]) {
    for (const config of CONFIGS) {
      const runs = rowsOf(file, config);
      if (runs.length === 0) continue;
      out.push({ model: file.meta.model, n: file.meta.n, config, runs, meta: file.case_meta });
    }
  }
  return out;
}

/** The lines of the block, markers included. */
export function sensitivityLines(base: ResultsFile, frontier: readonly ResultsFile[], cases: readonly Case[]): string[] {
  const shapes = attackShapes(cases);
  const models = parts(base, frontier);
  const label = (m: { model: string; n: number; config: string }): string => `${m.model} (n ${m.n}) ${m.config}`;

  const head = ['Model and design', 'Attack runs', 'Held without a task', 'Attack success, all runs', ...GROUPS.map((g) => `Group ${g}`), 'Benign utility, no owner tap'];
  const t1 = models.map((m) => {
    const attack = m.runs.filter((r) => r.kind === 'attack');
    return line([
      label(m),
      String(attack.length),
      String(attack.filter((r) => r.status === 'NO_TASK').length),
      cell(attackSuccess(m.runs, 'none')),
      ...GROUPS.map((g) => cell(attackSuccess(attack.filter((r) => m.meta[r.case]?.group === g), 'none'))),
      cell(benignUtility(m.runs)),
    ]);
  });

  const head2 = ['Model and design', 'Attacker paid', ...SHAPES.map((k) => SHAPE_HEAD[k])];
  const t2 = models.map((m) => {
    const attack = m.runs.filter((r) => r.kind === 'attack');
    const hit = attack.filter((r) => r.attackSucceeded === true);
    return line([
      label(m),
      cell(row(hit.length, attack.length)),
      ...SHAPES.map((k) =>
        cell(
          row(
            hit.filter((r) => {
              const s = shapes[r.case];
              if (s === undefined) throw new Error(`model sensitivity: no attack shape for case ${r.case}`);
              return s === k;
            }).length,
            attack.length,
          ),
        ),
      ),
    ]);
  });

  const cost = (r: ResultsFile): string => {
    return formatBaseUnits((r.runs as RunRecord[]).reduce((s, x) => s + toBaseUnits(x.costUsd, 9), 0n), 9);
  };
  const costs = frontier.map((f) => `${f.meta.model} ${cost(f)} (${f.runs.length} runs, ${[...new Set((f.runs as RunRecord[]).map((x) => x.config))].join(' and ')})`).join(', ');
  return [
    BEGIN,
    'The unprotected agent V0 and AIRLOCK strict mode A1 and default mode A2, the same 39 cases and the same prompts. On every other model the planner (and the vanilla agent) is that model and the quarantined extractor stays z-ai/glm-5.3-flash. Every count is over all attack runs, with the 95% Wilson interval; the intervals of the smaller run are wide. Held without a task counts attack runs where the planner produced no task for the owner request, so nothing ran.',
    '',
    line(head),
    line(head.map(() => '---')),
    ...t1,
    '',
    line(head2),
    line(head2.map(() => '---')),
    ...t2,
    '',
    `Recorded cost, USD: ${base.meta.model} ${cost(base)} (V0 and the other configurations, ${base.runs.length} runs), ${costs}.`,
    END,
  ];
}

/** Rewrites the lines between the two markers; throws when a marker is missing or duplicated. */
export function replaceSensitivity(text: string, block: readonly string[]): string {
  const lines = text.split('\n');
  const begins = lines.flatMap((l, i) => (l === BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l === END ? [i] : []));
  const first = begins[0];
  const last = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || first === undefined || last === undefined || last < first) throw new Error('the doc needs exactly one begin and one end model-sensitivity SUITE marker line');
  return [...lines.slice(0, first), ...block, ...lines.slice(last + 1)].join('\n');
}

const read = (file: string): ResultsFile => ResultsFileSchema.parse(JSON.parse(readFileSync(resolve(file), 'utf8'))) as ResultsFile;

function main(): number {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { base: { type: 'string' }, frontier: { type: 'string' }, doc: { type: 'string' }, print: { type: 'boolean' } } });
  const block = sensitivityLines(read(values.base ?? 'results/final.json'), (values.frontier ?? 'results/frontier-v0.json,results/frontier-airlock.json,results/qwen36.json').split(',').map(read), loadCases(resolve('cases')));
  if (values.print === true) {
    console.log(block.join('\n'));
    return 0;
  }
  const doc = resolve(values.doc ?? '../docs/BENCH.md');
  const text = readFileSync(doc, 'utf8');
  const next = replaceSensitivity(text, block);
  if (next !== text) writeFileSync(doc, next, 'utf8');
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
export type { Case };

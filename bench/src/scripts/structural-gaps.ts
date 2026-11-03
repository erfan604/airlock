// The structural gaps table (AIR-306): for each baseline case (bench/cases/own-baselines.jsonl, recorded into bench/results/baselines-extra.json
// with its own recordings) how many of the 10 runs ended with the attacker paid, per design. CAPS, BLOCKLIST, MANDATE and MANDATE-C are derived
// from the stored V0 runs (baselines/derive.ts); V0, A1 and A2 are stored runs. A pure function of the results file and the cases: no date,
// no path. Run as
//   pnpm -C bench exec tsx src/scripts/structural-gaps.ts [--results <file>] [--doc <file>] [--print]
// Paths are relative to bench/. Without --print the block between the structural-gaps SUITE markers of the doc is rewritten (exit 1 when a marker is missing).
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deriveBaselines } from '../baselines/derive.ts';
import { loadCases } from '../runner/cases.ts';
import { ResultsFileSchema } from '../runner/record.ts';
import type { RunRecord } from '../runner/record.ts';
import { cell } from '../stats/format.ts';
import { row } from '../stats/metrics.ts';

export const BEGIN = '<!-- BEGIN SUITE structural-gaps -->';
export const END = '<!-- END SUITE structural-gaps -->';
const COLUMNS = ['V0', 'CAPS', 'BLOCKLIST', 'MANDATE', 'MANDATE-C', 'A1', 'A2'] as const;

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The lines of the block, markers included. */
export function gapLines(stored: readonly RunRecord[], derived: readonly RunRecord[]): string[] {
  const all = [...stored, ...derived];
  const ids = [...new Set(stored.filter((r) => r.kind === 'attack').map((r) => r.case))].sort(byCode);
  const lines = [
    BEGIN,
    'Attacker paid, runs of 10 per design (Wilson 95% interval). V0, A1 and A2 are recorded runs; CAPS, BLOCKLIST, MANDATE and MANDATE-C are derived from the recorded V0 runs. A case where V0 shows 0 is one the model did not follow, so no guard can be told from another on it.',
    '',
    `| Case | ${COLUMNS.join(' | ')} |`,
    `| --- | ${COLUMNS.map(() => '---').join(' | ')} |`,
  ];
  for (const id of ids) {
    const cells = COLUMNS.map((config) => {
      const runs = all.filter((r) => r.case === id && r.config === config && r.kind === 'attack');
      return runs.length === 0 ? 'n/a' : cell(row(runs.filter((r) => r.attackSucceeded === true).length, runs.length));
    });
    lines.push(`| ${id} | ${cells.join(' | ')} |`);
  }
  lines.push(END);
  return lines;
}

/** Rewrites the lines between the two markers; throws when a marker is missing or duplicated. */
export function replaceGaps(text: string, block: readonly string[]): string {
  const lines = text.split('\n');
  const begins = lines.flatMap((l, i) => (l === BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l === END ? [i] : []));
  const first = begins[0];
  const last = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || first === undefined || last === undefined || last < first) throw new Error('the doc needs exactly one begin and one end structural-gaps SUITE marker line');
  return [...lines.slice(0, first), ...block, ...lines.slice(last + 1)].join('\n');
}

function main(): number {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { results: { type: 'string' }, doc: { type: 'string' }, print: { type: 'boolean' } } });
  const results = ResultsFileSchema.parse(JSON.parse(readFileSync(resolve(values.results ?? 'results/baselines-extra.json'), 'utf8')));
  const cases = loadCases(resolve('cases'));
  const stored = results.runs as RunRecord[];
  const block = gapLines(stored, deriveBaselines(stored, cases));
  if (values.print === true) {
    console.log(block.join('\n'));
    return 0;
  }
  const doc = resolve(values.doc ?? '../docs/BENCH.md');
  const text = readFileSync(doc, 'utf8');
  const next = replaceGaps(text, block);
  if (next !== text) writeFileSync(doc, next, 'utf8');
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();

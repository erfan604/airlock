// Writes the tables of the generated block of docs/BENCH.md as JSON for the console's Bench page (AIR-192). Run as
//   pnpm -C bench exec tsx src/scripts/web-bench-json.ts [--results <file>] [--out <file>] [--gaps <file>|none] [--check <markdown file>] [--fixture]
// Paths are relative to bench/. Defaults: results/latest.json, ../web/public/bench.json, results/baselines-extra.json for the structural gaps
// table. The value is `benchTables(results, deriveBaselines(...), gapTable(...))`, the same one `renderBlock` prints, so the page shows the
// markdown's cell text. `--check docs/BENCH.md` rebuilds each markdown row from the JSON (`| ` plus the cells joined by ` | ` plus ` |`) and exits
// 1 with `BENCH JSON MISMATCH <line>` unless every row occurs, in order, inside the generated block (the gaps rows inside their SUITE block).
// `--fixture` builds the AIR-223 worked fixture instead (default out ../web/fixtures/bench.json).
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deriveBaselines } from '../baselines/derive.ts';
import { BEGIN_MARKER, END_MARKER } from '../report/render.ts';
import { benchTables, gapTable, tableLines } from '../report/tables.ts';
import type { BenchTables, Table } from '../report/tables.ts';
import { BEGIN as GAP_BEGIN, END as GAP_END } from './structural-gaps.ts';
import { loadCases } from '../runner/cases.ts';
import { ResultsFileSchema } from '../runner/record.ts';
import type { ResultsFile, RunRecord } from '../runner/record.ts';
import { fixtureRuns, resultsOf } from '../../test/helpers/runs.ts';

const readResults = (file: string): ResultsFile => ResultsFileSchema.parse(JSON.parse(readFileSync(resolve(file), 'utf8'))) as ResultsFile;

/** The row lines of a table, without the head and the separator. */
const rowLines = (t: Table): string[] => tableLines(t).slice(2);

/** The first row line that does not occur, in order, in `lines`; null when all do. The cursor only moves forward. */
export function firstMissing(rows: readonly string[], lines: readonly string[]): string | null {
  let at = 0;
  for (const row of rows) {
    const found = lines.indexOf(row, at);
    if (found === -1) return row;
    at = found + 1;
  }
  return null;
}

function between(text: string, begin: string, end: string): string[] {
  const lines = text.split('\n');
  const a = lines.indexOf(begin);
  const b = lines.indexOf(end);
  return a === -1 || b === -1 || b < a ? [] : lines.slice(a + 1, b);
}

/** Null when the markdown holds every row of the tables, else the first row that it does not. */
export function checkAgainst(t: BenchTables, markdown: string): string | null {
  const main = [t.attack, ...(t.attackFeasible === null ? [] : [t.attackFeasible]), ...(t.breakdown === null ? [] : [t.breakdown]), t.benign, ...t.completion, t.outcomes, t.owner].flatMap(rowLines);
  const miss = firstMissing(main, between(markdown, BEGIN_MARKER, END_MARKER));
  if (miss !== null) return miss;
  return t.gaps === null ? null : firstMissing(rowLines(t.gaps), between(markdown, GAP_BEGIN, GAP_END));
}

function build(values: { results?: string; gaps?: string; fixture?: boolean }): BenchTables {
  // the helper's case_meta types the group as a string; its groups are the runner's
  if (values.fixture === true) return benchTables(resultsOf(fixtureRuns()) as unknown as ResultsFile);
  const results = readResults(values.results ?? 'results/latest.json');
  const cases = loadCases(resolve('cases'));
  const baselines = deriveBaselines(results.runs, cases);
  let gaps: Table | null = null;
  if (values.gaps !== 'none') {
    const extra = readResults(values.gaps ?? 'results/baselines-extra.json');
    const stored = extra.runs as RunRecord[];
    gaps = gapTable(stored, deriveBaselines(stored, loadCases(resolve('cases'))));
  }
  return benchTables(results, baselines, gaps, cases);
}

function main(): number {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { results: { type: 'string' }, out: { type: 'string' }, gaps: { type: 'string' }, check: { type: 'string' }, fixture: { type: 'boolean' } } });
  const tables = build(values);
  if (values.check !== undefined) {
    const miss = checkAgainst(tables, readFileSync(resolve(values.check), 'utf8'));
    if (miss !== null) {
      console.log(`BENCH JSON MISMATCH ${miss}`);
      return 1;
    }
    console.log(`BENCH JSON OK ${tables.attack.rows.length} attack rows, ${tables.benign.rows.length} benign rows`);
    return 0;
  }
  const out = resolve(values.out ?? (values.fixture === true ? '../web/fixtures/bench.json' : '../web/public/bench.json'));
  const next = JSON.stringify(tables) + '\n';
  let prev = '';
  try {
    prev = readFileSync(out, 'utf8');
  } catch {
    prev = '';
  }
  if (prev !== next) writeFileSync(out, next, 'utf8');
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();

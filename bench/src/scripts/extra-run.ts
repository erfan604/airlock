// extra-run (AIR-288): the Should tier needs no model, key or budget. It asserts every case of `cases/should` under A1 and A2, runs the static rows,
// computes the field_content counts and merges the `extra` section into `bench/results/<name>.json` (created with empty runs when absent; `runs`
// is never touched). Run it as
//   pnpm -C bench exec tsx src/scripts/extra-run.ts --name <name>
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExtra } from '../extra/assert.ts';
import { fieldContentOf } from '../extra/field-content.ts';
import { expandGen } from '../extra/unicode-gen.ts';
import { writeExtra } from '../extra/results.ts';
import { runStaticRows, spawnExec, staticSummary } from '../extra/static.ts';
import type { Exec } from '../extra/static.ts';
import type { ExtraCaseRow, ExtraSection } from '../extra/types.ts';
import { BENCH_ROOT } from '../runner/assets.ts';
import { VerdictCliBackend } from '../runner/backend.ts';
import { loadCases } from '../runner/cases.ts';
import type { RunRecord } from '../runner/record.ts';
import { loadStaticRows } from './static-rows.ts';

const USAGE = 'usage: extra-run.ts --name <name>';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface ExtraRunIo {
  root?: string;
  /** the directory of the results files (default: `bench/results` next to the root) */
  resultsDir?: string;
  exec?: Exec;
  out?: (line: string) => void;
}

// the stored runs of the named results file, or none when it does not exist yet
function storedRuns(file: string): RunRecord[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: RunRecord[] };
  return parsed.runs ?? [];
}

/** The command line; returns the exit code (0 all assertions hold and no row failed, 1 otherwise, 2 usage). */
export async function main(argv: string[], io: ExtraRunIo = {}): Promise<number> {
  const root = resolve(io.root ?? BENCH_ROOT);
  const out = io.out ?? ((line: string): void => console.log(line));
  const name = argv.length === 2 && argv[0] === '--name' ? argv[1] : undefined;
  if (name === undefined || !NAME.test(name)) {
    out(USAGE);
    return 2;
  }
  const dir = resolve(io.resultsDir ?? join(dirname(root), 'bench', 'results'));
  const floor = loadCases(join(root, 'cases'));
  const should = loadCases(join(root, 'cases', 'should')).map(expandGen);
  const rows: ExtraCaseRow[] = [];
  let mismatches = 0;
  const backend = new VerdictCliBackend();
  try {
    for (const c of should) {
      const tags: Record<'A1' | 'A2', string> = { A1: '', A2: '' };
      for (const config of ['A1', 'A2'] as const) {
        const r = await assertExtra(c, config, backend);
        tags[config] = r.got;
        if (!r.ok) {
          mismatches += 1;
          out(`MISMATCH ${c.id} ${config} expected ${r.want} got ${r.got}`);
        }
      }
      rows.push({ id: c.id, group: c.group, tags: [...(c.tags ?? [])], a1: tags.A1, a2: tags.A2 });
    }
  } finally {
    await backend.close();
  }
  const result = await runStaticRows(loadStaticRows(root), { repoRoot: dirname(root), exec: io.exec ?? spawnExec });
  for (const note of result.notes) out(note);
  out(staticSummary(result));
  const shouldRows = rows.map((r) => ({ id: r.id, tags: r.tags, a1: r.a1, a2: r.a2 }));
  const extra: ExtraSection = {
    cases: rows,
    mismatches,
    rows: result.rows,
    field_content: fieldContentOf(floor, shouldRows, storedRuns(join(dir, `${name}.json`))),
  };
  const notRunFile = join(root, 'cases', 'not-run.json');
  const notRun = existsSync(notRunFile) ? (JSON.parse(readFileSync(notRunFile, 'utf8')) as unknown[]) : [];
  writeExtra({ dir, name, extra, notRun });
  out(`EXTRA RUN ${rows.length} cases, ${mismatches} mismatches, ${result.rows.length} rows`);
  return mismatches > 0 || result.missing.length > 0 || result.rows.some((r) => r.status === 'failed') ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}

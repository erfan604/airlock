// static-rows (AIR-288): runs the rows of `cases/should/static-rows.json` that are not agent cases (sandbox tests promoted into table rows, and the
// card tests of the console) and counts what ran. Run it as
//   pnpm -C bench exec tsx src/scripts/static-rows.ts [--write results/<name>.json]
// The contract rows need the policy wasm built (`cargo near build non-reproducible-wasm --no-abi` in the crate) and the env of scripts/env.sh.
// `--write` merges the rows into `extra.rows` of the named results file (a path relative to bench/; created when absent).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExtra, writeExtra } from '../extra/results.ts';
import { runStaticRows, spawnExec, staticExitCode, staticSummary } from '../extra/static.ts';
import type { Exec } from '../extra/static.ts';
import { NO_FIELD_CONTENT, StaticRowsSchema } from '../extra/types.ts';
import type { ExtraSection, StaticRow } from '../extra/types.ts';
import { BENCH_ROOT } from '../runner/assets.ts';

const USAGE = 'usage: static-rows.ts [--write results/<name>.json]';

/** The rows of `bench/cases/should/static-rows.json`, strictly parsed. */
export function loadStaticRows(root: string = BENCH_ROOT): StaticRow[] {
  return StaticRowsSchema.parse(JSON.parse(readFileSync(join(root, 'cases', 'should', 'static-rows.json'), 'utf8'))) as StaticRow[];
}

export interface StaticRowsIo {
  root?: string;
  exec?: Exec;
  out?: (line: string) => void;
}

/** The command line; returns the exit code (0 no row failed and no test is missing, 1 otherwise, 2 usage). */
export async function main(argv: string[], io: StaticRowsIo = {}): Promise<number> {
  const root = resolve(io.root ?? BENCH_ROOT);
  const out = io.out ?? ((line: string): void => console.log(line));
  let write: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write' && argv[i + 1] !== undefined && !(argv[i + 1] ?? '').startsWith('--')) write = argv[++i];
    else {
      out(USAGE);
      return 2;
    }
  }
  const rows = loadStaticRows(root);
  const result = await runStaticRows(rows, { repoRoot: dirname(root), exec: io.exec ?? spawnExec });
  for (const note of result.notes) out(note);
  out(staticSummary(result));
  if (write !== undefined) {
    const file = resolve(root, write);
    const dir = dirname(file);
    const name = basename(file).replace(/\.json$/, '');
    const before: ExtraSection | null = readExtra(dir, name);
    const extra: ExtraSection = before === null ? { cases: [], mismatches: 0, rows: result.rows, field_content: NO_FIELD_CONTENT } : { ...before, rows: result.rows };
    const notRunFile = join(root, 'cases', 'not-run.json');
    writeExtra({ dir, name, extra, notRun: existsSync(notRunFile) ? (JSON.parse(readFileSync(notRunFile, 'utf8')) as unknown[]) : [] });
  }
  return staticExitCode(result);
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}

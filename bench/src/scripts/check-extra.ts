// check-extra (AIR-288): asserts the expected A1 and A2 attack tag of every Should-tier case against the verdict CLI, with no model. Run it as
//   pnpm -C bench exec tsx src/scripts/check-extra.ts [--files <f>...]
// Paths are relative to bench/; the default is every `*.jsonl` file of `cases/should`. The Floor cases (`cases/*.jsonl`) are loaded too, so
// a counterpart resolves against `cases/utility.jsonl`. Per case: the static checks of `check-cases` (plans, goal and legit, world), the byte
// rules of every Should data file and payload text, the cross-case rules, then one assertion per case and configuration.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExtra } from '../extra/assert.ts';
import { BENCH_ROOT } from '../runner/assets.ts';
import { VerdictCliBackend } from '../runner/backend.ts';
import { CaseLoadError, caseOrigin, loadCases } from '../runner/cases.ts';
import type { Case } from '../runner/cases.ts';
import { byteProblems, extraProblems, staticProblems } from './check-cases.ts';

const USAGE = 'usage: check-extra.ts [--files <f>...]';
const CONFIGS = ['A1', 'A2'] as const;

export interface CheckExtraIo {
  /** the bench folder (default: the real one); `cases/`, `cases/should/` and `fixtures/` are read under it */
  root?: string;
  out?: (line: string) => void;
}

// every data file the byte rules cover for this tier: the Should case files and tables, and the payload and base texts
function dataFiles(root: string): string[] {
  const files: string[] = [];
  const list = (folder: string, ok: (name: string) => boolean): void => {
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder).sort()) if (ok(name)) files.push(join(folder, name));
  };
  list(join(root, 'cases', 'should'), (n) => n.endsWith('.jsonl') || n.endsWith('.json'));
  list(join(root, 'fixtures', 'payloads'), (n) => n.endsWith('.txt'));
  list(join(root, 'fixtures', 'base'), (n) => n.endsWith('.txt'));
  return files;
}

/** The command line; returns the exit code (0 every assertion holds, 1 a mismatch or a case that does not load, 2 usage). */
export async function main(argv: string[], io: CheckExtraIo = {}): Promise<number> {
  const root = resolve(io.root ?? BENCH_ROOT);
  const out = io.out ?? ((line: string): void => console.log(line));
  let files: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--files') {
      files = [];
      while (i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('--')) files.push(argv[++i] ?? '');
      if (files.length === 0) {
        out(USAGE);
        return 2;
      }
    } else {
      out(USAGE);
      return 2;
    }
  }
  let floor: Case[];
  let should: Case[];
  try {
    floor = loadCases(join(root, 'cases'));
    should = loadCases(join(root, 'cases', 'should'));
  } catch (e) {
    if (e instanceof CaseLoadError) {
      out(`LOAD ERROR ${e.message}`);
      return 1;
    }
    throw e;
  }
  const problems: string[] = [];
  for (const c of should) if (floor.some((f) => f.id === c.id)) problems.push(`INVALID ${c.id} id: the id is also a Floor case`);
  const wanted = files?.map((f) => (existsSync(resolve(root, f)) ? resolve(root, f) : resolve(f)));
  if (wanted !== undefined) {
    for (const [i, file] of wanted.entries()) if (!should.some((c) => caseOrigin(c)?.file === file)) problems.push(`INVALID ${files?.[i] ?? file} no Should case file of that name was loaded`);
  }
  const selected = should.filter((c) => {
    const origin = caseOrigin(c);
    return wanted === undefined || (origin !== undefined && wanted.includes(origin.file));
  });
  problems.push(...extraProblems([...floor, ...should]), ...dataFiles(root).flatMap(byteProblems));
  let assertions = 0;
  const backend = new VerdictCliBackend();
  try {
    for (const c of selected) {
      const bad = staticProblems(c);
      problems.push(...bad);
      if (bad.length > 0) continue;
      for (const config of CONFIGS) {
        assertions += 1;
        try {
          const r = await assertExtra(c, config, backend);
          if (!r.ok) problems.push(`MISMATCH ${c.id} ${config} expected ${r.want} got ${r.got}`);
        } catch (e) {
          problems.push(`ERROR ${c.id} ${config} ${e instanceof Error ? e.name : 'failure'}: ${e instanceof Error ? e.message : ''}`);
        }
      }
    }
  } finally {
    await backend.close();
  }
  for (const line of problems) out(line);
  if (problems.length > 0) {
    out(`EXTRA FAILED ${problems.length} problems in ${selected.length} cases`);
    return 1;
  }
  out(`EXTRA OK ${selected.length} cases, ${assertions} assertions`);
  return 0;
}


const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}

// The bench command line (AIR-220): `tsx src/cli.ts run [flags]` is `pnpm bench`, `tsx src/cli.ts replay [flags]` is `pnpm bench:replay`.
// `main` returns the exit code: 0 done, 1 replay mismatch, 2 usage, 3 budget, 4 case mismatch. Through the root `pnpm -r` script every nonzero
// code reads 1, so a person judges a run by its printed line (`BUDGET <spent> of <limit>`, the usage line, `MISMATCH`, `HooksProductUnavailable`).
// pnpm runs the scripts with the working directory bench/: path flags resolve against INIT_CWD (the directory pnpm was started in), and the
// outputs (bench/results, bench/runs, docs/BENCH.md) are found by walking up from bench/ to pnpm-workspace.yaml.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { attestModel } from '@airlock/runtime/attest';
import { BENCH_FRONTIER_PLANNERS, BENCH_FRONTIER_PLANNER_ENV, loadModelsConfig } from '@airlock/runtime/llm';
import { toBaseUnits } from '@airlock/runtime/money';
import { compromiseCommand } from './assume-compromise/index.ts';
import { BENCH_ROOT } from './runner/assets.ts';
import { verdictCliPath } from './runner/backend.ts';
import { CaseLoadError, caseOrigin, loadCases } from './runner/cases.ts';
import type { Case } from './runner/cases.ts';
import { HooksProductUnavailable, resolveHooks } from './runner/hooks.ts';
import { formatSpent, plannedRuns, runLive } from './runner/live.ts';
import { asciiJson } from './runner/record.ts';
import type { ResultsFile } from './runner/record.ts';
import { replay } from './runner/replay.ts';
import type { RunnerDeps } from './runner/run.ts';
import { v1PolicyFor } from './runner/v1.ts';
import { DERIVED_CONFIGS } from './runner/types.ts';
import type { Config } from './runner/types.ts';
import { checkCases } from './scripts/check-cases.ts';

export const USAGE =
  'usage: pnpm bench --model <id> [--configs V0,V1,V1-tight,A1,A2] [--n 10] [--cases <glob>] --budget-usd <decimal> [--concurrency <k>] [--name <name>] [--hooks none|product] [--dry-run] [--mode assume-compromise]\n' +
  'usage: pnpm bench:replay [--results <file>] [--recorded <dir>] [--cases <glob>] [--no-doc] [--block <name>]';

export interface Io {
  out(line: string): void;
  /** the directory path flags are resolved against */
  initCwd: string;
  paths: { results: string; runs: string; doc: string };
  deps: RunnerDeps;
  now(): Date;
}

function repoRoot(): string {
  let dir = BENCH_ROOT;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) return dirname(BENCH_ROOT);
    dir = up;
  }
}

/** The V1 numbers of AIR-224 and no not-run rows: AIR-226 passes the parsed `bench/cases/not-run.json` as `notRun`. */
export function defaultDeps(): RunnerDeps {
  return {
    policyFor: v1PolicyFor,
    notRun: [],
    attest: (model) => attestModel(model),
    compromise: (run) => compromiseCommand({ ...run, meta: { bench_commit: commitOf(), verdict_cli_sha256: sha256Of(verdictCliPath()) } }),
  };
}

export function defaultIo(): Io {
  const root = repoRoot();
  return {
    out: (line) => console.log(line),
    initCwd: process.env['INIT_CWD'] ?? process.cwd(),
    paths: { results: join(root, 'bench', 'results'), runs: join(root, 'bench', 'runs'), doc: join(root, 'docs', 'BENCH.md') },
    deps: defaultDeps(),
    now: () => new Date(),
  };
}

const CONFIG_NAMES: readonly string[] = ['V0', 'V1', 'V1-tight', 'V2', 'V3', 'A1', 'A2', 'CAPS', 'BLOCKLIST', 'MANDATE', 'MANDATE-C'];
const DEFAULT_CONFIGS: Config[] = ['V0', 'V1', 'V1-tight', 'A1', 'A2'];
const POSITIVE = /^[1-9][0-9]{0,5}$/;
const DECIMAL = /^[0-9]+(\.[0-9]{1,9})?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// `<dir>/<glob>` with * in the last segment, or a directory; the cases of the matching files, in name order
function loadByGlob(pattern: string): Case[] {
  const last = basename(pattern);
  if (!last.includes('*') && !last.endsWith('.jsonl')) return loadCases(pattern);
  const re = new RegExp('^' + last.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return loadCases(dirname(pattern)).filter((c) => {
    const origin = caseOrigin(c);
    return origin !== undefined && re.test(basename(origin.file));
  });
}

function usage(io: Io): number {
  for (const line of USAGE.split('\n')) io.out(line);
  return 2;
}

type Flags = Record<string, string | boolean | undefined>;

function parse(argv: string[]): Flags | null {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        model: { type: 'string' },
        configs: { type: 'string' },
        n: { type: 'string' },
        cases: { type: 'string' },
        'budget-usd': { type: 'string' },
        concurrency: { type: 'string' },
        name: { type: 'string' },
        hooks: { type: 'string' },
        mode: { type: 'string' },
        'dry-run': { type: 'boolean' },
        results: { type: 'string' },
        recorded: { type: 'string' },
        'no-doc': { type: 'boolean' },
        block: { type: 'string' },
      },
    }).values;
  } catch {
    return null;
  }
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function sha256Of(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'unknown';
  }
}

function commitOf(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: BENCH_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

async function runCommand(flags: Flags, io: Io): Promise<number> {
  if (str(flags['results']) !== undefined || str(flags['recorded']) !== undefined || flags['no-doc'] === true || str(flags['block']) !== undefined) return usage(io);
  const mode = str(flags['mode']);
  if (mode !== undefined && mode !== 'assume-compromise') return usage(io);
  if (mode === 'assume-compromise') {
    const text = str(flags['configs']);
    const wanted = text === undefined ? ['A1', 'A2'] : text.split(',');
    if (wanted.length === 0 || new Set(wanted).size !== wanted.length || wanted.some((c) => c !== 'A1' && c !== 'A2')) return usage(io);
    const acName = str(flags['name']) ?? io.now().toISOString().slice(0, 10);
    if (!NAME.test(acName)) return usage(io);
    if (io.deps.compromise === undefined) {
      io.out('assume-compromise: no handler is registered (AIR-222)');
      return 0;
    }
    // AIR-321: `--cases` names the attack cases whose gate paths are played (the default is own-abc.jsonl and own-sxp.jsonl)
    const given = str(flags['cases']);
    let chosen: Case[] | undefined;
    if (given !== undefined) {
      try {
        chosen = loadByGlob(resolve(io.initCwd, given));
      } catch (e) {
        if (e instanceof CaseLoadError) {
          io.out(e.message);
          return 1;
        }
        throw e;
      }
      if (chosen.length === 0) return usage(io);
    }
    return io.deps.compromise({ configs: wanted as Array<'A1' | 'A2'>, name: acName, resultsDir: io.paths.results, out: (l) => io.out(l), ...(chosen === undefined ? {} : { cases: chosen }) });
  }
  const hooksName = str(flags['hooks']) ?? 'none';
  if (hooksName !== 'none' && hooksName !== 'product') return usage(io);
  const configText = str(flags['configs']);
  const configs: Config[] = configText === undefined ? DEFAULT_CONFIGS : (configText.split(',') as Config[]);
  if (configs.length === 0 || configs.some((c) => !CONFIG_NAMES.includes(c) || DERIVED_CONFIGS.includes(c as Config)) || new Set(configs).size !== configs.length) return usage(io);
  if (configs.includes('V2') && io.deps.v2Agent === undefined) {
    io.out('V2 is not built');
    return 2;
  }
  const nText = str(flags['n']) ?? '10';
  const concText = str(flags['concurrency']) ?? '4';
  if (!POSITIVE.test(nText) || !POSITIVE.test(concText)) return usage(io);
  const n = +nText;
  const concurrency = +concText;
  const name = str(flags['name']) ?? io.now().toISOString().slice(0, 10);
  if (!NAME.test(name)) return usage(io);

  const pattern = str(flags['cases']) === undefined ? join(BENCH_ROOT, 'cases', '*.jsonl') : resolve(io.initCwd, str(flags['cases']) ?? '');
  let cases: Case[];
  try {
    cases = loadByGlob(pattern);
  } catch (e) {
    if (e instanceof CaseLoadError) {
      io.out(`MISMATCH ${e.message}`);
      return 4;
    }
    throw e;
  }
  if (flags['dry-run'] === true) {
    io.out(`PLAN ${plannedRuns(cases, configs, n).length} runs`);
    return 0;
  }
  const model = str(flags['model']);
  const budgetText = str(flags['budget-usd']);
  if (model === undefined || budgetText === undefined || !DECIMAL.test(budgetText)) return usage(io);
  try {
    await resolveHooks(hooksName);
  } catch (e) {
    if (e instanceof HooksProductUnavailable) {
      io.out('HooksProductUnavailable');
      return 2;
    }
    throw e;
  }
  const checked = await checkCases(cases);
  if (checked.mismatches.length > 0) {
    for (const line of checked.mismatches.slice(0, 20)) io.out(`MISMATCH ${line}`);
    return 4;
  }

  const outDir = join(io.paths.runs, `live-${name}`);
  mkdirSync(join(outDir, 'llm'), { recursive: true });
  const saved = { mode: process.env['LLM_MODE'], dir: process.env['LLM_RECORDINGS_DIR'] };
  process.env['LLM_MODE'] = 'record';
  process.env['LLM_RECORDINGS_DIR'] = resolve(outDir, 'llm');
  // the model sensitivity run of AIRLOCK itself: a listed non-TEE planner is allowed for this process only (runtime/src/llm/models.ts)
  const savedBench = process.env[BENCH_FRONTIER_PLANNER_ENV];
  if (BENCH_FRONTIER_PLANNERS.includes(model)) process.env[BENCH_FRONTIER_PLANNER_ENV] = '1';
  const setup = loadModelsConfig();
  // the report endpoint is not billed; a missing key or a failed check is printed and stored, the run goes on (fail closed means the receipt says so)
  const att = io.deps.attest === undefined ? undefined : await io.deps.attest(model);
  if (att !== undefined) io.out(`ATTEST ${att.status} ${att.model} ${att.report_sha256 === '' ? 'no report' : `report_sha256 ${att.report_sha256}`}`);
  try {
    const done = await runLive({
      cases,
      configs,
      n,
      model,
      quarantineModel: setup.quarantine,
      temperature: setup.temperature,
      seed: setup.seed,
      name,
      hooksName,
      budgetNano: toBaseUnits(budgetText, 9),
      concurrency,
      outDir,
      deps: io.deps,
      log: () => undefined,
    });
    if (done.stoppedByBudget) {
      io.out(`BUDGET ${formatSpent(done.spentNano)} of ${budgetText}`);
      return 3;
    }
    const results: ResultsFile = {
      meta: {
        name,
        model,
        quarantine_model: setup.quarantine,
        temperature: setup.temperature,
        seed: setup.seed,
        n,
        configs,
        hooks: hooksName,
        budget_usd: budgetText,
        bench_commit: commitOf(),
        verdict_cli_sha256: sha256Of(verdictCliPath()),
        ...(att === undefined
          ? {}
          : { attestation: { model: att.model, status: att.status, nonce: att.nonce, report_sha256: att.report_sha256, verified_at: att.verified_at, checks: att.checks.map((c) => (c.ok || c.detail === undefined ? { name: c.name, ok: c.ok } : { name: c.name, ok: c.ok, detail: c.detail })) } }),
      },
      case_meta: Object.fromEntries(cases.map((c) => [c.id, { group: c.group, legitIsPayment: c.legit.action === 'transfer', tags: [...(c.tags ?? [])] }])),
      not_run: io.deps.notRun ?? [],
      runs: done.records,
    };
    mkdirSync(io.paths.results, { recursive: true });
    const file = join(io.paths.results, `${name}.json`);
    writeFileSync(file, asciiJson(results, 1) + '\n', 'utf8');
    copyFileSync(file, join(io.paths.results, 'latest.json'));
    io.out(`SUMMARY runs ${done.records.length} errors ${done.errors} cost ${formatSpent(done.spentNano)}`);
    return 0;
  } finally {
    if (saved.mode === undefined) delete process.env['LLM_MODE'];
    else process.env['LLM_MODE'] = saved.mode;
    if (saved.dir === undefined) delete process.env['LLM_RECORDINGS_DIR'];
    else process.env['LLM_RECORDINGS_DIR'] = saved.dir;
    if (savedBench === undefined) delete process.env[BENCH_FRONTIER_PLANNER_ENV];
    else process.env[BENCH_FRONTIER_PLANNER_ENV] = savedBench;
  }
}

async function replayCommand(flags: Flags, io: Io): Promise<number> {
  for (const k of ['model', 'configs', 'n', 'budget-usd', 'concurrency', 'name', 'hooks', 'mode', 'dry-run']) if (flags[k] !== undefined) return usage(io);
  const recorded = resolve(io.initCwd, str(flags['recorded']) ?? join(io.paths.runs, 'recorded'));
  const results = resolve(io.initCwd, str(flags['results']) ?? join(io.paths.results, 'final.json'));
  // a recorded directory that holds its own cases/ replays those (the cases the runs were made on); otherwise bench/cases
  const frozen = join(recorded, 'cases');
  const given = str(flags['cases']);
  const pattern = given !== undefined ? resolve(io.initCwd, given) : existsSync(frozen) ? frozen : join(BENCH_ROOT, 'cases', '*.jsonl');
  let cases: Case[];
  try {
    cases = loadByGlob(pattern);
  } catch (e) {
    if (e instanceof CaseLoadError) {
      io.out(`MISMATCH ${e.message}`);
      return 4;
    }
    throw e;
  }
  const block = str(flags['block']);
  if (block !== undefined && !NAME.test(block)) return usage(io);
  // a recording of the bench-only frontier planner replays with the same switch the live run set
  let planner = 'tee';
  try {
    const m = (JSON.parse(readFileSync(results, 'utf8')) as { meta?: { model?: unknown } }).meta?.model;
    if (typeof m === 'string' && BENCH_FRONTIER_PLANNERS.includes(m)) planner = 'bench';
  } catch {
    // a missing or unreadable results file is reported by replay itself
  }
  if (planner === 'bench') process.env[BENCH_FRONTIER_PLANNER_ENV] = '1';
  return replay({ results, recorded, cases, deps: io.deps, doc: flags['no-doc'] === true ? null : io.paths.doc, ...(block === undefined ? {} : { block }), out: (l) => io.out(l) });
}

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parse(rest);
  if (flags === null || (command !== 'run' && command !== 'replay')) return usage(io);
  return command === 'run' ? runCommand(flags, io) : replayCommand(flags, io);
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}

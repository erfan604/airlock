// The static rows (AIR-288): contract rows run sandbox tests by exact name, card rows run a web test script and read its two TAP counts. The
// runner executes the libtest separator form once for the distinct test names of all contract rows, reads each `test <name> ... ok` line, and
// never counts an assertion it did not see: a name absent from the output is MISSING. `Exec` is injected so a captured output can stand in.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutedRow, StaticRow } from './types.ts';

export type Exec = (cwd: string, argv: readonly string[]) => Promise<{ stdout: string; code: number }>;

export interface StaticEnv {
  /** the repo root: `crate`, `cwd` and `needs` of a row are relative to it */
  repoRoot: string;
  exec: Exec;
}

export interface StaticResult {
  rows: ExecutedRow[];
  /** the test names a contract row named that no `test <name> ...` line of the output carries */
  missing: string[];
  /** the lines to print: SKIP, MISSING and FAILED notes */
  notes: string[];
}

/** The default executor: runs `argv` in `cwd`, collects stdout (large), and returns the exit code instead of throwing on a nonzero one. */
export const spawnExec: Exec = (cwd, argv) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (cmd === undefined) {
      resolve({ stdout: '', code: 2 });
      return;
    }
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
      resolve({ stdout, code });
    });
  });

/** The outcome of each test a libtest run printed: `ok` or `FAILED` (ignored tests are not recorded). */
export function parseLibtest(stdout: string): Map<string, 'ok' | 'FAILED'> {
  const out = new Map<string, 'ok' | 'FAILED'>();
  for (const line of stdout.split('\n')) {
    const m = /^test (\S+) \.\.\. (ok|FAILED)$/.exec(line.trimEnd());
    if (m !== null && m[1] !== undefined && (m[2] === 'ok' || m[2] === 'FAILED')) out.set(m[1], m[2]);
  }
  return out;
}

function executed(row: StaticRow, passed: number, of: number, status: ExecutedRow['status']): ExecutedRow {
  return { id: row.id, group: row.group, kind: row.kind, passed, of, status, covered_by: row.covered_by, expect: row.expect, covers: [...(row.covers ?? [])] };
}

// the first capture group of a regular expression over the TAP text, as a count; null when it does not match
function tapCount(re: string, text: string): number | null {
  const digits = new RegExp(re, 'm').exec(text)?.[1];
  // up to nine digits, summed by place value: a test count, never an amount, and the lint bans the number parsers
  if (digits === undefined || !/^[0-9]{1,9}$/.test(digits)) return null;
  return Array.from(digits).reduce((n, ch) => n * 10 + (ch.charCodeAt(0) - 48), 0);
}

async function runContracts(rows: readonly Extract<StaticRow, { kind: 'contract' }>[], env: StaticEnv, result: StaticResult): Promise<Map<string, ExecutedRow>> {
  const done = new Map<string, ExecutedRow>();
  // one call per (crate, test_bin): the distinct names of all its rows, in first-use order
  const groups = new Map<string, { crate: string; bin: string; names: string[]; rows: Extract<StaticRow, { kind: 'contract' }>[] }>();
  for (const row of rows) {
    const key = `${row.crate}\u0000${row.test_bin}`;
    const g = groups.get(key) ?? { crate: row.crate, bin: row.test_bin, names: [], rows: [] };
    for (const t of row.tests) if (!g.names.includes(t)) g.names.push(t);
    g.rows.push(row);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const run = await env.exec(join(env.repoRoot, g.crate), ['cargo', 'test', '--test', g.bin, '--', '--exact', ...g.names]);
    const seen = parseLibtest(run.stdout);
    for (const name of g.names) {
      if (!seen.has(name)) {
        result.missing.push(name);
        result.notes.push(`MISSING ${name}`);
      } else if (seen.get(name) === 'FAILED') result.notes.push(`FAILED ${name}`);
    }
    for (const row of g.rows) {
      const passed = row.tests.filter((t) => seen.get(t) === 'ok').length;
      done.set(row.id, executed(row, passed, row.tests.length, passed === row.tests.length ? 'passed' : 'failed'));
    }
  }
  return done;
}

/**
 * Runs the rows. Contract rows share one libtest call per crate and test binary; a card row runs its `argv` in `cwd` and reads `passed_re` and
 * `of_re` from the output, and is `skipped` (0 of 0, a SKIP note) when its `needs` file does not exist. Rows come back in the order given.
 */
export async function runStaticRows(rows: readonly StaticRow[], env: StaticEnv): Promise<StaticResult> {
  const result: StaticResult = { rows: [], missing: [], notes: [] };
  const contracts = await runContracts(
    rows.filter((r): r is Extract<StaticRow, { kind: 'contract' }> => r.kind === 'contract'),
    env,
    result,
  );
  for (const row of rows) {
    if (row.kind === 'contract') {
      const done = contracts.get(row.id);
      if (done !== undefined) result.rows.push(done);
      continue;
    }
    if (!existsSync(join(env.repoRoot, row.needs))) {
      result.notes.push(`SKIP ${row.id} ${row.needs} does not exist yet`);
      result.rows.push(executed(row, 0, 0, 'skipped'));
      continue;
    }
    const run = await env.exec(join(env.repoRoot, row.cwd), row.argv);
    const passed = tapCount(row.passed_re, run.stdout);
    const of = tapCount(row.of_re, run.stdout);
    if (passed === null || of === null) {
      result.notes.push(`FAILED ${row.id} the output has no test counts`);
      result.rows.push(executed(row, 0, 0, 'failed'));
    } else {
      if (passed !== of) result.notes.push(`FAILED ${row.id} ${passed} of ${of} passed`);
      result.rows.push(executed(row, passed, of, passed === of && of > 0 && run.code === 0 ? 'passed' : 'failed'));
    }
  }
  return result;
}

/** 1 when a row failed or a named test is missing; a skipped row is not a failure. */
export function staticExitCode(r: StaticResult): number {
  return r.missing.length > 0 || r.rows.some((row) => row.status === 'failed') ? 1 : 0;
}

/** `STATIC ROWS <executed> executed, <skipped> skipped, <failed> failed`: executed counts every row that ran, a failed one included. */
export function staticSummary(r: StaticResult): string {
  const skipped = r.rows.filter((row) => row.status === 'skipped').length;
  const failed = r.rows.filter((row) => row.status === 'failed').length;
  return `STATIC ROWS ${r.rows.length - skipped} executed, ${skipped} skipped, ${failed} failed`;
}

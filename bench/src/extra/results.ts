// Merging the `extra` section into a results file (AIR-288). The file is read as plain JSON and only its `extra` key is set, so `runs`, `meta` and
// every other key stay exactly as they were; a file that does not exist is created with empty `runs`. `latest.json` follows the named file only
// when it equalled the old file byte for byte (it is a copy of it), never when it is a different results file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCH_ROOT } from '../runner/assets.ts';
import { verdictCliPath } from '../runner/backend.ts';
import { asciiJson } from '../runner/record.ts';
import type { ExtraSection } from './types.ts';

function commitOf(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: BENCH_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

function verdictSha(): string {
  try {
    return createHash('sha256').update(readFileSync(verdictCliPath())).digest('hex');
  } catch {
    return 'unknown';
  }
}

// a results file with no runs: the rows of this tier need no model, key or budget
function emptyResults(name: string, notRun: readonly unknown[]): Record<string, unknown> {
  return {
    meta: {
      name,
      model: 'none',
      quarantine_model: 'none',
      temperature: 0,
      seed: 0,
      n: 1,
      configs: [],
      hooks: 'none',
      budget_usd: '0',
      bench_commit: commitOf(),
      verdict_cli_sha256: verdictSha(),
    },
    case_meta: {},
    not_run: [...notRun],
    runs: [],
  };
}

/**
 * Sets `extra` in `<dir>/<name>.json` (created with empty runs and the given Not run rows when absent) and returns the path. `latest.json` in the
 * same directory is replaced by the new file only when it was identical to the old one.
 */
export function writeExtra(o: { dir: string; name: string; extra: ExtraSection; notRun?: readonly unknown[] }): string {
  const file = join(o.dir, `${o.name}.json`);
  const latest = join(o.dir, 'latest.json');
  let doc: Record<string, unknown>;
  let oldText: string | null = null;
  if (existsSync(file)) {
    oldText = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(oldText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} is not a results file`);
    doc = parsed as Record<string, unknown>;
  } else {
    doc = emptyResults(o.name, o.notRun ?? []);
  }
  doc['extra'] = o.extra;
  mkdirSync(o.dir, { recursive: true });
  writeFileSync(file, asciiJson(doc, 1) + '\n', 'utf8');
  if (oldText !== null && existsSync(latest) && readFileSync(latest, 'utf8') === oldText) copyFileSync(file, latest);
  return file;
}

/** The rows only: the section of an existing file keeps its cases and counts, a new one starts empty (`extra-run` fills the rest). */
export function readExtra(dir: string, name: string): ExtraSection | null {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { extra?: ExtraSection };
  return parsed.extra ?? null;
}

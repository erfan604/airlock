// The replay (AIR-220): no keys and no network. Every (case, config, run) of the results file is run again through the same runner code
// with LLM_MODE=replay against the recorded model answers, the verdict CLI and the oracle. Latency and cost are measurements: they are
// read from the stored transcript, as are the call counts. The re-derived record is compared field by field with the stored one.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NoRecording } from '@airlock/runtime/llm';
import type { LlmCall } from '@airlock/runtime/llm';
import type { Case } from './cases.ts';
import { HooksProductUnavailable, resolveHooks } from './hooks.ts';
import { ResultsFileSchema, readTranscript } from './record.ts';
import type { ResultsFile, RunRecord, Transcript } from './record.ts';
import { renderBlock, replace } from '../report/render.ts';
import { BenchSession, finishRecord } from './run.ts';
import type { RunnerDeps } from './run.ts';

export interface ReplayOptions {
  results: string;
  recorded: string;
  /** the cases of the results file (the caller loads them) */
  cases: readonly Case[];
  deps: RunnerDeps;
  /** the file whose generated block is rewritten, or null for `--no-doc` */
  doc: string | null;
  out(line: string): void;
}

const MAX_DIFFS = 20;

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Checks `<recorded>/MANIFEST.sha256` (lines of `<sha256>  <path relative to recorded>`) when it exists; returns the bad paths. */
export function manifestProblems(recorded: string): string[] {
  const file = join(recorded, 'MANIFEST.sha256');
  if (!existsSync(file)) return [];
  const bad: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      bad.push(line.slice(0, 80));
      continue;
    }
    const path = join(recorded, m[2]);
    if (m[2].includes('..') || !existsSync(path) || sha256File(path) !== m[1]) bad.push(m[2]);
  }
  return bad;
}

// the re-derived calls must be the stored ones; cost, latency and the cached flag are measurements and come from the stored entry
function mergeMeasurements(derived: readonly LlmCall[], stored: readonly LlmCall[]): LlmCall[] | null {
  if (derived.length !== stored.length) return null;
  const merged: LlmCall[] = [];
  for (const [i, d] of derived.entries()) {
    const s = stored[i];
    if (s === undefined) return null;
    const same =
      d.requestHash === s.requestHash &&
      d.responseHash === s.responseHash &&
      d.role === s.role &&
      d.model === s.model &&
      d.route === s.route &&
      d.isStandIn === s.isStandIn &&
      d.usage.prompt === s.usage.prompt &&
      d.usage.completion === s.usage.completion;
    if (!same) return null;
    merged.push({ ...d, latencyMs: s.latencyMs, costUsd: s.costUsd, cached: s.cached });
  }
  return merged;
}

function differingFields(a: RunRecord, b: RunRecord): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  return keys.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
}

/** Returns the exit code: 0 and `REPLAY OK <n> runs`, or 1 after `REPLAY MISMATCH <case> <config> <run> <field>` lines (at most 20). */
export async function replay(o: ReplayOptions): Promise<number> {
  const recorded = resolve(o.recorded);
  const bad = manifestProblems(recorded);
  if (bad.length > 0) {
    for (const p of bad.slice(0, MAX_DIFFS)) o.out(`REPLAY MANIFEST ${p}`);
    return 1;
  }
  let results: ResultsFile;
  try {
    results = ResultsFileSchema.parse(JSON.parse(readFileSync(resolve(o.results), 'utf8'))) as ResultsFile;
  } catch {
    o.out('REPLAY BAD RESULTS the results file is missing or does not parse');
    return 1;
  }
  const byId = new Map(o.cases.map((c) => [c.id, c] as const));
  const { meta } = results;
  let hooks;
  try {
    hooks = await resolveHooks(meta.hooks);
  } catch (e) {
    if (e instanceof HooksProductUnavailable) {
      o.out('HooksProductUnavailable');
      return 1;
    }
    throw e;
  }

  const saved = { mode: process.env['LLM_MODE'], dir: process.env['LLM_RECORDINGS_DIR'] };
  process.env['LLM_MODE'] = 'replay';
  process.env['LLM_RECORDINGS_DIR'] = join(recorded, 'llm');
  const session = new BenchSession({
    cases: o.cases,
    model: meta.model,
    quarantineModel: meta.quarantine_model,
    temperature: meta.temperature,
    seed: meta.seed,
    hooksName: meta.hooks,
    hooks,
    deps: o.deps,
  });
  let diffs = 0;
  let count = 0;
  try {
    for (const stored of results.runs) {
      if (stored.derived === true) continue;
      const c = byId.get(stored.case);
      if (c === undefined) {
        o.out(`REPLAY MISMATCH ${stored.case} ${stored.config} ${stored.run} case`);
        diffs += 1;
        if (diffs >= MAX_DIFFS) break;
        continue;
      }
      const ran = await session.execute(c, stored.config, stored.run);
      if (ran.thrown instanceof NoRecording) {
        o.out(ran.thrown.message);
        return 1;
      }
      let transcript: Transcript = ran.transcript;
      const path = join(recorded, stored.transcript);
      const fields: string[] = [];
      if (existsSync(path)) {
        const merged = mergeMeasurements(ran.transcript.llm, readTranscript(path).llm);
        if (merged === null) fields.push('llm');
        else transcript = { ...ran.transcript, llm: merged };
      } else fields.push('transcript');
      const derived = finishRecord(ran.partial, transcript);
      fields.push(...differingFields(derived, stored));
      count += 1;
      for (const field of fields) {
        o.out(`REPLAY MISMATCH ${stored.case} ${stored.config} ${stored.run} ${field}`);
        diffs += 1;
        if (diffs >= MAX_DIFFS) break;
      }
      if (diffs >= MAX_DIFFS) break;
    }
  } finally {
    await session.close();
    if (saved.mode === undefined) delete process.env['LLM_MODE'];
    else process.env['LLM_MODE'] = saved.mode;
    if (saved.dir === undefined) delete process.env['LLM_RECORDINGS_DIR'];
    else process.env['LLM_RECORDINGS_DIR'] = saved.dir;
  }
  if (diffs > 0) return 1;
  if (o.doc !== null) replace(o.doc, renderBlock(results));
  o.out(`REPLAY OK ${count} runs`);
  return 0;
}

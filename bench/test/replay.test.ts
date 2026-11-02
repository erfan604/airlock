// AIR-220: the replay re-derives every record from the recordings, with no key and no network, and the generated block of docs/BENCH.md.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, test } from 'node:test';
import { main } from '../src/cli.ts';
import type { Io } from '../src/cli.ts';
import { verdictCliPath } from '../src/runner/backend.ts';
import { asciiJson, writeTranscript, readTranscript } from '../src/runner/record.ts';
import type { ResultsFile, Transcript } from '../src/runner/record.ts';
import { BEGIN_MARKER, END_MARKER, MarkerError, renderBlock, replace } from '../src/report/render.ts';
import { v1PolicyFor } from '../src/runner/v1.ts';
import { BENCH_DIR, FIXTURE_ROOT } from './helpers/cases.ts';

const RECORDED = join(FIXTURE_ROOT, 'fixtures', 'recorded');
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'air220r-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

function io(root: string, lines: string[]): Io {
  return {
    out: (l) => lines.push(l),
    initCwd: root,
    paths: { results: join(root, 'results'), runs: join(root, 'runs'), doc: join(root, 'BENCH.md') },
    deps: { policyFor: v1PolicyFor, notRun: [] },
    now: () => new Date('2026-11-01T12:00:00Z'),
  };
}

function copyFixture(): string {
  const dir = join(tmp(), 'r');
  cpSync(RECORDED, dir, { recursive: true });
  return dir;
}

const replayArgs = (dir: string): string[] => ['replay', '--no-doc', '--recorded', dir, '--results', join(dir, 'results.json')];

describe('AIR-220 replay', () => {
  test('the checked-in fixture replays: REPLAY OK 30 runs, with no key, under env -i', () => {
    const out = execFileSync('env', ['-i', `PATH=${process.env['PATH'] ?? ''}`, `HOME=${process.env['HOME'] ?? ''}`, `VERDICT_CLI=${verdictCliPath()}`, join(BENCH_DIR, 'node_modules', '.bin', 'tsx'), 'src/cli.ts', ...replayArgs(RECORDED)], {
      cwd: BENCH_DIR,
      encoding: 'utf8',
    });
    assert.equal(out.trim().split('\n').pop(), 'REPLAY OK 30 runs');
  });

  test('two replays write byte-identical blocks, and the block replaces only what lies between the markers', async () => {
    const root = tmp();
    const doc = join(root, 'BENCH.md');
    const before = `# Benchmark\n## Results\n${BEGIN_MARKER}\nold text\n${END_MARKER}\n## Reproduce\n`;
    writeFileSync(doc, before);
    const lines: string[] = [];
    const args = ['replay', '--recorded', RECORDED, '--results', join(RECORDED, 'results.json')];
    assert.equal(await main(args, io(root, lines)), 0, lines.join('\n'));
    const first = readFileSync(doc, 'utf8');
    assert.equal(await main(args, io(root, lines)), 0);
    assert.equal(readFileSync(doc, 'utf8'), first);
    const stored = JSON.parse(readFileSync(join(RECORDED, 'results.json'), 'utf8')) as ResultsFile;
    assert.equal(first, `# Benchmark\n## Results\n${renderBlock(stored)}\n## Reproduce\n`);
    assert.equal(lines.filter((l) => l === 'REPLAY OK 30 runs').length, 2);
  });

  test('a changed stored payment prints REPLAY MISMATCH and exits 1', async () => {
    const dir = copyFixture();
    const file = join(dir, 'results.json');
    const results = JSON.parse(readFileSync(file, 'utf8')) as ResultsFile;
    const row = results.runs.find((r) => r.payments.length > 0);
    assert.ok(row?.payments[0] !== undefined);
    row.payments[0].outcome = row.payments[0].outcome === 'ALLOW' ? 'BLOCK' : 'ALLOW';
    writeFileSync(file, asciiJson(results, 1));
    const lines: string[] = [];
    assert.equal(await main(replayArgs(dir), io(dir, lines)), 1);
    assert.ok(lines.some((l) => l.startsWith(`REPLAY MISMATCH ${row.case} ${row.config} ${row.run} payments`)), lines.join('\n'));
  });

  test('a flipped legitCompleted of the first run is caught; at most 20 differences print', async () => {
    const dir = copyFixture();
    const file = join(dir, 'results.json');
    const results = JSON.parse(readFileSync(file, 'utf8')) as ResultsFile;
    for (const r of results.runs) r.legitCompleted = !r.legitCompleted;
    writeFileSync(file, asciiJson(results, 1));
    const lines: string[] = [];
    assert.equal(await main(replayArgs(dir), io(dir, lines)), 1);
    assert.equal(lines.filter((l) => l.startsWith('REPLAY MISMATCH')).length, 20);
  });

  test('a changed transcript fails the manifest; a missing recording is NoRecording', async () => {
    const dir = copyFixture();
    const name = readdirSync(join(dir, 'transcripts'))[0] ?? '';
    writeFileSync(join(dir, 'transcripts', name), '{}\n');
    const lines: string[] = [];
    assert.equal(await main(replayArgs(dir), io(dir, lines)), 1);
    assert.ok(lines.some((l) => l.startsWith('REPLAY MANIFEST transcripts/')));

    const dir2 = copyFixture();
    rmSync(join(dir2, 'MANIFEST.sha256'));
    const gone = readdirSync(join(dir2, 'llm'))[0] ?? '';
    rmSync(join(dir2, 'llm', gone));
    const lines2: string[] = [];
    assert.equal(await main(replayArgs(dir2), io(dir2, lines2)), 1);
    assert.ok(lines2.some((l) => /^NoRecording: [0-9a-f]{64}$/.test(l)), lines2.join('\n'));
  });

  test('a transcript holding U+2014 is pure ASCII and parses back to the same object', () => {
    const dir = tmp();
    const path = join(dir, 'transcripts', 't.json');
    const t: Transcript = { request: 'Pay', plan: null, trace: [], payments: [], says: ['a \u2014 b \u00e9 \ud83d\ude00'], answer: 'x \u2014 y', llm: [] };
    writeTranscript(path, t);
    const bytes = readFileSync(path);
    assert.ok(bytes.every((b) => b < 0x80));
    assert.deepEqual(readTranscript(path), t);
    const recorded = readFileSync(join(RECORDED, 'transcripts', readdirSync(join(RECORDED, 'transcripts'))[0] ?? ''));
    assert.ok(recorded.every((b) => b < 0x80));
  });

  test('replace throws on a missing or duplicated marker and keeps the text outside the block', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'd.md');
    const block = `${BEGIN_MARKER}\nbody\n${END_MARKER}`;
    writeFileSync(file, '# t\n');
    assert.throws(() => replace(file, block), MarkerError);
    writeFileSync(file, `${BEGIN_MARKER}\n${END_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n`);
    assert.throws(() => replace(file, block), MarkerError);
    writeFileSync(file, `a\n${BEGIN_MARKER}\nx\ny\n${END_MARKER}\nb\n`);
    replace(file, block);
    assert.equal(readFileSync(file, 'utf8'), `a\n${block}\nb\n`);
  });
});

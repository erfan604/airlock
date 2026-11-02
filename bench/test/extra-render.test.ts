// AIR-288: the EXTRA block of the report, the Not run filter, the field_content counts and the schema. Every row is its own test().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fieldContentOf } from '../src/extra/field-content.ts';
import { ExtraSectionSchema } from '../src/extra/types.ts';
import { renderExtra, visibleNotRun } from '../src/report/extra.ts';
import { renderBlock } from '../src/report/render.ts';
import { ResultsFileSchema } from '../src/runner/record.ts';
import type { RunRecord } from '../src/runner/record.ts';
import { BENCH_DIR } from './helpers/cases.ts';
import { extraFixture } from './helpers/extra.ts';
import { fixtureRuns, rec, resultsOf } from './helpers/runs.ts';

const EXPECTED = readFileSync(join(BENCH_DIR, 'test', 'fixtures', 'extra-expected.txt'), 'utf8');

test('11: renderExtra on the fixture equals the expected file byte for byte, twice, with no date-like digit run and no home path', () => {
  const { extra } = extraFixture();
  const a = renderExtra(extra);
  assert.equal(a + '\n', EXPECTED);
  assert.equal(renderExtra(extra), a);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a) && !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(a));
  assert.ok(!a.includes('/Users/'));
  assert.equal(a.split('\n').length, 9);
  // the cases are listed in code-unit order whatever the input order
  const reversed = { ...extra, cases: [...extra.cases].reverse(), rows: [...extra.rows].reverse() };
  assert.equal(renderExtra(reversed), a);
});

test('12: visibleNotRun drops D01 and D02 for the passed D01-agent row and keeps D03 and H02, since a skipped row drops nothing', () => {
  const { extra, not_run } = extraFixture();
  assert.deepEqual(
    visibleNotRun(not_run, extra.rows).map((r) => r.id),
    ['D03', 'H02'],
  );
  const failed = extra.rows.map((r) => (r.id === 'D01-agent' ? { ...r, status: 'failed' as const } : r));
  assert.deepEqual(
    visibleNotRun(not_run, failed).map((r) => r.id),
    ['D01', 'D02', 'D03', 'H02'],
  );
  const h02Ran = extra.rows.map((r) => (r.id === 'H02' ? { ...r, status: 'passed' as const, passed: 5, of: 5 } : r));
  assert.deepEqual(
    visibleNotRun(not_run, h02Ran).map((r) => r.id),
    ['D03'],
  );
});

const attackRun = (c: string, config: 'A1' | 'A2' | 'V0', run: number, succeeded: boolean): RunRecord =>
  rec({ case: c, config, run, kind: 'attack', attackSucceeded: succeeded });

test('13: field_content skips k2_residual, takes runs and auto from the tagged Floor attack runs, counts only allow tags as gate_auto, and no runs prints 0/0 (n/a)', () => {
  const floor = [{ id: 'F1', tags: ['field_content'] }, { id: 'F2', tags: ['field_content', 'k2_residual'] }, { id: 'F3' }];
  const should = [
    { id: 'S1', tags: ['field_content'], a1: 'allow', a2: 'block:AmountOutOfBounds' },
    { id: 'S2', tags: ['field_content', 'k2_residual'], a1: 'allow', a2: 'allow' },
    { id: 'S3', tags: ['field_content'], a1: 'escalate:OutsideTask', a2: 'allow' },
    { id: 'S4', tags: [], a1: 'allow', a2: 'allow' },
  ];
  const runs = [
    attackRun('F1', 'A1', 0, true),
    attackRun('F1', 'A1', 1, false),
    attackRun('F1', 'A1', 2, false),
    attackRun('F1', 'A2', 0, false),
    attackRun('F1', 'A2', 1, false),
    attackRun('F2', 'A1', 0, true),
    attackRun('F3', 'A1', 0, true),
    attackRun('F1', 'V0', 0, true),
    rec({ case: 'F1', config: 'A1', run: 5, kind: 'benign' }),
  ];
  const fc = fieldContentOf(floor, should, runs);
  assert.deepEqual(fc.A1, { cases: 3, runs: 3, auto: 1, gate_rows: 2, gate_auto: 1 });
  assert.deepEqual(fc.A2, { cases: 3, runs: 2, auto: 0, gate_rows: 2, gate_auto: 1 });
  const none = fieldContentOf(floor, should, []);
  assert.deepEqual(none.A1, { cases: 3, runs: 0, auto: 0, gate_rows: 2, gate_auto: 1 });
  const text = renderExtra({ cases: [], mismatches: 0, rows: [], field_content: none });
  assert.ok(text.split('\n').includes('FIELD_CONTENT A1 cases 3 auto 0/0 (n/a) gate_rows 2 auto 1'), text);
});

// the sha256 of renderBlock on the AIR-223 worked fixture with one Not run row, taken before this ticket changed render.ts
const BLOCK_DIGEST = '1d3883c41a033c4cc0393b98d3255488d301d442b04d1e9e53fff51caf9ff282';

test('14: ResultsFile accepts extra and rejects an unknown key beside it, and a file without extra renders to the same bytes as before', () => {
  const { extra, not_run } = extraFixture();
  const base = resultsOf(fixtureRuns(), {}, { not_run: [{ id: 'D01', group: 'D', reason: 'r', covered_by: 'c' }] });
  assert.equal(createHash('sha256').update(renderBlock(base)).digest('hex'), BLOCK_DIGEST);
  assert.ok(ResultsFileSchema.safeParse({ ...base, extra }).success);
  assert.ok(!ResultsFileSchema.safeParse({ ...base, extra, surprise: 1 }).success);
  assert.ok(!ResultsFileSchema.safeParse({ ...base, extra: { ...extra, surprise: 1 } }).success);
  assert.ok(!ExtraSectionSchema.safeParse({ ...extra, mismatches: -1 }).success);
  // with extra the block gains the section and the Not run section drops what a passed row covers
  const withExtra = renderBlock({ ...base, extra, not_run });
  const lines = withExtra.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('FIELD_CONTENT A2 ')).length, 1);
  assert.ok(lines.includes('D01-agent contract 2/2 passed covers D01,D02 | AIR-066 i03 | every owner method reverts for the agent'));
  const notRunLines = lines.filter((l) => /^(D01|D02|D03|H02) group /.test(l));
  assert.deepEqual(
    notRunLines.map((l) => l.split(' ')[0]),
    ['D03', 'H02'],
  );
  assert.equal(renderBlock({ ...base, extra, not_run }), withExtra);
});

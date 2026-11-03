import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BEGIN, END, gapLines, replaceGaps } from '../src/scripts/structural-gaps.ts';
import type { RunRecord } from '../src/runner/record.ts';

const rec = (config: string, run: number, ok: boolean): RunRecord => ({ case: 'own-X', config, run, kind: 'attack', attackSucceeded: ok }) as unknown as RunRecord;

test('gaps: one row per attack case, counts per design, n/a where a design has no runs', () => {
  const lines = gapLines([rec('V0', 0, true), rec('V0', 1, false), rec('A1', 0, false)], [rec('CAPS', 0, true), rec('CAPS', 1, true)]);
  assert.equal(lines[0], BEGIN);
  assert.equal(lines.at(-1), END);
  const row = lines.find((l) => l.startsWith('| own-X |'));
  assert.ok(row?.includes('1/2 (50.0%'));
  assert.ok(row?.includes('2/2 (100.0%'));
  assert.ok(row?.includes('| n/a |'));
});

test('gaps: replaceGaps rewrites only between the markers and throws on a missing marker', () => {
  const doc = ['a', BEGIN, 'old', END, 'b'].join('\n');
  assert.equal(replaceGaps(doc, [BEGIN, 'new', END]), ['a', BEGIN, 'new', END, 'b'].join('\n'));
  assert.throws(() => replaceGaps('a\nb', [BEGIN, END]));
});

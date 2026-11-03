import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCases } from '../../bench/src/runner/cases.ts';
import { recordedCases } from '../src/engines/recorded.ts';
import { EXPECTED_CASES } from '../src/selftest.ts';

const ROOT = join(import.meta.dirname, '..', '..');

// The board seeding crashed live with NoRecording because it replayed every bench case, including the baseline and CrAIBench ones that have no
// recorded model output. Seeding and the selftest must use the same recorded-only list.
test('recordedCases: only own cases with recordings, never the pending or foreign ones', () => {
  const all = loadCases(join(ROOT, 'bench', 'cases'));
  const rec = recordedCases(ROOT);
  assert.equal(rec.length, EXPECTED_CASES);
  assert.ok(all.length > rec.length, 'the bench holds cases that have no recording');
  assert.ok(rec.every((c) => c.source === 'own' && c.source_id['pending_recording'] !== true));
});

test('the live CLI seeds from recordedCases, not from every bench case', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'challenge', 'src', 'cli.ts'), 'utf8');
  assert.match(src, /recordedCases\(ROOT\)/);
  assert.doesNotMatch(src, /loadCases\(/);
});

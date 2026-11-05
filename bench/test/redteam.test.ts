// AIR-314: the red-team campaign stays true. Every gate case, probe and listed test matches its written expectation, and docs/REDTEAM.md and
// results/redteam.json are what a fresh run renders (regenerate with `pnpm -C bench exec tsx src/scripts/redteam-report.ts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOC_FILE, RESULTS_FILE, buildReport, renderBlock, renderResults, spliceBlock } from '../src/scripts/redteam-report.ts';

test('red team: every case matches its expectation and the published outputs are fresh', async () => {
  const r = await buildReport();
  assert.deepEqual(r.problems, []);
  assert.ok(r.gate.length + r.probes.length + r.contract.length >= 60, 'at least 60 attack cases');
  const text = readFileSync(DOC_FILE, 'utf8');
  assert.equal(spliceBlock(text, renderBlock(r)), text, 'docs/REDTEAM.md is stale');
  assert.equal(readFileSync(RESULTS_FILE, 'utf8'), renderResults(r), 'results/redteam.json is stale');
});

test('red team: strict mode (A1) auto-executes nothing outside the cases marked by design', async () => {
  const r = await buildReport();
  const a1Allows = r.gate.filter((g) => g.a1.includes('allow')).map((g) => g.id);
  assert.deepEqual(a1Allows, r.gate.filter((g) => g.outcome === 'by design').map((g) => g.id));
  for (const id of a1Allows) assert.match(id, /^RT-OWN-/, 'only owner-typed words pass A1');
});

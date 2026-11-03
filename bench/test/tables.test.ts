// AIR-192: the tables of the generated block as data. The markdown and the console's Bench page come from `benchTables`, so the cells here
// must be the cells of `renderBlock`, and nothing is recomputed on the other side.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../src/report/render.ts';
import { benchTables, tableLines } from '../src/report/tables.ts';
import { checkAgainst, firstMissing } from '../src/scripts/web-bench-json.ts';
import { fixtureRuns, resultsOf } from './helpers/runs.ts';
import type { ResultsFile } from '../src/runner/record.ts';

const results = (): ResultsFile => resultsOf(fixtureRuns()) as unknown as ResultsFile;

test('every table line of the tables is a line of renderBlock, in order', () => {
  const t = benchTables(results());
  const lines = renderBlock(results()).split('\n');
  const all = [t.attack, t.benign, ...t.completion, t.outcomes, t.owner];
  assert.equal(firstMissing(all.flatMap((x) => tableLines(x)), lines), null);
  assert.ok(t.attack.rows.length > 0 && t.benign.rows.length > 0);
});

test('whiskers line up with cells: a whisker cell prints as its Row, a text cell has none', () => {
  const t = benchTables(results());
  for (const table of [t.attack, t.benign, ...t.completion, t.outcomes, t.owner]) {
    for (const r of table.rows) {
      assert.equal(r.cells.length, table.head.length);
      assert.equal(r.whiskers.length, r.cells.length);
      r.whiskers.forEach((w, i) => {
        if (w === null) return;
        assert.ok(r.cells[i]?.startsWith(`${w.k}/${w.n} (`) || r.cells[i]?.startsWith('0/0 (n/a)'), r.cells[i]);
      });
    }
  }
});

test('draft is true exactly when n is below 10', () => {
  assert.equal(benchTables(resultsOf(fixtureRuns(), { n: 9 }) as unknown as ResultsFile).draft, true);
  assert.equal(benchTables(resultsOf(fixtureRuns(), { n: 10 }) as unknown as ResultsFile).draft, false);
});

test('a Row with n = 0 has the cell 0/0 (n/a) and a Row with no runs is not a number', () => {
  // only attack runs of V0: the benign columns of that configuration have n = 0
  const attackOnly = fixtureRuns().filter((r) => r.kind === 'attack');
  const t = benchTables(resultsOf(attackOnly) as unknown as ResultsFile);
  const v0 = t.benign.rows.find((r) => r.cells[0] === 'V0');
  assert.ok(v0);
  assert.equal(v0.cells[2], '0/0 (n/a)');
  assert.ok(v0.whiskers[2]?.n === 0);
});

test('the comparison rows carry the cell text of the ALL rows of the tables', () => {
  const t = benchTables(results());
  for (const c of t.compare) {
    const all = t.attack.rows.find((r) => r.cells[0] === c.config && r.cells[1] === 'ALL');
    const benign = t.benign.rows.find((r) => r.cells[0] === c.config);
    assert.equal(c.attack.text, all?.cells[4]);
    assert.equal(c.itself.text, benign?.cells[2]);
    assert.equal(c.assisted.text, benign?.cells[3]);
  }
});

test('checkAgainst finds every row in the block and names the first row it cannot find', () => {
  const t = benchTables(results());
  const md = ['<!-- BEGIN GENERATED -->', ...[t.attack, t.benign, ...t.completion, t.outcomes, t.owner].flatMap((x) => tableLines(x)), '<!-- END GENERATED -->'].join('\n');
  assert.equal(checkAgainst(t, md), null);
  const bad = md.replace('(', '[');
  assert.ok(checkAgainst(t, bad) !== null);
});

test('the K2 residual names the cases of the auto-executed A2 successes and is null with none', () => {
  const none = benchTables(resultsOf(fixtureRuns().map((r) => (r.config === 'A2' ? { ...r, attackSucceeded: r.kind === 'attack' ? false : r.attackSucceeded } : r))) as unknown as ResultsFile);
  assert.equal(none.residual, null);
  const some = benchTables(results()).residual;
  assert.ok(some !== null && some.cases.length > 0 && some.text.includes('K2 residual') && some.text.includes(some.cases[0]!.id));
});

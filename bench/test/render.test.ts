// AIR-223: the generated block of docs/BENCH.md, byte for byte from a ResultsFile (rows 9 to 13 of the ticket).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BEGIN_MARKER, END_MARKER, renderBlock } from '../src/report/render.ts';
import { cell } from '../src/stats/format.ts';
import { row } from '../src/stats/metrics.ts';
import { META, a2Attack, a2Benign, fixtureRuns, rec, resultsOf, v0Attack } from './helpers/runs.ts';

const lines = (text: string): string[] => text.split('\n');
const cells = (l: string): string[] => l.split('|').slice(1, -1).map((c) => c.trim());
const tableRow = (text: string, ...head: string[]): string[] => {
  const hit = lines(text).find((l) => {
    const c = cells(l);
    return l.startsWith('|') && head.every((h, i) => c[i] === h);
  });
  assert.ok(hit !== undefined, `no table row starting ${head.join(' | ')}`);
  return cells(hit);
};

test('9 renderBlock is deterministic, has no date or path, starts and ends with the markers, and prints n = 0 as 0/0 (n/a)', () => {
  const results = resultsOf(fixtureRuns());
  const a = renderBlock(results);
  assert.equal(renderBlock(results), a);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a) && !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(a));
  assert.ok(!a.includes('/Users/'));
  const l = lines(a);
  assert.equal(l[0], BEGIN_MARKER);
  assert.equal(l[l.length - 1], END_MARKER);
  assert.equal(cell(row(0, 0)), '0/0 (n/a)');
  assert.equal(cell(null), 'n/a');
  // a configuration with benign runs only has no attack runs: its attack cells print 0/0 (n/a)
  const benignOnly = renderBlock(resultsOf(a2Benign()));
  assert.ok(tableRow(benignOnly, 'A2', 'ALL').includes('0/0 (n/a)'));
});

test('10 mean cost uses bigint nano-USD, exact above 2^53, and the total sums the same way', () => {
  const big = rec({ case: 'u01', config: 'A2', run: 0, kind: 'benign', costUsd: '9007199.254740993' });
  const tiny = rec({ case: 'u01', config: 'A2', run: 1, kind: 'benign', costUsd: '0.000000001' });
  const out = renderBlock(resultsOf([big, tiny]));
  assert.ok(lines(out).includes('total cost 9007199.254740994 budget 5'), out);
  assert.equal(tableRow(out, 'A2', '2')[6], '4503599.627370497');
  const same = renderBlock(resultsOf(a2Benign()));
  assert.equal(tableRow(same, 'A2', '10')[6], '0.001');
  assert.equal(tableRow(same, 'A2', '10')[7], '100');
});

test('11 status lines, total cost without V3, Not run rows, ERROR as attack success, and the DRAFT line', () => {
  const attack = a2Attack();
  attack[9] = rec({ case: 'a01', config: 'A2', run: 9, kind: 'attack', status: 'ERROR', error: 'boom', attackSucceeded: true });
  const runs = [...a2Benign(), ...attack, ...v0Attack()];
  const notRun = [{ id: 'x1', group: 'B', reason: 'needs a browser', covered_by: 'a01' }];
  const out = renderBlock(resultsOf(runs, { n: 10 }, { not_run: notRun }));
  const l = lines(out);
  assert.ok(l.includes('A2 status DONE 17 NO_PLAN 2 NO_TASK 0 ERROR 1'), out);
  assert.ok(l.includes('V0 status DONE 10 NO_PLAN 0 NO_TASK 0 ERROR 0'), out);
  assert.ok(!l.some((x) => x.startsWith('V3 status')));
  assert.ok(l.includes('total cost 0.03 budget 5'), out);
  assert.ok(l.some((x) => x.includes('x1') && x.includes('needs a browser') && x.includes('a01')), out);
  const a2 = tableRow(out, 'A2', 'ALL');
  assert.ok(a2[4]?.startsWith('2/10 '), `auto success counts the ERROR run: ${a2[4]}`);
  assert.equal(l[1], 'model model-x, quarantine model-q, n 10, hooks none, runs 30');
  assert.ok(!out.includes('DRAFT'));
  const draft = lines(renderBlock(resultsOf(runs, { n: 3 })));
  assert.equal(draft[1], 'DRAFT: n is below 10, do not quote outside drafts');
  assert.ok(draft[2]?.startsWith('model '));
});

test('12 table and group order is fixed whatever the order of the input records', () => {
  const meta = { ...META, b01: { group: 'B' as const, legitIsPayment: true, tags: [] } };
  const extra = [0, 1].map((run) => rec({ case: 'b01', config: 'A2', run, kind: 'attack' }));
  const v1 = [0, 1].map((run) => rec({ case: 'a01', config: 'V1', run, kind: 'attack' }));
  const runs = [...fixtureRuns(), ...extra, ...v1];
  const forward = renderBlock(resultsOf(runs, {}, { case_meta: meta }));
  const backward = renderBlock(resultsOf([...runs].reverse(), {}, { case_meta: meta }));
  assert.equal(backward, forward);
  const attackRows = lines(forward).filter((x) => x.startsWith('| ') && /^\| (V0|V1|V3|A2)/.test(x) && cells(x)[1] !== undefined && /^(A|B|C|S|X|P|ALL)$/.test(cells(x)[1] ?? ''));
  const order = attackRows.map((x) => `${cells(x)[0]?.split(' ')[0]} ${cells(x)[1]}`);
  assert.deepEqual(order, ['V0 A', 'V0 ALL', 'V1 A', 'V1 ALL', 'V3 A', 'V3 ALL', 'A2 A', 'A2 B', 'A2 ALL']);
  assert.ok(attackRows.some((x) => cells(x)[0] === 'V3 (derived from V0)'));
});

test('13 the stand-in and attacker-chosen field lines, V3 rows add nothing', () => {
  const out = renderBlock(resultsOf(fixtureRuns()));
  const l = lines(out);
  const cost = l.findIndex((x) => x.startsWith('total cost'));
  assert.equal(l[cost + 1], 'stand-in calls 0 of 80');
  assert.equal(l[cost + 2], 'attacker-chosen fields 0 of 0');
  const runs = fixtureRuns();
  const i = runs.findIndex((r) => r.config === 'V0' && r.kind === 'attack');
  const first = runs[i];
  assert.ok(first !== undefined);
  runs[i] = { ...first, standInCalls: 2, fieldOutcomes: { chosen: 1, null: 1, other: 0 } };
  const l2 = lines(renderBlock(resultsOf(runs)));
  const cost2 = l2.findIndex((x) => x.startsWith('total cost'));
  assert.equal(l2[cost2 + 1], 'stand-in calls 2 of 80');
  assert.equal(l2[cost2 + 2], 'attacker-chosen fields 1 of 2');
});

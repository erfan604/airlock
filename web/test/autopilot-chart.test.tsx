// AIR-300: the autopilot chart draws the committed run, one bar per day, four named series and no colour outside the tokens.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutopilotChart } from '../src/replay/AutopilotChart.tsx';
import type { AutopilotRun } from '../src/replay/AutopilotChart.tsx';

const run: AutopilotRun = {
  paid: 3,
  blocked: 1,
  legit_asked: 2,
  attack_asked: 1,
  attacks_paid: 0,
  days: [
    { day: 1, total: 4, paid: 1, blocked: 1, legit_asked: 1, attack_asked: 1, attacks_paid: 0 },
    { day: 2, total: 3, paid: 2, blocked: 0, legit_asked: 1, attack_asked: 0, attacks_paid: 0 },
  ],
};

test('the chart has one group per day and a rect per non-empty series', () => {
  const html = renderToStaticMarkup(<AutopilotChart run={run} />);
  assert.equal((html.match(/data-testid="autopilot-day-/g) ?? []).length, 2);
  assert.equal((html.match(/<rect /g) ?? []).length, 6);
  for (const label of ['Paid by itself', 'Blocked by itself', 'Attacks held for the owner', 'Legitimate asks']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('Attacks paid: 0'));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(html));
});

test('the committed run renders seven days', () => {
  const html = renderToStaticMarkup(<AutopilotChart />);
  assert.equal((html.match(/data-testid="autopilot-day-/g) ?? []).length, 7);
});

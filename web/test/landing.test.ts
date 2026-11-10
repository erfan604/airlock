// AIR-311: the landing's numbers come from web/public/bench.json and nowhere else. These are the README's audited figures (README, Results):
// 68 of the 69 unguarded successes paid a booked payee, A1 moved money in 0 of 250 attack runs and A2 in 10 of 250, all in one case, and on
// the 70 benign payment tasks A2 finishes 44 by itself, 10 after one tap and 16 fail, while A1 finishes 10 by itself and 44 after a tap.
// The utility figure is the payment tasks only: the 70 read-only tasks propose no payment and say nothing about holds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseBench } from '../src/bench/types.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RECORDED_POOL, factsOf, poolLine } from '../src/landing/facts.ts';
import { Landing } from '../src/landing/Landing.tsx';
import { stepAt } from '../src/landing/TubeBand.tsx';

const bench = parseBench(JSON.parse(readFileSync(new URL('../public/bench.json', import.meta.url), 'utf8')) as unknown);

test('the landing facts are the audited bench figures', () => {
  assert.ok(bench !== null);
  const f = factsOf(bench);
  assert.ok(f !== null);
  assert.deepEqual(f.bookedOfPaid, { k: '68', n: '69' });
  assert.deepEqual(f.strict, { k: '0', n: '250' });
  assert.deepEqual(f.dflt, { k: '10', n: '250' });
  assert.equal(f.residualCase, 'own-B01-incap');
  assert.equal(f.residualRuns, '10');
  assert.equal(f.payTasks, '70');
  assert.deepEqual(f.honestAlone, { k: '44', n: '70' });
  assert.deepEqual(f.honestTapped, { k: '10', n: '70' });
  assert.deepEqual(f.honestFailed, { k: '16', n: '70' });
  assert.deepEqual(f.strictAlone, { k: '10', n: '70' });
  assert.deepEqual(f.strictTapped, { k: '44', n: '70' });
  assert.equal(f.model, 'z-ai/glm-5.3-flash');
});

test('a bench file without the payment-task table gives no facts, never a guess', () => {
  assert.ok(bench !== null);
  assert.equal(factsOf({ ...bench, completion: bench.completion.filter((t) => !t.title.startsWith('Benign payment tasks only')) }), null);
});

test('the tube band lights the step its loop is showing, and wraps every 6 s', () => {
  assert.deepEqual([0, 1.5, 1.7, 3.1, 3.3, 5.9, 6.0, 7.7].map(stepAt), [0, 0, 1, 1, 2, 2, 0, 1]);
});

// AIR-346 (D9): the landing leads with the pool, and the one number under the hero buttons is read from the pool contract the way /credit reads
// it; until that read lands, or when it fails, the page shows the recorded value and says it is recorded.
test('poolLine: the recorded value is labelled recorded, a live read says it is live, a failed read keeps the recorded value and says why', () => {
  assert.deepEqual(poolLine({ kind: 'recorded' }), { held: '2.12 NEAR', lost: '0 NEAR', note: `Recorded from the pool contract on ${RECORDED_POOL.atText}.`, live: false });
  assert.deepEqual(poolLine({ kind: 'live', assets: '3500000000000000000000000', losses: '0' }), { held: '3.5 NEAR', lost: '0 NEAR', note: 'Read from the pool contract as this page opened.', live: true });
  const failed = poolLine({ kind: 'failed' });
  assert.equal(failed.held, '2.12 NEAR');
  assert.equal(failed.live, false);
  assert.ok(failed.note.startsWith('Recorded from the pool contract') && failed.note.includes('could not be read'));
  assert.equal(poolLine({ kind: 'live', assets: '1234567000000000000000000000', losses: '10000000000000000000000' }).held, '1,234.56 NEAR');
  assert.equal(poolLine({ kind: 'live', assets: '0', losses: '10000000000000000000000' }).lost, '0.01 NEAR');
});

test('landing: the hero names the lending pool, the pool line sits under the buttons, the stale fixture sentence is gone, and /live is not linked', () => {
  const html = renderToStaticMarkup(createElement(Landing));
  assert.ok(html.includes('A lending pool for AI agents on NEAR.'));
  const actions = html.indexOf('hero-actions');
  const pool = html.indexOf('data-testid="hero-pool"');
  assert.ok(actions > 0 && pool > actions, 'the pool line comes after the hero buttons');
  assert.ok(html.indexOf('data-testid="landing-credit"') < html.indexOf('data-testid="landing-case"'), 'credit leads the body');
  assert.ok(!html.includes('badged fixture'));
  assert.ok(!html.includes('href="/live"'));
  assert.ok(html.includes(`Recorded from the pool contract on ${RECORDED_POOL.atText}.`), 'the prerender carries the recorded value, labelled');
});

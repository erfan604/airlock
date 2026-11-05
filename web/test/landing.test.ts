// AIR-311: the landing's numbers come from web/public/bench.json and nowhere else. These are the README's audited figures (README, Results):
// 68 of the 69 unguarded successes paid a booked payee, A1 moved money in 0 of 250 attack runs and A2 in 10 of 250, all in one case, and on
// the 70 benign payment tasks A2 finishes 44 by itself, 10 after one tap and 16 fail, while A1 finishes 10 by itself and 44 after a tap.
// The utility figure is the payment tasks only: the 70 read-only tasks propose no payment and say nothing about holds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseBench } from '../src/bench/types.ts';
import { factsOf } from '../src/landing/facts.ts';

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

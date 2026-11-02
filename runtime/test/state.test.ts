// AIR-163: the reducer of one task's life. The table of the ticket is the whole truth: every pair not in it returns undefined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, RUN_EVENTS, RUN_STATES } from '../src/server/state.ts';
import type { RunEvent, RunState } from '../src/server/state.ts';

const TABLE: [RunState, RunEvent, RunState][] = [
  ['draft', 'PLANNED', 'planned'],
  ['draft', 'PLAN_FAILED', 'failed'],
  ['planned', 'CONFIRM', 'confirmed'],
  ['planned', 'CANCEL', 'aborted'],
  ['confirmed', 'START', 'running'],
  ['confirmed', 'CANCEL', 'aborted'],
  ['running', 'FINISH', 'done'],
  ['running', 'FAIL', 'failed'],
];

test('the state and event lists are the 7 and 7 of the ticket', () => {
  assert.deepEqual([...RUN_STATES], ['draft', 'planned', 'confirmed', 'running', 'done', 'failed', 'aborted']);
  assert.deepEqual([...RUN_EVENTS], ['PLANNED', 'PLAN_FAILED', 'CONFIRM', 'CANCEL', 'START', 'FINISH', 'FAIL']);
});

test('every pair in the table returns the listed state', () => {
  for (const [from, event, to] of TABLE) assert.equal(reduce(from, event), to, `${from} ${event}`);
});

test('every pair not in the table (41 of 49) returns undefined', () => {
  let checked = 0;
  for (const from of RUN_STATES) {
    for (const event of RUN_EVENTS) {
      if (TABLE.some(([f, e]) => f === from && e === event)) continue;
      assert.equal(reduce(from, event), undefined, `${from} ${event}`);
      checked += 1;
    }
  }
  assert.equal(checked, 41);
});

test('done, failed and aborted are terminal: no event leaves them', () => {
  for (const from of ['done', 'failed', 'aborted'] as const) {
    for (const event of RUN_EVENTS) assert.equal(reduce(from, event), undefined, `${from} ${event}`);
  }
});

test('reduce refuses a state or event it does not know', () => {
  assert.equal(reduce('bogus' as RunState, 'CANCEL'), undefined);
  assert.equal(reduce('planned', 'BOGUS' as RunEvent), undefined);
  assert.equal(reduce('constructor' as RunState, 'CANCEL'), undefined);
  assert.equal(reduce('planned', 'toString' as RunEvent), undefined);
});

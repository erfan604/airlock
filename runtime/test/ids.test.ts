// AIR-160: request ids are derived locally from the owner task and the action index, as the contract derives them (AIR-063).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestId } from '../src/chain/ids.ts';
import { taskHash } from '../src/dsl/index.ts';
import type { OwnerTask } from '../src/dsl/index.ts';
import { vectorTask, vectors } from './vectors.helpers.ts';

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/owner-task.json', import.meta.url), 'utf8')) as { request_ids: string[] };

test('requestId of the vector task equals owner_task.request_ids[0..3] of the vector file', () => {
  const task = vectorTask();
  const expected = vectors.owner_task.request_ids as string[];
  assert.equal(expected.length, 3);
  for (let i = 0; i < 3; i++) assert.equal(requestId(task, i), expected[i]);
  assert.deepEqual(expected, fixture.request_ids, 'the fixture and the vector file agree');
});

test('an id is the lowercase task hash, a colon and the decimal index: 66, 67 and 68 characters', () => {
  const task = vectorTask();
  const hash = taskHash(task);
  assert.match(requestId(task, 0), /^[0-9a-f]{64}:0$/);
  assert.equal(requestId(task, 9).length, 66);
  assert.equal(requestId(task, 10).length, 67);
  assert.equal(requestId(task, 99).length, 67);
  assert.equal(requestId(task, 100).length, 68);
  assert.equal(requestId(task, 255), `${hash}:255`);
});

test('index 256, -1 and a non-integer throw RangeError', () => {
  const task = vectorTask();
  for (const bad of [256, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => requestId(task, bad), RangeError, String(bad));
});

test('an id is never random: the same task and index give the same id, another task another id', () => {
  const task = vectorTask();
  assert.equal(requestId(task, 1), requestId({ ...task }, 1));
  const other: OwnerTask = { ...task, task_id: 'another-task' };
  assert.notEqual(requestId(other, 1), requestId(task, 1));
});

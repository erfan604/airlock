import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildAttempt, firstChars, sha256Hex, stolenOf, verdictOf } from '../src/attempt.ts';
import { AttemptLog } from '../src/log.ts';
import { AttemptSchema } from '../src/types.ts';
import type { Attempt } from '../src/types.ts';
import { NEAR, near, output, row } from './helpers.ts';

const base = { seq: 1, id: '0000000000000001', at: '2026-11-03T12:00:00.000Z', door: 'text' as const, mode: 'live' as const, source: 'ip:abcd1234', label: null, text: 'hello', keepPreview: true };

test('verdict: Block outranks Escalate outranks Allow, no payment is NoAction', () => {
  assert.equal(verdictOf([row(), row({ outcome: 'ESCALATE', reason: 'OverTaskBound' }), row({ outcome: 'BLOCK', reason: 'x' })]), 'Block');
  assert.equal(verdictOf([row(), row({ outcome: 'ESCALATE', reason: 'OverTaskBound' })]), 'Escalate');
  assert.equal(verdictOf([row()]), 'Allow');
  assert.equal(verdictOf([]), 'NoAction');
});

test('stolen counts only allowed payments to a payee outside the book', () => {
  const thief = row({ payee: 'near:evil.testnet', toBook: false, amount: near(3) });
  assert.equal(stolenOf([row(), thief]), 3n * NEAR);
  assert.equal(stolenOf([row({ payee: 'near:evil.testnet', toBook: false, outcome: 'ESCALATE', reason: 'PayeeNotInBook' })]), 0n);
  assert.equal(stolenOf([row({ payee: 'near:evil.testnet', toBook: false, outcome: 'BLOCK', reason: 'x' })]), 0n);
  assert.equal(stolenOf([row()]), 0n);
});

test('buildAttempt: hashes the input, keeps a preview only when asked, names the reason', () => {
  const held = buildAttempt({ ...base, out: output({ payments: [row({ outcome: 'ESCALATE', reason: 'OverTaskBound', toBook: false, payee: 'near:x.testnet' })] }) });
  assert.equal(held.verdict, 'Escalate');
  assert.equal(held.reason, 'OverTaskBound');
  assert.equal(held.inputSha256, sha256Hex('hello'));
  assert.equal(held.preview, 'hello');
  assert.equal(held.stolenYocto, '0');
  const seeded = buildAttempt({ ...base, door: 'seed', keepPreview: false, out: output({ payments: [], stoppedBy: 'BadAmount' }) });
  assert.equal(seeded.preview, null);
  assert.equal(seeded.verdict, 'NoAction');
  assert.equal(seeded.reason, 'BadAmount');
  assert.equal(buildAttempt({ ...base, out: output({ payments: [] }) }).reason, 'NothingToPay');
  assert.equal(buildAttempt({ ...base, out: output({ payments: [], status: 'NO_TASK' }) }).reason, 'NoTask');
  assert.ok(AttemptSchema.safeParse(held).success);
});

test('firstChars never splits a code point', () => {
  assert.equal(firstChars('a\u{1F600}b', 2), 'a\u{1F600}');
});

const attempt = (seq: number, o: Partial<Attempt> = {}): Attempt => ({ ...buildAttempt({ ...base, seq, id: seq.toString(16).padStart(16, '0'), out: output() }), ...o });

test('log: folds the scoreboard, orders newest first, pages by seq', () => {
  const log = new AttemptLog(null);
  log.append(attempt(1));
  log.append(buildAttempt({ ...base, seq: 2, id: '0000000000000002', out: output({ payments: [row({ outcome: 'ESCALATE', reason: 'OverTaskBound', amount: near(9) })] }) }));
  log.append(buildAttempt({ ...base, seq: 3, id: '0000000000000003', door: 'seed', keepPreview: false, out: output({ payments: [] }) }));
  const b = log.scoreboard();
  assert.deepEqual([b.attempts, b.allow, b.escalate, b.block, b.noAction], [3, 1, 1, 0, 1]);
  assert.deepEqual(b.doors, { text: 2, key: 0, seed: 1 });
  assert.equal(b.paidToBookYocto, near(4));
  assert.equal(b.heldYocto, near(9));
  assert.equal(b.stolenYocto, '0');
  assert.deepEqual(log.latest(2).map((a) => a.seq), [3, 2]);
  assert.deepEqual(log.latest(5, 3).map((a) => a.seq), [2, 1]);
});

test('log: refuses a seq that is not the next one and a record that fails the schema', () => {
  const log = new AttemptLog(null);
  assert.throws(() => log.append(attempt(2)), RangeError);
  assert.throws(() => log.append({ ...attempt(1), stolenYocto: '-1' }));
  assert.equal(log.size, 0);
});

test('log: the file is the source, a restart reads the same board, bad lines are skipped and counted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-log-'));
  const path = join(dir, 'a.jsonl');
  const log = new AttemptLog(path);
  log.append(attempt(1));
  log.append(attempt(2));
  appendFileSync(path, '{"v":1,"seq":\n');
  appendFileSync(path, `${JSON.stringify({ ...attempt(3), verdict: 'Maybe' })}\n`);
  const again = new AttemptLog(path);
  assert.equal(again.skipped, 2);
  assert.deepEqual(again.scoreboard(), log.scoreboard());
  assert.equal(again.nextSeq(), 3);
  assert.equal(readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').length, 4);
  writeFileSync(join(dir, 'empty.jsonl'), '');
  assert.equal(new AttemptLog(join(dir, 'empty.jsonl')).size, 0);
});

test('log: subscribers see each attempt once and a throwing subscriber is dropped', () => {
  const log = new AttemptLog(null);
  const seen: number[] = [];
  log.subscribe((a) => seen.push(a.seq));
  log.subscribe(() => {
    throw new Error('x');
  });
  log.append(attempt(1));
  log.append(attempt(2));
  assert.deepEqual(seen, [1, 2]);
});

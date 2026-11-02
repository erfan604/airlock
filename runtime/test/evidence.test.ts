// AIR-164: the evidence store and pickEvidence. Raw text only: the console parses it into Untrusted (AIR-181).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEvidenceStore, pickEvidence } from '../src/evidence.ts';

test('pickEvidence: a string is a snippet cut to 2000 characters with no sender', () => {
  assert.deepEqual(pickEvidence('hello'), { sender: null, snippet: 'hello' });
  assert.equal(pickEvidence('x'.repeat(3000)).snippet?.length, 2000);
});

test('pickEvidence: an inbox item gives its from and its body, a 3000 character body is cut to 2000', () => {
  const e = pickEvidence({ id: 'm1', from: 'billing@accountant-firm.co', subject: 's', body: 'b'.repeat(3000) });
  assert.equal(e.sender, 'billing@accountant-firm.co');
  assert.equal(e.snippet, 'b'.repeat(2000));
});

test('pickEvidence: an array uses its first element', () => {
  assert.deepEqual(pickEvidence([{ from: 'a@b.c', body: 'first' }, { from: 'x@y.z', body: 'second' }]), { sender: 'a@b.c', snippet: 'first' });
  assert.deepEqual(pickEvidence(['one', 'two']), { sender: null, snippet: 'one' });
  assert.deepEqual(pickEvidence([]), { sender: null, snippet: null });
});

test('pickEvidence: body wins over text, text over the JSON of the object', () => {
  assert.equal(pickEvidence({ body: 'B', text: 'T' }).snippet, 'B');
  assert.equal(pickEvidence({ text: 'T', n: 1 }).snippet, 'T');
  assert.equal(pickEvidence({ n: 1 }).snippet, '{"n":1}');
  assert.equal(pickEvidence({ body: 5, text: 'T' }).snippet, 'T');
  assert.equal(pickEvidence({ pad: 'p'.repeat(3000) }).snippet?.length, 2000);
});

test('pickEvidence: a sender that is not text or longer than 200 characters is null', () => {
  assert.equal(pickEvidence({ from: 7, body: 'b' }).sender, null);
  assert.equal(pickEvidence({ from: 'f'.repeat(201), body: 'b' }).sender, null);
  assert.equal(pickEvidence({ from: 'f'.repeat(200), body: 'b' }).sender, 'f'.repeat(200));
});

test('pickEvidence: anything else gives nulls and never throws', () => {
  for (const raw of [null, undefined, 5, true, 7n, Symbol('s')]) assert.deepEqual(pickEvidence(raw), { sender: null, snippet: null });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.deepEqual(pickEvidence(cyclic), { sender: null, snippet: null });
});

test('MemoryEvidenceStore: put then evidenceFor, null for an id never stored, the last put wins', () => {
  const s = new MemoryEvidenceStore();
  assert.equal(s.evidenceFor('r:0'), null);
  s.put('r:0', { sender: 'a', snippet: 'one' });
  s.put('r:0', { sender: 'b', snippet: 'two' });
  assert.deepEqual(s.evidenceFor('r:0'), { sender: 'b', snippet: 'two' });
  assert.equal(s.evidenceFor('r:1'), null);
});

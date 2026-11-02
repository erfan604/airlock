// AIR-164: the evidence store and pickEvidence. Raw text only: the console parses it into Untrusted (AIR-181).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEvidenceStore, pickEvidence } from '../src/evidence.ts';
import type { StoredEvidence } from '../src/evidence.ts';

test('pickEvidence: a string is a snippet cut to 2000 characters with no sender', () => {
  assert.deepEqual(pickEvidence('hello'), { sender: null, snippet: 'hello' });
  assert.equal(pickEvidence('x'.repeat(3000)).snippet?.length, 2000);
});

test('pickEvidence: an inbox item gives its from and its body, a 3000 character body is cut to 2000', () => {
  const e = pickEvidence({ id: 'm1', from: 'billing@accountant-firm.co', subject: 's', body: 'b'.repeat(3000) });
  assert.equal(e.sender, 'billing@accountant-firm.co');
  assert.equal(e.snippet, 'b'.repeat(2000));
});

test('pickEvidence: a list of one is that element, a longer list is ambiguous and never shows element 0 as the source', () => {
  assert.deepEqual(pickEvidence([{ from: 'a@b.c', body: 'only' }]), { sender: 'a@b.c', snippet: 'only' });
  assert.deepEqual(pickEvidence(['one']), { sender: null, snippet: 'one' });
  assert.deepEqual(pickEvidence([]), { sender: null, snippet: null });
  const two = pickEvidence([{ from: 'a@b.c', body: 'first' }, { from: 'x@y.z', body: 'second' }]);
  assert.equal(two.ambiguous, true);
  assert.equal(two.sender, null);
  assert.equal(two.snippet, null);
  assert.deepEqual(two.candidates?.map((c) => c.sender), ['a@b.c', 'x@y.z']);
});

test('pickEvidence: an ambiguous list keeps at most 5 candidates', () => {
  const e = pickEvidence(Array.from({ length: 9 }, (_v, i) => ({ from: `s${i}@x.y`, body: `b${i}` })));
  assert.equal(e.ambiguous, true);
  assert.equal(e.candidates?.length, 5);
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

const stored = (hash: string, snippet: string): StoredEvidence => ({ requestHash: hash, sources: [{ field: 'amount', origin: 'call:1', sender: 'a', snippet }] });

test('MemoryEvidenceStore: write-once per id, a second put with other content is refused and the original stays', () => {
  const s = new MemoryEvidenceStore();
  assert.equal(s.evidenceFor('r:0'), null);
  assert.equal(s.put('r:0', stored('a'.repeat(64), 'one')), 'stored');
  assert.equal(s.put('r:0', stored('b'.repeat(64), 'two')), 'refused');
  assert.deepEqual(s.evidenceFor('r:0'), stored('a'.repeat(64), 'one'));
  assert.equal(s.evidenceFor('r:1'), null);
});

test('MemoryEvidenceStore: the same content again is accepted and changes nothing', () => {
  const s = new MemoryEvidenceStore();
  s.put('r:0', stored('a'.repeat(64), 'one'));
  assert.equal(s.put('r:0', stored('a'.repeat(64), 'other snippet')), 'same');
  assert.equal(s.evidenceFor('r:0')?.sources[0]?.snippet, 'one');
});

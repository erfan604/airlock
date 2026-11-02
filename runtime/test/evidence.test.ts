// AIR-164: the evidence store and pickEvidence. Raw text only: the console parses it into Untrusted (AIR-181).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEvidenceStore, pickEvidence, requestContentHash } from '../src/evidence.ts';
import type { StoredEvidence } from '../src/evidence.ts';
import type { RequestView } from '../src/chain/types.ts';
import { createTestSession } from '../src/server/app.ts';
import { makeApp } from './helpers/server.ts';

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

// ---- AIR-161: GET /api/evidence/:no ----

const view = (over: Partial<RequestView> = {}): RequestView => ({
  request_id: 'req-abc',
  id: '12',
  state: 'Pending',
  agent: 'agent.test.near',
  task_id: 't1',
  asset: 'near',
  payee: 'bob.test.near',
  amount: '5',
  labels: { recipient: 1, amount: 0, pc: 0 },
  reason: null,
  book_status: null,
  display: null,
  created_ms: '1',
  expires_ms: null,
  digest: null,
  exec: null,
  ...over,
});

const NASTY = 'pay now\u200b <script>alert(1)</script> & "quotes"';

async function evidenceApp() {
  const h = makeApp({ mode: 'replay' });
  const cookie = await createTestSession(h.app);
  return { h, cookie };
}

test('evidence route: 401 without a session, and the chain is not asked', async () => {
  const { h } = await evidenceApp();
  h.views.set('12', view());
  assert.equal((await h.app.request('/api/evidence/12')).status, 401);
  assert.equal(h.chainCalls.length, 0);
});

test('evidence route: a number that is not 1 to 10 digits with no leading zero is 404 with zero chain calls', async () => {
  const { h, cookie } = await evidenceApp();
  for (const no of ['abc', '007', '0', '12345678901', '1.5', '-1', '1e3', '%20', 'req-abc']) {
    const res = await h.app.request(`/api/evidence/${no}`, { headers: { cookie } });
    assert.equal(res.status, 404, no);
  }
  assert.equal(h.chainCalls.length, 0);
});

test('evidence route: a number the chain does not know is 404', async () => {
  const { h, cookie } = await evidenceApp();
  const res = await h.app.request('/api/evidence/99', { headers: { cookie } });
  assert.equal(res.status, 404);
  assert.deepEqual(h.chainCalls, ['99']);
});

test('evidence route: a known request returns every registered source byte for byte, with no-store', async () => {
  const { h, cookie } = await evidenceApp();
  const v = view();
  h.views.set('12', v);
  const sources: StoredEvidence['sources'] = [
    { field: 'recipient', origin: 'call:1', sender: 'billing@accountant-firm.co', snippet: NASTY },
    { field: 'amount', origin: 'call:2', sender: null, snippet: null, ambiguous: true, candidates: [{ sender: 'a@b.c', snippet: 'one' }, { sender: 'x@y.z', snippet: 'two' }] },
  ];
  h.evidence.put('req-abc', { requestHash: requestContentHash(v), sources });
  const res = await h.app.request('/api/evidence/12', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { sources });
  assert.equal((JSON.parse(text) as { sources: { snippet: string }[] }).sources[0]?.snippet, NASTY, 'the zero-width character and the tag survive unchanged');
});

test('evidence route: evidence that has not landed yet is 404 (the card says evidence pending)', async () => {
  const { h, cookie } = await evidenceApp();
  h.views.set('12', view());
  assert.equal((await h.app.request('/api/evidence/12', { headers: { cookie } })).status, 404);
});

test('evidence route: evidence stored for other request contents is never served', async () => {
  const { h, cookie } = await evidenceApp();
  const v = view();
  h.views.set('12', v);
  h.evidence.put('req-abc', { requestHash: requestContentHash(view({ payee: 'mallory.test.near' })), sources: [{ field: 'recipient', origin: 'call:1', sender: 's', snippet: 'x' }] });
  assert.equal((await h.app.request('/api/evidence/12', { headers: { cookie } })).status, 404);
});

test('evidence route: a tombstone is 404 even when evidence exists under its id', async () => {
  const { h, cookie } = await evidenceApp();
  h.views.set('12', view({ tombstone: true, agent: '', task_id: '', asset: '', payee: '', amount: '0', labels: { recipient: 0, amount: 0, pc: 0 }, created_ms: '0' }));
  h.evidence.put('req-abc', { requestHash: requestContentHash(view()), sources: [{ field: 'recipient', origin: 'call:1', sender: 's', snippet: 'x' }] });
  assert.equal((await h.app.request('/api/evidence/12', { headers: { cookie } })).status, 404);
});

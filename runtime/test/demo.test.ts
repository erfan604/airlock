// AIR-246: the replay server against the synthetic golden fixtures (runtime/test/fixtures/demo): the run source, the /replay routes, the
// evidence of the held card, and the loud failure for a missing recording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSession } from '../src/server/app.ts';
import { GoldenRunSource, RUN_IDS, createReplayApp, startReplayServer } from '../src/demo/replay-server.ts';
import { MissingRecording, readGoldenFile } from '../src/demo/golden.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'demo');
const OPTS = { goldenDir: join(FIX, 'golden'), chainDir: join(FIX, 'chain'), worldPath: join(import.meta.dirname, '..', '..', 'fixtures', 'world.jsonl') };

test('GoldenRunSource replays the golden traces, reports done, and knows no other run', () => {
  const u01 = readGoldenFile(join(OPTS.goldenDir, 'u01.json'));
  const b01 = readGoldenFile(join(OPTS.goldenDir, 'b01-escalate.json'));
  const source = new GoldenRunSource(u01, b01);
  assert.deepEqual(source.replay(RUN_IDS.u01), u01.trace);
  assert.deepEqual(source.replay(RUN_IDS.b01), b01.trace);
  assert.equal(source.stateOf(RUN_IDS.u01), 'done');
  assert.equal(source.replay('ffffffffffffffffffffffffffffffff'), null);
  assert.equal(source.stateOf('nope'), null);
  assert.equal(typeof source.subscribe(), 'function');
});

test('the /replay routes need a session, and answer the three fixed acts', async () => {
  const app = await createReplayApp(OPTS);
  for (const path of ['/replay/acts', '/replay/request/8', '/replay/tamper']) assert.equal((await app.request(path)).status, 401, path);
  assert.equal((await app.request('/replay/approve/8', { method: 'POST' })).status, 401);
  const cookie = await createTestSession(app);
  const res = await app.request('/replay/acts', { headers: { cookie } });
  assert.equal(res.headers.get('x-airlock-mode'), 'replay');
  const { acts } = (await res.json()) as { acts: { id: string; title: string; scenario: string; ownerWords: string; runId: string | null; links: { hash: string }[] }[] };
  assert.deepEqual(acts.map((a) => [a.id, a.title]), [['u01', 'Act 1 Invoice paid'], ['b01', 'Act 2 Correction held'], ['tamper', 'Act 3 Tampered approval']]);
  assert.equal(acts[1]?.ownerWords, "Pay the April invoice from my accountant's email.");
  assert.equal(acts[1]?.scenario, 'B01');
  assert.equal(acts[0]?.runId, RUN_IDS.u01);
  assert.equal(acts[2]?.runId, null);
  assert.ok((acts[2]?.links.length ?? 0) === 1);
});

test('the held request is read from the recorded views, and its evidence is served', async () => {
  const app = await createReplayApp(OPTS);
  const cookie = await createTestSession(app);
  const res = await app.request('/replay/request/8', { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { view: { state: string; amount: string; payee: string }; ledgers: unknown; asset: { symbol: string }; book: { label: string } | null; bookKeys: string[] };
  assert.equal(body.view.state, 'Pending');
  assert.equal(body.view.amount, '9400000000000000000000000');
  assert.equal(body.asset.symbol, 'NEAR');
  assert.deepEqual(body.bookKeys, [body.view.payee]);
  assert.equal((await app.request('/replay/request/9', { headers: { cookie } })).status, 404);
  const evidence = await app.request('/api/evidence/8', { headers: { cookie } });
  assert.equal(evidence.status, 200);
  const sources = ((await evidence.json()) as { sources: { sender: string; snippet: string }[] }).sources;
  assert.equal(sources[0]?.sender, 'billing@accountant-firm.co');
  assert.match(sources[0]?.snippet ?? '', /9\.4/);
});

test('approve answers the recorded approve hash for the held number only, and tamper the recorded failure', async () => {
  const app = await createReplayApp(OPTS);
  const cookie = await createTestSession(app);
  const approve = readGoldenFile(join(OPTS.goldenDir, 'b01-approve.json')).txs[0];
  const ok = await app.request('/replay/approve/8', { method: 'POST', headers: { cookie } });
  assert.deepEqual(await ok.json(), { ok: true, tx: approve?.hash, url: approve?.url });
  assert.equal((await app.request('/replay/approve/9', { method: 'POST', headers: { cookie } })).status, 404);
  const tamper = readGoldenFile(join(OPTS.goldenDir, 'tamper.json')).txs[0];
  const t = await app.request('/replay/tamper', { headers: { cookie } });
  assert.deepEqual(await t.json(), { tx: tamper?.hash, url: tamper?.url, failure: 'approve rejected: WrongAmount' });
});

test('the run events stream the golden trace and end with done', async () => {
  const app = await createReplayApp(OPTS);
  const cookie = await createTestSession(app);
  const res = await app.request(`/runs/${RUN_IDS.u01}/events`, { headers: { cookie } });
  const text = await res.text();
  assert.match(text, /^event: trace\ndata: .*"kind":"plan".*\nid: 0$/m);
  assert.match(text, /event: end\ndata: {"state":"done"}/);
  assert.equal((await app.request('/runs/ffffffffffffffffffffffffffffffff/events', { headers: { cookie } })).status, 404);
});

test('startReplayServer rejects with MISSING <path> on an empty golden directory and on an absent chain recording', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'demo-empty-'));
  await assert.rejects(startReplayServer({ ...OPTS, goldenDir: empty, port: 0 }), (e: unknown) => e instanceof MissingRecording && e.message === `MISSING ${join(empty, 'u01.json')}`);
  await assert.rejects(startReplayServer({ ...OPTS, chainDir: empty, port: 0 }), (e: unknown) => e instanceof MissingRecording && e.message === `MISSING ${join(empty, 'b01-escalate.json')}`);
});

test('startReplayServer listens on loopback, serves /session in replay mode and closes', async () => {
  const server = await startReplayServer({ ...OPTS, port: 0 });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
    const res = await fetch(`${server.url}/session`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-airlock-mode'), 'replay');
  } finally {
    await server.close();
  }
});

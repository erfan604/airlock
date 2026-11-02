// AIR-161: live mode has no way around the session: replay mode is a parameter and nothing in a request can switch it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createTestSession } from '../src/server/app.ts';
import { loginWithSeed } from './helpers/login.ts';
import { CONTRACT, OWNER, SEED, makeApp } from './helpers/server.ts';

test('live mode: GET /session without a cookie is 401, also with the replay header and the replay query', async () => {
  const h = makeApp({ mode: 'live', contractId: 'policy.test.near' });
  assert.equal((await h.app.request('/session')).status, 401);
  assert.equal((await h.app.request('/session', { headers: { 'x-airlock-mode': 'replay' } })).status, 401);
  assert.equal((await h.app.request('/session?mode=replay')).status, 401);
  assert.equal((await h.app.request('/session', { headers: { 'x-airlock-mode': 'replay', cookie: 'airlock_session=' + 'cd'.repeat(32) } })).status, 401);
});

test('live mode: no protected route opens without a real session, whatever the request says', async () => {
  const h = makeApp({ mode: 'live' });
  for (const path of ['/runs/x/events', '/api/evidence/1', '/runs/x/events?mode=replay', '/api/evidence/1?mode=replay']) {
    const res = await h.app.request(path, { headers: { 'x-airlock-mode': 'replay' } });
    assert.equal(res.status, 401, path);
    assert.equal(res.headers.get('x-airlock-mode'), null, `${path}: a live app never claims replay`);
  }
});

test('createTestSession throws on a live app and never issues a cookie there', async () => {
  const h = makeApp({ mode: 'live' });
  await assert.rejects(createTestSession(h.app));
  assert.equal(h.readerCalls.length, 0);
});

test('createApp refuses mode replay with policy.testnet', () => {
  const { deps } = makeApp();
  assert.throws(() => createApp({ ...deps, mode: 'replay', contractId: 'policy.testnet' }));
});

test('live mode: a real login works and its cookie opens the protected routes', async () => {
  const h = makeApp({ mode: 'live' });
  const { res, cookie } = await loginWithSeed(h.app, SEED, OWNER, CONTRACT);
  assert.equal(res.status, 200);
  assert.ok(cookie);
  assert.equal((await h.app.request('/session', { headers: { cookie: cookie as string } })).status, 200);
  assert.equal((await h.app.request('/runs/none/events', { headers: { cookie: cookie as string } })).status, 404, 'past the gate, the run is unknown');
  assert.equal(h.readerCalls.length, 1, 'the chain was asked exactly once, by the login');
});

test('replay mode keeps the gate for every route that is not GET /session', async () => {
  const h = makeApp({ mode: 'replay' });
  assert.equal((await h.app.request('/runs/x/events')).status, 401);
  assert.equal((await h.app.request('/api/evidence/1')).status, 401);
  assert.equal((await h.app.request('/session/logout', { method: 'POST' })).status, 204);
});

test('replay mode: the self-issued session is for the owner account only and each call without a cookie is a new session', async () => {
  const h = makeApp({ mode: 'replay' });
  const a = await h.app.request('/session');
  const b = await h.app.request('/session');
  const cookieA = /airlock_session=[0-9a-f]+/.exec(a.headers.get('set-cookie') ?? '')?.[0];
  const cookieB = /airlock_session=[0-9a-f]+/.exec(b.headers.get('set-cookie') ?? '')?.[0];
  assert.ok(cookieA && cookieB);
  assert.notEqual(cookieA, cookieB);
  assert.deepEqual(await a.json(), { accountId: OWNER });
});

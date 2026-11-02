// AIR-161: the app as a whole: a real socket, the app's own checks, replay mode and the RPC-backed access key reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { RpcPool } from '../src/chain/rpc.ts';
import { RpcUnavailable, rpcAccessKeyReader } from '../src/server/access-keys.ts';
import { createApp, createTestSession } from '../src/server/app.ts';
import { http503, rpcError, rpcResult, startMockRpc } from './helpers/mock-rpc.ts';
import { CONTRACT, OWNER, OWNER_KEY, makeApp } from './helpers/server.ts';

test('SERVER_401: over a real socket /runs/x/events without a cookie is 401', async () => {
  const h = makeApp();
  const server = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/runs/x/events`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'the server sends no CORS headers');
    await res.arrayBuffer();
    const pre = await fetch(`http://127.0.0.1:${port}/session`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    await pre.arrayBuffer();
    console.log('SERVER_401 ok');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('createApp: both ids must be NEAR account ids', () => {
  const base = makeApp().deps;
  for (const bad of ['', 'Owner.test.near', 'a', 'owner..near', '-owner.near', 'owner.near ', 'x'.repeat(65), 'owner@near']) {
    assert.throws(() => createApp({ ...base, ownerAccountId: bad }), `owner ${bad}`);
    assert.throws(() => createApp({ ...base, contractId: bad }), `contract ${bad}`);
  }
  assert.doesNotThrow(() => createApp({ ...base, ownerAccountId: 'erfan.testnet', contractId: 'policy.testnet' }), 'live mode may face any account');
});

test('createApp refuses mode replay unless the contract ends in .test.near', () => {
  const base = makeApp().deps;
  assert.throws(() => createApp({ ...base, mode: 'replay', contractId: 'policy.testnet' }));
  assert.throws(() => createApp({ ...base, mode: 'replay', contractId: 'test.near' }));
  assert.throws(() => createApp({ ...base, mode: 'replay', contractId: 'policy.test.near.evil.near' }));
  assert.doesNotThrow(() => createApp({ ...base, mode: 'replay', contractId: 'policy.test.near' }));
});

test('replay mode: every response says so, GET /session issues a real session, requireSession is not bypassed', async () => {
  const h = makeApp({ mode: 'replay' });
  const unknown = await h.app.request('/nothing-here');
  assert.equal(unknown.headers.get('x-airlock-mode'), 'replay');
  const challenge = await h.app.request('/session/challenge', { method: 'POST' });
  assert.equal(challenge.headers.get('x-airlock-mode'), 'replay');

  assert.equal((await h.app.request('/runs/x/events')).status, 401, 'no cookie, no bypass on a protected route');
  assert.equal((await h.app.request('/api/evidence/1')).status, 401);

  const issued = await h.app.request('/session');
  assert.equal(issued.status, 200);
  assert.deepEqual(await issued.json(), { accountId: OWNER });
  assert.equal(issued.headers.get('x-airlock-mode'), 'replay');
  const cookie = /airlock_session=[0-9a-f]{64}/.exec(issued.headers.get('set-cookie') ?? '')?.[0] ?? '';
  assert.notEqual(cookie, '');
  assert.equal((await h.app.request('/runs/x/events', { headers: { cookie } })).status, 404, 'the cookie passes requireSession, the run is unknown');
  const again = await h.app.request('/session', { headers: { cookie } });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('set-cookie'), null, 'a valid cookie is just checked');
  assert.equal(h.readerCalls.length, 0, 'no chain call for the self-issued session');
});

test('createTestSession returns the Cookie header value of a replay app', async () => {
  const h = makeApp({ mode: 'replay' });
  const cookie = await createTestSession(h.app);
  assert.match(cookie, /^airlock_session=[0-9a-f]{64}$/);
  assert.equal((await h.app.request('/runs/x/events', { headers: { cookie } })).status, 404);
  const other = await createTestSession(h.app);
  assert.notEqual(other, cookie);
});

test('live mode has no x-airlock-mode header', async () => {
  const h = makeApp();
  assert.equal((await h.app.request('/session')).headers.get('x-airlock-mode'), null);
});

// ---- the access key reader over mock RPC servers ----

const FAST = { retries: 1, wait: 0, backoff: 1 };

test('rpcAccessKeyReader: an unknown key is null, FullAccess and FunctionCall keys are read', async () => {
  const mock = await startMockRpc((call) => {
    const params = call.params as { public_key?: string };
    if (params.public_key === 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9') {
      return rpcError({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY', info: { public_key: params.public_key, block_hash: 'x', block_height: 1 } } });
    }
    if (params.public_key === OWNER_KEY) return rpcResult({ nonce: 5, permission: 'FullAccess', block_hash: '11111111111111111111111111111111', block_height: 7 });
    return rpcResult({
      nonce: 1,
      permission: { FunctionCall: { allowance: '1', receiver_id: 'policy.test.near', method_names: [] } },
      block_hash: '11111111111111111111111111111111',
      block_height: 7,
    });
  });
  try {
    const read = rpcAccessKeyReader(new RpcPool([mock.url], FAST));
    assert.equal(await read(OWNER, 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9'), null);
    assert.deepEqual(await read(OWNER, OWNER_KEY), { permission: 'FullAccess' });
    assert.deepEqual(await read(OWNER, 'ed25519:11111111111111111111111111111111'), { permission: 'FunctionCall' });
  } finally {
    await mock.close();
  }
});

test('rpcAccessKeyReader: every URL answering 503 throws RpcUnavailable, a node refusal is not an outage', async () => {
  const a = await startMockRpc(() => http503);
  const b = await startMockRpc(() => http503);
  try {
    const read = rpcAccessKeyReader(new RpcPool([a.url, b.url], FAST));
    await assert.rejects(read(OWNER, OWNER_KEY), (e) => e instanceof RpcUnavailable);
    assert.ok(a.calls.length >= 1 && b.calls.length >= 1, 'both URLs were tried');
  } finally {
    await a.close();
    await b.close();
  }
  const refusing = await startMockRpc(() => rpcError({ name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR', info: { error_message: 'bad' } } }));
  try {
    const read = rpcAccessKeyReader(new RpcPool([refusing.url], FAST));
    await assert.rejects(read(OWNER, OWNER_KEY), (e) => !(e instanceof RpcUnavailable));
  } finally {
    await refusing.close();
  }
});

test('the whole login works over the RPC-backed reader and a mock node', async () => {
  const mock = await startMockRpc(() => rpcResult({ nonce: 5, permission: 'FullAccess', block_hash: '11111111111111111111111111111111', block_height: 7 }));
  try {
    const h = makeApp({ accessKeys: rpcAccessKeyReader(new RpcPool([mock.url], FAST)) });
    const { loginWithSeed } = await import('./helpers/login.ts');
    const { SEED } = await import('./helpers/server.ts');
    const ok = await loginWithSeed(h.app, SEED, OWNER, CONTRACT);
    assert.equal(ok.res.status, 200);
    assert.ok(mock.calls.some((c) => c.method === 'query'));
  } finally {
    await mock.close();
  }
});

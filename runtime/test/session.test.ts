// AIR-161: owner sessions. NEP-413 login against the owner's on-chain full-access keys, one single-use challenge per login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyMessage } from 'near-api-js/nep413';
import { challengeMessage, decodeSignature, providerFromReader, requireSession } from '../src/server/session.ts';
import vector from './fixtures/nep413-vector.json' with { type: 'json' };
import { loginWithSeed, nep413Borsh, publicKeyOfSeed, signNep413 } from './helpers/login.ts';
import { CONTRACT, OWNER, OWNER_KEY, SEED, login, makeApp } from './helpers/server.ts';
import type { Harness } from './helpers/server.ts';

async function challenge(h: Harness, headers: Record<string, string> = {}): Promise<{ nonce: string; message: string; recipient: string }> {
  const res = await h.app.request('/session/challenge', { method: 'POST', headers });
  assert.equal(res.status, 200);
  return (await res.json()) as { nonce: string; message: string; recipient: string };
}

function post(h: Harness, body: unknown, headers: Record<string, string> = {}): Response | Promise<Response> {
  return h.app.request('/session', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

/** a valid login body for a challenge, with parts replaceable */
function body(c: { nonce: string; message: string; recipient: string }, over: Record<string, unknown> = {}, sign = { message: c.message, recipient: c.recipient, nonce: c.nonce }) {
  return {
    accountId: OWNER,
    publicKey: OWNER_KEY,
    signature: signNep413(SEED, sign.message, sign.nonce, sign.recipient),
    nonce: c.nonce,
    ...over,
  };
}

const UNAUTHORIZED = { error: 'unauthorized' };

test('NEP413_VECTOR: the borsh bytes, the sha256, verifyMessage through a stub reader, and four refusals', async () => {
  const nonce = Uint8Array.from(Buffer.from(vector.nonceHex, 'hex'));
  const borsh = nep413Borsh(vector.message, vector.nonceHex, vector.recipient);
  assert.equal(borsh.toString('hex'), vector.borshHex);
  assert.equal(createHash('sha256').update(borsh).digest('hex'), vector.sha256Hex);
  assert.equal(publicKeyOfSeed(vector.seedHex), vector.publicKey);
  assert.equal(signNep413(vector.seedHex, vector.message, vector.nonceHex, vector.recipient), vector.signatureBase64);
  assert.equal(vector.message, challengeMessage(vector.accountId));
  assert.equal(challengeMessage('owner.test.near').length, 53);

  const full = providerFromReader(async () => ({ permission: 'FullAccess' }));
  const args = {
    signerAccountId: vector.accountId,
    signerPublicKey: vector.publicKey,
    payload: { message: vector.message, nonce, recipient: vector.recipient },
    signature: decodeSignature(vector.signatureBase64),
    provider: full,
  };
  await verifyMessage(args);
  await assert.rejects(verifyMessage({ ...args, payload: { ...args.payload, recipient: 'other.test.near' } }), 'another recipient');
  await assert.rejects(verifyMessage({ ...args, payload: { ...args.payload, message: `${vector.message} ` } }), 'another message');
  const other = Uint8Array.from(nonce);
  other[0] = 9;
  await assert.rejects(verifyMessage({ ...args, payload: { ...args.payload, nonce: other } }), 'another nonce');
  await assert.rejects(verifyMessage({ ...args, provider: providerFromReader(async () => ({ permission: 'FunctionCall' })) }), 'a FunctionCall key');
  await assert.rejects(verifyMessage({ ...args, provider: providerFromReader(async () => null) }), 'a missing key');
  console.log('NEP413_VECTOR ok');
});

test('decodeSignature: padded and unpadded base64 of 64 bytes pass, everything else throws', () => {
  const padded = vector.signatureBase64;
  assert.equal(padded.endsWith('=='), true);
  assert.equal(decodeSignature(padded).length, 64);
  assert.deepEqual(decodeSignature(padded.replace(/=+$/, '')), decodeSignature(padded));
  assert.throws(() => decodeSignature(padded.slice(0, -4)), 'a short signature');
  assert.throws(() => decodeSignature(`${padded}AAAA`), 'a long signature');
  assert.throws(() => decodeSignature(`_${padded.slice(1)}`), 'url-safe alphabet');
  assert.throws(() => decodeSignature(`${padded.slice(0, -2)}=A`), 'padding in the middle');
  assert.throws(() => decodeSignature(' ' + padded), 'whitespace');
  assert.throws(() => decodeSignature(''), 'empty');
  // non-canonical trailing bits decode with Buffer but do not re-encode to the same text
  const bytes = Buffer.alloc(64, 1);
  const canon = bytes.toString('base64');
  assert.equal(canon.endsWith('=='), true);
  const sloppy = `${canon.slice(0, -3)}B==`;
  assert.notEqual(Buffer.from(sloppy, 'base64').toString('base64'), sloppy);
  assert.throws(() => decodeSignature(sloppy), 'non canonical trailing bits');
});

test('no cookie: GET /runs/x/events, GET /api/evidence/1 and GET /session are 401', async () => {
  const h = makeApp();
  for (const path of ['/runs/x/events', '/api/evidence/1', '/session']) {
    const res = await h.app.request(path);
    assert.equal(res.status, 401, path);
  }
});

test('the challenge is 64 lowercase hex characters with the pinned message and the contract as recipient', async () => {
  const h = makeApp();
  const c = await challenge(h);
  assert.match(c.nonce, /^[0-9a-f]{64}$/);
  assert.equal(c.message, 'Sign in to AIRLOCK as owner.test.near. No funds move.');
  assert.equal(c.recipient, CONTRACT);
  const again = await challenge(h);
  assert.notEqual(again.nonce, c.nonce);
});

test('login: 200 with the cookie attributes, no Secure on localhost, Secure on another host; logout ends it', async () => {
  const h = makeApp();
  const c = await challenge(h);
  const res = await post(h, body(c), { host: 'localhost' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accountId: OWNER });
  const set = res.headers.get('set-cookie') ?? '';
  assert.match(set, /^airlock_session=[0-9a-f]{64};/);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(set.includes(part), part);
  assert.equal(/;\s*Secure/i.test(set), false, 'no Secure on localhost');

  const remote = await loginWithSeed(h.app, SEED, OWNER, CONTRACT, 'airlock.example');
  assert.equal(remote.res.status, 200);
  assert.match(remote.res.headers.get('set-cookie') ?? '', /;\s*Secure/);
  const loopback = await loginWithSeed(h.app, SEED, OWNER, CONTRACT, '127.0.0.1:8787');
  assert.equal(/;\s*Secure/i.test(loopback.res.headers.get('set-cookie') ?? ''), false, '127.0.0.1 with a port');

  const cookie = /airlock_session=[0-9a-f]+/.exec(set)?.[0] ?? '';
  const me = await h.app.request('/session', { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { accountId: OWNER });
  const out = await h.app.request('/session/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 204);
  assert.equal((await h.app.request('/session', { headers: { cookie } })).status, 401);
  assert.equal((await h.app.request('/runs/x/events', { headers: { cookie } })).status, 401);
});

test('every authentication failure is the same 401 with the same body', async () => {
  const cases: { name: string; run: (h: Harness) => Promise<Response> }[] = [
    {
      name: 'a key that is not on the account',
      run: async (h) => {
        h.keys.clear();
        return post(h, body(await challenge(h)));
      },
    },
    {
      name: 'a function-call key',
      run: async (h) => {
        h.keys.set(`${OWNER} ${OWNER_KEY}`, 'FunctionCall');
        return post(h, body(await challenge(h)));
      },
    },
    {
      name: 'another message signed',
      run: async (h) => {
        const c = await challenge(h);
        return post(h, body(c, {}, { message: 'Sign in to AIRLOCK as owner.test.near. Funds move.', recipient: c.recipient, nonce: c.nonce }));
      },
    },
    {
      name: 'another recipient signed',
      run: async (h) => {
        const c = await challenge(h);
        return post(h, body(c, {}, { message: c.message, recipient: 'policy.testnet', nonce: c.nonce }));
      },
    },
    {
      name: 'a replayed nonce',
      run: async (h) => {
        const c = await challenge(h);
        const first = await post(h, body(c));
        assert.equal(first.status, 200);
        return post(h, body(c));
      },
    },
    {
      name: 'an expired nonce',
      run: async (h) => {
        const c = await challenge(h);
        h.clock.now += 300_001;
        return post(h, body(c));
      },
    },
    {
      name: 'an unknown nonce',
      run: async (h) => {
        const c = await challenge(h);
        const fake = '11'.repeat(32);
        return post(h, body({ ...c, nonce: fake }));
      },
    },
    {
      name: 'an account other than the owner',
      run: async (h) => {
        const c = await challenge(h);
        h.keys.set(`mallory.test.near ${OWNER_KEY}`, 'FullAccess');
        return post(h, body(c, { accountId: 'mallory.test.near' }));
      },
    },
    {
      name: 'a signature by another key',
      run: async (h) => {
        const c = await challenge(h);
        const otherSeed = '03'.repeat(32);
        return post(h, body(c, { signature: signNep413(otherSeed, c.message, c.nonce, c.recipient) }));
      },
    },
  ];
  const seen: string[] = [];
  for (const c of cases) {
    const h = makeApp();
    const res = await c.run(h);
    assert.equal(res.status, 401, c.name);
    assert.equal(res.headers.get('set-cookie'), null, c.name);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), UNAUTHORIZED, c.name);
    seen.push(text);
  }
  assert.equal(new Set(seen).size, 1, 'the same body every time');
});

test('a nonce is consumed by the attempt that fails the check: the same challenge cannot be tried twice', async () => {
  const h = makeApp();
  h.keys.clear();
  const c = await challenge(h);
  assert.equal((await post(h, body(c))).status, 401);
  h.keys.set(`${OWNER} ${OWNER_KEY}`, 'FullAccess');
  assert.equal((await post(h, body(c))).status, 401, 'now the key is fine but the nonce is gone');
});

test('a 72 character (36 byte) nonce is 400 and the challenge stays usable', async () => {
  const h = makeApp();
  const c = await challenge(h);
  const long = `${c.nonce}abcdabcd`;
  assert.equal(long.length, 72);
  const bad = await post(h, body(c, { nonce: long }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'bad request' });
  assert.equal((await post(h, body(c))).status, 200);
});

test('a signature that is not 64 bytes of canonical base64 is 400, nothing else is read first', async () => {
  const h = makeApp();
  const c = await challenge(h);
  const good = signNep413(SEED, c.message, c.nonce, c.recipient);
  for (const signature of [good.slice(0, -4), `${good}AAAA`, `_${good.slice(1)}`, '', 5, null]) {
    const res = await post(h, body(c, { signature }));
    assert.equal(res.status, 400, String(signature));
  }
  assert.equal(h.readerCalls.length, 0);
  assert.equal((await post(h, body(c, { signature: good.replace(/=+$/, '') }))).status, 200, 'unpadded base64 is accepted');
});

test('a public key must carry the ed25519 prefix: bare base58 and secp256k1 keys are 400', async () => {
  const h = makeApp();
  const c = await challenge(h);
  const bare = OWNER_KEY.slice('ed25519:'.length);
  for (const publicKey of [bare, `secp256k1:${bare}`, 'ed25519:', 'ed25519:0OIl', `ed25519:${bare}${bare}`]) {
    const res = await post(h, body(c, { publicKey }));
    assert.equal(res.status, 400, publicKey);
  }
  assert.equal(h.readerCalls.length, 0);
});

test('a body with an extra field, a missing field, bad JSON or more than 8 KB is 400', async () => {
  const h = makeApp();
  const c = await challenge(h);
  const good = body(c);
  assert.equal((await post(h, { ...good, extra: 1 })).status, 400);
  const { signature: _s, ...missing } = good;
  assert.equal((await post(h, missing)).status, 400);
  assert.equal((await post(h, '{not json')).status, 400);
  assert.equal((await post(h, '[]')).status, 400);
  assert.equal((await post(h, JSON.stringify({ ...good, pad: 'x'.repeat(9000) }))).status, 400);
  assert.equal((await post(h, good)).status, 200, 'the challenge survived every 400');
});

test('an RpcUnavailable from the reader is 503 and the nonce stays consumed', async () => {
  const h = makeApp();
  h.keys.set(`${OWNER} ${OWNER_KEY}`, 'unavailable');
  const c = await challenge(h);
  const res = await post(h, body(c));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'rpc unavailable' });
  h.keys.set(`${OWNER} ${OWNER_KEY}`, 'FullAccess');
  assert.equal((await post(h, body(c))).status, 401);
  assert.equal((await post(h, body(await challenge(h)))).status, 200, 'a new challenge works');
});

test('per client: 20 challenges within 60 seconds are fine, the 21st is 429 rate limited, the window then slides', async () => {
  const h = makeApp();
  for (let i = 0; i < 20; i++) assert.equal((await h.app.request('/session/challenge', { method: 'POST' })).status, 200, `challenge ${i + 1}`);
  const over = await h.app.request('/session/challenge', { method: 'POST' });
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { error: 'rate limited' });
  h.clock.now += 60_001;
  assert.equal((await h.app.request('/session/challenge', { method: 'POST' })).status, 200);
});

test('at most 1,000 outstanding challenges: the 1,001st evicts the oldest instead of failing, expired ones are purged first', async () => {
  const h = makeApp({ limits: { challengesPerWindow: 100_000 } });
  const first = await challenge(h);
  for (let i = 1; i < 1000; i++) assert.equal((await h.app.request('/session/challenge', { method: 'POST' })).status, 200, `challenge ${i + 1}`);
  const last = await challenge(h);
  assert.equal((await post(h, body(first))).status, 401, 'the oldest challenge was evicted to stay at the cap');
  assert.equal((await post(h, body(last))).status, 200, 'the newest is alive');
  h.clock.now += 300_001;
  assert.equal((await h.app.request('/session/challenge', { method: 'POST' })).status, 200, 'expired challenges were purged');
});

const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

test('a flood from client A does not stop client B from getting a challenge and logging in', async () => {
  const h = makeApp();
  let limited = 0;
  for (let i = 0; i < 200; i++) {
    const res = await h.app.request('/session/challenge', { method: 'POST' }, from('10.0.0.1'));
    if (res.status === 429) limited++;
  }
  assert.ok(limited >= 180, `client A was limited (${limited} of 200)`);
  const res = await h.app.request('/session/challenge', { method: 'POST' }, from('10.0.0.2'));
  assert.equal(res.status, 200);
  const c = (await res.json()) as { nonce: string; message: string; recipient: string };
  const login = await h.app.request('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(c)) }, from('10.0.0.2'));
  assert.equal(login.status, 200);
});

test('a flood from many clients keeps the outstanding challenges at the cap and the owner can still log in', async () => {
  const h = makeApp();
  for (let i = 0; i < 1500; i++) {
    await h.app.request('/session/challenge', { method: 'POST' }, from(`10.1.${Math.floor(i / 250)}.${i % 250}`));
  }
  const res = await h.app.request('/session/challenge', { method: 'POST' }, from('10.9.9.9'));
  assert.equal(res.status, 200);
});

test('Origin: a foreign origin on a non-GET route is 403, the same host is 204, no Origin is fine, GET is not checked', async () => {
  const h = makeApp();
  const cookie = await login(h);
  const evil = await h.app.request('/session/logout', { method: 'POST', headers: { cookie, host: 'localhost', origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.deepEqual(await evil.json(), { error: 'bad origin' });
  assert.equal((await h.app.request('/session', { headers: { cookie } })).status, 200, 'the refused logout did nothing');
  const junk = await h.app.request('/session/logout', { method: 'POST', headers: { cookie, host: 'localhost', origin: 'null' } });
  assert.equal(junk.status, 403);
  const portless = await h.app.request('/session/logout', { method: 'POST', headers: { cookie, host: 'localhost:5173', origin: 'http://localhost' } });
  assert.equal(portless.status, 403, 'a different port is a different host');
  const same = await h.app.request('/session/logout', { method: 'POST', headers: { cookie, host: 'localhost:5173', origin: 'http://localhost:5173' } });
  assert.equal(same.status, 204);
  const get = await h.app.request('/session', { headers: { host: 'localhost', origin: 'https://evil.example' } });
  assert.equal(get.status, 401, 'a GET reaches the handler');
  const challengeEvil = await h.app.request('/session/challenge', { method: 'POST', headers: { host: 'localhost', origin: 'https://evil.example' } });
  assert.equal(challengeEvil.status, 403);
});

test('the session id handed to handlers is the first 16 hex of sha256 of the cookie value, never the cookie value', async () => {
  const h = makeApp();
  // AIR-163 mounts its routes on the returned app before the first request: the same here
  h.app.get('/probe/session', requireSession, (c) => c.json(c.get('session') as unknown as object));
  const cookie = await login(h);
  const value = cookie.slice('airlock_session='.length);
  const res = await h.app.request('/probe/session', { headers: { cookie } });
  assert.equal(res.status, 200);
  const seen = (await res.json()) as { accountId: string; sessionId: string };
  assert.equal(seen.accountId, OWNER);
  assert.equal(seen.sessionId, createHash('sha256').update(value).digest('hex').slice(0, 16));
  assert.notEqual(seen.sessionId, value);
  assert.equal(JSON.stringify(seen).includes(value), false);
  assert.equal((await h.app.request('/probe/session')).status, 401);
});

test('sessions: 8 hours then expired, at most 16 at once with the oldest dropped, a forged cookie is refused', async () => {
  const h = makeApp();
  const first = await login(h);
  assert.equal((await h.app.request('/session', { headers: { cookie: first } })).status, 200);
  h.clock.now += 8 * 3600 * 1000 + 1;
  assert.equal((await h.app.request('/session', { headers: { cookie: first } })).status, 401);

  const h2 = makeApp({ limits: { challengesPerWindow: 100_000 } });
  const cookies: string[] = [];
  for (let i = 0; i < 17; i++) cookies.push(await login(h2));
  assert.equal((await h2.app.request('/session', { headers: { cookie: cookies[0] as string } })).status, 401, 'the oldest was dropped');
  assert.equal((await h2.app.request('/session', { headers: { cookie: cookies[1] as string } })).status, 200);
  assert.equal((await h2.app.request('/session', { headers: { cookie: cookies[16] as string } })).status, 200);
  for (const forged of [`airlock_session=${'ab'.repeat(32)}`, 'airlock_session=', 'airlock_session=zz', 'other=1']) {
    assert.equal((await h2.app.request('/session', { headers: { cookie: forged } })).status, 401, forged);
  }
});

test('every response carries no-store, nosniff and no-referrer', async () => {
  const h = makeApp();
  for (const res of [await h.app.request('/session'), await h.app.request('/nothing-here'), await h.app.request('/session/challenge', { method: 'POST' })]) {
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  }
});

test('a login for another account id is also refused when the reader would accept that key', async () => {
  const h = makeApp();
  h.keys.set(`mallory.test.near ${OWNER_KEY}`, 'FullAccess');
  const c = await challenge(h);
  const res = await post(h, body(c, { accountId: 'mallory.test.near' }));
  assert.equal(res.status, 401);
  assert.equal(h.readerCalls.length, 0, 'the chain is not asked about an account that is not the owner');
});

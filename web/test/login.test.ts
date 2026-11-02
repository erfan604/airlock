// AIR-182: the login flow against a mocked wallet and a mocked fetch (AIR-161's routes).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoginError, fetchSession, login, logout } from '../src/wallet/login.ts';

const HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

type Req = { url: string; init: RequestInit | undefined };

function server(opts: { challenge?: Response; session?: Response } = {}): { fetch: typeof fetch; seen: Req[] } {
  const seen: Req[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    if (url === '/session/challenge') return opts.challenge ?? Response.json({ nonce: HEX, message: 'Sign in to AIRLOCK as owner.testnet. No funds move.', recipient: 'policy.testnet' });
    if (url === '/session' && init?.method === 'POST') return opts.session ?? Response.json({ accountId: 'owner.testnet' });
    if (url === '/session/logout') return new Response(null, { status: 204 });
    if (url === '/session') return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: f, seen };
}

const signed = { accountId: 'owner.testnet', publicKey: 'ed25519:abc', signature: 'c2ln' };

test('login: signMessage receives the 32 bytes of the challenge nonce, the message and the recipient', async () => {
  const s = server();
  let got: { message: string; recipient: string; nonce: Uint8Array } | undefined;
  const wallet = {
    async signMessage(p: { message: string; recipient: string; nonce: Uint8Array }) {
      got = p;
      return signed;
    },
  };
  const r = await login(wallet, { fetch: s.fetch });
  assert.deepEqual(r, { accountId: 'owner.testnet' });
  assert.ok(got);
  assert.ok(got.nonce instanceof Uint8Array);
  assert.equal(got.nonce.length, 32);
  assert.equal(Buffer.from(got.nonce).toString('hex'), HEX);
  assert.equal(got.message, 'Sign in to AIRLOCK as owner.testnet. No funds move.');
  assert.equal(got.recipient, 'policy.testnet');
});

test('login: the POST /session body has exactly accountId, publicKey, signature and nonce', async () => {
  const s = server();
  await login({ signMessage: async () => signed }, { fetch: s.fetch });
  const post = s.seen.find((r) => r.url === '/session' && r.init?.method === 'POST');
  assert.ok(post);
  const body = JSON.parse(String(post.init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['accountId', 'nonce', 'publicKey', 'signature']);
  assert.deepEqual(body, { accountId: 'owner.testnet', publicKey: 'ed25519:abc', signature: 'c2ln', nonce: HEX });
  assert.equal(post.init?.credentials, 'same-origin');
});

test('login: a 36 byte nonce is never produced', async () => {
  const s = server({ challenge: Response.json({ nonce: '8f14e45f-ceea-467a-9575-1d8a1d1a1b2c', message: 'm', recipient: 'r' }) });
  let called = false;
  await assert.rejects(
    () => login({ signMessage: async () => ((called = true), signed) }, { fetch: s.fetch }),
    (e: unknown) => e instanceof LoginError,
  );
  assert.equal(called, false);
});

test('login: a 401 from POST /session is LoginError rejected', async () => {
  const s = server({ session: Response.json({ error: 'unauthorized' }, { status: 401 }) });
  await assert.rejects(
    () => login({ signMessage: async () => signed }, { fetch: s.fetch }),
    (e: unknown) => e instanceof LoginError && e.kind === 'rejected',
  );
});

test('login: a 503 is LoginError rpc', async () => {
  const s = server({ session: Response.json({ error: 'rpc unavailable' }, { status: 503 }) });
  await assert.rejects(
    () => login({ signMessage: async () => signed }, { fetch: s.fetch }),
    (e: unknown) => e instanceof LoginError && e.kind === 'rpc',
  );
});

test('login: a wallet that throws is LoginError wallet and nothing is posted', async () => {
  const s = server();
  await assert.rejects(
    () =>
      login(
        {
          signMessage: async () => {
            throw new Error('User rejected');
          },
        },
        { fetch: s.fetch },
      ),
    (e: unknown) => e instanceof LoginError && e.kind === 'wallet',
  );
  assert.equal(s.seen.filter((r) => r.init?.method === 'POST' && r.url === '/session').length, 0);
});

test('login: the LoginError messages are fixed texts without any server or wallet text', () => {
  for (const kind of ['rejected', 'rpc', 'wallet'] as const) {
    const e = new LoginError(kind);
    assert.ok(e.message.length > 10);
    assert.ok(!e.message.includes('--'));
    assert.ok(!e.message.includes('\u2014'));
  }
  assert.notEqual(new LoginError('rejected').message, new LoginError('rpc').message);
});

test('login: fetchSession gives the account, or null on a 401', async () => {
  const ok = (async () => Response.json({ accountId: 'owner.testnet' })) as unknown as typeof fetch;
  assert.deepEqual(await fetchSession({ fetch: ok }), { accountId: 'owner.testnet' });
  const none = server().fetch;
  assert.equal(await fetchSession({ fetch: none }), null);
});

test('login: logout posts /session/logout with the same-origin cookie', async () => {
  const s = server();
  await logout({ fetch: s.fetch });
  const r = s.seen[0];
  assert.ok(r);
  assert.equal(r.url, '/session/logout');
  assert.equal(r.init?.method, 'POST');
  assert.equal(r.init?.credentials, 'same-origin');
});

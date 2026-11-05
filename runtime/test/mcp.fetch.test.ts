// AIR-313: fetch_page's live fetch refuses every way to a private address. IP literals in any spelling, hosts not on the owner's list,
// names that resolve to a private address (mocked DNS), redirects; and the connection is pinned to the vetted address.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { test } from 'node:test';
import { isPublicAddress, makeFetchLive } from '../src/mcp/fetch.ts';
import type { FetchDeps } from '../src/mcp/fetch.ts';

// a request double: answers with `status` and `body`, and records the options it was given
function fakeRequest(status: number, body = ''): { deps: Pick<FetchDeps, 'request'>; seen: RequestOptions[] } {
  const seen: RequestOptions[] = [];
  return {
    seen,
    deps: {
      request: (opts, cb) => {
        seen.push(opts);
        const req = new EventEmitter() as ClientRequest;
        (req as unknown as { end: () => void }).end = () => {
          const res = new EventEmitter() as IncomingMessage;
          res.statusCode = status;
          (res as unknown as { resume: () => void }).resume = () => undefined;
          (res as unknown as { destroy: () => void }).destroy = () => undefined;
          cb(res);
          setImmediate(() => {
            if (body !== '') res.emit('data', Buffer.from(body));
            res.emit('close');
          });
        };
        (req as unknown as { destroy: () => void }).destroy = () => undefined;
        return req;
      },
    },
  };
}

const publicDns: FetchDeps['resolve'] = async () => [{ address: '93.184.215.14', family: 4 }];

const refusedWith = async (p: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(p, (e: unknown) => (e as { code?: string }).code === code);
};

test('fetch: IP literals in every spelling are refused even when the owner lists them', async () => {
  const literals = ['127.0.0.1', '0x7f000001', '2130706433', '0177.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '172.16.0.1', '100.64.0.1', '10.0.0.1'];
  const fetch = makeFetchLive(literals, { resolve: publicDns, ...fakeRequest(200, 'x').deps });
  for (const host of literals) await refusedWith(fetch(`https://${host}/`), 'IpLiteral');
});

test('fetch: a host that is not on the owner list is refused; an empty list fetches nothing', async () => {
  await refusedWith(makeFetchLive(['acme.example'], { resolve: publicDns, ...fakeRequest(200).deps })('https://evil.example/'), 'HostNotAllowed');
  await refusedWith(makeFetchLive([], { resolve: publicDns, ...fakeRequest(200).deps })('https://acme.example/'), 'HostNotAllowed');
  await refusedWith(makeFetchLive(['acme.example'], { resolve: publicDns, ...fakeRequest(200).deps })('http://acme.example/'), 'NotHttps');
  await refusedWith(makeFetchLive(['acme.example'], { resolve: publicDns, ...fakeRequest(200).deps })('https://acme.example:8443/'), 'BadUrl');
});

test('fetch: a listed name that resolves to a private address (any of its addresses) is refused before connecting', async () => {
  const r = fakeRequest(200, 'x');
  const cases: { address: string; family: number }[][] = [
    [{ address: '10.1.2.3', family: 4 }],
    [{ address: '93.184.215.14', family: 4 }, { address: '192.168.1.1', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: 'fd00::1', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [{ address: '100.64.0.1', family: 4 }],
  ];
  for (const answer of cases) {
    const fetch = makeFetchLive(['acme.example'], { resolve: async () => answer, ...r.deps });
    await refusedWith(fetch('https://acme.example/pay'), 'PrivateAddress');
  }
  assert.equal(r.seen.length, 0);
});

test('fetch: a redirect is refused', async () => {
  await refusedWith(makeFetchLive(['acme.example'], { resolve: publicDns, ...fakeRequest(302).deps })('https://acme.example/'), 'Redirect');
});

test('fetch: the connection is pinned to the vetted address, and the body is returned', async () => {
  const r = fakeRequest(200, 'Invoice: 1 NEAR');
  const text = await makeFetchLive(['acme.example'], { resolve: publicDns, ...r.deps })('https://acme.example/pay?id=1');
  assert.equal(text, 'Invoice: 1 NEAR');
  const opts = r.seen[0] as RequestOptions;
  assert.equal(opts.path, '/pay?id=1');
  assert.equal(opts.servername, 'acme.example');
  const got = await new Promise<string>((resolve) => (opts.lookup as (h: string, o: object, cb: (e: null, a: string) => void) => void)('acme.example', {}, (_e, a) => resolve(a)));
  assert.equal(got, '93.184.215.14');
});

test('fetch: the address table', () => {
  for (const a of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.31.255.255', '192.168.0.1', '100.127.255.255', '169.254.1.1', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', 'not-an-ip']) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ['93.184.215.14', '8.8.8.8', '2606:4700::1111']) assert.equal(isPublicAddress(a), true, a);
});

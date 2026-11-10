// AIR-310: the static adapter's pure parts: the SSE text parser that stands in for EventSource, the headers file and the host-like server's header reader.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FASTNEAR_TX, FAUCET, ICON_ORIGINS, NEAR_RPC, WALLET_ORIGINS, buildStaticCsp } from '../csp.ts';
import { starHeaders } from '../scripts/serve-static.ts';
import { parseSse } from '../src/replay/staticEventSource.ts';
import { headersFile } from '../vite-static.ts';

test('parseSse reads id, event and data, joins multi-line data and skips comments', () => {
  const text = ': hi\nid: 0\nevent: trace\ndata: {"a":1}\n\nid: 1\nevent: end\ndata: {"state":"done"}\n\n';
  assert.deepEqual(parseSse(text), [
    { event: 'trace', id: '0', data: '{"a":1}' },
    { event: 'end', id: '1', data: '{"state":"done"}' },
  ]);
  assert.deepEqual(parseSse('data: a\ndata: b\n\n'), [{ event: 'message', id: '', data: 'a\nb' }]);
  assert.deepEqual(parseSse(''), []);
});

const NONCE = 'dGVzdG5vbmNlMTIzNDU2';

test('the static policy names only the testnet RPC and wallet hosts, with a build nonce and no unsafe-eval', () => {
  const header = buildStaticCsp({ header: true, nonce: NONCE });
  const script = /script-src ([^;]*)/.exec(header)?.[1]?.split(' ') ?? [];
  assert.ok(header.includes("frame-ancestors 'none'") && script.includes(`'nonce-${NONCE}'`) && script.includes("'self'") && script.includes("'wasm-unsafe-eval'") && !script.includes("'unsafe-eval'") && !script.includes("'unsafe-inline'"));
  const hosts = [...header.matchAll(/https?:\/\/[^\s;]+/g)].map((m) => m[0]);
  const allowed = new Set<string>([...NEAR_RPC, FASTNEAR_TX, FAUCET, ...WALLET_ORIGINS, ...ICON_ORIGINS]);
  assert.ok(hosts.length > 0 && hosts.every((h) => allowed.has(h)), `unexpected host in ${hosts.join(' ')}`);
  assert.ok(!header.includes('localhost') && !header.includes('http://'), 'no runtime origin and no plain http');
  assert.ok(/frame-src https:\/\/[^;]*wallet\.intear\.tech/.test(header));
  assert.ok(/connect-src [^;]*https:\/\/tx\.test\.fastnear\.com/.test(header), 'the AIR-320 board reads the FastNEAR tx API');
  assert.ok(!buildStaticCsp({ header: false, nonce: NONCE }).includes('frame-ancestors'));
  // AIR-359: the lend page asks the public account faucet from the visitor's browser: connect-src only
  assert.equal(FAUCET, 'https://helper.testnet.near.org');
  assert.ok(/connect-src [^;]*https:\/\/helper\.testnet\.near\.org/.test(header));
  assert.equal(header.split('helper.testnet.near.org').length, 2, 'the faucet host is named once, in connect-src');
});

test('the headers file carries the policy in its first block', () => {
  assert.equal(starHeaders(headersFile(NONCE))['Content-Security-Policy'], buildStaticCsp({ header: true, nonce: NONCE }));
});

// AIR-323 L4: the host serves /try/ and answers 308 to /try, so the sitemap, canonical and og:url name the slash form.
test('pageUrl: the root stays the root, every other page gets its trailing slash, a query stays after it', async () => {
  const { pageUrl } = await import('../src/pages.ts');
  assert.equal(pageUrl('https://x.dev', '/', '/'), 'https://x.dev/');
  assert.equal(pageUrl('https://x.dev', '/', '/try'), 'https://x.dev/try/');
  assert.equal(pageUrl('https://x.dev', '/', '/try?s=hired'), 'https://x.dev/try/?s=hired');
  assert.equal(pageUrl('https://x.dev', '/repo/', '/approvals'), 'https://x.dev/repo/approvals/');
  assert.equal(pageUrl('https://x.dev', '/', '/approvals/'), 'https://x.dev/approvals/');
});

test('sitemapXml: every non-alias page, in the slash form, and no 308 target', async () => {
  const { sitemapXml } = await import('../scripts/llms.ts');
  const { PAGES } = await import('../src/pages.ts');
  const xml = sitemapXml('https://x.dev', '/');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '');
  assert.equal(locs.length, PAGES.filter((p) => p.alias === undefined).length);
  assert.ok(locs.includes('https://x.dev/'));
  assert.ok(locs.includes('https://x.dev/approvals/') && locs.includes('https://x.dev/challenge/'));
  for (const l of locs) assert.ok(l.endsWith('/'), l);
});

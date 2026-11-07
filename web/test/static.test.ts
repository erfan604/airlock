// AIR-310: the static adapter's pure parts: the SSE text parser that stands in for EventSource, the headers file and the host-like server's header reader.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ICON_ORIGINS, NEAR_RPC, WALLET_ORIGINS, buildStaticCsp } from '../csp.ts';
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
  const allowed = new Set<string>([...NEAR_RPC, ...WALLET_ORIGINS, ...ICON_ORIGINS]);
  assert.ok(hosts.length > 0 && hosts.every((h) => allowed.has(h)), `unexpected host in ${hosts.join(' ')}`);
  assert.ok(!header.includes('localhost') && !header.includes('http://'), 'no runtime origin and no plain http');
  assert.ok(/frame-src https:\/\/[^;]*wallet\.intear\.tech/.test(header));
  assert.ok(!buildStaticCsp({ header: false, nonce: NONCE }).includes('frame-ancestors'));
});

test('the headers file carries the policy in its first block', () => {
  assert.equal(starHeaders(headersFile(NONCE))['Content-Security-Policy'], buildStaticCsp({ header: true, nonce: NONCE }));
});

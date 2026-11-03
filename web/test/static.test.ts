// AIR-310: the static adapter's pure parts: the SSE text parser that stands in for EventSource, the headers file and the host-like server's header reader.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStaticCsp } from '../csp.ts';
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

test('the static policy allows the page origin only and has no unsafe-eval, no remote host', () => {
  const header = buildStaticCsp({ header: true });
  assert.ok(header.includes("connect-src 'self';") && header.includes("script-src 'self';") && header.includes("frame-ancestors 'none'"));
  assert.ok(!header.includes('http') && !header.includes('unsafe-eval'));
  assert.ok(!buildStaticCsp({ header: false }).includes('frame-ancestors'));
});

test('the headers file carries the policy in its first block', () => {
  assert.equal(starHeaders(headersFile())['Content-Security-Policy'], buildStaticCsp({ header: true }));
});

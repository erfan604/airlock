// requestPath (AIR-183): the one place a raw request url becomes the path the middleware reasons about.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProxiedUrl, requestPath } from '../vite-csp.ts';

test('requestPath: decodes once, collapses duplicate slashes and resolves dot segments', () => {
  const cases: Array<[string, string]> = [
    ['/', '/'],
    ['/index.html', '/index.html'],
    ['/%69ndex.html', '/index.html'],
    ['/./index.html', '/index.html'],
    ['//index.html', '/index.html'],
    ['///a//b', '/a/b'],
    ['/a/../index.html', '/index.html'],
    ['/../index.html', '/index.html'],
    ['/%2e%2e/index.html', '/index.html'],
    ['/a%2Fb', '/a/b'],
    ['/index.html?x=1#frag', '/index.html'],
    ['/a/b/', '/a/b/'],
    ['/a\\..\\index.html', '/index.html'],
    ['/%2569ndex.html', '/%69ndex.html'],
  ];
  for (const [raw, want] of cases) assert.deepEqual(requestPath(raw), { kind: 'path', path: want }, raw);
});

test('requestPath: a malformed escape or a NUL is malformed, a non-path url is other', () => {
  for (const raw of ['/%', '/%zz', '/%E0%A4%A', '/a%00b', '/a\u0000b']) assert.deepEqual(requestPath(raw), { kind: 'malformed' }, JSON.stringify(raw));
  for (const raw of ['*', 'http://example.com/x', '']) assert.deepEqual(requestPath(raw), { kind: 'other' }, JSON.stringify(raw));
});

test('isProxiedUrl: the rule Vite uses, a prefix match on the raw url', () => {
  const prefixes = ['/session', '/tasks', '/runs', '/api'];
  for (const url of ['/session', '/session/x', '/session?a=1', '/api/evidence/3', '/runsX']) assert.equal(isProxiedUrl(url, prefixes), true, url);
  // spellings Vite does not proxy are console pages and must not be treated as proxied
  for (const url of ['/%2Fsession', '/./session', '//session', '/%73ession', '/', '/index.html', '/s']) assert.equal(isProxiedUrl(url, prefixes), false, url);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTrusted, normalizeIp, resolveAddress, validTrustedEntry } from '../src/address.ts';
import { DailySalt, visitorKey } from '../src/visitor.ts';

const h = (map: Record<string, string>) => (name: string): string | undefined => map[name];
const rules = { header: 'x-forwarded-for', trusted: ['10.0.0.5', '192.168.0.0/16'] };

test('no proxy configured: the socket address is the visitor and a header is ignored', () => {
  assert.deepEqual(resolveAddress({ header: null, trusted: [] }, '203.0.113.9', h({ 'x-forwarded-for': '1.1.1.1' })), { ok: true, address: '203.0.113.9' });
  assert.deepEqual(resolveAddress({ header: null, trusted: [] }, '::ffff:203.0.113.9', h({})), { ok: true, address: '203.0.113.9' });
  assert.deepEqual(resolveAddress({ header: null, trusted: [] }, undefined, h({})), { ok: false });
  assert.deepEqual(resolveAddress({ header: null, trusted: [] }, 'not an ip', h({})), { ok: false });
});

test('a header from a socket that is not a trusted proxy is ignored: spoofing buys nothing', () => {
  assert.deepEqual(resolveAddress(rules, '203.0.113.9', h({ 'x-forwarded-for': '1.2.3.4' })), { ok: true, address: '203.0.113.9' });
});

test('from a trusted proxy X-Forwarded-For gives its rightmost hop, never the client supplied left side', () => {
  assert.deepEqual(resolveAddress(rules, '10.0.0.5', h({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 198.51.100.4' })), { ok: true, address: '198.51.100.4' });
  assert.deepEqual(resolveAddress(rules, '192.168.4.4', h({ 'x-forwarded-for': '198.51.100.4' })), { ok: true, address: '198.51.100.4' });
  assert.deepEqual(resolveAddress(rules, '10.0.0.5', h({ 'x-forwarded-for': '2001:db8::1' })), { ok: true, address: '2001:db8::1' });
});

test('from a trusted proxy a missing, malformed or over long header is refused, not replaced by the socket address', () => {
  for (const value of [undefined, '', 'garbage', '1.2.3.4, not-an-ip', '1.2.3.4,', 'x'.repeat(300), '1.2.3.4 5.6.7.8', '999.1.1.1']) {
    assert.deepEqual(resolveAddress(rules, '10.0.0.5', h(value === undefined ? {} : { 'x-forwarded-for': value })), { ok: false }, String(value));
  }
});

test('a single valued header such as cf-connecting-ip must hold exactly one address', () => {
  const cf = { header: 'cf-connecting-ip', trusted: ['10.0.0.5'] };
  assert.deepEqual(resolveAddress(cf, '10.0.0.5', h({ 'cf-connecting-ip': '198.51.100.4' })), { ok: true, address: '198.51.100.4' });
  assert.deepEqual(resolveAddress(cf, '10.0.0.5', h({ 'cf-connecting-ip': '1.1.1.1, 198.51.100.4' })), { ok: false });
});

test('trusted entries: exact addresses and IPv4 blocks, nothing else', () => {
  assert.equal(isTrusted('192.168.200.1', ['192.168.0.0/16']), true);
  assert.equal(isTrusted('192.169.0.1', ['192.168.0.0/16']), false);
  assert.equal(isTrusted('1.2.3.4', ['0.0.0.0/0']), true);
  assert.equal(isTrusted('1.2.3.4', ['1.2.3.4/32']), true);
  assert.equal(isTrusted('2001:db8::1', ['2001:db8::1']), true);
  assert.deepEqual(['10.0.0.1', '10.0.0.0/8', '::1'].map(validTrustedEntry), [true, true, true]);
  assert.deepEqual(['10.0.0.0/33', 'host.example', '10.0.0.0/8/1', ''].map(validTrustedEntry), [false, false, false, false]);
  assert.equal(normalizeIp('::FFFF:1.2.3.4'), '1.2.3.4');
});

test('visitor key: an HMAC under a random secret, not recomputable from the date or the address', () => {
  let now = Date.parse('2026-11-03T10:00:00Z');
  let n = 0;
  const salt = new DailySalt(() => now, () => Buffer.alloc(32, ++n));
  const today = salt.current();
  assert.match(today, /^[0-9a-f]{64}$/);
  assert.equal(salt.current(), today, 'stable within the day');
  assert.notEqual(today, '2026-11-03');
  assert.ok(!today.includes('2026'));
  const k = visitorKey('203.0.113.9', today);
  assert.equal(k.key, visitorKey('203.0.113.9', today).key);
  assert.match(k.short, /^ip:[0-9a-f]{8}$/);
  // what an attacker can compute without the secret does not match
  assert.notEqual(visitorKey('203.0.113.9', '2026-11-03').short, k.short);
  now += 24 * 3_600_000;
  const tomorrow = salt.current();
  assert.notEqual(tomorrow, today, 'rotated at UTC midnight');
  assert.notEqual(visitorKey('203.0.113.9', tomorrow).key, k.key);
});

test('the real salt source is random per process', () => {
  assert.notEqual(new DailySalt().current(), new DailySalt().current());
});

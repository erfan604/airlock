// Untrusted (AIR-183): the opaque wrapper for text an outsider wrote.
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { Untrusted, revealUntrusted, wrapUntrusted } from '../src/components/untrusted.ts';

test('untrusted: wrapUntrusted accepts strings only', () => {
  assert.equal(wrapUntrusted(5), null);
  assert.equal(wrapUntrusted(null), null);
  assert.equal(wrapUntrusted(undefined), null);
  assert.equal(wrapUntrusted({ text: 'x' }), null);
  assert.ok(wrapUntrusted('x') instanceof Untrusted);
  assert.ok(wrapUntrusted('') instanceof Untrusted);
});

test('untrusted: string conversion and JSON never contain the text', () => {
  const u = wrapUntrusted('SECRET-ATTACKER-TEXT');
  assert.ok(u);
  assert.equal(String(u), '[Untrusted]');
  assert.equal(`${u}`, '[Untrusted]');
  assert.equal(JSON.stringify(u), '"[Untrusted]"');
  assert.equal(JSON.stringify({ a: [u] }).includes('SECRET'), false);
  assert.equal(inspect(u).includes('SECRET'), false);
});

test('untrusted: revealUntrusted returns the exact text', () => {
  const raw = 'a\u200Bb <script>alert(1)</script>';
  const u = wrapUntrusted(raw);
  assert.ok(u);
  assert.equal(revealUntrusted(u), raw);
});

test('untrusted: the constructor is not available to outside code', () => {
  // @ts-expect-error the constructor is private
  assert.throws(() => new Untrusted('x'), TypeError);
});

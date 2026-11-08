// AIR-325: the TypeScript consumer of fixtures/sol-vectors.json (the Rust verdict crate and the policy contract read it too). Each
// `sol:` payee key vector is its own test: accepted keys decode to the listed bytes, rejected keys throw exactly the listed KeyError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KeyError, assetForPayeeKey, solAddressBytes, validatePayeeKey } from '../src/dsl/keys.ts';

const doc = JSON.parse(readFileSync(new URL('../../fixtures/sol-vectors.json', import.meta.url), 'utf8')) as {
  payee_keys: { accept: { key: string; bytes_hex: string }[]; reject: { key: string; error: string }[] };
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

test('the fixture has the sol vectors', () => {
  assert.ok(doc.payee_keys.accept.length >= 6);
  assert.ok(doc.payee_keys.reject.length >= 20);
});

doc.payee_keys.accept.forEach((v) => {
  test(`sol key accepted: ${v.key}`, () => {
    validatePayeeKey(v.key);
    const bytes = solAddressBytes(v.key.split(':')[2] ?? '');
    assert.ok(bytes instanceof Uint8Array, String(bytes));
    assert.equal(hex(bytes), v.bytes_hex);
    assert.equal(assetForPayeeKey(v.key), `sol:${v.key.split(':')[1]}`);
  });
});

doc.payee_keys.reject.forEach((v, i) => {
  test(`sol key rejected ${i} as ${v.error}`, () => {
    assert.throws(
      () => validatePayeeKey(v.key),
      (e: unknown) => e instanceof KeyError && e.code === v.error,
    );
  });
});

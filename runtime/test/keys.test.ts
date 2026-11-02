// AIR-122: payee keys. The Rust validator (contracts/airlock-verdict/src/keys.rs) is the reference and its check order decides which
// KeyError a refused key names; the 40 shared vectors run in vectors.test.ts, the rows here pin the rules in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyError, assetForPayeeKey, assetOfTarget, canonicalEvm, canonicalNear, payeeKey, validatePayeeKey } from '../src/dsl/index.ts';

const ADDR = 'd8da6bf26964af9d7eed9e03e53415d37aa96045';
const CANON = '0x' + ADDR;
const KELVIN = String.fromCharCode(0x212a);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof KeyError) return e.code;
    throw e;
  }
  return 'no error';
}

// ---- canonicalEvm ----
for (const input of ['0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045', ADDR, CANON, ADDR.toUpperCase(), '0x' + ADDR.toUpperCase()]) {
  test(`canonicalEvm maps ${input.slice(0, 12)}... to the lowercase 0x form`, () => {
    assert.equal(canonicalEvm(input), CANON);
  });
}

const EVM_REFUSED: [string, string, string][] = [
  ['an uppercase 0X prefix', '0X' + ADDR, 'BadChar'],
  ['39 digits', ADDR.slice(1), 'BadLength'],
  ['41 digits', ADDR + 'a', 'BadLength'],
  ['0x and 39 digits', '0x' + ADDR.slice(1), 'BadLength'],
  ['0x and 41 digits', '0x' + ADDR + 'a', 'BadLength'],
  ['the empty string', '', 'BadLength'],
  ['a 40 character address with an x in it', 'x' + ADDR.slice(1), 'BadChar'],
  ['a non-hex digit', 'g' + ADDR.slice(1), 'BadChar'],
  ['a 42 character address without 0x', '1x' + ADDR, 'BadChar'],
  ['a non-ASCII digit', ADDR.slice(1) + String.fromCharCode(0xff10), 'NonAscii'],
  ['the Kelvin sign', KELVIN + ADDR.slice(1), 'NonAscii'],
];
for (const [name, input, code] of EVM_REFUSED) {
  test(`canonicalEvm refuses ${name} as ${code}`, () => {
    assert.equal(codeOf(() => canonicalEvm(input)), code);
  });
}

// ---- canonicalNear ----
test('canonicalNear returns a valid lowercase account unchanged', () => {
  assert.equal(canonicalNear('accountant.testnet'), 'accountant.testnet');
  assert.equal(canonicalNear('a-b_c.d'), 'a-b_c.d');
  assert.equal(canonicalNear('ab'), 'ab');
  assert.equal(canonicalNear('a'.repeat(64)), 'a'.repeat(64));
});

const NEAR_REFUSED: [string, string, string][] = [
  ['an uppercase letter', 'Accountant.testnet', 'BadChar'],
  ['one character', 'a', 'BadLength'],
  ['65 characters', 'a'.repeat(65), 'BadLength'],
  ['the empty string', '', 'BadLength'],
  ['a leading separator', '-ab', 'BadSeparator'],
  ['a trailing dot', 'ab.', 'BadSeparator'],
  ['a doubled separator', 'a..b', 'BadSeparator'],
  ['a space', 'a b', 'BadChar'],
  ['a colon', 'near:ab', 'BadChar'],
  ['the Kelvin sign (no folding)', KELVIN + 'elvin.near', 'NonAscii'],
];
for (const [name, input, code] of NEAR_REFUSED) {
  test(`canonicalNear refuses ${name} as ${code}`, () => {
    assert.equal(codeOf(() => canonicalNear(input)), code);
  });
}

// ---- validatePayeeKey ----
test('validatePayeeKey accepts the two canonical forms', () => {
  validatePayeeKey('near:accountant.testnet');
  validatePayeeKey(`evm:84532:${CANON}`);
  validatePayeeKey(`evm:18446744073709551615:${CANON}`);
  validatePayeeKey(`evm:1:${CANON}`);
});

const KEY_REFUSED: [string, string, string][] = [
  ['an ft key', 'ft:token.near:alice.near', 'UnknownScheme'],
  ['chain id 0', `evm:0:${CANON}`, 'BadChainId'],
  ['a chain id with a leading zero', `evm:084532:${CANON}`, 'BadChainId'],
  ['a chain id above u64', `evm:18446744073709551616:${CANON}`, 'BadChainId'],
  ['a chain id with a sign', `evm:+1:${CANON}`, 'BadChainId'],
  ['a key with the Kelvin sign', 'near:' + KELVIN + 'elvin.test.near', 'NonAscii'],
  ['the Kelvin sign before an unknown scheme', KELVIN + 'ear:abc', 'NonAscii'],
  ['no scheme', 'accountant.testnet', 'UnknownScheme'],
  ['an uppercase scheme', 'NEAR:accountant.testnet', 'UnknownScheme'],
  ['evm and a valid chain id and no address', 'evm:1', 'BadLength'],
  ['evm and a valid chain id and an empty address', 'evm:1:', 'BadLength'],
  ['evm and a chain id that is not a number', 'evm:abc', 'BadChainId'],
  ['evm and nothing', 'evm:', 'BadChainId'],
  ['a 40 character address in a key (a key needs the 0x, so the length is wrong)', 'evm:1:x' + ADDR.slice(1), 'BadLength'],
  ['an uppercase address digit', 'evm:1:0x' + ADDR.slice(0, 5).toUpperCase() + ADDR.slice(5), 'BadChar'],
  ['an address without 0x', `evm:1:${ADDR}`, 'BadLength'],
  ['a 42 character address with an uppercase X', `evm:1:0X${ADDR}`, 'BadChar'],
  ['a near key with an uppercase letter', 'near:Accountant.test.near', 'BadChar'],
  ['a near key that is too short', 'near:a', 'BadLength'],
  ['a near key with a trailing separator', 'near:ab-', 'BadSeparator'],
  ['an empty key', '', 'UnknownScheme'],
];
for (const [name, key, code] of KEY_REFUSED) {
  test(`validatePayeeKey refuses ${name} as ${code}`, () => {
    assert.equal(codeOf(() => validatePayeeKey(key)), code);
  });
}

test('assetForPayeeKey: near for a near key, evm:<chain id>:native for an evm key', () => {
  assert.equal(assetForPayeeKey('near:accountant.testnet'), 'near');
  assert.equal(assetForPayeeKey(`evm:84532:${CANON}`), 'evm:84532:native');
  assert.equal(assetForPayeeKey(`evm:18446744073709551615:${CANON}`), 'evm:18446744073709551615:native');
  assert.equal(codeOf(() => assetForPayeeKey('ft:a:b')), 'UnknownScheme');
});

// AIR-109: the erc20 form
const USDC_ADDR = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
test('erc20 payee keys: accepted, and mapped to the asset of their token', () => {
  const key = `erc20:84532:${USDC_ADDR}:${CANON}`;
  validatePayeeKey(key);
  assert.equal(assetForPayeeKey(key), `evm:84532:erc20:${USDC_ADDR}`);
  assert.equal(assetForPayeeKey(`evm:84532:${CANON}`), 'evm:84532:native');
});

for (const [name, key, code] of [
  ['no payee', `erc20:84532:${USDC_ADDR}`, 'BadLength'],
  ['uppercase token', `erc20:84532:0x${USDC_ADDR.slice(2).toUpperCase()}:${CANON}`, 'BadChar'],
  ['0X payee', `erc20:84532:${USDC_ADDR}:0X${ADDR}`, 'BadChar'],
  ['short payee', `erc20:84532:${USDC_ADDR}:0x${ADDR.slice(1)}`, 'BadLength'],
  ['chain id 0', `erc20:0:${USDC_ADDR}:${CANON}`, 'BadChainId'],
  ['leading zero chain id', `erc20:084532:${USDC_ADDR}:${CANON}`, 'BadChainId'],
  ['cyrillic digit', `erc20:84532:${USDC_ADDR}:0x${ADDR.slice(0, 39)}${String.fromCharCode(0x430)}`, 'NonAscii'],
] as const) {
  test(`erc20 payee key refused: ${name}`, () => {
    assert.equal(codeOf(() => validatePayeeKey(key)), code);
  });
}

// ---- Target, payeeKey, assetOfTarget ----
test('payeeKey canonicalizes a bare near account and accepts the matching key', () => {
  assert.equal(payeeKey({ kind: 'near' }, 'accountant.testnet'), 'near:accountant.testnet');
  assert.equal(payeeKey({ kind: 'near' }, 'near:accountant.testnet'), 'near:accountant.testnet');
});

test('payeeKey canonicalizes a bare evm address and accepts the matching key', () => {
  const target = { kind: 'evm', chain_id: 84532 } as const;
  assert.equal(payeeKey(target, ADDR.toUpperCase()), `evm:84532:${CANON}`);
  assert.equal(payeeKey(target, CANON), `evm:84532:${CANON}`);
  assert.equal(payeeKey(target, `evm:84532:${CANON}`), `evm:84532:${CANON}`);
});

test('payeeKey refuses a key of another scheme or chain id as TargetMismatch', () => {
  assert.equal(codeOf(() => payeeKey({ kind: 'evm', chain_id: 84532 }, `evm:1:${CANON}`)), 'TargetMismatch');
  assert.equal(codeOf(() => payeeKey({ kind: 'near' }, `evm:84532:${CANON}`)), 'TargetMismatch');
  assert.equal(codeOf(() => payeeKey({ kind: 'evm', chain_id: 84532 }, 'near:accountant.testnet')), 'TargetMismatch');
});

test('payeeKey validates a prefixed key of the right target and refuses a bad bare input', () => {
  assert.equal(codeOf(() => payeeKey({ kind: 'near' }, 'near:Accountant.testnet')), 'BadChar');
  assert.equal(codeOf(() => payeeKey({ kind: 'evm', chain_id: 84532 }, 'evm:84532:0xABC')), 'BadLength');
  assert.equal(codeOf(() => payeeKey({ kind: 'near' }, 'Accountant.testnet')), 'BadChar');
  assert.equal(codeOf(() => payeeKey({ kind: 'evm', chain_id: 84532 }, 'xyz')), 'BadLength');
});

test('payeeKey checks ASCII first, on the raw string, before the target', () => {
  assert.equal(codeOf(() => payeeKey({ kind: 'near' }, 'evm:1:' + KELVIN)), 'NonAscii');
  assert.equal(codeOf(() => payeeKey({ kind: 'evm', chain_id: 84532 }, 'near:' + KELVIN)), 'NonAscii');
});

test('payeeKey refuses a chain id that is not a positive safe integer', () => {
  for (const chain_id of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
    assert.equal(codeOf(() => payeeKey({ kind: 'evm', chain_id }, CANON)), 'BadChainId');
    assert.equal(codeOf(() => assetOfTarget({ kind: 'evm', chain_id })), 'BadChainId');
  }
});

test('assetOfTarget: near and evm:<chain id>:native', () => {
  assert.equal(assetOfTarget({ kind: 'near' }), 'near');
  assert.equal(assetOfTarget({ kind: 'evm', chain_id: 84532 }), 'evm:84532:native');
});

test('KeyError carries its code and never the key text', () => {
  try {
    validatePayeeKey('near:' + KELVIN + 'secret-marker');
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof KeyError);
    assert.equal(e.code, 'NonAscii');
    assert.ok(!e.message.includes('secret-marker'));
  }
});

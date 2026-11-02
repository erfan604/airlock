// AIR-189: look-alike detector rules (F10 3.3). Keys are canonical strings; the detector only helps the human, the contract matches exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyError, checkBookAdd, checkLookalike, hexBody } from '../src/dsl/index.ts';

const HEX = '0123456789abcdef';
const BODY40 = 'd8da6bf26964af9d7eed9e03e53415d37aa96045';
const BODY64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const EVM = `evm:84532:0x${BODY40}`;
const IMPLICIT = `near:${BODY64}`;
const ETH_IMPLICIT = `near:0x${BODY40}`;

// 32-bit LCG, seed 20261022, so every run draws the same keys
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

// flip the digits at the given body positions to a different digit
function flip(body: string, positions: number[]): string {
  const out = body.split('');
  for (const p of positions) out[p] = HEX.charAt((HEX.indexOf(out[p] as string) + 1) % 16);
  return out.join('');
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof KeyError) return e.code;
    throw e;
  }
  return 'no error';
}

test('hexBody returns the digits of an EVM, implicit and ETH-implicit key and null otherwise', () => {
  assert.equal(hexBody(EVM), BODY40);
  assert.equal(hexBody(IMPLICIT), BODY64);
  assert.equal(hexBody(ETH_IMPLICIT), BODY40);
  assert.equal(hexBody('near:acct-firm.near'), null);
  assert.equal(hexBody('near:abcdef'), null);
  assert.equal(hexBody('ft:whatever'), null);
});

test('keeping the first 4 and last 4 digits is hex_ends for an EVM key', () => {
  const candidate = `evm:84532:0x${BODY40.slice(0, 4)}${'0'.repeat(32)}${BODY40.slice(36)}`;
  const r = checkLookalike(candidate, ['near:other.near', EVM]);
  assert.ok(r);
  assert.equal(r.nearest, EVM);
  assert.equal(r.kind, 'hex_ends');
});

test('the same ends on a 64-hex implicit account is hex_ends', () => {
  const candidate = `near:${BODY64.slice(0, 4)}${'f'.repeat(56)}${BODY64.slice(60)}`;
  const r = checkLookalike(candidate, [IMPLICIT]);
  assert.ok(r);
  assert.equal(r.kind, 'hex_ends');
  assert.equal(r.nearest, IMPLICIT);
});

test('the same ends on an ETH-implicit account is hex_ends, and an EVM key with the same digits is compared too', () => {
  const candidate = `near:0x${BODY40.slice(0, 4)}${'1'.repeat(32)}${BODY40.slice(36)}`;
  assert.equal(checkLookalike(candidate, [ETH_IMPLICIT])?.kind, 'hex_ends');
  assert.equal(checkLookalike(candidate, [EVM])?.kind, 'hex_ends');
  const evmCandidate = `evm:1:0x${BODY40.slice(0, 4)}${'2'.repeat(32)}${BODY40.slice(36)}`;
  assert.equal(checkLookalike(evmCandidate, [ETH_IMPLICIT])?.nearest, ETH_IMPLICIT);
});

test('a key 6 digits away with different ends is hex_hamming with 6 indexes into the full candidate key', () => {
  const positions = [0, 5, 9, 14, 20, 30];
  const candidate = `evm:84532:0x${flip(BODY40, positions)}`;
  const r = checkLookalike(candidate, [EVM]);
  assert.ok(r);
  assert.equal(r.kind, 'hex_hamming');
  assert.equal(r.distance, 6);
  const offset = 'evm:84532:0x'.length;
  assert.deepEqual(r.differingIndexes, positions.map((p) => p + offset));
  for (const i of r.differingIndexes) assert.notEqual(candidate.charAt(i), EVM.charAt(i));
});

test('a key 7 digits away with different ends is null', () => {
  const candidate = `evm:84532:0x${flip(BODY40, [0, 5, 9, 14, 20, 30, 33])}`;
  assert.equal(checkLookalike(candidate, [EVM]), null);
});

test('hex_hamming on implicit accounts offsets the indexes by the near: prefix', () => {
  const candidate = `near:${flip(BODY64, [0, 10, 20, 30, 40, 50])}`;
  const r = checkLookalike(candidate, [IMPLICIT]);
  assert.ok(r);
  assert.equal(r.kind, 'hex_hamming');
  assert.deepEqual(r.differingIndexes, [5, 15, 25, 35, 45, 55]);
});

test('hex keys of different digit lengths are not compared', () => {
  const candidate = `near:${BODY40.slice(0, 4)}${'0'.repeat(56)}${BODY40.slice(36)}`;
  assert.equal(checkLookalike(candidate, [EVM]), null);
});

test('acct-firrn.near against acct-firm.near is name_edit distance 2 at the r and the n', () => {
  const candidate = 'near:acct-firrn.near';
  const r = checkLookalike(candidate, ['near:acct-firm.near']);
  assert.ok(r);
  assert.equal(r.kind, 'name_edit');
  assert.equal(r.nearest, 'near:acct-firm.near');
  assert.equal(r.distance, 2);
  assert.equal(r.differingIndexes.length, 2);
  assert.deepEqual(r.differingIndexes.map((i) => candidate.charAt(i)).sort(), ['n', 'r']);
});

test('one-edit and two-edit variants are flagged, a three-edit variant is null', () => {
  const book = ['near:acct-firm.near'];
  assert.equal(checkLookalike('near:acct-fiim.near', book)?.distance, 1);
  assert.equal(checkLookalike('near:acct-firm1.near', book)?.distance, 1);
  assert.equal(checkLookalike('near:act-firm.near', book)?.distance, 1);
  assert.equal(checkLookalike('near:acc-fiim.near', book)?.distance, 2);
  assert.equal(checkLookalike('near:acct-xyzm.near', book), null);
});

test('the prefix trap and a look-alike parent are name_subaccount', () => {
  const prefix = checkLookalike('near:accountant.testnet.evil.testnet', ['near:accountant.testnet']);
  assert.ok(prefix);
  assert.equal(prefix.kind, 'name_subaccount');
  assert.equal(prefix.nearest, 'near:accountant.testnet');
  const parent = checkLookalike('near:pay.acct-firrn.near', ['near:acct-firm.near']);
  assert.ok(parent);
  assert.equal(parent.kind, 'name_subaccount');
  assert.equal(parent.nearest, 'near:acct-firm.near');
});

test('a real sub-account of a book entry is null', () => {
  assert.equal(checkLookalike('near:pay.accountant.testnet', ['near:accountant.testnet']), null);
});

test('a-c-c-t-firm.near is name_separator at distance 3 while acct_firm.near is name_edit at distance 1', () => {
  const book = ['near:acct-firm.near'];
  const sep = checkLookalike('near:a-c-c-t-firm.near', book);
  assert.ok(sep);
  assert.equal(sep.kind, 'name_separator');
  assert.equal(sep.distance, 3);
  const edit = checkLookalike('near:acct_firm.near', book);
  assert.ok(edit);
  assert.equal(edit.kind, 'name_edit');
  assert.equal(edit.distance, 1);
});

test('an exact book entry is null, and so is an unrelated key', () => {
  const book = [EVM, 'near:acct-firm.near'];
  assert.equal(checkLookalike('near:acct-firm.near', book), null);
  assert.equal(checkLookalike(EVM, book), null);
  assert.equal(checkLookalike('near:completely-different.testnet', book), null);
});

test('the first book entry that matches wins', () => {
  const r = checkLookalike('near:acct-firn.near', ['near:acct-fira.near', 'near:acct-firm.near']);
  assert.equal(r?.nearest, 'near:acct-fira.near');
});

test('non-canonical keys throw their KeyError', () => {
  assert.equal(codeOf(() => checkLookalike('near:Accountant.testnet', ['near:acct-firm.near'])), 'BadChar');
  assert.equal(codeOf(() => checkLookalike(`evm:1:0x${BODY40.toUpperCase()}`, [EVM])), 'BadChar');
  assert.equal(codeOf(() => checkLookalike('near:acct-firm.near', ['near:Bad.near'])), 'BadChar');
  assert.equal(codeOf(() => checkBookAdd('ft:x', [])), 'UnknownScheme');
});

test('checkBookAdd flags a key that resembles an entry and returns null for an unrelated one', () => {
  const book = [EVM, 'near:acct-firm.near'];
  assert.equal(checkBookAdd('near:acct-firrn.near', book)?.kind, 'name_edit');
  assert.equal(checkBookAdd(`evm:84532:0x${BODY40.slice(0, 4)}${'0'.repeat(32)}${BODY40.slice(36)}`, book)?.kind, 'hex_ends');
  assert.equal(checkBookAdd('near:unrelated-vendor.testnet', book), null);
});

test('the seeded generator is stable', () => {
  const a = lcg(20261022);
  const b = lcg(20261022);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

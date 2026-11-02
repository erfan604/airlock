// AIR-182: the wallet capability table. Only wallets that show what they sign are ever offered.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import snapshot from '../src/wallet/manifest-snapshot.json' with { type: 'json' };
import { WALLET_CAPABILITIES, allowedWallet, revealInstruction } from '../src/wallet/capabilities.ts';

test('capabilities: Nightly and any id not in the table are refused', () => {
  assert.equal(allowedWallet('nightly-wallet'), null);
  assert.equal(allowedWallet('hot-wallet'), null);
  assert.equal(allowedWallet(''), null);
  // inherited names are not table rows
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(allowedWallet(id), null, id);
});

test('capabilities: Nightly has a row that says it never shows the arguments', () => {
  const row = WALLET_CAPABILITIES['nightly-wallet'];
  assert.ok(row);
  assert.equal(row.shows_args, 'never');
  assert.equal(row.allowed, false);
});

test('capabilities: every wallet of the pinned snapshot has a row and is allowed', () => {
  assert.equal(snapshot.wallets.length, 1);
  for (const w of snapshot.wallets) {
    const row = allowedWallet(w.id);
    assert.ok(row, `${w.id} is allowed`);
    assert.notEqual(row.shows_args, 'never');
    assert.equal(row.allowed, true);
    assert.equal(row.signatureEncoding, 'base64');
  }
});

test('capabilities: the primary wallet row carries the exact on-screen words of RESULTS.md', () => {
  const row = allowedWallet('intear-wallet');
  assert.ok(row);
  assert.equal(row.shows_args, 'after_tap');
  assert.equal(row.shows_deposit, 'exact');
  assert.equal(row.howToReveal, 'Tap Show args in Intear and compare the five values');
});

test('capabilities: a row marked not allowed is refused even when it shows the arguments', () => {
  const meteor = WALLET_CAPABILITIES['meteor-wallet'];
  assert.ok(meteor);
  assert.equal(meteor.shows_args, 'details');
  assert.equal(meteor.shows_deposit, 'rounds_to_zero');
  assert.equal(meteor.allowed, false);
  assert.equal(allowedWallet('meteor-wallet'), null);
});

test('capabilities: revealInstruction gives the words of an allowed wallet and nothing for others', () => {
  assert.equal(revealInstruction('intear-wallet'), 'Tap Show args in Intear and compare the five values');
  assert.equal(revealInstruction('nightly-wallet'), '');
  assert.equal(revealInstruction('nobody'), '');
});

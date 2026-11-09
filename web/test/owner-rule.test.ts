// AIR-335: the helpers of the owner rule for visible text: the word testnet and the owner's name are not printed, and a label never looks like an account id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoLabel, labelOwner, shownAccount } from '../src/components/account.ts';
import { plain } from '../src/components/plain.ts';

/** What the page treats as a NEAR account id: lowercase parts joined by . - _, ending in .testnet or .near, or a 64 digit hex implicit account. */
export const LOOKS_LIKE_ACCOUNT = /(?:^|[^A-Za-z0-9_.-])(?:near:)?(?:[a-z0-9]+[-_.])*[a-z0-9]+\.(?:testnet|near)(?![A-Za-z0-9_-])|\b[0-9a-f]{64}\b/;

test('plain rewrites the word testnet in prose and leaves everything else alone', () => {
  assert.equal(plain('Transactions on testnet are evidence, not proof.'), 'Transactions on the test network are evidence, not proof.');
  assert.equal(plain('NEAR Testnet funds'), 'NEAR test network funds');
  assert.equal(plain('No such word here.'), 'No such word here.');
});

test('demoLabel gives a plain label that cannot be mistaken for an account id', () => {
  assert.equal(demoLabel('near:accountant.erfan-airlock.testnet'), 'Accountant (demo)');
  assert.equal(demoLabel('erfan-airlock.testnet'), 'demo owner');
  assert.equal(demoLabel('policy-v3.erfan-airlock.testnet'), 'demo policy');
  assert.equal(demoLabel('erfan-agent.testnet'), 'demo agent');
  for (const id of ['near:accountant.erfan-airlock.testnet', 'erfan-airlock.testnet', 'policy-v3.erfan-airlock.testnet', 'erfan-agent.testnet', 'near:landlord.erfan-airlock.testnet']) {
    const label = demoLabel(id);
    assert.ok(!LOOKS_LIKE_ACCOUNT.test(label), `${label} must not parse as an account id`);
    assert.ok(!/erfan|testnet/i.test(label), label);
  }
});

test('labelOwner replaces every owner-named account in a text and nothing else', () => {
  assert.equal(labelOwner('to near:accountant.erfan-airlock.testnet today'), 'to Accountant (demo) today');
  assert.equal(labelOwner('{"a":"erfan-airlock.testnet","b":"policy.erfan-airlock.testnet"}'), '{"a":"demo owner","b":"demo policy"}');
  assert.equal(labelOwner('kanocotton.testnet pays 4.2 NEAR'), 'kanocotton.testnet pays 4.2 NEAR', 'a real account that is not the owner is untouched');
  assert.ok(!LOOKS_LIKE_ACCOUNT.test(labelOwner('x near:accountant.erfan-airlock.testnet y')));
  assert.ok(LOOKS_LIKE_ACCOUNT.test('pay kanocotton.testnet'), 'the detector sees a real-looking id');
  assert.ok(LOOKS_LIKE_ACCOUNT.test('pay accountant.demo.testnet'), 'an invented id is exactly what the detector must catch');
});

test('shownAccount gives the neutral label for the owner name only', () => {
  assert.equal(shownAccount('policy-v3.erfan-airlock.testnet', 'the demo policy'), 'the demo policy');
  assert.equal(shownAccount('alice.testnet', 'the demo policy'), 'alice.testnet');
});

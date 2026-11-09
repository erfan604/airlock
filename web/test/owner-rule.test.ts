// AIR-335: the helpers of the owner rule for visible text: the word testnet and the owner's name are not printed, and what is rewritten stays well formed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubOwner, shownAccount } from '../src/components/account.ts';
import { plain } from '../src/components/plain.ts';

test('plain rewrites the word testnet in prose and leaves everything else alone', () => {
  assert.equal(plain('Transactions on testnet are evidence, not proof.'), 'Transactions on the test network are evidence, not proof.');
  assert.equal(plain('NEAR Testnet funds'), 'NEAR test network funds');
  assert.equal(plain('No such word here.'), 'No such word here.');
});

test('scrubOwner turns the owner name into demo, keeps the shape and keeps different names different', () => {
  assert.equal(scrubOwner('near:accountant.erfan-airlock.testnet'), 'near:accountant.demo.testnet');
  assert.equal(scrubOwner('erfan-airlock.testnet'), 'demo.testnet');
  assert.equal(scrubOwner('erfan-agent.testnet'), 'demo-agent.testnet');
  assert.notEqual(scrubOwner('erfan-agent.testnet'), scrubOwner('erfan-airlock.testnet'));
  assert.ok(/^near:[a-z0-9._-]+$/.test(scrubOwner('near:accountant.erfan-airlock.testnet')), 'still a well formed payee key');
  assert.equal(scrubOwner('ERFAN'), 'demo');
  assert.equal(scrubOwner('kanocotton.testnet'), 'kanocotton.testnet');
  assert.equal(scrubOwner('{"a":"erfan-airlock.testnet","b":"erfan-airlock.testnet"}'), '{"a":"demo.testnet","b":"demo.testnet"}');
});

test('shownAccount gives the neutral label for the owner name only', () => {
  assert.equal(shownAccount('policy-v3.erfan-airlock.testnet', 'the demo policy'), 'the demo policy');
  assert.equal(shownAccount('alice.testnet', 'the demo policy'), 'alice.testnet');
});

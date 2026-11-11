// The approvals page shows a plain warning for a contract this site does not run. The check must name accounts, never a name
// pattern: on the public test network anyone can register an account whose name looks like one of ours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runsHere } from '../src/approvals/StaticApprovals.tsx';
import { DEFAULT_POLICY } from '../src/approvals/staticChain.ts';

test('runsHere: the credit card, the practice card and team accounts run here', () => {
  assert.equal(runsHere(DEFAULT_POLICY), true);
  assert.equal(runsHere('try.airlock-try-b193fe.testnet'), true);
  assert.equal(runsHere('card.airlock-credit-c1108d.testnet'), true);
});

test('runsHere: an account that only looks like a practice card does not run here', () => {
  for (const id of ['try.airlock-try-zzzzzz.testnet', 'try.airlock-try-b193ff.testnet', 'try.airlock-try-abc.testnet', 'xtry.airlock-try-b193fe.testnet.evil.testnet', 'airlock-try-b193fe.testnet.evil.testnet']) {
    assert.equal(runsHere(id), false, id);
  }
});

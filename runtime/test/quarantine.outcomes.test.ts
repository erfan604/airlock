// AIR-142: fieldOutcomes counts what the extractor returned against what the injected text asked for. Values are built at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldOutcomes } from '../src/quarantine/index.ts';

const wanted = (): Record<string, string> => ({ amount: ['9', '9', '9'].join(''), recipient: ['mal', 'lory'].join('') + '.testnet' });

test('fieldOutcomes: a value equal to the wanted one is chosen', () => {
  const w = wanted();
  assert.deepEqual(fieldOutcomes({ amount: w['amount'], recipient: w['recipient'] }, w), { amount: 'chosen', recipient: 'chosen' });
});
test('fieldOutcomes: a null value is null', () => {
  assert.deepEqual(fieldOutcomes({ amount: null, recipient: null }, wanted()), { amount: 'null', recipient: 'null' });
});
test('fieldOutcomes: a missing key is null', () => {
  assert.deepEqual(fieldOutcomes({}, wanted()), { amount: 'null', recipient: 'null' });
});
test('fieldOutcomes: a different string is other, and the keys are exactly those of wanted', () => {
  const out = fieldOutcomes({ amount: '4.2', recipient: 'carol.testnet', extra: 'x' }, wanted());
  assert.deepEqual(out, { amount: 'other', recipient: 'other' });
});

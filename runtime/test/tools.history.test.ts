// AIR-124 (F10): an address read from get_tx_history is tool output. A payee extracted from it and paid through run carries the
// tool_output label plus the quarantine label, so it is never trusted and can never auto-pay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, isTrusted, labelsToBits } from '../src/dsl/index.ts';
import { run } from '../src/interpreter/index.ts';
import { fixtureTools } from '../src/tools/fixtures.ts';
import { EMPTY_WORLD } from '../src/tools/world.ts';
import type { World } from '../src/tools/world.ts';
import { decimalsOf, stubBook, stubExtract } from './helpers/interp.ts';

const PLAN = [
  { let: 'h', call: 'get_tx_history' },
  { let: 'x', extract: { from: { ref: 'h' }, schema: { to: 'address' } } },
  { action: 'transfer', args: { to: { ref: 'x', path: ['to'] }, amount: '1', asset: 'near' } },
];

const WORLD: World = {
  ...EMPTY_WORLD,
  history: [{ id: 'h1', hash: '0x01', from: 'owner.testnet', to: 'landlord.testnet', amount: '25', memo: 'rent' }],
};

test('a payee extracted from get_tx_history is Untrusted:tool_output plus Untrusted:quarantine', async () => {
  const { extract, requests } = stubExtract({ to: 'evil-ops.testnet' });
  const result = await run(checkPlan(PLAN), { tools: fixtureTools(WORLD), extract, book: stubBook(), decimalsOf });
  assert.ok(result.ok, 'the run must not abort');
  assert.equal(result.proposed.length, 1);
  const [p] = result.proposed;
  assert.ok(p !== undefined);
  assert.equal(p.payee, 'near:evil-ops.testnet');
  assert.deepEqual(p.recipientLabels, ['Untrusted:tool_output', 'Untrusted:quarantine']);
  const bits = labelsToBits(p.recipientLabels);
  assert.equal(isTrusted(bits), false);
  assert.equal(bits, 1024 | 4096);
  // the extractor was handed the history rows the tool returned
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.data, WORLD.history);
  console.log('HISTORY_LABEL ok');
});

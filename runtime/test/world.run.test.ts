// AIR-125: the demo world through the interpreter. The scenario picks the one email, the fixture tools serve it with its channel label, the
// U01 plan of AIR-120 reads it, and the proposal shows where each value came from. The extractor is a stub (AIR-121 helper): the value it
// returns is checked against the text of the data, so the stub and the data cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { checkPlan } from '../src/dsl/index.ts';
import { run } from '../src/interpreter/index.ts';
import { fixtureTools } from '../src/tools/fixtures.ts';
import { loadWorld } from '../src/tools/world.ts';
import type { World } from '../src/tools/world.ts';
import { decimalsOf, stubBook, stubExtract } from './helpers/interp.ts';

const DEMO = join(import.meta.dirname, '../../fixtures/world.jsonl');

// the U01 plan of AIR-120 (test/dsl.test.ts): read the inbox, extract amount and vendor, look the vendor up in the book, pay
const U01 = [
  { let: 'mail', call: 'read_inbox' },
  { let: 'inv', extract: { from: { ref: 'mail' }, schema: { amount: 'amount', vendor: 'text' } } },
  { let: 'payee', lookup: { key: 'accountant' } },
  { action: 'transfer', args: { to: { ref: 'payee' }, amount: { ref: 'inv', path: ['amount'] }, asset: 'near' } },
];

const bookOf = (world: World) => stubBook(world.book.map((b): [string, string] => [b.key, b.alias]));

async function runScenario(scenario: string, extracted: { amount: string; vendor: string }) {
  const world = loadWorld(DEMO, { scenario });
  const { extract, requests } = stubExtract(extracted);
  const result = await run(checkPlan(U01), { tools: fixtureTools(world), extract, book: bookOf(world), decimalsOf });
  return { world, requests, result };
}

let finished = 0;

test('scenario U01 with the amount 4.2: one proposal to the accountant of 4.2 NEAR, the amount from the email and the quarantine', async () => {
  const { world, requests, result } = await runScenario('U01', { amount: '4.2', vendor: 'accountant' });
  assert.ok(result.ok, 'the run must not abort');
  assert.equal(result.proposed.length, 1);
  const [p] = result.proposed;
  assert.ok(p !== undefined);
  assert.equal(p.payee, 'near:accountant.testnet');
  assert.equal(p.amount, 4200000000000000000000000n);
  assert.deepEqual(p.amountLabels, ['Untrusted:email', 'Untrusted:quarantine']);
  assert.deepEqual(p.recipientLabels, ['Book']);
  assert.deepEqual(p.pc, ['Owner']);
  // the extractor was handed the one email of the scenario, and that email says the amount the stub returns
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.data, world.inbox);
  assert.equal(world.inbox.length, 1);
  assert.ok(world.inbox[0]?.body.includes('4.2'));
  finished += 1;
});

test('scenario B01 with the amount 9.4: the same shape with 9.4 NEAR, and the item says 9.4', async () => {
  const { world, result } = await runScenario('B01', { amount: '9.4', vendor: 'accountant' });
  // the stub value must come from the data: the B01 item holds the string the stub returns
  assert.equal(world.inbox.length, 1);
  assert.equal(world.inbox[0]?.id, 'inv-april-correction');
  assert.ok(world.inbox[0]?.body.includes('9.4'));
  assert.ok(result.ok, 'the run must not abort');
  assert.equal(result.proposed.length, 1);
  const [p] = result.proposed;
  assert.ok(p !== undefined);
  assert.equal(p.payee, 'near:accountant.testnet');
  assert.equal(p.amount, 9400000000000000000000000n);
  assert.deepEqual(p.amountLabels, ['Untrusted:email', 'Untrusted:quarantine']);
  assert.deepEqual(p.recipientLabels, ['Book']);
  assert.deepEqual(p.pc, ['Owner']);
  finished += 1;
  if (finished === 2) console.log('WORLD_RUN ok');
});

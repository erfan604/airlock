// AIR-145: every few-shot plan of the planner prompt runs through the interpreter to ok: true over the fixture tools of a small world and a
// stub extractor, so a wrong argument name or a lookup the world cannot answer fails here and not in a live tuning round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan } from '../src/dsl/index.ts';
import { run } from '../src/interpreter/index.ts';
import { fixtureTools } from '../src/tools/fixtures.ts';
import { EMPTY_WORLD } from '../src/tools/world.ts';
import type { World } from '../src/tools/world.ts';
import { FEW_SHOTS } from '../src/planner/prompt.ts';
import { decimalsOf, stubBook, stubExtract } from './helpers/interp.ts';

const WORLD: World = {
  ...EMPTY_WORLD,
  inbox: [{ id: 'm1', from: 'billing@accountant-firm.co', subject: 'Invoice', body: 'Please pay 4.2 NEAR for April.', attachments: [] }],
  files: { 'bill.txt': 'Total due: 4.2 NEAR' },
  feed: [{ id: 'f1', from: 'friend', text: 'hello' }],
  tokens: [{ id: 't1', symbol: 'NEAR', name: 'NEAR', description: 'the native token' }],
  memory: [{ key: 'm1', text: 'a note' }],
  prices: { near: '3.5' },
  balances: { near: '300' },
  book: [
    { alias: 'accountant', key: 'near:accountant.testnet' },
    { alias: 'landlord', key: 'near:landlord.testnet' },
  ],
};

const book = stubBook(WORLD.book.map((b): [string, string] => [b.key, b.alias]));
// one value per schema key a plan may ask for; a key the stub does not know reads as null, which the run tolerates
const VALUES = { amount: '4.2', vendor: 'accountant', summary: 'one invoice' };

test('the prompt has between three and six few-shot plans', () => {
  assert.ok(FEW_SHOTS.length >= 3 && FEW_SHOTS.length <= 6, `found ${FEW_SHOTS.length}`);
});

FEW_SHOTS.forEach((shot, i) => {
  test(`few-shot ${i + 1} runs to ok: true over the fixture tools of a small world`, async () => {
    const checked = checkPlan(shot.plan);
    const { extract } = stubExtract(VALUES);
    const result = await run(checked, { tools: fixtureTools(WORLD), extract, book, decimalsOf });
    assert.ok(result.ok, result.ok ? '' : `aborted with ${result.cause.code} at ${JSON.stringify(result.cause.step)}`);
    assert.ok(result.proposed.length + result.says.length >= 1, 'a plan either pays or says something');
  });
});

test('the payment few-shots pay the book entry they look up, and the literal one pays 5 NEAR', async () => {
  const paid: Array<{ payee: string; amount: bigint }> = [];
  for (const shot of FEW_SHOTS) {
    const result = await run(checkPlan(shot.plan), { tools: fixtureTools(WORLD), extract: stubExtract(VALUES).extract, book, decimalsOf });
    assert.ok(result.ok);
    for (const p of result.proposed) paid.push({ payee: p.payee, amount: p.amount });
  }
  assert.ok(paid.some((p) => p.payee === 'near:accountant.testnet' && p.amount === 4_200_000_000_000_000_000_000_000n));
  assert.ok(paid.some((p) => p.payee === 'near:landlord.testnet' && p.amount === 5_000_000_000_000_000_000_000_000n));
});

// Red team 2026-11-11: /rob under each griefing case a published key allows (the agent out of gas money, the day's limit used, every signed slot
// used, the queue of holds full). The page says what happened in one plain sentence, says the card itself is fine, and offers the same check run in
// the browser by the shipped gate (public/verdict.wasm), labelled as computed in the browser and never as a transaction. The card's limits are read
// from the chain or the state file, never written into the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RobView } from '../src/live/RobPage.tsx';
import type { RobViewProps } from '../src/live/RobPage.tsx';
import { reasonWords, send, wishOf } from '../src/live/rob.ts';
import type { Wish } from '../src/live/rob.ts';
import { checkColumns, griefOf } from '../src/live/robCheck.ts';
import type { CardLimits } from '../src/live/robCheck.ts';
import { instantiateVerdict, tagOf } from '../src/try/verdictWasm.ts';
import { countsOfTry } from '../src/live/tryChain.ts';
import vector from './fixtures/tx-vector.json' with { type: 'json' };
import { NOW, PUB } from './fixtures/robPub.ts';

const LIM: CardLimits = { hardCap: '20000000000000000000000', dailyCap: '200000000000000000000000', maxPending: 80, paused: false };
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const EMPTY = { counts: countsOfTry([]), rows: [], truncated: false };
const view = (o: Partial<RobViewProps> = {}): string =>
  renderToStaticMarkup(<RobView pub={PUB} board={EMPTY} choice={{ kind: 'preset', id: 'stranger' }} mine={null} mineIds={[]} nowMs={NOW} ownPayee="" ownAmount="" onChoose={() => undefined} onOwn={() => undefined} onSend={() => undefined} {...o} />);
const TX = 'H4TCupRbnrqkWe3oxip6oRuB9Tn3aL8YuuiPpDSuNSuf';
const answered = (kind: 'paid' | 'held' | 'blocked', reason: string | null) => ({ sent: { kind: 'answer' as const, answer: { kind, reason, requestId: 'x:1' }, tx: TX, ms: 2000 }, startedMs: NOW - 2000 });

test('rob grief: the limits the page prints come from the card, not from the page', () => {
  assert.match(reasonWords('DailyLimit', LIM), /0\.2 NEAR/);
  assert.match(reasonWords('AmountOutOfBounds', LIM), /0\.02 NEAR/);
  assert.match(reasonWords('PendingFull', LIM), /80 requests/);
  for (const code of ['DailyLimit', 'AmountOutOfBounds', 'PendingFull']) assert.doesNotMatch(reasonWords(code, null), /0\.05|0\.01|Fifty|50/);
  const t = text(view({ limits: LIM }));
  assert.ok(t.includes('at most 0.02 NEAR at once and 0.2 NEAR a day'));
  const none = text(view({ limits: null }));
  assert.doesNotMatch(none, /0\.05 NEAR|0\.01 NEAR/);
});

test('rob grief: each griefing case is named, and the answer for every other request is not', () => {
  assert.equal(griefOf(answered('blocked', 'DailyLimit').sent), 'daily');
  assert.equal(griefOf(answered('held', 'OverPayeeLimit').sent), 'daily');
  assert.equal(griefOf(answered('blocked', 'PendingFull').sent), 'queue');
  assert.equal(griefOf({ kind: 'unavailable', why: 'x', grief: 'slots' }), 'slots');
  assert.equal(griefOf({ kind: 'unavailable', why: 'x', grief: 'gas' }), 'gas');
  assert.equal(griefOf(answered('held', 'OutsideTask').sent), null);
  assert.equal(griefOf(answered('paid', null).sent), null);
});

const ok = (result: unknown): Response => Response.json({ jsonrpc: '2.0', id: 'airlock', result });
function chainWith(sendTx: () => Response): typeof fetch {
  return (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> };
    if (body.method === 'send_tx') return sendTx();
    if (body.params['request_type'] === 'view_access_key') return ok({ nonce: 10, block_hash: vector.blockHash });
    return ok({ result: Array.from(new TextEncoder().encode('null')) });
  }) as unknown as typeof fetch;
}

test('rob grief: an agent out of gas money is said so, not "try again in a moment"', async () => {
  const broke = () => Response.json({ jsonrpc: '2.0', id: 'airlock', error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} }, data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { signer_id: 'a', balance: '1', cost: '2' } } } }, message: 'Transaction has insufficient balance' } });
  const r = await send(PUB, wishOf({ kind: 'preset', id: 'stranger' }, PUB) as Wish, { rpc: { rpcUrls: ['https://rpc.example'], fetch: chainWith(broke) }, random: () => 0.2, now: () => NOW });
  assert.equal(r.kind, 'unavailable');
  assert.equal(griefOf(r), 'gas');
  const noSlot = await send({ ...PUB, tasks: [] }, wishOf({ kind: 'preset', id: 'stranger' }, PUB) as Wish, { rpc: { rpcUrls: ['https://rpc.example'], fetch: chainWith(broke) }, random: () => 0.2, now: () => NOW });
  assert.equal(griefOf(noSlot), 'slots');
});

test('rob grief: the window says what happened, that the card is fine, and offers the check in the browser', () => {
  const cases: [string, RobViewProps['mine']][] = [
    ['gas', { sent: { kind: 'unavailable', why: 'x', grief: 'gas' }, startedMs: NOW }],
    ['daily', answered('blocked', 'DailyLimit')],
    ['slots', { sent: { kind: 'unavailable', why: 'x', grief: 'slots' }, startedMs: NOW }],
    ['queue', answered('blocked', 'PendingFull')],
  ];
  for (const [name, mine] of cases) {
    const html = view({ mine, limits: LIM });
    const t = text(html);
    assert.ok(t.includes('The card itself is fine'), name);
    assert.ok(t.includes('Nothing has been paid outside the owner\'s book.'), `${name}: said only when the board shows 0 paid outside`);
    assert.ok(html.includes('data-testid="rob-check"'), `${name}: the check button`);
    assert.ok(t.includes('Run the same check in your browser'), name);
  }
  const paidOutside = text(view({ mine: cases[0]?.[1] ?? null, board: { counts: { ...countsOfTry([]), paidOutside: 1, attempts: 1 }, rows: [], truncated: false } }));
  assert.ok(!paidOutside.includes('Nothing has been paid outside'));
  assert.ok(!text(view({ mine: answered('held', 'OutsideTask') })).includes('Run the same check in your browser'));
});

test('rob grief: a browser check is labelled as computed in the browser, with no transaction link and no contract code', () => {
  const html = view({ mine: answered('blocked', 'DailyLimit'), limits: LIM, check: { verdict: { kind: 'escalate', reason: 'OutsideTask' } } });
  const t = text(html);
  const part = /data-testid="rob-check-result"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
  assert.ok(part !== '', 'the result is shown in its own box');
  assert.ok(text(part).includes('Computed in your browser by the same gate code the contract runs. This is not a transaction: nothing was sent to the chain.'));
  assert.ok(!part.includes('nearblocks') && !part.includes('Contract code'));
  assert.ok(t.includes('Held'));
});

test('rob grief: the browser check runs the shipped gate on the visitor\'s exact request and agrees with what the chain answered', async () => {
  const gate = await instantiateVerdict(readFileSync(new URL('../public/verdict.wasm', import.meta.url)));
  const near = { known: true, hardCap: LIM.hardCap, dailyCap: LIM.dailyCap };
  const tag = (id: string): string => tagOf(gate.decide(checkColumns(wishOf({ kind: 'preset', id }, PUB) as Wish, PUB, near, LIM.paused)));
  // the same answers the card gave on chain (site-state rows: the honest payment paid the shop, a stranger's payee held OutsideTask)
  assert.equal(tag('honest'), 'allow');
  assert.equal(tag('stranger'), 'escalate:OutsideTask');
  assert.equal(tag('more'), 'escalate:UntrustedTrigger');
  assert.equal(tagOf(gate.decide(checkColumns(wishOf({ kind: 'preset', id: 'coin' }, PUB) as Wish, PUB, { known: false, hardCap: '0', dailyCap: '0' }, false))), 'block:UnknownAsset');
});

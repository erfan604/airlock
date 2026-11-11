// AIR-356: /rob as text, in each state: the prerender, refused (held and blocked), paid, the queue full, a file that cannot be read, the board.
// No "testnet" outside the one limits line, no "erfan", no banned word, and no number before the chain gave one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/App.tsx';
import { PAGES } from '../src/pages.ts';
import { ROUTES } from '../src/routes.ts';
import { NAV } from '../src/shell/SiteNav.tsx';
import RobPage, { RobView, nearOf, payeeText } from '../src/live/RobPage.tsx';
import type { RobViewProps } from '../src/live/RobPage.tsx';
import { countsOfTry } from '../src/live/tryChain.ts';
import type { TryAttempt } from '../src/live/tryChain.ts';
import { PUB } from './fixtures/robPub.ts';

const banned = readFileSync(new URL('../../docs/banned-phrases.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const mainOf = (html: string): string => /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? '';

function copyProblems(t: string): string[] {
  const out: string[] = [];
  if (/testnet/i.test(t)) out.push('testnet');
  if (/test network/i.test(t.replace('Runs on the NEAR test network, where NEAR has no value.', ''))) out.push('"test network" outside the limits line');
  if (/erfan/i.test(t)) out.push('erfan');
  if (/\u2014/.test(t)) out.push('em dash');
  for (const w of ['hack-proof', 'unhackable', 'first', 'only one', 'strangers', 'users']) if (new RegExp(`\\b${w}\\b`, 'i').test(t)) out.push(w);
  for (const b of banned) if (t.toLowerCase().includes(b.toLowerCase())) out.push(`banned: ${b}`);
  return out;
}

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const row = (n: number, verdict: TryAttempt['verdict'], over: Partial<TryAttempt> = {}): TryAttempt => ({ tx: `Hash${String(n).padStart(40, '1')}`, atMs: NOW - n * 60_000, requestId: `${'a'.repeat(64)}:${String(n)}`, payee: 'near:my-own-wallet.testnet', amount: '5000000000000000000000', reason: 'OutsideTask', kind: verdict === 'expired' ? 'held' : (verdict as TryAttempt['kind']), verdict, ...over });
const ROWS = [row(1, 'expired'), row(2, 'blocked', { reason: 'AmountOutOfBounds', amount: '5000000000000000000000000' }), row(3, 'paid_shop', { payee: PUB.shop.payee, amount: PUB.honestAmount, reason: null })];
const BOARD = { counts: countsOfTry(ROWS), rows: ROWS, truncated: false };
const TX = 'H4TCupRbnrqkWe3oxip6oRuB9Tn3aL8YuuiPpDSuNSuf';

const view = (o: Partial<RobViewProps> = {}): string =>
  renderToStaticMarkup(<RobView pub={PUB} board={BOARD} choice={{ kind: 'preset', id: 'stranger' }} mine={null} mineIds={[]} nowMs={NOW} ownPayee="" ownAmount="" onChoose={() => undefined} onOwn={() => undefined} onSend={() => undefined} {...o} />);

test('rob: routed lazily, listed for the prerender and the smoke test, and in the nav right after Lend', () => {
  assert.equal(typeof ROUTES['/rob'], 'function');
  assert.ok(PAGES.some((p) => p.path === '/rob' && p.title === 'Rob it yourself | AIRLOCK'));
  const i = NAV.findIndex((n) => n.path === 'lend');
  assert.equal(NAV[i + 1]?.path, 'rob');
  assert.equal(NAV[i + 1]?.label, 'Rob it');
});

test('rob: the prerender says what the card is, offers the four choices and the own form, and shows no number', () => {
  const t = text(mainOf(renderToStaticMarkup(<App pathname="/rob" page={<RobPage />} />)));
  assert.ok(t.includes('Rob it yourself'));
  assert.ok(t.includes('separate from the lending pool'));
  for (const s of ['Send the money to my account', 'Pay the shop, but a bigger amount', 'Change what is paid in', 'The payment the owner really asked for', 'Or try your own', 'Send it to the card']) assert.ok(t.includes(s), s);
  assert.ok(t.includes('Reading every attempt from the chain.'));
  assert.ok(!/\d+ paid to anyone/.test(t));
  assert.deepEqual(copyProblems(t), []);
});

const answer = (kind: 'paid' | 'held' | 'blocked', reason: string | null) => ({ sent: { kind: 'answer' as const, answer: { kind, reason, requestId: 'x:1' }, tx: TX, ms: 3200 }, startedMs: NOW - 3200 });

test('rob: a held attempt is refused, held for the owner, expiring unpaid, with the code, the time and the transaction', () => {
  const html = view({ mine: answer('held', 'OutsideTask') });
  const t = text(html);
  assert.ok(html.includes('data-state="refused"'));
  assert.ok(t.includes('Refused'));
  assert.ok(t.includes('Held for the owner; it expires unpaid. This payee is not in the task the owner signed, so the owner is asked.'));
  assert.ok(t.includes('OutsideTask') && t.includes('Took 3.2 s.'));
  assert.ok(html.includes(`href="https://testnet.nearblocks.io/txns/${TX}"`));
  assert.deepEqual(copyProblems(t), []);
  const gone = text(view({ mine: answer('held', 'OutsideTask'), board: { ...BOARD, rows: [...ROWS, row(9, 'expired', { requestId: 'x:1' })] } }));
  assert.ok(gone.includes('Held for the owner; it expired unpaid.'));
});

test('rob: blocked and paid read as the contract answered; the queue full is not called a failure of the attack', () => {
  const blocked = text(view({ mine: answer('blocked', 'AmountOutOfBounds') }));
  assert.ok(blocked.includes('Blocked. The amount is above the most this card may ever pay at once (0.01 NEAR).') && blocked.includes('AmountOutOfBounds'));
  const paid = view({ mine: answer('paid', null) });
  assert.ok(paid.includes('data-state="paid"') && text(paid).includes('Paid') && text(paid).includes('the card paid the booked shop'));
  const queue = text(view({ mine: answer('blocked', 'PendingFull') }));
  assert.ok(queue.includes('The queue is full right now.') && queue.includes('Your attack was still refused; try again in a minute.'));
  const daily = text(view({ mine: answer('blocked', 'DailyLimit') }));
  assert.ok(daily.includes("The card has paid today's 0.05 NEAR of honest payments"));
  for (const t of [blocked, text(paid), queue, daily]) assert.deepEqual(copyProblems(t), []);
});

test('rob: the board leads with what was paid to anyone but the shop, then the rest, rows newest first with the visitor\'s own marked', () => {
  const html = view({ mineIds: [ROWS[1]?.requestId ?? ''] });
  const t = text(html);
  assert.ok(t.includes('0 paid to anyone but the booked shop, in 3 attempts.'));
  assert.ok(t.includes('Held for the owner: 1 (1 expired unpaid). Blocked: 1. Paid to the booked shop: 1.'));
  const words = [...html.matchAll(/class="rob-row-word">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(words, ['Expired unpaid', 'Blocked', 'Paid the shop'], 'newest first');
  assert.equal((html.match(/data-mine="true"/g) ?? []).length, 1);
  assert.ok(t.includes('my-own-wallet') && !t.includes('my-own-wallet.testnet'));
  assert.deepEqual(copyProblems(t), []);
});

test('rob: an unreadable file or chain is said plainly, with no number and no send button', () => {
  const html = view({ pub: 'unreadable', board: 'unreadable' });
  const t = text(html);
  assert.ok(t.includes("The card's public file could not be read, so this page will not sign anything."));
  assert.ok(t.includes('The chain could not be read just now, so no count is shown.'));
  assert.ok(/data-testid="rob-go"[^>]*disabled/.test(html));
  assert.ok(text(view({ pub: { refuse: 'the file names a credit account' } })).includes('This page will not sign anything: the file names a credit account.'));
});

test('rob: amounts and payees print in the short form', () => {
  assert.equal(nearOf('5000000000000000000000'), '0.005 NEAR');
  assert.equal(nearOf('5000000000000000000000000'), '5 NEAR');
  assert.equal(payeeText(PUB.shop.payee, PUB.shop.payee), 'the booked shop');
  assert.equal(payeeText('sol:devnet:111', null), 'a SOL address');
  assert.equal(payeeText('near:bob.testnet', null), 'bob');
});

// AIR-360: the bench replay on the board
const REPLAY = { date: '2026-11-11', requests: 3, held: 2, paidShop: 1, paidElsewhere: 0, firstTx: ROWS[0]!.tx, lastTx: ROWS[2]!.tx, ids: { ['a'.repeat(64)]: [1, 3] } };

test('rob: the board says who sent what, from the replay file, marks replayed rows and counts the browsers apart', () => {
  const html = view({ replay: REPLAY });
  const t = text(html);
  assert.ok(t.includes('The team replayed the 3 payment requests its bench recorded in strict mode on Nov 11, 2026: 2 were held and 1, the legitimate payment, were paid to the booked shop. Every other attempt here was sent from a browser like yours.'));
  assert.ok(t.includes('From browsers so far: 1 attempt, 0 paid to anyone but the booked shop.'));
  assert.equal((html.match(/data-replay="true"/g) ?? []).length, 2);
  assert.equal((t.match(/bench replay, /g) ?? []).length, 2);
  assert.deepEqual(copyProblems(t), []);
  // no replay yet: no sentence
  assert.ok(!text(view({ replay: { ...REPLAY, requests: 0, held: 0, paidShop: 0, ids: {} } })).includes('The team replayed'));
});

test('rob: a long board shows its newest rows with a visible count and a "Show more" in the page style', () => {
  const many = Array.from({ length: 30 }, (_, i) => row(i + 1, 'expired'));
  const board = { counts: countsOfTry(many), rows: many, truncated: false };
  const first = view({ board, onMore: () => undefined });
  assert.equal((first.match(/data-testid="rob-row"/g) ?? []).length, 12);
  assert.ok(text(first).includes('Newest at the top, showing 12 of 30.'));
  assert.ok(/<button type="button" class="act" data-testid="rob-more">Show 12 more<\/button>/.test(first));
  assert.ok(text(first).includes('in 30 attempts.'));
  const last = view({ board, shown: 24, onMore: () => undefined });
  assert.ok(text(last).includes('Show 6 more'));
  assert.ok(!view({ board, shown: 36, onMore: () => undefined }).includes('rob-more'));
  const big = Array.from({ length: 1234 }, (_, i) => row(i + 1, 'expired'));
  assert.ok(text(view({ board: { counts: countsOfTry(big), rows: big, truncated: false } })).includes('0 paid to anyone but the booked shop, in 1,234 attempts.'));
});

// AIR-359: the /lend page as text. The prerender (no key, no chain) and every state carry no "testnet" outside the one limits line, no "erfan",
// no em dash or double hyphen, no banned phrase, none of the words the owner keeps off this page, and no number the chain did not give.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/App.tsx';
import { PAGES } from '../src/pages.ts';
import { ROUTES } from '../src/routes.ts';
import { NAV } from '../src/shell/SiteNav.tsx';
import LenderPage, { LenderView, near4, shortAccount } from '../src/lender/LenderPage.tsx';
import type { ChainView, LenderViewProps } from '../src/lender/LenderPage.tsx';
import type { Schedule } from '../src/lender/history.ts';
import type { PoolEvent } from '../src/lender/lenders.ts';

const banned = readFileSync(new URL('../../docs/banned-phrases.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

function copyProblems(t: string): string[] {
  const out: string[] = [];
  const noLimits = t.replace(/Runs on the NEAR test network[^.]*\./, '');
  if (/testnet/i.test(t)) out.push('testnet');
  if (/test network/i.test(noLimits)) out.push('"test network" outside the limits line');
  if (/erfan/i.test(t)) out.push('erfan');
  if (/\u2014|--/.test(t)) out.push('dash');
  for (const w of ['yield', 'apy', 'earn', 'earns', 'earned', 'earning', 'users', 'strangers', 'investors']) if (new RegExp(`\\b${w}\\b`, 'i').test(t)) out.push(w);
  for (const b of banned) if (t.toLowerCase().includes(b.toLowerCase())) out.push(`banned: ${b}`);
  return out;
}

const NOW = Date.parse('2026-11-11T05:00:00Z');
const POOL = 'pool.airlock-credit-c1108d.testnet';
const CARD = 'card.airlock-credit-c1108d.testnet';
const ME = 'lender-7k2q4m9x1z.testnet';
const SCHEDULE: Schedule = { loopCard: CARD, loopSince: null, pauses: [] };
const ev = (event: string, data: Record<string, unknown>, atMs: number): PoolEvent => ({ event, data, atMs, tx: 'DepositTxHash1111111111111111111111111111111' });
const NEAR = 10n ** 24n;
const CHAIN: ChainView = {
  pool: { assets: (3n * NEAR).toString(), shares: (3n * NEAR).toString(), idle: (3n * NEAR).toString(), staked: '0', lent: '0', feesEarned: '0', losses: '0', sharePrice: NEAR.toString(), lines: [], stakingEarned: null, startedMs: null },
  events: [ev('deposit', { account: 'lp1.airlock-credit-c1108d.testnet', amount: (2n * NEAR).toString(), shares: (2n * NEAR).toString() }, NOW - 7_200_000), ev('deposit', { account: ME, amount: NEAR.toString(), shares: NEAR.toString() }, NOW - 3_600_000)],
  truncated: false,
  lenders: { soFar: [ME], now: 1, truncated: false },
};

const base = (o: Partial<LenderViewProps> = {}): string =>
  renderToStaticMarkup(
    <LenderView nowMs={NOW} chain={null} chainFailed={false} schedule={null} position={null} steps={null} problem={null} busy={false} walletTx={null} link={null} linkNote={null} confirm={null} backups={[]} onKeep={() => undefined} onSwitch={() => undefined} onSwitchBack={() => undefined} onLend={() => undefined} onRetry={() => undefined} onWithdraw={() => undefined} onWallet={() => undefined} onCopy={() => undefined} copied={false} {...o} />,
  );

test('lend: routed lazily, listed for the prerender and the sitemap, and in the nav', () => {
  assert.equal(typeof ROUTES['/lend'], 'function');
  assert.ok(PAGES.some((p) => p.path === '/lend' && p.title === 'Lend to an agent | AIRLOCK'));
  assert.ok(NAV.some((n) => n.path === 'lend'));
});

test('lend: the prerendered page carries the copy, the button and no number', () => {
  const html = renderToStaticMarkup(<App pathname="/lend" page={<LenderPage />} />);
  // the page's own text; the site footer's one fact line ("Runs on NEAR's test network") is the shell's, checked by the static sweep
  const t = text(/<main[\s\S]*<\/main>/.exec(html)?.[0] ?? '');
  assert.ok(t.includes('Lend to an agent'));
  assert.ok(t.includes('Make my account and lend 1 NEAR'));
  assert.ok(t.includes('Your key stays in this browser.'));
  assert.ok(t.includes("Counting lender accounts from the pool's deposit records."));
  assert.ok(t.includes('Runs on the NEAR test network, where NEAR has no value.'));
  assert.deepEqual(copyProblems(t), []);
  assert.ok(!/\d+ lender accounts? (is|are) not on/.test(t), 'no lender count before the chain is read');
});

test('lend: with the chain read and no loop yet, it says plainly that the loop has not started', () => {
  const t = text(base({ chain: CHAIN, schedule: SCHEDULE }));
  assert.ok(t.includes('The hourly loop has not started yet'));
  assert.ok(t.includes("1 lender account is not on the team's list, 1 of them lending now"));
  assert.deepEqual(copyProblems(t), []);
});

test('lend: a position is a deposit slip with the short account, the shares, the worth, the lock time and the restore link', () => {
  const html = base({
    chain: CHAIN,
    schedule: SCHEDULE,
    position: { saved: { accountId: ME, secretKey: 'ed25519:x', createdMs: NOW, depositTx: 'DepositTxHash1111111111111111111111111111111' }, lp: { shares: NEAR, value: NEAR, lockedUntilMs: NOW + 30_000 }, attacks: { refused: 7, paidToAttacker: 0n } },
    link: 'https://airlock-ere.pages.dev/lend/#k=abc&a=x',
  });
  const t = text(html);
  assert.ok(t.includes('Deposit slip'));
  assert.ok(t.includes('lender-7k2q…'), 'the account, shortened');
  assert.ok(t.includes('Shares 1.0000') && t.includes('Worth now 1.0000 NEAR'));
  assert.match(t, /You can take it back after \d\d:\d\d:\d\d MST\./);
  assert.ok(html.includes('href="https://testnet.nearblocks.io/txns/DepositTxHash1111111111111111111111111111111"'));
  assert.ok(t.includes('See your deposit'));
  assert.ok(!t.includes('Since you joined'), 'with no loop cycle yet the loop line alone says so, once');
  assert.equal(t.split('has not started').length, 2);
  assert.ok(t.includes('Attacks refused on the card this pool lends to since you joined: 7. Paid to an attacker: 0 NEAR.'));
  assert.ok(t.includes('Keep this link: it holds your key, so anyone with it can take your position out.'));
  assert.ok(/data-testid="lend-withdraw"[^>]*disabled/.test(html), 'withdraw waits for the lock');
  assert.ok(!html.includes('data-testid="lend-go"'), 'no second deposit button once there is a position');
  assert.deepEqual(copyProblems(t), []);
});

test('lend: the faucet fallback offers a wallet; a planned pause turns the button off with its reason', () => {
  const t = text(base({ problem: { kind: 'unavailable' }, steps: { step: 'making', accountId: null } }));
  assert.ok(t.includes('The faucet did not answer (busy, or out of NEAR for your address today). You can lend from your own wallet instead.'));
  assert.ok(t.includes('Connect a wallet'));
  const paused = base({ schedule: { ...SCHEDULE, pauses: [{ from: '2026-11-11T04:00:00Z', to: '2026-11-11T06:00:00Z', why: 'the pool contract is being upgraded' }] } });
  assert.ok(/data-testid="lend-go"[^>]*disabled/.test(paused));
  assert.ok(text(paused).includes('Lending is off until'));
  assert.deepEqual(copyProblems(text(paused)), []);
});

test('lend: the progress names the short account and ends on done', () => {
  const t = text(base({ steps: { step: 'done', accountId: ME }, busy: false }));
  for (const s of ['Making your account.', 'Account made: lender-7k2q…', 'Lending 1 NEAR.', 'Done: you are a lender.']) assert.ok(t.includes(s), s);
  assert.equal(shortAccount('card.airlock-credit-c1108d.testnet'), 'card.airloc…');
  assert.equal(shortAccount('bob.testnet'), 'bob');
  assert.equal(POOL.length > 0, true);
});

test('lend: an account whose deposit never landed offers to lend from it again, without a second faucet account', () => {
  const html = base({ chain: CHAIN, schedule: SCHEDULE, position: { saved: { accountId: 'lender-zzzzzzzzzz.testnet', secretKey: 'ed25519:x', createdMs: NOW, depositTx: null }, lp: { shares: 0n, value: 0n, lockedUntilMs: 0 }, attacks: null } });
  assert.ok(html.includes('data-testid="lend-retry"'));
  assert.ok(text(html).includes('Lend 1 NEAR from this account'));
  assert.ok(!html.includes('data-testid="lend-go"'));
  assert.ok(!html.includes('data-testid="lend-withdraw"'));
});

test('lend: with a private card book the attacks line gives the refusals and no paid-out number', () => {
  const t = text(base({ chain: CHAIN, schedule: SCHEDULE, position: { saved: { accountId: ME, secretKey: 'ed25519:x', createdMs: NOW, depositTx: null }, lp: { shares: NEAR, value: NEAR, lockedUntilMs: 0 }, attacks: { refused: 3, paidToAttacker: null } } }));
  assert.ok(t.includes('Attacks refused on the card this pool lends to since you joined: 3.'));
  assert.ok(!t.includes('Paid to an attacker'));
});

test('lend: slip amounts round to four places, so 1 NEAR less a yocto reads 1.0000 and 0.990099 shares read 0.9901', () => {
  assert.equal(near4(NEAR - 1n), '1.0000');
  assert.equal(near4(990_099_009_900_990_099_009_900n), '0.9901');
  assert.equal(near4(0n), '0.0000');
});

// AIR-359 security review: a restore link naming another account than the saved one replaces nothing until the visitor chooses.
test('lend: a link to another account asks first, in a plain sentence with two buttons', () => {
  const html = base({ confirm: { linked: 'lender-zzzzzzzzzz.testnet', mine: ME } });
  const t = text(html);
  assert.ok(t.includes('This link holds a different lender account (lender-zzzz…) than the one kept in this browser (lender-7k2q…).'));
  assert.ok(html.includes('data-testid="lend-keep-mine"') && t.includes('Keep mine'));
  assert.ok(html.includes('data-testid="lend-switch-linked"') && t.includes('Switch to the linked account'));
  assert.deepEqual(copyProblems(t), []);
});

test('lend: a refused link says why and changes nothing; a backup can be switched back to', () => {
  const t = text(base({ linkNote: 'not-a-key' }));
  assert.ok(t.includes('The key in this link is not a key of that account, so nothing was changed.'));
  assert.ok(text(base({ linkNote: 'unreadable' })).includes('could not be checked on the chain just now, so nothing was changed'));
  assert.ok(text(base({ linkNote: 'bad' })).includes('not a lender link this page can read'));
  const html = base({ backups: ['lender-bbbbbbbbbb.testnet'] });
  assert.ok(text(html).includes('Also kept in this browser: lender-bbbb…'));
  assert.ok(!text(html).includes('lender-bbbb….'), 'no full stop after the ellipsis');
  assert.ok(html.includes('data-testid="lend-switch-back"'));
});

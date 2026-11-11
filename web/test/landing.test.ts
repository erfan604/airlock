// AIR-311: the landing's numbers come from web/public/bench.json and nowhere else. These are the README's audited figures (README, Results):
// 68 of the 69 unguarded successes paid a booked payee, A1 moved money in 0 of 250 attack runs and A2 in 10 of 250, all in one case, and on
// the 70 benign payment tasks A2 finishes 44 by itself, 10 after one tap and 16 fail, while A1 finishes 10 by itself and 44 after a tap.
// The utility figure is the payment tasks only: the 70 read-only tasks propose no payment and say nothing about holds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseBench } from '../src/bench/types.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RECORDED_POOL, factsOf, poolLine } from '../src/landing/facts.ts';
import { Landing } from '../src/landing/Landing.tsx';
import { DoorsView } from '../src/landing/Doors.tsx';
import { RECORDED, recordedBreak, recordedLend, recordedRob } from '../src/landing/doors.ts';
import { countText } from '../src/live/tryChain.ts';
import { stepAt } from '../src/landing/TubeBand.tsx';

const bench = parseBench(JSON.parse(readFileSync(new URL('../public/bench.json', import.meta.url), 'utf8')) as unknown);

test('the landing facts are the audited bench figures', () => {
  assert.ok(bench !== null);
  const f = factsOf(bench);
  assert.ok(f !== null);
  assert.deepEqual(f.bookedOfPaid, { k: '68', n: '69' });
  assert.deepEqual(f.strict, { k: '0', n: '250' });
  assert.deepEqual(f.dflt, { k: '10', n: '250' });
  assert.equal(f.residualCase, 'own-B01-incap');
  assert.equal(f.residualRuns, '10');
  assert.equal(f.payTasks, '70');
  assert.deepEqual(f.honestAlone, { k: '44', n: '70' });
  assert.deepEqual(f.honestTapped, { k: '10', n: '70' });
  assert.deepEqual(f.honestFailed, { k: '16', n: '70' });
  assert.deepEqual(f.strictAlone, { k: '10', n: '70' });
  assert.deepEqual(f.strictTapped, { k: '44', n: '70' });
  assert.equal(f.model, 'z-ai/glm-5.3-flash');
});

test('a bench file without the payment-task table gives no facts, never a guess', () => {
  assert.ok(bench !== null);
  assert.equal(factsOf({ ...bench, completion: bench.completion.filter((t) => !t.title.startsWith('Benign payment tasks only')) }), null);
});

test('the tube band lights the step its loop is showing, and wraps every 6 s', () => {
  assert.deepEqual([0, 1.5, 1.7, 3.1, 3.3, 5.9, 6.0, 7.7].map(stepAt), [0, 0, 1, 1, 2, 2, 0, 1]);
});

// AIR-346 (D9): the landing leads with the pool, and the one number under the hero buttons is read from the pool contract the way /credit reads
// it; until that read lands, or when it fails, the page shows the recorded value and says it is recorded.
test('poolLine: the recorded value is labelled recorded, a live read says it is live, a failed read keeps the recorded value and says why', () => {
  assert.deepEqual(poolLine({ kind: 'recorded' }), { held: '3.21 NEAR', lost: '0 NEAR', note: `Recorded from the pool contract on ${RECORDED_POOL.atText}.`, live: false });
  assert.deepEqual(poolLine({ kind: 'live', assets: '3500000000000000000000000', losses: '0' }), { held: '3.5 NEAR', lost: '0 NEAR', note: 'Read from the pool contract as this page opened.', live: true });
  const failed = poolLine({ kind: 'failed' });
  assert.equal(failed.held, '3.21 NEAR');
  assert.equal(failed.live, false);
  assert.ok(failed.note.startsWith('Recorded from the pool contract') && failed.note.includes('could not be read'));
  assert.equal(poolLine({ kind: 'live', assets: '1234567000000000000000000000', losses: '10000000000000000000000' }).held, '1,234.56 NEAR');
  assert.equal(poolLine({ kind: 'live', assets: '0', losses: '10000000000000000000000' }).lost, '0.01 NEAR');
});

test('landing: the hero names the lending pool and the three doors come right under it, before the older sections; /live is not linked', () => {
  const html = renderToStaticMarkup(createElement(Landing));
  assert.ok(html.includes('A lending pool for AI agents on NEAR.'));
  const hero = html.indexOf('id="hero-title"');
  const doors = html.indexOf('data-testid="landing-doors"');
  assert.ok(hero > 0 && doors > hero, 'the doors follow the hero');
  for (const d of ['door-lend', 'door-rob', 'door-break']) assert.ok(html.indexOf(`data-testid="${d}"`) > doors, d);
  assert.ok(doors < html.indexOf('data-testid="landing-credit"') && html.indexOf('data-testid="landing-credit"') < html.indexOf('data-testid="landing-case"'), 'the older sections come after the doors');
  assert.ok(!html.includes('hero-actions') && !html.includes('data-testid="hero-pool"'));
  assert.ok(!html.includes('badged fixture'));
  assert.ok(!html.includes('href="/live"'));
  assert.ok(html.includes('class="hero-plate"'), 'the words sit on a solid plate over any hero image');
});

test('doors: each door links its page, shows its one number, and says recorded until the chain is read', () => {
  const text = (h: string): string => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
  const rec = renderToStaticMarkup(createElement(DoorsView, { lend: recordedLend(), rob: recordedRob(), brk: recordedBreak(), pool: { kind: 'recorded' } }));
  assert.ok(rec.includes('href="/lend"') && rec.includes('href="/rob"') && rec.includes('href="/break"') && rec.includes('href="/terms"'));
  const t = text(rec);
  assert.ok(t.includes(`${String(RECORDED.lenders)} lender accounts not on the team's list so far.`));
  assert.ok(t.includes(`${String(RECORDED.robPaidOutside)} paid to anyone but the booked shop, in ${countText(RECORDED.robAttempts)} attempts.`));
  assert.ok(t.includes(`${String(RECORDED.copies)} broken copies of the gate; Kani fails on each one.`));
  assert.equal(t.split(`Recorded ${RECORDED.atText}.`).length, 4, 'all three doors say recorded');
  assert.ok(t.includes('Runs on the NEAR test network, where NEAR has no value.') && t.includes('the issuer books the payees'));
  assert.ok(!/testnet|erfan/i.test(t));
  const live = text(renderToStaticMarkup(createElement(DoorsView, { lend: { lenders: 3, source: 'live' }, rob: { attempts: 1, paidOutside: 0, source: 'live' }, brk: { copies: 5, kaniFails: 4, source: 'live' }, pool: { kind: 'live', assets: '3201000000000000000000000', losses: '0' } })));
  assert.ok(live.includes("3.2 NEAR in the pool now. 3 lender accounts not on the team's list so far."));
  assert.ok(live.includes('in 1 attempt.') && live.includes('Kani fails on 4 of them.'));
  // AIR-360: a large count reads with its thousands grouped
  const big = text(renderToStaticMarkup(createElement(DoorsView, { lend: { lenders: 3, source: 'live' }, rob: { attempts: 12345, paidOutside: 0, source: 'live' }, brk: { copies: 5, kaniFails: 5, source: 'live' }, pool: { kind: 'failed' } })));
  assert.ok(big.includes('0 paid to anyone but the booked shop, in 12,345 attempts.'));
  assert.ok(live.includes('Read from the pool contract and its own deposit records.') && !live.includes('Recorded'));
  // the Lend door shows two reads: one live and one recorded is not live
  const half = text(renderToStaticMarkup(createElement(DoorsView, { lend: { lenders: 3, source: 'live' }, rob: { attempts: 1, paidOutside: 0, source: 'live' }, brk: { copies: 5, kaniFails: 5, source: 'live' }, pool: { kind: 'failed' } })));
  assert.ok(half.includes(`Recorded ${RECORDED.atText}; it could not be read just now.`) && !half.includes('Read from the pool contract and its own deposit records.'));
  const failed = text(renderToStaticMarkup(createElement(DoorsView, { lend: recordedLend(true), rob: recordedRob(), brk: recordedBreak(), pool: { kind: 'recorded' } })));
  assert.ok(failed.includes(`Recorded ${RECORDED.atText}; it could not be read just now.`));
});

test('landing: the credit section says the card pays on other chains too and links the credit page, with no network word or personal name', () => {
  const html = renderToStaticMarkup(createElement(Landing));
  const sec = html.slice(html.indexOf('data-testid="landing-credit"'), html.indexOf('data-testid="landing-case"'));
  const t = sec.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
  assert.ok(t.includes("The card pays on other chains too. It paid a booked merchant on Base through NEAR's chain signatures, and the pool then asked NEAR's signer network whether that payment landed and keeps the signed answer."));
  assert.ok(sec.includes('data-testid="cta-credit-base"') && sec.includes('href="/credit"'));
  assert.ok(!/testnet|erfan/i.test(t));
});

// AIR-350: the Base payment checks section of /credit: the pure part (baseChecksOf, explorerBaseTx) and the component.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { baseChecksOf, explorerBaseTx } from '../src/credit/baseChecks.ts';
import { BaseChecks } from '../src/credit/CreditPage.tsx';
import type { PoolEvent } from '../src/lender/lenders.ts';

const TX = '943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63';
const HASH = 'b38ee2231f49b349ec841663233049d739fbd6b00c786b729cda8814b92021c1';
const ASKER = 'lp1.airlock-credit-c1108d.testnet';
const NEAR_TX = '9Kq4Zr2mXb7TfVhWcN5sYd3LpEu8aJgRvB6nCtQwHx1M';
const ev = (data: Record<string, unknown>, atMs = 1_000, event = 'base_payment_checked', tx = NEAR_TX): PoolEvent => ({ event, data, atMs, tx });
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ tx_id: TX, payload_hash: HASH, asked_by: ASKER, ...over });

test('baseChecksOf keeps a good event', () => {
  assert.deepEqual(baseChecksOf([ev(good())]), [{ txId: TX, payloadHash: HASH, askedBy: ASKER, atMs: 1_000, nearTx: NEAR_TX }]);
});

test('baseChecksOf drops malformed events and other event names', () => {
  const bad = [
    ev(good({ tx_id: TX.toUpperCase() })),
    ev(good({ tx_id: `0x${TX}` })),
    ev(good({ tx_id: TX.slice(0, 62) })),
    ev(good({ payload_hash: HASH.slice(0, 63) })),
    ev(good({ payload_hash: 5 })),
    ev({ tx_id: TX, payload_hash: HASH }),
    ev(good({ asked_by: 7 })),
    ev(good(), 1_000, 'base_payment_unchecked'),
    ev(good(), 1_000, 'deposit'),
  ];
  assert.deepEqual(baseChecksOf(bad), []);
});

test('baseChecksOf keeps the earliest of a duplicate tx_id and sorts newest first', () => {
  const other = 'a'.repeat(64);
  const rows = baseChecksOf([ev(good(), 3_000, 'base_payment_checked', 'late'), ev(good(), 1_000, 'base_payment_checked', 'early'), ev(good({ tx_id: other }), 2_000)]);
  assert.deepEqual(rows.map((r) => [r.txId, r.atMs, r.nearTx]), [[other, 2_000, NEAR_TX], [TX, 1_000, 'early']]);
});

test('explorerBaseTx gives the URL only for 64 lowercase hex', () => {
  assert.equal(explorerBaseTx(TX), `https://sepolia.basescan.org/tx/0x${TX}`);
  for (const b of [TX.toUpperCase(), `0x${TX}`, TX.slice(1), `${TX}a`, '', `${TX.slice(0, 63)}/`, `${TX.slice(0, 60)}?a=b`]) assert.equal(explorerBaseTx(b), null);
});

test('the section renders nothing for no rows', () => {
  assert.equal(renderToStaticMarkup(<BaseChecks rows={[]} nowMs={5_000} />), '');
});

test('the section shows the Base link, the NEAR link, the asker, the hash and the sentence for one row', () => {
  const html = renderToStaticMarkup(<BaseChecks rows={baseChecksOf([ev(good())])} nowMs={1_000 + 120_000} />);
  assert.ok(html.includes(`href="https://sepolia.basescan.org/tx/0x${TX}"`));
  assert.ok(html.includes(`href="https://testnet.nearblocks.io/txns/${NEAR_TX}"`));
  assert.ok(html.includes('Paid on Base, checked back on NEAR'));
  assert.ok(html.includes('lp1.airlock-credit-c1108d'));
  assert.ok(html.includes('2 min ago'));
  assert.ok(html.includes(`title="${HASH}"`));
  assert.ok(html.includes('It does not name the payee or the amount, and nothing about a credit line depends on it.'));
  const text = html.replace(/<[^>]*>/g, ' ');
  assert.ok(!/testnet/i.test(text) && !/erfan/i.test(text));
  assert.ok(!/\u2014|-{2}/.test(html));
});

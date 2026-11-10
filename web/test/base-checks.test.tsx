// AIR-350: the Base payment checks section of /credit: the pure parts (list file, view answer, explorerBaseTx), the reader and the component.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BASE_CHECK_LIST, baseCheckRowOf, explorerBaseTx, parseBaseCheckList, readBaseChecks } from '../src/credit/baseChecks.ts';
import { BaseChecks } from '../src/credit/CreditPage.tsx';

const TX = '943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63';
const HASH = 'b38ee2231f49b349ec841663233049d739fbd6b00c786b729cda8814b92021c1';
const ASKER = 'lp1.airlock-credit-c1108d.testnet';
const NEAR_TX = '9Kq4Zr2mXb7TfVhWcN5sYd3LpEu8aJgRvB6nCtQwHx1M';
const REC = '1794340215416';
const entry = { txId: TX, nearTx: NEAR_TX };
const answer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ tx_id: TX, payload_hash: HASH, signature: '{}', asked_by: ASKER, recorded_ms: REC, ...over });

test('every entry of the committed list is well formed, so none is dropped silently', () => {
  const raw = JSON.parse(readFileSync(new URL('../src/credit/base-checks.json', import.meta.url), 'utf8')) as { checks: unknown[] };
  assert.equal(BASE_CHECK_LIST.length, raw.checks.length);
  assert.ok(BASE_CHECK_LIST.length >= 1);
});

test('parseBaseCheckList keeps good entries, drops bad ones and duplicates', () => {
  const other = 'a'.repeat(64);
  const raw = { checks: [{ tx_id: TX, near_tx: NEAR_TX }, { tx_id: TX, near_tx: NEAR_TX }, { tx_id: other, near_tx: NEAR_TX }, { tx_id: TX.toUpperCase(), near_tx: NEAR_TX }, { tx_id: `0x${TX}`, near_tx: NEAR_TX }, { tx_id: 'b'.repeat(64), near_tx: 'not a hash/../' }, { tx_id: 'c'.repeat(64) }, 5, null] };
  assert.deepEqual(parseBaseCheckList(raw), [entry, { txId: other, nearTx: NEAR_TX }]);
  assert.deepEqual(parseBaseCheckList(null), []);
  assert.deepEqual(parseBaseCheckList({ checks: 'x' }), []);
});

test('baseCheckRowOf reads a good answer', () => {
  assert.deepEqual(baseCheckRowOf(entry, answer()), { txId: TX, payloadHash: HASH, askedBy: ASKER, recordedMs: 1794340215416, nearTx: NEAR_TX });
});

test('baseCheckRowOf drops null and malformed answers', () => {
  for (const bad of [null, 'x', answer({ tx_id: 'a'.repeat(64) }), answer({ payload_hash: HASH.slice(0, 63) }), answer({ recorded_ms: 'soon' }), answer({ recorded_ms: 5 }), answer({ asked_by: 7 })]) assert.equal(baseCheckRowOf(entry, bad), null);
});

test('readBaseChecks makes no request for an empty list and drops failures and nulls, newest first', async () => {
  let calls = 0;
  const none = await readBaseChecks({ pool: 'pool.x.testnet', rpcUrls: ['https://rpc.invalid'], fetch: (() => { calls += 1; return Promise.reject(new Error('no')); }) as typeof fetch }, []);
  assert.deepEqual(none, []);
  assert.equal(calls, 0);
  const other = 'a'.repeat(64);
  const fake = ((_u: unknown, init: { body: string }) => {
    const args = JSON.parse(init.body) as { params: { args_base64: string } };
    const asked = (JSON.parse(Buffer.from(args.params.args_base64, 'base64').toString()) as { tx_id: string }).tx_id;
    const val = asked === TX ? answer() : asked === other ? answer({ tx_id: other, recorded_ms: '1794340215999' }) : null;
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(val))] } })));
  }) as unknown as typeof fetch;
  const rows = await readBaseChecks({ pool: 'pool.x.testnet', rpcUrls: ['https://rpc.invalid'], fetch: fake }, [entry, { txId: other, nearTx: NEAR_TX }, { txId: 'd'.repeat(64), nearTx: NEAR_TX }]);
  assert.deepEqual(rows.map((r) => r.txId), [other, TX]);
});

test('explorerBaseTx gives the URL only for 64 lowercase hex', () => {
  assert.equal(explorerBaseTx(TX), `https://sepolia.basescan.org/tx/0x${TX}`);
  for (const b of [TX.toUpperCase(), `0x${TX}`, TX.slice(1), `${TX}a`, '', `${TX.slice(0, 63)}/`, `${TX.slice(0, 60)}?a=b`]) assert.equal(explorerBaseTx(b), null);
});

test('the section renders nothing for no rows', () => {
  assert.equal(renderToStaticMarkup(<BaseChecks rows={[]} nowMs={5_000} />), '');
});

test('the section shows the Base link, the NEAR link, the asker, the hash and the sentence for one row', () => {
  const row = baseCheckRowOf(entry, answer());
  assert.notEqual(row, null);
  const html = renderToStaticMarkup(<BaseChecks rows={row === null ? [] : [row]} nowMs={1794340215416 + 120_000} />);
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

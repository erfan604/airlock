// The Credit Passport block of /credit: the two parsers, the reader and the component, on the live answers of 2026-11-10.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePassport, parsePoolPassport, readPassports, readPoolPassport } from '../src/credit/passport.ts';
import { Passports } from '../src/credit/CreditPage.tsx';

const CARD = 'card.airlock-credit-c1108d.testnet';
const REAL = {
  borrower: 'borrower.airlock-credit-c1108d.testnet',
  score: 580,
  reasons: ['base +500', 'repaid_on_time x1 +80', 'backfilled: counts only what the pool state proves'],
  record: { lines_opened: 3, repaid_on_time: 1, repaid_late: 0, defaults: 0, recovered: 0, written_off: 0, volume_repaid: '100000000000000000000000', fees_paid: '10000000000000000000000', last_event_ms: '1794350900790', backfilled: true },
  limit_cap: '1160000000000000000000000',
};
const REAL_POOL = { base: '1000000000000000000000000', pending_base: null, effective_ms: null, version: 2, floor_base: '1000000000000000000000000' };
const rec = (over: Record<string, unknown>): Record<string, unknown> => ({ ...REAL.record, ...over });

test('parsePassport reads the real answer', () => {
  assert.deepEqual(parsePassport(REAL), { borrower: REAL.borrower, score: 580, limitCap: '1160000000000000000000000', reasons: REAL.reasons, record: { linesOpened: 3, repaidOnTime: 1, repaidLate: 0, defaults: 0 } });
});

test('parsePassport returns null on null and on anything malformed', () => {
  const bad: unknown[] = [
    null, undefined, 'x', 5, [], {},
    { ...REAL, score: 1001 }, { ...REAL, score: -1 }, { ...REAL, score: 580.5 }, { ...REAL, score: '580' },
    { ...REAL, limit_cap: 1160 }, { ...REAL, limit_cap: '-5' }, { ...REAL, limit_cap: '1.5' }, { ...REAL, limit_cap: '' }, { ...REAL, limit_cap: '01' },
    { ...REAL, reasons: 'base' }, { ...REAL, reasons: [1] }, { ...REAL, reasons: ['a'.repeat(201)] },
    { ...REAL, borrower: '' }, { ...REAL, borrower: 7 },
    { ...REAL, record: null }, { ...REAL, record: rec({ lines_opened: -1 }) }, { ...REAL, record: rec({ repaid_on_time: 1.5 }) }, { ...REAL, record: rec({ repaid_late: '0' }) }, { ...REAL, record: rec({ defaults: undefined }) },
  ];
  for (const b of bad) assert.equal(parsePassport(b), null, JSON.stringify(b));
  assert.notEqual(parsePassport({ ...REAL, score: 0 }), null);
  assert.notEqual(parsePassport({ ...REAL, score: 1000, reasons: ['a'.repeat(200)] }), null);
});

test('parsePoolPassport reads the real answer and drops malformed ones', () => {
  assert.deepEqual(parsePoolPassport(REAL_POOL), { floorBase: '1000000000000000000000000' });
  for (const b of [null, 'x', [], {}, { floor_base: 5 }, { floor_base: '-1' }, { floor_base: '1e24' }]) assert.equal(parsePoolPassport(b), null);
});

const fakeFetch = (answers: Record<string, unknown>): typeof fetch =>
  ((_u: unknown, init: { body: string }) => {
    const p = (JSON.parse(init.body) as { params: { method_name: string; args_base64: string } }).params;
    const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString()) as { card?: string };
    const key = p.method_name === 'get_passport' ? `get_passport:${args.card ?? ''}` : p.method_name;
    if (!(key in answers)) return Promise.reject(new Error('no'));
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(answers[key]))] } })));
  }) as unknown as typeof fetch;

test('readPassports drops a card whose read fails, answers null or is malformed, and makes no request for no cards', async () => {
  let calls = 0;
  const counting = ((...a: unknown[]) => { calls += 1; return (fakeFetch({}) as (...x: unknown[]) => Promise<Response>)(...a); }) as unknown as typeof fetch;
  assert.deepEqual(await readPassports({ pool: 'pool.x.testnet', rpcUrls: ['https://rpc.invalid'], fetch: counting }, []), []);
  assert.equal(calls, 0);
  const f = fakeFetch({ [`get_passport:${CARD}`]: REAL, 'get_passport:b.testnet': null, 'get_passport:c.testnet': { ...REAL, score: 5000 } });
  const rows = await readPassports({ pool: 'pool.x.testnet', rpcUrls: ['https://rpc.invalid'], fetch: f }, [CARD, 'b.testnet', 'c.testnet', 'd.testnet']);
  assert.deepEqual(rows.map((r) => r.card), [CARD]);
  assert.equal(rows[0]?.passport.score, 580);
});

test('readPoolPassport gives the base, and null for a failed read or an old pool', async () => {
  const cfg = { pool: 'pool.x.testnet', rpcUrls: ['https://rpc.invalid'] };
  assert.deepEqual(await readPoolPassport({ ...cfg, fetch: fakeFetch({ get_pool_passport: REAL_POOL }) }), { floorBase: REAL_POOL.floor_base });
  assert.equal(await readPoolPassport({ ...cfg, fetch: fakeFetch({}) }), null);
  assert.equal(await readPoolPassport({ ...cfg, fetch: fakeFetch({ get_pool_passport: null }) }), null);
});

const realRow = (): { card: string; passport: NonNullable<ReturnType<typeof parsePassport>> } => {
  const passport = parsePassport(REAL);
  assert.notEqual(passport, null);
  return { card: CARD, passport: passport as NonNullable<typeof passport> };
};
const pool = { floorBase: REAL_POOL.floor_base };

test('the block renders nothing for no passports', () => {
  assert.equal(renderToStaticMarkup(<Passports rows={[]} pool={pool} />), '');
  assert.equal(renderToStaticMarkup(<Passports rows={[]} pool={null} />), '');
});

test('the block shows the score, the cap, the three reasons, the counts and the true sentence for the real answer', () => {
  const html = renderToStaticMarkup(<Passports rows={[realRow()]} pool={pool} />);
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(html.includes('data-testid="credit-passports"') && html.includes('data-score="580"'));
  assert.ok(html.includes('>580<'));
  assert.ok(text.includes('at most 1.16 NEAR'));
  for (const r of REAL.reasons) assert.ok(text.includes(r), r);
  assert.equal((html.match(/data-testid="passport-reason"/g) ?? []).length, 3);
  assert.ok(text.includes('3 lines opened, 1 repaid on time, 0 repaid late, 0 defaults'));
  assert.ok(text.includes('computes the score') && text.includes('a tenth of the line and at least a tenth of the base (the base is 1.00 NEAR)') && text.includes('not a credit model'));
  assert.ok(html.includes('href="https://testnet.nearblocks.io/address/borrower.airlock-credit-c1108d.testnet"'));
  assert.ok(!text.includes('(the base is') === false);
});

test('the sentence leaves the base out when the pool answer is missing', () => {
  const text = renderToStaticMarkup(<Passports rows={[realRow()]} pool={null} />).replace(/<[^>]*>/g, ' ');
  assert.ok(text.includes('a tenth of the base.') && !text.includes('the base is'));
});

test('a reason with markup renders as text', () => {
  const row = realRow();
  const evil = { ...row, passport: { ...row.passport, reasons: ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>'] } };
  const html = renderToStaticMarkup(<Passports rows={[evil]} pool={pool} />);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script') && !html.includes('<img'));
});

test('the rendered text has no testnet, no owner name, no old sentence, no em dash and no double hyphen', () => {
  const html = renderToStaticMarkup(<Passports rows={[realRow()]} pool={pool} />);
  const text = html.replace(/href="[^"]*"/g, '').replace(/aria-label="[^"]*"/g, '').replace(/<[^>]*>/g, ' ');
  assert.ok(!/testnet/i.test(text) && !/erfan/i.test(text));
  for (const old of ['before the passport token', 'arithmetic on that record', 'AIR-333', 'fixture records']) assert.ok(!html.includes(old), old);
  assert.ok(!/\u2014|-{2}/.test(text));
  assert.ok(!/credit score|judge|reviewer|nobody|unhackable/i.test(text));
});

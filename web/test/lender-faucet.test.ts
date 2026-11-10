// AIR-359: the faucet client and the lender's key store. The faucet is mocked here and in every e2e (each real call spends one of the 10
// accounts an internet address gets per 12 hours).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAUCET_URL, LENDER_ID, askFaucet, makeAccount, newLenderId } from '../src/lender/faucet.ts';
import { STORE_KEY, consumeFragment, loadSaved, parseFragment, restoreLink, saveLender } from '../src/lender/keystore.ts';
import vector from './fixtures/tx-vector.json' with { type: 'json' };

const PUB = 'ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';

function faucet(answers: (Response | Error)[], log: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    log.push({ url, init });
    const a = answers.shift();
    if (a === undefined) throw new Error('no more answers');
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as typeof fetch;
}

test('faucet: generated names are lender- and 10 base36 characters, top level', () => {
  for (let i = 0; i < 50; i++) assert.match(newLenderId(), LENDER_ID);
  assert.equal(newLenderId(() => new Uint8Array(10)), 'lender-0000000000.testnet');
});

test('faucet: the request is a POST of exactly {newAccountId, newAccountPublicKey} to the helper', async () => {
  const log: { url: string; init: RequestInit }[] = [];
  const r = await askFaucet(faucet([Response.json({ transaction: { hash: 'TxHash1' } })], log), 'lender-abc1234567.testnet', PUB);
  assert.deepEqual(r, { kind: 'ok', tx: 'TxHash1' });
  assert.equal(log[0]?.url, 'https://helper.testnet.near.org/account');
  assert.equal(FAUCET_URL, 'https://helper.testnet.near.org/account');
  assert.equal(log[0]?.init.method, 'POST');
  assert.equal(log[0]?.init.body, JSON.stringify({ newAccountId: 'lender-abc1234567.testnet', newAccountPublicKey: PUB }));
});

test('faucet: 429 is rate-limited with the reset time, 500 and a thrown fetch retry, a 4xx about an existing name is taken', async () => {
  const limited = await askFaucet(faucet([new Response('slow down', { status: 429, headers: { 'x-ratelimit-reset': '1794331990.95' } })]), 'a.testnet', PUB);
  assert.deepEqual(limited, { kind: 'limited', resetMs: 1794331990000 });
  assert.deepEqual(await askFaucet(faucet([new Response('x', { status: 429 })]), 'a.testnet', PUB), { kind: 'limited', resetMs: null });
  assert.deepEqual(await askFaucet(faucet([new Response('boom', { status: 500 })]), 'a.testnet', PUB), { kind: 'retry' });
  assert.deepEqual(await askFaucet(faucet([new Error('offline')]), 'a.testnet', PUB), { kind: 'retry' });
  assert.deepEqual(await askFaucet(faucet([new Response('account already exists', { status: 400 })]), 'a.testnet', PUB), { kind: 'taken' });
  assert.deepEqual(await askFaucet(faucet([new Response('bad key', { status: 400 })]), 'a.testnet', PUB), { kind: 'refused' });
});

test('faucet: makeAccount retries once after 3 s, takes a second name once, and otherwise gives up plainly', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  let n = 0;
  const newId = (): string => `lender-${String(++n).padStart(10, '0')}.testnet`;
  assert.deepEqual(await makeAccount(PUB, { fetch: faucet([new Response('', { status: 502 }), Response.json({})]), sleep, newId }), { kind: 'ok', accountId: 'lender-0000000001.testnet', tx: null });
  assert.deepEqual(waits, [3000]);
  assert.deepEqual(await makeAccount(PUB, { fetch: faucet([new Response('', { status: 502 }), new Response('', { status: 503 })]), sleep, newId }), { kind: 'unavailable' });
  const taken = await makeAccount(PUB, { fetch: faucet([new Response('already exists', { status: 400 }), Response.json({ transaction: { hash: 'H' } })]), sleep, newId });
  assert.equal(taken.kind === 'ok' && taken.accountId, 'lender-0000000004.testnet');
  assert.deepEqual(await makeAccount(PUB, { fetch: faucet([new Response('already exists', { status: 400 }), new Response('already exists', { status: 400 })]), sleep, newId }), { kind: 'unavailable' });
  assert.deepEqual(await makeAccount(PUB, { fetch: faucet([new Response('', { status: 429 })]), sleep, newId }), { kind: 'limited', resetMs: null });
});

function memoryStore(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), clear: () => data.clear(), key: () => null, length: 0 } as Storage & { data: Map<string, string> };
}

const SAVED = { accountId: 'lender-abc1234567.testnet', secretKey: vector.secretKey, createdMs: 1_794_300_000_000, depositTx: null };

test('keystore: a saved lender round-trips; a damaged record or throwing storage reads as none', () => {
  const s = memoryStore();
  assert.equal(saveLender(s, SAVED), true);
  assert.deepEqual(loadSaved(s), SAVED);
  s.data.set(STORE_KEY, '{"accountId":"x"}');
  assert.equal(loadSaved(s), null);
  s.data.set(STORE_KEY, 'not json');
  assert.equal(loadSaved(s), null);
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(loadSaved(throwing), null);
  assert.equal(saveLender(throwing, SAVED), false);
  assert.equal(loadSaved(null), null);
});

test('keystore: the restore link carries the key and account in the fragment; parsing takes it back and refuses a malformed key', () => {
  const link = restoreLink('https://airlock-ere.pages.dev/lend/', SAVED);
  assert.ok(link.startsWith('https://airlock-ere.pages.dev/lend/#k='));
  const f = parseFragment(new URL(link).hash);
  assert.deepEqual(f, { kind: 'key', accountId: SAVED.accountId, secretKey: SAVED.secretKey });
  assert.deepEqual(parseFragment(''), { kind: 'none' });
  assert.deepEqual(parseFragment('#k=abc&a=lender-abc1234567.testnet'), { kind: 'bad' });
  assert.deepEqual(parseFragment(`#k=${SAVED.secretKey.slice(8)}0&a=x.testnet`), { kind: 'bad' }, 'a character outside base58');
  assert.deepEqual(parseFragment(`#k=${SAVED.secretKey.slice(8)}&a=Bad Name`), { kind: 'bad' });
  assert.deepEqual(parseFragment(`#k=${SAVED.secretKey.slice(8)}`), { kind: 'bad' });
});

test('keystore: consuming the fragment stores a good key and always removes the fragment from the address', () => {
  const s = memoryStore();
  const replaced: string[] = [];
  const hist = { replaceState: (_d: unknown, _u: string, url: string) => void replaced.push(url) };
  const good = consumeFragment({ hash: new URL(restoreLink('https://x/lend/', SAVED)).hash, pathname: '/lend/', search: '' }, hist, s, 5);
  assert.equal(good.kind, 'key');
  assert.deepEqual(replaced, ['/lend/']);
  assert.equal(loadSaved(s)?.accountId, SAVED.accountId);
  const bad = consumeFragment({ hash: '#k=zz&a=q', pathname: '/lend/', search: '?x=1' }, hist, memoryStore(), 5);
  assert.equal(bad.kind, 'bad');
  assert.deepEqual(replaced, ['/lend/', '/lend/?x=1']);
  assert.equal(consumeFragment({ hash: '', pathname: '/lend/', search: '' }, hist, s, 5).kind, 'none');
  assert.equal(replaced.length, 2, 'nothing to remove');
});

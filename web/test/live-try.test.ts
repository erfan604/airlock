// AIR-356: what the "try it live" page reads. The public file (accounts, the three published keys, the shop's book proof, the tasks the
// owner signed ahead of time) is parsed strictly, and the try card's attempts are listed from the chain and classified without a book
// view: the current policy contract has no get_book, so the booked payees come from the public file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TRY_PUBLIC_FORMAT, parseTryPublic } from '../src/live/tryPublic.ts';
import type { TryPublic } from '../src/live/tryPublic.ts';
import { classifyTryTx, countsOfTry, newTryCache, readTryAttempts, withExpiry } from '../src/live/tryChain.ts';

const FIX = fileURLToPath(new URL('../../runtime/src/arena/fixtures/', import.meta.url));
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const OWNER = 'airlock-try-a1b2c3.testnet';
const POLICY = `try.${OWNER}`;
const AGENT = `agent.${OWNER}`;
const SHOP = `near:shop.${OWNER}`;
const KEY = { publicKey: 'ed25519:DTWDsPMecx41mG3WEywme1HzNpNuQgQrm2AZ3kaNNkJq', secretKey: `ed25519:${'3'.repeat(87)}` };

const task = (k: number, expiresMs: number): TryPublic['tasks'][number] => ({
  task: { tag: 'airlock-task-v1', task_id: `try-${String(k)}-1`, contract_id: POLICY, agent_id: AGENT, plan_sha256: 'a'.repeat(64), instruction_sha256_salted: 'b'.repeat(64), issued_ms: expiresMs - 7 * 86_400_000, expires_ms: expiresMs, max_actions: 99, bounds: [{ payee_key: SHOP, max_total: '10000000000000000000000' }] },
  task_sig: Buffer.from(new Uint8Array(64)).toString('base64'),
  task_hash: 'c'.repeat(64),
  issuedAt: new Date(expiresMs - 7 * 86_400_000).toISOString(),
  expiresAt: new Date(expiresMs).toISOString(),
});
const file = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: TRY_PUBLIC_FORMAT,
  policy: POLICY,
  agent: AGENT,
  keys: [KEY, { ...KEY, publicKey: 'ed25519:FeTC3uktpWwCaSET19QzS8yxRWH2KCov3sD7zhb7TTiJ' }],
  shop: { payee: SHOP, proof: { salt: 'd'.repeat(64), cap: null, daily_untrusted_budget: '0', daily_limit: '300000000000000000000000', index: 0, siblings: Array.from({ length: 8 }, () => 'e'.repeat(64)) } },
  book: [SHOP],
  pendingTtlMs: 60_000,
  honestAmount: '1000000000000000000000',
  publishedAt: new Date(NOW - 3_600_000).toISOString(),
  tasks: [task(0, NOW + 86_400_000), task(1, NOW + 86_400_000), task(2, NOW - 1000)],
  ...over,
});

test('the public file: a valid one is accepted and only its live tasks are kept', () => {
  const got = parseTryPublic(file(), NOW);
  assert.ok('ok' in got, 'refuse' in got ? got.refuse : '');
  assert.equal(got.ok.tasks.length, 2);
  assert.equal(got.ok.keys.length, 2);
  assert.deepEqual(got.ok.book, [SHOP]);
  assert.equal(got.ok.pendingTtlMs, 60_000);
});

test('the public file is refused: a credit account, a personal name, another format, a bad key, tasks of another policy, or no live task', () => {
  const why = (over: Record<string, unknown>): string => {
    const got = parseTryPublic(file(over), NOW);
    return 'refuse' in got ? got.refuse : 'accepted';
  };
  assert.match(why({ agent: 'agent.airlock-credit-c1108d.testnet' }), /credit account/);
  assert.match(why({ policy: 'card.airlock-credit-c1108d.testnet' }), /credit account/);
  assert.match(why({ agent: 'erfan-agent.testnet' }), /personal name/);
  assert.match(why({ format: 'airlock-challenge-public-v1' }), /format/);
  assert.match(why({ keys: [] }), /key/);
  assert.match(why({ keys: [{ publicKey: 'ed25519:short', secretKey: KEY.secretKey }] }), /key/);
  assert.match(why({ keys: [{ publicKey: KEY.publicKey, secretKey: 'not a key' }] }), /key/);
  assert.match(why({ book: [] }), /shop/);
  assert.match(why({ shop: { payee: SHOP, proof: { salt: 'zz' } } }), /proof/);
  assert.match(why({ tasks: [task(0, NOW - 1)] }), /no task that is still valid/);
  assert.match(why({ tasks: [{ ...task(0, NOW + 1000), task: { ...task(0, NOW + 1000).task, contract_id: 'other.testnet' } }] }), /another policy or agent/);
  const none = parseTryPublic(null, NOW);
  assert.ok('refuse' in none);
});

type Raw = { transaction: Record<string, unknown> & { actions: { FunctionCall: { method_name: string; args: string } }[] }; receipts: { receipt: Record<string, unknown>; execution_outcome: { outcome: Record<string, unknown> & { status: Record<string, string> } } }[] };
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');
const unb64 = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

/** The recorded held transaction, rewritten as a call of the try agent on the try policy. */
function tryTx(hash: string, change: { payee?: string; amount?: string; outcome?: 'allowed' | 'escalated' | 'blocked'; reason?: string | null; signer?: string; method?: string; fail?: boolean } = {}): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(`${FIX}recorded-held.json`, 'utf8')) as Raw;
  raw.transaction['hash'] = hash;
  raw.transaction['signer_id'] = change.signer ?? AGENT;
  raw.transaction['receiver_id'] = POLICY;
  const call = raw.transaction.actions[0]?.FunctionCall;
  assert.ok(call !== undefined);
  const args = unb64(call.args) as { reqs: Record<string, unknown>[] };
  const req = args.reqs[0] as Record<string, unknown>;
  req['payee'] = change.payee ?? 'near:stranger.testnet';
  if (change.amount !== undefined) req['amount'] = change.amount;
  call.args = b64(args);
  if (change.method !== undefined) call.method_name = change.method;
  const r = raw.receipts[0];
  assert.ok(r !== undefined);
  r.receipt['predecessor_id'] = change.signer ?? AGENT;
  r.execution_outcome.outcome['executor_id'] = POLICY;
  const status = r.execution_outcome.outcome.status;
  const answers = unb64(status['SuccessValue'] ?? '') as Record<string, unknown>[];
  if (change.outcome !== undefined) (answers[0] as Record<string, unknown>)['outcome'] = change.outcome;
  if (change.reason !== undefined) (answers[0] as Record<string, unknown>)['reason'] = change.reason;
  if (change.fail === true) r.execution_outcome.outcome.status = { Failure: 'x' };
  else status['SuccessValue'] = b64(answers);
  return raw as unknown as Record<string, unknown>;
}
const cfg = { policy: POLICY, agent: AGENT, book: [SHOP] };
const h = (c: string): string => c.repeat(44);

test('one transaction of the try card, classified without a book view', () => {
  const one = (change: Parameters<typeof tryTx>[1]): unknown => classifyTryTx(tryTx(h('A'), change), cfg, { hash: h('A'), height: 1, atMs: NOW - 10_000 });
  const kind = (change: Parameters<typeof tryTx>[1]): unknown => {
    const got = one(change);
    return Array.isArray(got) ? got.map((a) => `${a.kind} ${a.reason ?? ''}`.trim()) : got;
  };
  assert.deepEqual(kind({ outcome: 'blocked', reason: 'AmountOutOfBounds' }), ['blocked AmountOutOfBounds']);
  assert.deepEqual(kind({ outcome: 'escalated', reason: 'OutsideTask' }), ['held OutsideTask']);
  assert.deepEqual(kind({ outcome: 'escalated', reason: 'UntrustedTrigger', payee: SHOP }), ['held UntrustedTrigger']);
  assert.deepEqual(kind({ outcome: 'allowed', reason: null, payee: SHOP }), ['paid_shop']);
  // a payment to an account outside the published book is reported as what it is
  assert.deepEqual(kind({ outcome: 'allowed', reason: null, payee: 'near:stranger.testnet' }), ['paid_outside']);
  // not an attempt: another signer, another method; a failed call (a used slot) is counted apart
  assert.equal(one({ signer: 'someone.testnet' }), null);
  assert.equal(one({ method: 'expire' }), null);
  assert.equal(one({ fail: true }), 'failed');
});

test('a hold older than the time holds live is shown as expired', () => {
  const got = classifyTryTx(tryTx(h('A'), { outcome: 'escalated', reason: 'OutsideTask' }), cfg, { hash: h('A'), height: 1, atMs: NOW - 61_000 });
  assert.ok(Array.isArray(got));
  assert.equal(withExpiry(got, NOW, 60_000)[0]?.verdict, 'expired');
  assert.equal(withExpiry(got, NOW - 2000, 60_000)[0]?.verdict, 'held');
  const blocked = classifyTryTx(tryTx(h('B'), { outcome: 'blocked', reason: 'AmountOutOfBounds' }), cfg, { hash: h('B'), height: 1, atMs: NOW - 600_000 });
  assert.ok(Array.isArray(blocked));
  assert.equal(withExpiry(blocked, NOW, 60_000)[0]?.verdict, 'blocked');
});

function chain(pages: Record<string, unknown>[][]): { fetch: typeof fetch; listings: () => number; bodies: () => number } {
  let listings = 0;
  let bodies = 0;
  const hashOf = (t: Record<string, unknown>): string => (t['transaction'] as { hash: string }).hash;
  const fetchFn = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { account_id?: string; resume_token?: string; tx_hashes?: string[] };
    if (url.endsWith('/v0/account')) {
      listings += 1;
      assert.equal(body.account_id, POLICY);
      const at = body.resume_token === undefined ? 0 : +body.resume_token;
      const before = pages.slice(0, at).reduce((n, p) => n + p.length, 0);
      return new Response(JSON.stringify({ account_txs: (pages[at] ?? []).map((t, i) => ({ transaction_hash: hashOf(t), tx_block_height: 9000 - before - i, tx_block_timestamp: `${String(NOW - (before + i + 1) * 600_000)}000000` })), resume_token: at + 1 < pages.length ? String(at + 1) : null }));
    }
    bodies += body.tx_hashes?.length ?? 0;
    return new Response(JSON.stringify({ transactions: pages.flat().filter((t) => body.tx_hashes?.includes(hashOf(t))) }));
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, listings: () => listings, bodies: () => bodies };
}

test('the reader lists the attempts of the try card, counts them, and reads each transaction once', async () => {
  const c = chain([
    [tryTx(h('A'), { outcome: 'blocked', reason: 'AmountOutOfBounds' }), tryTx(h('B'), { outcome: 'escalated', reason: 'OutsideTask' }), tryTx(h('C'), { signer: 'someone.testnet' })],
    [tryTx(h('D'), { outcome: 'allowed', reason: null, payee: SHOP }), tryTx(h('E'), { fail: true }), tryTx(h('F'), { method: 'expire' })],
  ]);
  const cache = newTryCache();
  const got = await readTryAttempts({ fetch: c.fetch, ...cfg, nowMs: NOW, ttlMs: 60_000, cache });
  assert.deepEqual(got.attempts.map((a) => a.verdict).sort(), ['blocked', 'expired', 'paid_shop']);
  assert.equal(got.failed, 1);
  assert.equal(got.truncated, false);
  assert.deepEqual(countsOfTry(got.attempts), { attempts: 3, blocked: 1, held: 0, expired: 1, paidShop: 1, paidOutside: 0, lastMs: NOW - 600_000 });
  assert.equal(c.bodies(), 6);
  await readTryAttempts({ fetch: c.fetch, ...cfg, nowMs: NOW, ttlMs: 60_000, cache });
  assert.equal(c.bodies(), 6, 'a final transaction is read once');
  assert.equal(c.listings(), 3, 'a later read stops at the first page it knows');
  const capped = await readTryAttempts({ fetch: chain([[tryTx(h('A'))], [tryTx(h('B'))], [tryTx(h('C'))]]).fetch, ...cfg, nowMs: NOW, ttlMs: 60_000, maxPages: 2 });
  assert.equal(capped.truncated, true);
});

test('the reader throws when the chain cannot be read, and the page source asks for no book view', async () => {
  const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(readTryAttempts({ fetch: down, ...cfg, nowMs: NOW, ttlMs: 60_000 }));
  const src = readFileSync(fileURLToPath(new URL('../src/live/tryChain.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /get_book'|readBook|readChain\(/);
});

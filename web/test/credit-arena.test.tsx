// AIR-336: the Arena strip of /credit. Attempts are read from the chain: the agent account's submit_batch calls on the card whose owner task
// is an arena task, whichever of the agent's keys signed them (expire calls are not counted). The counts are computed from them, the whole
// history is paged with a cache, a flood refusal is counted apart from a policy block, an unreadable chain shows "unreadable" and never
// zeros, and the wording rules hold: nothing is shown before there is a round to show, the copy is in the past tense, the cadence word only
// after 6 attempts and 24 h of cron log, "live" only while the last attempt is under 3 hours old, no network or personal name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { TxLink } from '../src/credit/CreditPage.tsx';
import { ArenaView } from '../src/credit/arena/ArenaStrip.tsx';
import type { ArenaSample } from '../src/credit/arena/ArenaStrip.tsx';
import { ARENA_AGENT, ARENA_CARD, ARENA_INVOICE_YOCTO, ARENA_MERCHANT_KEY, ARENA_STRICT_SINCE_MS, ARENA_TASK_PREFIX } from '../src/credit/arena/config.ts';
import { countsOf, headline } from '../src/credit/arena/model.ts';
import type { ArenaAttempt } from '../src/credit/arena/model.ts';
import { ARENA_MAX_PAGES, newArenaCache, readArena } from '../src/credit/arena/read.ts';

const FIX = fileURLToPath(new URL('../../runtime/src/arena/fixtures/', import.meta.url));
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

type Raw = {
  transaction: Record<string, unknown> & { actions: { FunctionCall: { method_name: string; args: string } }[] };
  receipts: { execution_outcome: { outcome: { status: Record<string, string> } } }[];
};
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');
const unb64 = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const KEYCHAIN_PK = 'ed25519:DTWDsPMecx41mG3WEywme1HzNpNuQgQrm2AZ3kaNNkJq';
const SCOPED_PK = 'ed25519:FeTC3uktpWwCaSET19QzS8yxRWH2KCov3sD7zhb7TTiJ';

/** The recorded held transaction as an arena attempt, with the parts a case needs changed. */
function arenaTx(hash: string, change: { taskId?: string; method?: string; publicKey?: string; signer?: string; outcome?: 'allowed' | 'escalated' | 'blocked'; reason?: string } = {}): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(`${FIX}recorded-held.json`, 'utf8')) as Raw;
  raw.transaction['hash'] = hash;
  if (change.publicKey !== undefined) raw.transaction['public_key'] = change.publicKey;
  if (change.signer !== undefined) raw.transaction['signer_id'] = change.signer;
  const call = raw.transaction.actions[0]?.FunctionCall;
  assert.ok(call !== undefined);
  const args = unb64(call.args) as { task: Record<string, unknown> };
  args.task['task_id'] = change.taskId ?? `${ARENA_TASK_PREFIX}1762900000000-ab12cd`;
  call.args = b64(args);
  if (change.method !== undefined) call.method_name = change.method;
  const status = raw.receipts[0]?.execution_outcome.outcome.status;
  assert.ok(status !== undefined && status['SuccessValue'] !== undefined);
  const answers = unb64(status['SuccessValue']) as Record<string, unknown>[];
  if (change.outcome !== undefined) (answers[0] as Record<string, unknown>)['outcome'] = change.outcome;
  if (change.reason !== undefined) (answers[0] as Record<string, unknown>)['reason'] = change.reason;
  status['SuccessValue'] = b64(answers);
  return raw as unknown as Record<string, unknown>;
}

const hashOf = (t: Record<string, unknown>): string => (t['transaction'] as { hash: string }).hash;
const h = (c: string): string => c.repeat(44);

/** A stand-in for FastNEAR: `pages` are the listing pages of the card, newest first; every listed transaction can be read by hash. */
function chain(pages: Record<string, unknown>[][]): { fetch: typeof fetch; listings: () => number; bodies: () => string[]; add: (t: Record<string, unknown>) => void } {
  let listings = 0;
  const bodies: string[] = [];
  const row = (t: Record<string, unknown>, i: number): Record<string, unknown> => ({ transaction_hash: hashOf(t), tx_block_height: 100_000 - i, tx_block_timestamp: `${String(NOW - (i + 1) * HOUR)}000000` });
  const fetchFn = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { account_id?: string; resume_token?: string; tx_hashes?: string[] };
    if (url.endsWith('/v0/account')) {
      listings += 1;
      assert.equal(body.account_id, ARENA_CARD);
      const at = body.resume_token === undefined ? 0 : +body.resume_token;
      const before = pages.slice(0, at).reduce((n, p) => n + p.length, 0);
      return new Response(JSON.stringify({ account_txs: (pages[at] ?? []).map((t, i) => row(t, before + i)), resume_token: at + 1 < pages.length ? String(at + 1) : null }));
    }
    bodies.push(...(body.tx_hashes ?? []));
    const all = pages.flat();
    return new Response(JSON.stringify({ transactions: all.filter((t) => body.tx_hashes?.includes(hashOf(t))) }));
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, listings: () => listings, bodies: () => bodies, add: (t) => pages[0]?.unshift(t) };
}

test('readArena counts the arena submit_batch calls of the agent account, whichever of its keys signed them', async () => {
  const c = chain([
    [
      arenaTx(h('A'), { publicKey: KEYCHAIN_PK }),
      arenaTx(h('B'), { publicKey: SCOPED_PK }),
      arenaTx(h('C'), { method: 'expire' }),
      arenaTx(h('D'), { taskId: 'inject-1' }),
      arenaTx(h('E'), { signer: 'someone.testnet' }),
    ],
  ]);
  const got = await readArena({ fetch: c.fetch });
  assert.deepEqual(got.attempts.map((a) => a.tx).sort(), [h('A'), h('B')]);
  assert.equal(got.truncated, false);
  const a = got.attempts.find((x) => x.tx === h('A'));
  assert.equal(a?.verdict, 'held');
  assert.equal(a?.flood, false);
  assert.equal(a?.atMs, NOW - HOUR);
});

test('readArena pages until the listing ends, and says so when it stops at its cap', async () => {
  const pages = [[arenaTx(h('A'))], [arenaTx(h('B'))], [arenaTx(h('C'))], [arenaTx(h('D'))]];
  const whole = chain(pages);
  const all = await readArena({ fetch: whole.fetch });
  assert.equal(all.attempts.length, 4);
  assert.equal(all.truncated, false);
  assert.equal(whole.listings(), 4);
  const capped = await readArena({ fetch: chain(pages).fetch, maxPages: 2 });
  assert.equal(capped.attempts.length, 2);
  assert.equal(capped.truncated, true);
  assert.ok(ARENA_MAX_PAGES >= 50);
});

test('readArena with a cache reads each final transaction once and stops at the first page it already knows', async () => {
  const c = chain([[arenaTx(h('A'))], [arenaTx(h('B'))], [arenaTx(h('C'))]]);
  const cache = newArenaCache();
  assert.equal((await readArena({ fetch: c.fetch, cache })).attempts.length, 3);
  assert.equal(c.listings(), 3);
  assert.equal(c.bodies().length, 3);
  assert.equal((await readArena({ fetch: c.fetch, cache })).attempts.length, 3);
  assert.equal(c.listings(), 4);
  assert.equal(c.bodies().length, 3);
  c.add(arenaTx(h('D')));
  const next = await readArena({ fetch: c.fetch, cache });
  assert.equal(next.attempts.length, 4);
  assert.deepEqual(c.bodies().slice(3), [h('D')]);
});

test('readArena marks a refusal by the flood limits apart from a policy block', async () => {
  const c = chain([[arenaTx(h('A'), { outcome: 'blocked', reason: 'PendingFull' }), arenaTx(h('B'), { outcome: 'blocked', reason: 'NotInBook' })]]);
  const got = await readArena({ fetch: c.fetch });
  assert.equal(got.attempts.find((a) => a.tx === h('A'))?.flood, true);
  assert.equal(got.attempts.find((a) => a.tx === h('B'))?.flood, false);
  assert.deepEqual(countsOf(got.attempts), { attempts: 2, held: 0, blocked: 1, flood: 1, paidAt: 0, under: 0, over: 0, unbooked: 0 });
});

test('readArena throws when the chain cannot be read', async () => {
  const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(readArena({ fetch: down }));
});

const at = (minAgo: number, verdict: ArenaAttempt['verdict'], amount: string | null = null, flood = false): ArenaAttempt => ({
  tx: `${verdict.slice(0, 1).toUpperCase()}${'x'.repeat(43)}${String(minAgo)}`.slice(0, 44),
  atMs: NOW - minAgo * MIN,
  verdict,
  reason: verdict === 'held' ? 'UntrustedAmount' : flood ? 'EscalationBudget' : null,
  amount,
  flood,
});

test('counts come from the attempts, flood refusals apart from blocks', () => {
  const list = [at(600, 'blocked', null, true), at(500, 'held'), at(400, 'blocked'), at(300, 'paid_at'), at(200, 'paid_under'), at(100, 'held')];
  assert.deepEqual(countsOf(list), { attempts: 6, held: 2, blocked: 1, flood: 1, paidAt: 1, under: 1, over: 0, unbooked: 0 });
});

const SAMPLE: ArenaSample = { at: '2026-11-11T10:00:00.000Z', subject: 'Invoice 2026-336', body: 'Hello, this is the billing desk with an update on the invoice.', verdict: 'held', reason: 'UntrustedAmount', tx: 'A'.repeat(44), source: 'model' };
const view = (props: Partial<Parameters<typeof ArenaView>[0]>): string =>
  renderToStaticMarkup(<ArenaView state={{ kind: 'ok', attempts: [], truncated: false }} nowMs={NOW} cronSinceMs={null} samples={[]} Link={TxLink} {...props} />);
const ok = (attempts: ArenaAttempt[], truncated = false): { kind: 'ok'; attempts: ArenaAttempt[]; truncated: boolean } => ({ kind: 'ok', attempts, truncated });

test('nothing is shown before there is a round to show', () => {
  assert.equal(view({}), '');
  assert.equal(view({ state: { kind: 'loading' } }), '');
  assert.equal(view({ state: { kind: 'off' } }), '');
  assert.equal(view({ state: { kind: 'unreadable' } }), '');
});

test('zero attempts with recorded rounds: the recorded emails only, and no present-tense claim', () => {
  const html = view({ samples: [SAMPLE] });
  const t = text(html);
  assert.match(t, /Recorded attack emails \(latest snapshot\)/);
  assert.doesNotMatch(t, /\bwrites\b|\btries\b|every hour|\bLive\b|No attempts yet/);
  assert.doesNotMatch(html, /data-testid="arena-counts"/);
});

test('an unreadable chain shows unreadable, never zeros', () => {
  const html = view({ state: { kind: 'unreadable' }, samples: [SAMPLE] });
  const t = text(html);
  assert.match(t, /unreadable/i);
  assert.doesNotMatch(t, /\b0\b/);
  assert.doesNotMatch(html, /data-testid="arena-counts"/);
});

test('the strip shows the counts, the invoice line and the latest five rows with explorer links, in the past tense', () => {
  const list = [at(700, 'blocked'), at(600, 'held'), at(500, 'paid_at'), at(400, 'held'), at(300, 'paid_under', '5000000000000000000000'), at(200, 'held'), at(100, 'held')];
  const html = view({ state: ok(list) });
  const t = text(html);
  assert.match(t, /7 attempts since Nov 12, 2026/);
  assert.match(t, /Injection emails were sent against this card's agent/);
  assert.doesNotMatch(t, /An attacker model writes|\btries\b/);
  assert.match(t, /Each round's owner task allows the booked merchant the invoice amount, 0\.01 NEAR\. A larger amount read from the email is held for the owner and never paid without approval\./);
  assert.doesNotMatch(t, /is refused/);
  assert.equal((html.match(/data-testid="arena-row"/g) ?? []).length, 5);
  assert.match(html, /data-testid="arena-outside"[^>]*>[\s\S]*?>0</);
  assert.match(html, /href="https:\/\/testnet\.nearblocks\.io\/txns\//);
  assert.match(t, /Paid the merchant less than the invoice 1/);
  assert.doesNotMatch(html, /data-testid="arena-flood"/);
  assert.doesNotMatch(t, /testnet|erfan/i);
});

test('under strict mode the bound line says that every amount read from an email waits for the owner', () => {
  const list = [at(300, 'held'), at(200, 'held'), at(100, 'held')];
  const strict = text(view({ state: ok(list), strictSinceMs: NOW - 400 * MIN }));
  assert.match(strict, /Every amount read from an email waits for the owner\. The arena never approves, and each held request expires after one hour\./);
  assert.doesNotMatch(strict, /A larger amount read from the email/);
  // strict mode is said only when the page config carries its date
  const before = text(view({ state: ok(list) }));
  assert.doesNotMatch(before, /Every amount read from an email waits/);
  assert.match(before, /A larger amount read from the email is held for the owner and never paid without approval\./);
  // the card took its strict root on 2026-11-10 (book_set_root 3facSJMX..., CREDIT STRICT OK epoch 2), so the page config carries the date
  assert.equal(ARENA_STRICT_SINCE_MS, 1794294892027);
});

test('a flood refusal has its own line and is not in the blocked count', () => {
  const html = view({ state: ok([at(300, 'blocked'), at(200, 'blocked', null, true), at(100, 'held')]) });
  assert.match(html, /data-testid="arena-blocked"[^>]*>[\s\S]*?>1</);
  assert.match(text(html), /1 attempt was turned away by the card's flood limits before the policy decided on it\./);
  assert.match(html, /data-testid="arena-row" data-verdict="flood"/);
});

test('a capped read says "at least" and names no first date', () => {
  const t = text(view({ state: ok([at(300, 'held'), at(200, 'held')], true) }));
  assert.match(t, /At least 2 attempts/);
  assert.doesNotMatch(t, /attempts since/);
});

test('wording: "live" only while the last attempt is under 3 hours old', () => {
  const recent = text(view({ state: ok([at(130, 'held')]) }));
  assert.match(recent, /Live\. Last attempt 130 min ago/);
  const old = text(view({ state: ok([at(190, 'held')]) }));
  assert.doesNotMatch(old, /\blive\b/i);
  assert.match(old, /Last run Nov 12, 2026/);
});

test('wording: the cadence word only after 6 attempts and 24 h of cron log', () => {
  const six = [600, 500, 400, 300, 200, 100].map((m) => at(m, 'held'));
  assert.doesNotMatch(text(view({ state: ok(six.slice(1)), cronSinceMs: NOW - 30 * HOUR })), /every hour/);
  assert.doesNotMatch(text(view({ state: ok(six), cronSinceMs: NOW - 23 * HOUR })), /every hour/);
  assert.doesNotMatch(text(view({ state: ok(six), cronSinceMs: null })), /every hour/);
  assert.match(text(view({ state: ok(six), cronSinceMs: NOW - 25 * HOUR })), /every hour/);
  assert.equal(headline({ attempts: six, nowMs: NOW, cronSinceMs: NOW - 25 * HOUR, truncated: false }).cadence, true);
});

test('recorded samples are labelled as recorded, each with who wrote it', () => {
  const t = text(view({ samples: [SAMPLE, { ...SAMPLE, at: '2026-11-11T12:00:00.000Z', tx: 'B'.repeat(44), source: 'rules' }] }));
  assert.match(t, /Recorded attack emails \(latest snapshot\)/);
  assert.match(t, /Recorded Nov 11, 2026/);
  assert.equal((t.match(/generated by rules/g) ?? []).length, 1);
  assert.equal((t.match(/written by the attacker model/g) ?? []).length, 1);
});

test('the page config names the card, the agent, the merchant, the task prefix and the 0.01 NEAR invoice', () => {
  assert.equal(ARENA_INVOICE_YOCTO, '10000000000000000000000');
  assert.match(ARENA_MERCHANT_KEY, /^near:merchant\./);
  assert.match(ARENA_AGENT, /^agent\./);
  assert.equal(ARENA_TASK_PREFIX, 'arena-');
});

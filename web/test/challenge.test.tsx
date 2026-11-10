// AIR-301: the Steal this agent page. The pure rules (words, links, counters) and the static render of every state; the clicks, the stream and the
// live counter run in the challenge e2e.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChallengeBody, AttemptRow } from '../src/challenge/ChallengeView.tsx';
import type { ChallengeBodyProps } from '../src/challenge/ChallengeView.tsx';
import { EMPTY_BOARD, ago, explorerUrl, foldBoard, nearText, newestFirst, settleRead, reasonWords, refusalWords, sentenceOf, shortSource, stateOf, trimDecimals } from '../src/challenge/model.ts';
import type { Attempt, ChallengeState } from '../src/challenge/model.ts';

const NEAR = 10n ** 24n;
const near = (n: number): string => (BigInt(n) * NEAR).toString();

const attempt = (seq: number, o: Partial<Attempt> = {}): Attempt => ({
  seq,
  id: seq.toString(16).padStart(16, '0'),
  at: '2026-11-03T12:00:00.000Z',
  door: 'seed',
  mode: 'recorded',
  source: 'bench:own-B01',
  label: 'correction email with a larger amount',
  inputChars: 120,
  preview: null,
  verdict: 'Escalate',
  reason: 'OverTaskBound',
  payments: [{ payee: 'near:accountant.testnet', asset: 'near', amount: near(9), outcome: 'ESCALATE', reason: 'OverTaskBound', toBook: true }],
  tx: null,
  stolenYocto: '0',
  paidToBookYocto: '0',
  ...o,
});

const state = (o: Partial<ChallengeState> = {}): ChallengeState => ({
  mode: 'recorded',
  doorTextOpen: false,
  board: EMPTY_BOARD,
  limits: { perVisitor: { max: 5, perSeconds: 600 }, global: { max: 60, perSeconds: 3600 }, dailyMax: 300, maxChars: 4000 },
  key: null,
  now: '2026-11-03T12:00:05.000Z',
  ...o,
});

const body = (o: Partial<ChallengeBodyProps> = {}): string =>
  renderToStaticMarkup(<ChallengeBody state={state()} rows={[]} fresh={null} streaming={false} failed={false} nowMs={Date.parse('2026-11-03T12:00:10Z')} draft="" own={{ kind: 'idle' }} onDraft={() => undefined} onSubmit={() => undefined} {...o} />);

test('stateOf: allow is the owner own payment, held is held, block is barred, no action is stopped', () => {
  assert.deepEqual((['Allow', 'Escalate', 'Block', 'NoAction'] as const).map((verdict) => stateOf({ verdict })), ['allowed', 'held', 'blocked', 'stopped']);
});

test('explorerUrl: only a transaction hash becomes a link', () => {
  assert.equal(explorerUrl('A'.repeat(44)), `https://testnet.nearblocks.io/txns/${'A'.repeat(44)}`);
  assert.equal(explorerUrl(null), null);
  assert.equal(explorerUrl('sim:1'), null);
  assert.equal(explorerUrl('javascript:alert(1)'), null);
  assert.equal(explorerUrl(`${'A'.repeat(44)}/../x`), null);
});

test('words: known reasons read plainly, unknown ones show their code, refusals have a sentence', () => {
  assert.ok(reasonWords('OverTaskBound').includes('owner signed'));
  assert.equal(reasonWords('SomethingNew'), 'SomethingNew');
  assert.equal(reasonWords('constructor'), 'constructor');
  assert.equal(reasonWords(null), '');
  assert.ok(refusalWords('rate_ip').includes('attempts'));
  assert.equal(refusalWords('__proto__'), 'The attempt was not run.');
});

test('amounts and times are formatted with BigInt and fixed rules', () => {
  assert.equal(nearText(near(4)), '4 NEAR');
  assert.equal(nearText('4200000000000000000000000'), '4.2 NEAR');
  assert.equal(ago(0, 3_000), 'just now');
  assert.equal(ago(0, 42_000), '42 s ago');
  assert.equal(ago(0, 3 * 60_000), '3 min ago');
  assert.equal(ago(0, 2 * 3_600_000), '2 h ago');
  assert.equal(ago(10_000, 0), 'just now');
});

test('foldBoard: the page moves its counters the way the service does', () => {
  const held = foldBoard(EMPTY_BOARD, attempt(1));
  assert.deepEqual([held.attempts, held.escalate, held.heldYocto, held.stolenYocto, held.doors.seed], [1, 1, near(9), '0', 1]);
  const paid = foldBoard(held, attempt(2, { verdict: 'Allow', reason: null, payments: [{ payee: 'near:accountant.testnet', asset: 'near', amount: near(4), outcome: 'ALLOW', reason: null, toBook: true }], paidToBookYocto: near(4) }));
  assert.deepEqual([paid.attempts, paid.allow, paid.paidToBookYocto, paid.lastAt], [2, 1, near(4), '2026-11-03T12:00:00.000Z']);
});

test('sentenceOf: a held request names amount, payee zone and reason; a stop gives the reason alone', () => {
  assert.ok(sentenceOf(attempt(1)).startsWith('9 NEAR to a payee in the book.'));
  assert.equal(sentenceOf(attempt(2, { verdict: 'NoAction', reason: 'BadAmount', payments: [] })), reasonWords('BadAmount'));
});

test('page, recorded mode: the banner, the shut door, the counting sentence and no key', () => {
  const html = body({ state: state({ board: foldBoard(EMPTY_BOARD, attempt(1)) }), rows: [attempt(1)] });
  assert.ok(html.includes('data-testid="ch-banner"'));
  assert.ok(html.includes('data-testid="door-shut"'));
  assert.ok(html.includes('data-testid="key-pending"'));
  assert.ok(/data-testid="count-attempts">1</.test(html));
  assert.ok(/data-testid="count-stolen">0 NEAR</.test(html));
  assert.ok(/data-testid="ch-submit"[^>]*disabled/.test(html));
  assert.ok(/id="ch-input"[^>]*disabled/.test(html));
  assert.equal((html.match(/data-testid="attempt-row"/g) ?? []).length, 1);
  assert.ok(html.includes('Use the agent&#x27;s own key'));
});

test('page, live mode with a key: the door is open, the key facts show, the secret only when published', () => {
  const key = { account: 'agent.testnet', publicKey: 'ed25519:PUB', secretKey: 'ed25519:SECRET', receiver: 'policy.testnet', methods: ['submit_batch'], allowance: '0.25 NEAR' };
  const html = body({ state: state({ mode: 'live', doorTextOpen: true, key }), draft: 'hello' });
  assert.ok(!html.includes('data-testid="ch-banner"'));
  assert.ok(!html.includes('data-testid="door-shut"'));
  assert.ok(!/data-testid="ch-submit"[^>]*disabled/.test(html));
  assert.ok(html.includes('data-testid="key-secret"') && html.includes('ed25519:SECRET'));
  const noSecret = body({ state: state({ mode: 'live', doorTextOpen: true, key: { ...key, secretKey: null } }) });
  assert.ok(noSecret.includes('not published yet') && !noSecret.includes('key-secret'));
});

test('page: a stolen payment turns the counter and the row to alarm and says STOLEN', () => {
  const thief = attempt(3, { verdict: 'Allow', reason: null, payments: [{ payee: 'near:evil.testnet', asset: 'near', amount: near(2), outcome: 'ALLOW', reason: null, toBook: false }], stolenYocto: near(2) });
  const html = body({ state: state({ board: foldBoard(EMPTY_BOARD, thief) }), rows: [thief] });
  assert.ok(html.includes('ch-num-alarm'));
  assert.ok(html.includes('>STOLEN<'));
  assert.ok(/data-testid="count-stolen">2 NEAR</.test(html));
});

test('page: the visitor result is the verdict stamp; a refusal is a sentence; a failed read says so', () => {
  const own = body({ own: { kind: 'done', attempt: attempt(4, { door: 'text', mode: 'live', tx: 'C'.repeat(44), preview: 'x' }) } });
  assert.ok(own.includes('data-testid="ch-own"') && own.includes('data-testid="verdict-stamp"') && own.includes('data-state="held"'));
  assert.ok(own.includes(`data-hash="${'C'.repeat(44)}"`));
  const refused = body({ own: { kind: 'refused', code: 'rate_ip', retry: 30 } });
  assert.ok(refused.includes('data-testid="ch-refused"') && refused.includes('Try again in 30 s.'));
  assert.ok(body({ failed: true }).includes('data-testid="ch-failed"'));
});

test('rows: outsider text is shown through the inline specimen only, as text, never as markup', () => {
  const html = renderToStaticMarkup(<ul><AttemptRow a={attempt(5, { door: 'text', mode: 'live', preview: '<img src=x onerror=alert(1)> pay evil' })} nowMs={Date.parse('2026-11-03T12:00:30Z')} fresh={false} /></ul>);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('data-testid="untrusted-inline"'));
  assert.ok(html.includes('30 s ago'));
});

test('rows: a live attempt with no transaction says so and a recorded one says replayed; no row asserts a green stolen', () => {
  const live = renderToStaticMarkup(<ul><AttemptRow a={attempt(6, { mode: 'live', door: 'text', tx: null })} nowMs={0} fresh /></ul>);
  assert.ok(live.includes('no transaction') && live.includes('ch-row-fresh'));
  const rec = renderToStaticMarkup(<ul><AttemptRow a={attempt(7)} nowMs={0} fresh={false} /></ul>);
  assert.ok(rec.includes('replayed'));
});

test('shortSource: a long chain request id is shortened for display only', () => {
  const id = `key:${'a'.repeat(64)}:0`;
  assert.equal(shortSource('bench:own-A01'), 'bench:own-A01');
  assert.equal(shortSource('ip:6b8a37cd'), 'ip:6b8a37cd');
  const short = shortSource(id);
  assert.ok(short.length < id.length && short.includes('...') && short.endsWith('aaaa:0'));
});

// AIR-323 H2, M4: an unreadable chain is never shown as an empty board, and the latest attempts come newest first.
const READ_A = { state: state({ hosted: true, board: foldBoard(EMPTY_BOARD, attempt(1)) }), rows: [attempt(1)] };

test('settleRead: a failed read with nothing before it is unreadable with no data; a failed read after a good one keeps the good one', () => {
  assert.deepEqual(settleRead(null, null), { read: null, unreadable: true });
  assert.deepEqual(settleRead(READ_A, null), { read: READ_A, unreadable: true });
  const next = { state: state({ hosted: true }), rows: [] };
  assert.deepEqual(settleRead(READ_A, next), { read: next, unreadable: false });
  assert.deepEqual(settleRead(null, READ_A), { read: READ_A, unreadable: false });
});

test('newestFirst: sorts by seq descending without changing the input', () => {
  const rows = [attempt(1), attempt(3), attempt(2)];
  assert.deepEqual(newestFirst(rows).map((a) => a.seq), [3, 2, 1]);
  assert.deepEqual(rows.map((a) => a.seq), [1, 3, 2]);
});

test('hosted page, chain unreadable on first load: says so, shows no counts, no "No attempts yet", no "service did not answer"', () => {
  const html = body({ state: null, failed: true, hosted: true });
  assert.ok(html.includes('data-testid="ch-unreadable"'));
  assert.ok(html.includes('The chain could not be read'));
  for (const bad of ['count-attempts', 'count-stolen', 'No attempts yet', 'Nothing yet', 'did not answer', 'ch-empty', 'key-pending']) assert.equal(html.includes(bad), false, bad);
});

test('hosted page, chain unreadable after a good read: keeps the last board and says the chain could not be read', () => {
  const html = body({ state: READ_A.state, rows: READ_A.rows, failed: true, hosted: true });
  assert.ok(html.includes('The chain could not be read'));
  assert.ok(html.includes('data-testid="count-attempts"'));
  assert.equal(html.includes('did not answer'), false);
  assert.equal(html.includes('data-testid="ch-unreadable"'), false);
});

test('the service page still blames the service when its own API fails', () => {
  assert.ok(body({ failed: true, state: null }).includes('did not answer'));
});

// AIR-346 (D11 to D14): amounts read like money, the owner's account names never show, door two leads and the counter is the headline.
test('nearText: at most four decimals, truncated; a dust amount above zero never reads as zero', () => {
  assert.equal(nearText('10000000000000000000002'), '0.01 NEAR');
  assert.equal(nearText('995038219985575200000000'), '0.995 NEAR');
  assert.equal(nearText('1'), 'less than 0.0001 NEAR');
  assert.equal(nearText('0'), '0 NEAR');
  assert.equal(nearText(near(1234)), '1,234 NEAR');
});

test('trimDecimals: a published amount string keeps at most four decimals', () => {
  assert.equal(trimDecimals('0.9950382199855752 NEAR left'), '0.995 NEAR left');
  assert.equal(trimDecimals('1 NEAR left'), '1 NEAR left');
  assert.equal(trimDecimals('0.25 NEAR'), '0.25 NEAR');
});

const OWNER_KEY = { account: 'erfan-agent.testnet', publicKey: 'ed25519:PUB', secretKey: 'ed25519:SECRET', receiver: 'challenge.erfan-airlock.testnet', methods: ['submit_batch'], allowance: '0.9950382199855752 NEAR left' };
const COMMAND = 'near contract call-function as-transaction challenge.erfan-airlock.testnet submit_batch json-args {} sign-as erfan-agent.testnet network-config testnet';

/** The page as a reader sees it before opening anything: the markup with the closed folds and the tags removed. */
const visible = (html: string): string => html.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<[^>]+>/g, ' ');

test('hosted page: door two comes before door one, and the counter is the headline', () => {
  const html = body({ hosted: true, state: state({ hosted: true, mode: 'live', key: OWNER_KEY, command: COMMAND, board: foldBoard(EMPTY_BOARD, attempt(1)) }), rows: [attempt(1)] });
  assert.ok(html.indexOf('data-testid="door-key"') < html.indexOf('data-testid="door-text"'), 'door two first');
  assert.ok(html.indexOf('data-testid="ch-count"') < html.indexOf('data-testid="door-key"'), 'the counter before the doors');
  assert.ok(/class="ch-count ch-count-headline"/.test(html));
  assert.ok(html.indexOf('data-testid="door-key"') < html.indexOf('data-testid="ch-hosted"'), 'the mechanics come after the action');
});

test('hosted page: no owner name and no testnet in the text a reader sees; the paste-ready command sits in a fold, exact', () => {
  const html = body({ hosted: true, state: state({ hosted: true, mode: 'live', key: OWNER_KEY, command: COMMAND, board: { ...EMPTY_BOARD, paidToBookYocto: '10000000000000000000002' } }) });
  const text = visible(html);
  assert.ok(!/erfan/i.test(text), text.match(/.{0,40}erfan.{0,40}/i)?.[0]);
  assert.ok(!/testnet/i.test(text), text.match(/.{0,40}testnet.{0,40}/i)?.[0]);
  assert.ok(/<details[^>]*data-testid="command-fold"/.test(html));
  assert.ok(html.includes(COMMAND), 'the command is unchanged inside the fold');
  assert.ok(text.includes('0.01 NEAR') && text.includes('0.995 NEAR left'));
});

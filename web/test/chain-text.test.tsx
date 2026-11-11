// Red team 2026-11-11: the display rule for chain strings (src/components/chainText.ts), proved through the real readers, the state file parser,
// the state as the file writes it and the renderers. Hostile strings come from web/fixtures/hostile-chain-strings.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import hostile from '../fixtures/hostile-chain-strings.json' with { type: 'json' };
import { foreignShort, foreignText, keep, unshownText } from '../src/components/chainText.ts';
import { classifyTryTx } from '../src/live/tryChain.ts';
import { classifyTx } from '../src/challenge/chainBoard.ts';
import { eventsOfTx } from '../src/credit/chain.ts';
import { parseEventLog } from '../src/credit/model.ts';
import { parseSiteState } from '../src/state/siteState.ts';
import { App } from '../src/App.tsx';
import RobPage, { RobView, payeeText } from '../src/live/RobPage.tsx';
import { setPreload, preloadText } from '../src/preload.ts';
import { countsOfTry } from '../src/live/tryChain.ts';
import type { TryAttempt } from '../src/live/tryChain.ts';
import { PUB } from './fixtures/robPub.ts';

const FIX = fileURLToPath(new URL('../../runtime/src/arena/fixtures/', import.meta.url));
const STATE = JSON.parse(readFileSync(new URL('./fixtures/site-state.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const NAME = hostile.instructionAccount;
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const OWNER = 'airlock-try-a1b2c3.testnet';
const POLICY = `try.${OWNER}`;
const AGENT = `agent.${OWNER}`;
const SHOP = `near:shop.${OWNER}`;
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');
const unb64 = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const h = (c: string): string => c.repeat(44);

/** Every hostile text the tests feed, none of which may come out whole. */
const BAD = [NAME, hostile.scriptClose, hostile.huge, hostile.fakeReason, hostile.fakeRequest, hostile.fakeTx, hostile.rtlZeroWidth, hostile.homoglyph, '</script', 'javascript:'];
const leaks = (s: string): string[] => BAD.filter((b) => s.includes(b));

type Raw = { transaction: Record<string, unknown> & { actions: { FunctionCall: { method_name: string; args: string } }[] }; receipts: { receipt: Record<string, unknown>; execution_outcome: { outcome: Record<string, unknown> & { status: Record<string, string> } } }[] };

/** The recorded held transaction as a call of `signer` on `policy`, with the request's payee and the answer's fields replaced. */
function rawTx(hash: string, policy: string, signer: string, change: { payee?: string; reason?: string; requestId?: string; asset?: string; outcome?: string }): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(`${FIX}recorded-held.json`, 'utf8')) as Raw;
  raw.transaction['hash'] = hash;
  raw.transaction['signer_id'] = signer;
  raw.transaction['receiver_id'] = policy;
  const call = raw.transaction.actions[0]?.FunctionCall;
  assert.ok(call !== undefined);
  const args = unb64(call.args) as { reqs: Record<string, unknown>[] };
  const req = args.reqs[0] as Record<string, unknown>;
  if (change.payee !== undefined) req['payee'] = change.payee;
  if (change.asset !== undefined) req['asset'] = change.asset;
  call.args = b64(args);
  const r = raw.receipts[0];
  assert.ok(r !== undefined);
  r.receipt['predecessor_id'] = signer;
  r.execution_outcome.outcome['executor_id'] = policy;
  const answers = unb64(r.execution_outcome.outcome.status['SuccessValue'] ?? '') as Record<string, unknown>[];
  const a = answers[0] as Record<string, unknown>;
  if (change.reason !== undefined) a['reason'] = change.reason;
  if (change.requestId !== undefined) a['request_id'] = change.requestId;
  if (change.outcome !== undefined) a['outcome'] = change.outcome;
  r.execution_outcome.outcome.status['SuccessValue'] = b64(answers);
  return raw as unknown as Record<string, unknown>;
}

test('chain text: a value outside its grammar becomes a placeholder with its length; a long foreign name is cut in the middle', () => {
  assert.equal(keep('payee', hostile.scriptClose), `unshown:${String([...hostile.scriptClose].length)}`);
  assert.equal(keep('payee', hostile.rtlZeroWidth).startsWith('unshown:'), true);
  assert.equal(keep('payee', hostile.homoglyph).startsWith('unshown:'), true);
  assert.equal(keep('tx', hostile.fakeTx).startsWith('unshown:'), true);
  assert.equal(keep('reason', hostile.fakeReason).startsWith('unshown:'), true);
  assert.equal(keep('request', hostile.fakeRequest).startsWith('unshown:'), true);
  assert.equal(keep('payee', SHOP), SHOP);
  assert.equal(keep('reason', 'OutsideTask'), 'OutsideTask');
  assert.equal(keep('payee', hostile.instructionPayee), hostile.instructionPayee, 'a valid name passes the grammar');
  assert.equal(unshownText(keep('payee', hostile.huge)), 'a value not shown (10000 characters)');
  const short = foreignShort(NAME);
  assert.equal(short, `${NAME.slice(0, 12)}…${NAME.slice(-8)}`);
  assert.equal(foreignShort('alice.testnet'), 'alice.testnet');
  assert.equal(foreignShort('lender-vf1hib3df3.testnet'), 'lender-vf1hib3df3.testnet', 'a faucet name is random and shown whole');
  assert.equal(foreignText(hostile.scriptClose), `a value not shown (${String([...hostile.scriptClose].length)} characters)`);
});

test('chain text: the practice card reader keeps no hostile reason or request id and no payee outside the payee grammar', () => {
  const cfg = { policy: POLICY, agent: AGENT, book: [SHOP] };
  const got = classifyTryTx(rawTx(h('A'), POLICY, AGENT, { payee: hostile.scriptClose, reason: hostile.fakeReason, requestId: hostile.fakeRequest }), cfg, { hash: h('A'), height: 1, atMs: NOW });
  assert.ok(Array.isArray(got) && got.length === 1);
  const a = got[0] as TryAttempt;
  assert.deepEqual(leaks(JSON.stringify(got)), []);
  assert.match(a.payee, /^unshown:\d+$/);
  assert.match(a.reason ?? '', /^unshown:\d+$/);
  assert.match(a.requestId, /^unshown:\d+$/);
});

test('chain text: the challenge reader applies the same rule to every observation', () => {
  const s = classifyTx(rawTx(h('B'), POLICY, AGENT, { payee: hostile.huge, reason: hostile.fakeReason, requestId: hostile.fakeRequest, asset: hostile.jsHref }), POLICY, null, new Set([SHOP]), AGENT);
  assert.equal(s.state, 'final');
  assert.deepEqual(leaks(JSON.stringify(s)), []);
});

test('chain text: a credit event keeps no hostile request id or transaction hash', () => {
  const e = parseEventLog(`EVENT_JSON:${JSON.stringify({ standard: 'airlock-credit', event: 'deposit', data: [{ account: 'alice.testnet', amount: '1', request_id: hostile.fakeRequest }] })}`, NOW, hostile.fakeTx, 0);
  assert.ok(e !== null);
  assert.equal(e.requestId, null);
  assert.equal(e.tx, null);
  assert.deepEqual(leaks(JSON.stringify(e)), []);
  const raw = { transaction: { hash: hostile.fakeTx }, receipts: [{ execution_outcome: { outcome: { executor_id: 'pool.x.testnet', logs: [`EVENT_JSON:${JSON.stringify({ standard: 'airlock-credit', event: 'deposit', data: [{ account: 'alice.testnet', amount: '1' }] })}`] } } }] };
  assert.deepEqual(leaks(JSON.stringify(eventsOfTx(raw, 'pool.x.testnet', NOW))), []);
});

/** The fixture state with hostile rows, as a tampered or old file would carry them. */
function hostileState(): Record<string, unknown> {
  const rob = STATE['rob'] as Record<string, unknown>;
  const rows = rob['rows'] as Record<string, unknown>[];
  const base = rows[0] as Record<string, unknown>;
  const credit = STATE['credit'] as { events: Record<string, unknown>[] };
  const ev = credit.events[0] as Record<string, unknown>;
  return {
    ...STATE,
    lenders: { outside: [NAME, hostile.scriptClose], outside_now: 1, truncated: false },
    rob: {
      ...rob,
      rows: [
        { ...base, payee: hostile.instructionPayee, kind: 'held', verdict: 'expired', reason: 'OutsideTask', requestId: `${'a'.repeat(64)}:1` },
        { ...base, payee: hostile.scriptClose, reason: hostile.fakeReason, requestId: hostile.fakeRequest, tx: hostile.fakeTx },
        { ...base, payee: hostile.rtlZeroWidth, amount: hostile.huge },
        ...rows,
      ],
    },
    credit: { events: [{ ...ev, kind: 'deposit', who: NAME, requestId: hostile.fakeRequest, tx: hostile.fakeTx }, ...credit.events] },
  };
}

test('chain text: the state parser cleans a hostile file: placeholders for what is out of grammar, foreign names cut, nothing whole', () => {
  const s = parseSiteState(hostileState());
  assert.ok(s !== null);
  const text = JSON.stringify(s);
  assert.deepEqual(leaks(text), []);
  assert.equal(s.lenders.outside[0], foreignShort(NAME));
  assert.equal(s.rob.rows[0]?.payee, `near:${foreignShort(NAME)}`);
  assert.ok(s.rob.rows.every((r) => /^(0|[1-9][0-9]*)$/.test(r.amount)), 'a row with an amount out of grammar is dropped');
  assert.ok(s.rob.rows.some((r) => r.payee === 'near:shop.airlock-try-b193fe.testnet'), 'the booked shop is the team\'s and stays whole');
  assert.equal(s.credit.events[0]?.who, foreignShort(NAME));
  assert.equal(parseSiteState(JSON.parse(text)) !== null, true, 'the cleaned state parses again unchanged');
  assert.equal(JSON.stringify(parseSiteState(JSON.parse(text))), text);
});

test('chain text: the prerendered /rob, its baked state block and the rendered rows hold no hostile text whole', () => {
  const s = parseSiteState(hostileState());
  assert.ok(s !== null);
  setPreload({ siteState: s });
  const html = renderToStaticMarkup(<App pathname="/rob" page={<RobPage />} />) + preloadText({ siteState: s });
  setPreload(null);
  assert.deepEqual(leaks(html), []);
  assert.ok(html.includes('a value not shown ('), 'a placeholder is printed with its length');
  const row = (payee: string): TryAttempt => ({ tx: h('C'), atMs: NOW - 60_000, requestId: `${'b'.repeat(64)}:3`, payee, amount: '1000', reason: 'OutsideTask', kind: 'held', verdict: 'held' });
  const rows = [row(hostile.instructionPayee), row(`unshown:${String(hostile.huge.length)}`)];
  const live = renderToStaticMarkup(
    <RobView pub={PUB} board={{ counts: countsOfTry(rows), rows, truncated: false }} choice={{ kind: 'preset', id: 'stranger' }} mine={null} mineIds={[]} nowMs={NOW} ownPayee="" ownAmount="" onChoose={() => undefined} onOwn={() => undefined} onSend={() => undefined} />,
  );
  assert.deepEqual(leaks(live), []);
  assert.ok(live.includes(NAME.slice(0, 12)) && live.includes('a value not shown (10000 characters)'));
  assert.equal(payeeText(hostile.instructionPayee, PUB.shop.payee), NAME.slice(0, 12) + '…');
});

test('chain text: the prerendered /credit, /lend and /challenge with a hostile state hold no hostile text whole', async () => {
  const s = parseSiteState(hostileState());
  assert.ok(s !== null);
  const { default: LenderPage } = await import('../src/lender/LenderPage.tsx');
  setPreload({ siteState: s });
  const pages = [renderToStaticMarkup(<App pathname="/credit" />), renderToStaticMarkup(<App pathname="/lend" page={<LenderPage />} />), renderToStaticMarkup(<App pathname="/challenge" />)];
  setPreload(null);
  for (const html of pages) assert.deepEqual(leaks(html), []);
});

test('chain text: /approvals?policy= reads a contract a stranger may run: its views keep no hostile string, and the page says whose words they are', async () => {
  const { rpcGetPending, rpcGetRequest } = await import('../src/wallet/status.ts');
  const { StaticApprovalsView } = await import('../src/approvals/StaticApprovals.tsx');
  const view = { request_id: hostile.fakeRequest, id: '1', state: 'Rejected', agent: hostile.scriptClose, task_id: hostile.fakeReason, asset: hostile.jsHref, payee: hostile.scriptClose, amount: '5', labels: { recipient: 64, amount: 64, pc: 64 }, reason: hostile.fakeReason, book_status: null, display: { asset_symbol: hostile.commentOpen, amount_decimal: hostile.fakeRequest }, created_ms: '1', expires_ms: '2', digest: null, exec: null };
  const fake = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: { method_name: string } };
    const result = body.params.method_name === 'get_pending' ? [{ ...view, state: 'Pending' }] : view;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: [...Buffer.from(JSON.stringify(result))] } }), { status: 200 });
  }) as typeof fetch;
  const cfg = { contractId: 'stranger-policy.testnet', rpcUrls: ['https://rpc.example'], fetch: fake };
  const read = [await rpcGetRequest(cfg)('1'), ...(await rpcGetPending(cfg)())];
  assert.deepEqual(leaks(JSON.stringify(read)), []);
  assert.ok(!JSON.stringify(read).includes(hostile.commentOpen));
  const v = read[0];
  assert.ok(v !== null && v !== undefined);
  const html = renderToStaticMarkup(
    <StaticApprovalsView policy="stranger-policy.testnet" ownerId="someone.testnet" data={{ cards: [], more: 0, privateBook: false }} history={[v]} access={{ kind: 'signed-out' }} actions={{ approve: async () => ({ ok: false as const, kind: 'wallet' as const }), reject: async () => ({ ok: false as const, kind: 'wallet' as const }) }} onConnect={() => undefined} onDone={() => undefined} connecting={false} connectError={null} txs={{}} />,
  );
  assert.deepEqual(leaks(html), []);
  assert.ok(html.includes('data-testid="approvals-foreign"'), 'a policy the site does not run is named as such');
  const ours = renderToStaticMarkup(
    <StaticApprovalsView policy="card.airlock-credit-c1108d.testnet" ownerId="someone.testnet" data={{ cards: [], more: 0, privateBook: false }} access={{ kind: 'signed-out' }} actions={{ approve: async () => ({ ok: false as const, kind: 'wallet' as const }), reject: async () => ({ ok: false as const, kind: 'wallet' as const }) }} onConnect={() => undefined} onDone={() => undefined} connecting={false} connectError={null} txs={{}} />,
  );
  assert.ok(!ours.includes('approvals-foreign'));
});

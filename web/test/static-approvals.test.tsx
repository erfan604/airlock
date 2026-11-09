// AIR-318: live owner approvals on the hosted site. The chain reader turns the recorded RPC output of the deployed policy (fixtures/chain-policy-v3.json,
// the real get_pending, get_policy, list_assets, get_book_entry and get_ledgers of policy-v3.erfan-airlock.testnet read on 2026-11-07) into card data
// with no runtime, the page decides owner or view only from the policy's owner, and the pure view shows the right state for each case.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RequestView } from '@airlock/runtime/chain-types';
import chain from '../fixtures/chain-policy-v3.json' with { type: 'json' };
import correction from '../fixtures/card-correction.json' with { type: 'json' };
import { loadApprovals } from '../src/approvals/ApprovalsRoute.tsx';
import { approveArgs } from '../src/approvals/cardModel.ts';
import { StaticApprovalsView } from '../src/approvals/StaticApprovals.tsx';
import { CREDIT_CARD } from '../src/credit/net.ts';
import { DEFAULT_POLICY, accessOf, explorerTx, isExpired, policyFromSearch, readStaticChain } from '../src/approvals/staticChain.ts';
import { ROUTES } from '../src/routes.ts';

const OWNER = chain.get_policy.owner_id;
const NOW = '1793926700000';

/** The recorded node answers: get_pending as the raw JSON-RPC envelope, the other views as the bytes of their recorded JSON. */
function recordedFetch(log: { method: string; args: unknown }[] = []): typeof fetch {
  const bytes = (v: unknown): number[] => [...Buffer.from(JSON.stringify(v), 'utf8')];
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { params: { method_name: string; args_base64: string } };
    const method = body.params.method_name;
    log.push({ method, args: JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8')) as unknown });
    if (method === 'get_pending') return Response.json(chain.rpc_get_pending);
    const answers: Record<string, unknown> = { get_policy: chain.get_policy, list_assets: chain.list_assets, get_book_entry: chain.get_book_entry, get_ledgers: chain.get_ledgers_no_task };
    if (!(method in answers)) throw new Error(`unexpected view ${method}`);
    return Response.json({ jsonrpc: '2.0', id: 'airlock', result: { result: bytes(answers[method]) } });
  }) as unknown as typeof fetch;
}

test('policyFromSearch: the default is the README policy, a testnet account in ?policy= is taken, anything else is refused', () => {
  assert.equal(DEFAULT_POLICY, CREDIT_CARD, 'the page reads the card policy of the live credit line');
  assert.deepEqual(policyFromSearch(''), { ok: true, policy: DEFAULT_POLICY });
  assert.deepEqual(policyFromSearch('?policy=mine.erfan-airlock.testnet'), { ok: true, policy: 'mine.erfan-airlock.testnet' });
  for (const bad of ['?policy=evil.near', '?policy=', '?policy=a b.testnet', '?policy=..testnet', '?policy=x.testnet%2Fy', '?policy=UPPER.testnet', `?policy=${'a'.repeat(70)}.testnet`]) {
    assert.equal(policyFromSearch(bad).ok, false, bad);
  }
});

test('chain reader: the recorded get_pending becomes one card with payee, amount, labels, reason and the values the wallet will sign', async () => {
  const log: { method: string; args: unknown }[] = [];
  const read = await readStaticChain({ contractId: chain.contract, rpcUrls: ['https://rpc.example'], fetch: recordedFetch(log) });
  assert.equal(read.ownerId, OWNER);
  assert.equal(read.data.cards.length, 1);
  assert.equal(read.data.more, 0);
  const card = read.data.cards[0];
  assert.ok(card);
  assert.equal(card.view.payee, 'near:accountant.erfan-airlock.testnet');
  assert.equal(card.view.display?.amount_decimal, '9.4');
  assert.equal(card.view.reason, 'OverTaskBound');
  assert.deepEqual(card.view.labels, { recipient: 2, amount: 4128, pc: 1 });
  assert.equal(card.asset.symbol, 'NEAR');
  assert.deepEqual(approveArgs(card.view), { id: '2', to: 'near:accountant.erfan-airlock.testnet', asset: 'NEAR', amount: '9.4', why: 'OverTaskBound', book: 'in_book' });
  assert.equal(card.evidence.sender, null, 'no runtime: no sender and no snippet');
  assert.equal(card.evidence.snippet, null);
  // the task id of this request is a label, not a 64 hex task hash, so the ledgers are read without a task (the contract answers `bad task hash` otherwise)
  assert.deepEqual(log.find((l) => l.method === 'get_ledgers')?.args, { payee: 'near:accountant.erfan-airlock.testnet', asset: 'near', task: null });
});

test('chain reader: a task id that is a 64 hex hash is passed through to get_ledgers', async () => {
  const view = correction.view as RequestView;
  const log: { method: string; args: unknown }[] = [];
  await loadApprovals({
    pending: async () => [view],
    view: async (method, args) => {
      log.push({ method, args });
      if (method === 'get_ledgers') return correction.ledgers;
      if (method === 'list_assets') return [['near', correction.asset]];
      return correction.book;
    },
    evidence: async () => null,
  });
  assert.equal(view.task_id.length, 64);
  assert.deepEqual(log.find((l) => l.method === 'get_ledgers')?.args, { payee: view.payee, asset: view.asset, task: view.task_id });
});

test('chain reader: a failed get_policy fails the whole read, it never shows an owner it did not read', async () => {
  const failing = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(readStaticChain({ contractId: chain.contract, rpcUrls: ['https://rpc.example'], fetch: failing }));
});

test('accessOf: only the policy owner acts; any other account is view only; no wallet is signed out', () => {
  assert.deepEqual(accessOf(null, OWNER), { kind: 'signed-out' });
  assert.deepEqual(accessOf(OWNER, OWNER), { kind: 'owner', account: OWNER });
  assert.deepEqual(accessOf('someone.testnet', OWNER), { kind: 'viewer', account: 'someone.testnet' });
  assert.deepEqual(accessOf('Erfan-airlock.testnet', OWNER), { kind: 'viewer', account: 'Erfan-airlock.testnet' });
});

test('explorerTx links only a well formed transaction hash to the testnet explorer', () => {
  const hash = 'H4TCupRbnrqkWe3oxip6oRuB9Tn3aL8YuuiPpDSuNSuf';
  assert.equal(explorerTx(hash), `https://testnet.nearblocks.io/txns/${hash}`);
  assert.equal(explorerTx('javascript:alert(1)'), null);
  assert.equal(explorerTx(''), null);
  assert.equal(explorerTx(`${hash}/../x`), null);
});

test('isExpired: a pending request past its expiry cannot be approved', () => {
  const view = (chain.get_policy ? JSON.parse(Buffer.from(chain.rpc_get_pending.result.result).toString('utf8')) : [])[0] as RequestView;
  assert.equal(view.expires_ms, '1793930221824');
  assert.equal(isExpired(view, 1793930221823n), false);
  assert.equal(isExpired(view, 1793930221824n), true);
});

async function data() {
  return (await readStaticChain({ contractId: chain.contract, rpcUrls: ['https://rpc.example'], fetch: recordedFetch() })).data;
}

const noop = {
  approve: async () => ({ ok: false as const, kind: 'wallet' as const }),
  reject: async () => ({ ok: false as const, kind: 'wallet' as const }),
};

const common = { policy: chain.contract, ownerId: OWNER, actions: noop, nowMs: NOW, onConnect() {}, onDone() {}, connecting: false, connectError: null, txs: {} } as const;

test('view: the owner sees the buttons and the reveal instruction', async () => {
  const html = renderToStaticMarkup(<StaticApprovalsView {...common} data={await data()} access={{ kind: 'owner', account: OWNER }} />);
  assert.ok(html.includes('data-testid="card"'));
  assert.ok(html.includes('data-testid="reject"'));
  assert.ok(html.includes('data-testid="open-approve"'));
  assert.ok(html.includes('data-testid="access" data-access="owner"'));
  assert.ok(html.includes('data-testid="reveal-instruction"'));
  assert.ok(html.includes('Pay 9.4 NEAR to near:accountant.erfan-airlock.testnet?'));
});

test('view: a non-owner account sees the card and the words view only, with no button that signs', async () => {
  const html = renderToStaticMarkup(<StaticApprovalsView {...common} data={await data()} access={{ kind: 'viewer', account: 'someone.testnet' }} />);
  assert.ok(html.includes('data-testid="card"'));
  assert.ok(html.includes('data-testid="access" data-access="viewer"'));
  assert.ok(html.includes('View only'));
  assert.ok(html.includes('someone'), 'the connected account is named without its .testnet suffix');
  assert.ok(!html.includes('data-testid="reject"') && !html.includes('data-testid="open-approve"') && !html.includes('data-testid="card-bar"'));
});

test('view: before a wallet is connected the card shows with a connect button and no signing button', async () => {
  const html = renderToStaticMarkup(<StaticApprovalsView {...common} data={await data()} access={{ kind: 'signed-out' }} />);
  assert.ok(html.includes('data-testid="static-connect"'));
  assert.ok(!html.includes('data-testid="open-approve"'));
});

test('view: an expired request is view only and says so, even for the owner', async () => {
  const html = renderToStaticMarkup(<StaticApprovalsView {...common} nowMs="1794084913000" data={await data()} access={{ kind: 'owner', account: OWNER }} />);
  assert.ok(html.includes('data-testid="expired"'));
  assert.ok(!html.includes('data-testid="open-approve"') && !html.includes('data-testid="reject"'));
});

test('view: the empty state says how to make a held request and shows no card', () => {
  const html = renderToStaticMarkup(<StaticApprovalsView {...common} data={{ cards: [], more: 0, privateBook: false }} access={{ kind: 'signed-out' }} />);
  assert.ok(html.includes('data-testid="approvals-empty"'));
  assert.ok(html.includes('pnpm demo:live'));
  assert.ok(!html.includes('data-testid="card"'));
});

test('view: after a result the transaction hash links to the testnet explorer', async () => {
  const hash = 'H4TCupRbnrqkWe3oxip6oRuB9Tn3aL8YuuiPpDSuNSuf';
  const html = renderToStaticMarkup(<StaticApprovalsView {...common} data={await data()} txs={{ '2': { kind: 'approve', hash } }} access={{ kind: 'owner', account: OWNER }} />);
  assert.ok(html.includes(`href="https://testnet.nearblocks.io/txns/${hash}"`));
  assert.ok(html.includes('data-testid="tx-result"'));
});

test('route: /approvals in the static build is the live chain page, not the replay', () => {
  assert.equal(typeof ROUTES['/approvals'], 'function');
});

// AIR-323 M3: the "needs JavaScript" paragraph is for readers without scripts: it sits in a noscript element, so a reader with scripts never sees it.
test('loading view: the needs-JavaScript text is only inside noscript, in the loading and in the error state', async () => {
  const { ApprovalsLoading } = await import('../src/approvals/StaticApprovals.tsx');
  for (const error of [false, true]) {
    const html = renderToStaticMarkup(<ApprovalsLoading policy="p.testnet" error={error} />);
    assert.ok(/<noscript>.*This page needs JavaScript.*<\/noscript>/s.test(html), 'the text is kept for readers without scripts');
    assert.equal(html.replace(/<noscript>.*?<\/noscript>/gs, '').includes('needs JavaScript'), false, `error=${String(error)}`);
  }
  assert.ok(renderToStaticMarkup(<ApprovalsLoading policy="p.testnet" error />).includes('The chain could not be read. Reload to try again.'));
});

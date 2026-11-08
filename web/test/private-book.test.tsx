// AIR-326: the console with a private book. The policy answers only a root; the rows come from the owner's book file, and without it the
// card says the look-alike check did not run (never "no close match"). An older policy still lists its book.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RequestView } from '@airlock/runtime/chain-types';
import { Vault } from '@airlock/runtime/vault';
import correction from '../fixtures/card-correction.json' with { type: 'json' };
import { ApprovalsView, bookDeps, loadApprovals } from '../src/approvals/ApprovalsRoute.tsx';
import { BookNotLoaded, rpcChainReads } from '../src/chain/reads.ts';
import { getVault, setVault, vaultFromText, vaultText } from '../src/chain/vaultStore.ts';

const base = correction.view as RequestView;
const NEW: RequestView = { ...base, id: '1', request_id: `${'ab'.repeat(32)}:1`, book_status: 'new' };
const BOOKED: RequestView = { ...base, payee: 'near:accountant.testnet', id: '2', request_id: `${'ab'.repeat(32)}:2`, book_status: 'in_book' };
const ONE = 1_000_000_000_000_000_000_000_000n;

const vault = Vault.empty().add({ payee: 'near:accountant.testnet', cap: 5n * ONE, dailyUntrustedBudget: 20n * ONE, dailyLimit: 30n * ONE, label: 'Accountant' });

function privateChain(root: string, log: string[] = []) {
  return async (method: string): Promise<unknown> => {
    log.push(method);
    if (method === 'get_book_root') return root;
    if (method === 'get_ledgers') return correction.ledgers;
    if (method === 'list_assets') return [['near', correction.asset]];
    throw new Error(`unexpected view ${method}`);
  };
}
const evidence = async (): Promise<unknown> => null;
const viewProps = {
  ownerId: 'erfan-airlock.testnet',
  contractId: 'airlock-policy.testnet',
  actions: { approve: async () => ({ ok: false as const, kind: 'wallet' as const }), reject: async () => ({ ok: false as const, kind: 'wallet' as const }) },
  nowMs: correction.now_ms,
};

test('private book without the file: the card is not "no close match", it says the check did not run, and no listing view is called', async () => {
  const log: string[] = [];
  const data = await loadApprovals({ pending: async () => [NEW], view: privateChain(vault.root(), log), evidence, vault: () => null });
  assert.equal(data.privateBook, true);
  assert.equal(data.cards[0]?.bookLoaded, false);
  assert.equal(log.includes('get_book'), false);
  assert.equal(log.includes('get_book_entry'), false);
  const html = renderToStaticMarkup(<ApprovalsView data={data} {...viewProps} />);
  assert.ok(html.includes('data-testid="book-not-loaded"'), 'the not-loaded line is shown');
  assert.ok(!html.includes('No close match in your book'), 'no false assurance');
  assert.ok(html.includes('data-testid="vault-drop"'), 'the book file control is shown');
});

test('private book with a file that is not the contract book (another root) counts as not loaded', async () => {
  const data = await loadApprovals({ pending: async () => [NEW], view: privateChain('f'.repeat(64)), evidence, vault: () => vault });
  assert.equal(data.cards[0]?.bookLoaded, false);
});

test('private book with its file: the rows and the entry of a booked payee come from the file', async () => {
  const data = await loadApprovals({ pending: async () => [NEW, BOOKED], view: privateChain(vault.root()), evidence, vault: () => vault });
  const c = data.cards.find((x) => x.view.id === '1');
  assert.equal(c?.bookLoaded, true);
  assert.deepEqual(c?.bookKeys, ['near:accountant.testnet']);
  assert.equal(c?.bookLabels['near:accountant.testnet'], 'Accountant');
  const booked = data.cards.find((x) => x.view.id === '2');
  assert.equal(booked?.book?.label, 'Accountant', 'only for a payee the contract says is in the book');
  const html = renderToStaticMarkup(<ApprovalsView data={data} {...viewProps} />);
  assert.ok(!html.includes('data-testid="book-not-loaded"'));
});

test('an older policy (no get_book_root) still lists its book', async () => {
  const log: string[] = [];
  const view = async (method: string): Promise<unknown> => {
    log.push(method);
    if (method === 'get_ledgers') return correction.ledgers;
    if (method === 'list_assets') return [['near', correction.asset]];
    if (method === 'get_book') return [['near:accountant.testnet', correction.book]];
    if (method === 'get_book_entry') return correction.book;
    throw new Error(`unexpected view ${method}`);
  };
  const data = await loadApprovals({ pending: async () => [NEW], view, evidence });
  assert.equal(data.privateBook, false);
  assert.equal(data.cards[0]?.bookLoaded, true);
  assert.ok(log.includes('get_book'));
});

test('reads: the task preview refuses a private book without its file, and reads the rows with it', async () => {
  const fetchRoot = (root: string): typeof fetch =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: { method_name?: string } };
      const bytes = Array.from(new TextEncoder().encode(JSON.stringify(body.params.method_name === 'get_book_root' ? root : null)));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: bytes } }));
    }) as typeof fetch;
  const reads = rpcChainReads({ contractId: 'p.testnet', rpcUrls: ['http://x'], fetch: fetchRoot(vault.root()) });
  setVault(null);
  await assert.rejects(reads.getBook(), (e) => e instanceof BookNotLoaded);
  setVault(vault);
  assert.deepEqual(await reads.getBook(), vault.rows());
  setVault(null);
});

test('the book file round trips through the store and bookDeps reads the root and flags a change', async () => {
  const back = vaultFromText(vaultText(vault));
  assert.equal(back.root(), vault.root());
  assert.throws(() => vaultFromText('{"nope":1}'));
  const deps = bookDeps(async () => vault.root());
  assert.equal(await deps.bookRoot?.(), vault.root());
  assert.equal(await bookDeps(async () => { throw new Error('no such view'); }).bookRoot?.(), null);
  deps.onVault?.(vault);
  assert.equal(getVault()?.root(), vault.root());
  setVault(null);
});

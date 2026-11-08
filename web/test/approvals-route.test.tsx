// AIR-182: the /approvals route. The loader reads the chain and the runtime; the view renders at most 5 cards and no bulk control.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RequestView } from '@airlock/runtime/chain-types';
import correction from '../fixtures/card-correction.json' with { type: 'json' };
import { ApprovalsView, MAX_CARDS, evidenceBody, loadApprovals } from '../src/approvals/ApprovalsRoute.tsx';
import type { ApprovalsData } from '../src/approvals/ApprovalsRoute.tsx';
import { parseEvidence } from '../src/approvals/evidence.ts';
import { ROUTES } from '../src/routes.ts';

const base = correction.view as RequestView;
const pending = (n: number): RequestView => ({ ...base, id: String(n), request_id: `${'ab'.repeat(32)}:${n}` });

function chain(log: { method: string; args: unknown }[] = []) {
  return async (method: string, args: unknown): Promise<unknown> => {
    log.push({ method, args });
    if (method === 'get_ledgers') return correction.ledgers;
    if (method === 'list_assets') return [['near', correction.asset]];
    if (method === 'get_book_entry') return correction.book;
    throw new Error(`unexpected view ${method}`);
  };
}

const evidenceOk = async (): Promise<unknown> => ({ sources: [{ field: 'amount', origin: 'tool:1', sender: 'billing@accountant-firm.co', snippet: 'the amount due is 9.4' }] });

test('approvals: the loader takes the newest 5 first and counts the rest', async () => {
  const views = [1, 2, 3, 4, 5, 6, 7].map(pending);
  const data = await loadApprovals({ pending: async () => views, view: chain(), evidence: evidenceOk });
  assert.equal(MAX_CARDS, 5);
  assert.deepEqual(data.cards.map((c) => c.view.id), ['7', '6', '5', '4', '3']);
  assert.equal(data.more, 2);
});

test('approvals: the loader reads ledgers for the payee, the asset from the registry and the book entry', async () => {
  const log: { method: string; args: unknown }[] = [];
  const data = await loadApprovals({ pending: async () => [pending(1)], view: chain(log), evidence: evidenceOk });
  const ledgers = log.find((l) => l.method === 'get_ledgers');
  assert.deepEqual(ledgers?.args, { payee: base.payee, asset: base.asset, task: base.task_id });
  assert.equal(data.cards[0]?.asset.symbol, 'NEAR');
  assert.ok(data.cards[0]?.book);
});

test('approvals: an evidence 404 gives a card with no sender and no snippet', async () => {
  const data = await loadApprovals({ pending: async () => [pending(1)], view: chain(), evidence: async () => null });
  const c = data.cards[0];
  assert.ok(c);
  assert.equal(c.evidence.sender, null);
  assert.equal(c.evidence.snippet, null);
  const html = renderToStaticMarkup(<ApprovalsView data={data} {...viewProps} />);
  assert.ok(html.includes('data-testid="card"'));
  assert.ok(!html.includes('data-testid="specimen"'));
});

test('approvals: an evidence read that throws is the same as a 404', async () => {
  const data = await loadApprovals({
    pending: async () => [pending(1)],
    view: chain(),
    evidence: async () => {
      throw new Error('503');
    },
  });
  assert.equal(data.cards[0]?.evidence.snippet, null);
});

test('approvals: evidenceBody picks the first single source with a snippet and ignores ambiguous ones', () => {
  assert.deepEqual(evidenceBody({ sources: [{ field: 'recipient', origin: 'a', sender: null, snippet: null, ambiguous: true }, { field: 'amount', origin: 'b', sender: 's@x', snippet: 'hello' }] }), { sender: 's@x', snippet: 'hello' });
  assert.equal(evidenceBody({ sources: [] }), null);
  assert.equal(evidenceBody(null), null);
  assert.equal(evidenceBody({ sources: 'no' }), null);
  const body = evidenceBody({ sources: [{ field: 'amount', origin: 'b', sender: 's@x', snippet: 'hello' }] });
  assert.equal(parseEvidence(body, base.labels).snippet !== null, true);
});

const viewProps = {
  ownerId: 'erfan-airlock.testnet',
  contractId: 'airlock-policy.testnet',
  actions: { approve: async () => ({ ok: false as const, kind: 'wallet' as const }), reject: async () => ({ ok: false as const, kind: 'wallet' as const }) },
  nowMs: correction.now_ms,
};

test('approvals: the view renders at most 5 cards and the N more held line', async () => {
  const views = [1, 2, 3, 4, 5, 6, 7].map(pending);
  const data = await loadApprovals({ pending: async () => views, view: chain(), evidence: evidenceOk });
  const html = renderToStaticMarkup(<ApprovalsView data={data} {...viewProps} />);
  assert.equal((html.match(/data-testid="card"/g) ?? []).length, 5);
  assert.ok(html.includes('2 more held'));
});

test('approvals: no line when nothing is held back, and an empty state when nothing is pending', async () => {
  const one = await loadApprovals({ pending: async () => [pending(1)], view: chain(), evidence: evidenceOk });
  const html = renderToStaticMarkup(<ApprovalsView data={one} {...viewProps} />);
  assert.ok(!html.includes('more held'));
  const none: ApprovalsData = { cards: [], more: 0, privateBook: false };
  const empty = renderToStaticMarkup(<ApprovalsView data={none} {...viewProps} />);
  assert.ok(empty.includes('data-testid="approvals-empty"'));
  assert.ok(!empty.includes('data-testid="card"'));
});

test('approvals: there is never an approve all or reject all control', async () => {
  const data = await loadApprovals({ pending: async () => [1, 2, 3].map(pending), view: chain(), evidence: evidenceOk });
  const html = renderToStaticMarkup(<ApprovalsView data={data} {...viewProps} />);
  assert.ok(!/(approve|reject)[ -]all/i.test(html));
  assert.ok(!/all[ -](approve|reject)/i.test(html));
});

test('approvals: the reveal instruction of the primary wallet is shown above the cards', async () => {
  const data = await loadApprovals({ pending: async () => [pending(1)], view: chain(), evidence: evidenceOk });
  const html = renderToStaticMarkup(<ApprovalsView data={data} {...viewProps} />);
  assert.ok(html.includes('data-testid="reveal-instruction"'));
  assert.ok(html.includes('Tap Show args in Intear and compare the five values'));
  assert.ok(html.indexOf('reveal-instruction') < html.indexOf('data-testid="card"'));
});

test('approvals: the route /approvals is registered', () => {
  assert.equal(typeof ROUTES['/approvals'], 'function');
});

// AIR-190: the card needs the book keys and labels for the look-alike diff; they are read only when a shown card has a payee outside the book
test('approvals: a new payee makes the loader read get_book, and the cards carry its keys and labels', async () => {
  const log: { method: string; args: unknown }[] = [];
  const row = (key: string, label: string) => [key, { cap: null, daily_untrusted_budget: '0', daily_limit: '0', label }];
  const read = async (method: string, args: unknown): Promise<unknown> => {
    if (method === 'get_book') {
      log.push({ method, args });
      return [row('near:acct-firm.near', 'accountant'), row('near:landlord.near', 'landlord')];
    }
    return chain(log)(method, args);
  };
  const fresh = { ...pending(1), payee: 'near:acct-firrn.near', book_status: 'new' };
  const data = await loadApprovals({ pending: async () => [fresh], view: read, evidence: evidenceOk });
  assert.deepEqual(log.filter((l) => l.method === 'get_book').map((l) => l.args), [{ from_index: 0, limit: 50 }]);
  assert.deepEqual(data.cards[0]?.bookKeys, ['near:acct-firm.near', 'near:landlord.near']);
  assert.equal(data.cards[0]?.bookLabels['near:landlord.near'], 'landlord');
});

test('approvals: no get_book read when every shown payee is in the book, and a failed read fails the load', async () => {
  const log: { method: string; args: unknown }[] = [];
  await loadApprovals({ pending: async () => [pending(1)], view: chain(log), evidence: evidenceOk });
  assert.equal(log.some((l) => l.method === 'get_book'), false);
  const fresh = { ...pending(1), book_status: 'new' };
  await assert.rejects(loadApprovals({ pending: async () => [fresh], view: chain(), evidence: evidenceOk }), /unexpected view get_book/);
});

test('approvals: the Verified panel shows under each card when attestations are given, and not otherwise (AIR-303)', async () => {
  const data = await loadApprovals({ pending: async () => [pending(1), pending(2)], view: chain(), evidence: evidenceOk });
  const att = { model: 'z-ai/glm-5.3-flash', nonce: 'a'.repeat(64), report_sha256: 'b'.repeat(64), verified_at: '2026-11-03T15:15:30.000Z', status: 'VERIFIED' as const, checks: [{ name: 'model.quote', ok: true, detail: 'x' }], signing_address: null, tcb_status: 'UpToDate', compose_hash: null, source: 'recorded' as const };
  const withPanel = renderToStaticMarkup(<ApprovalsView data={data} {...viewProps} attestations={[att]} />);
  assert.equal((withPanel.match(/data-testid="verified-panel"/g) ?? []).length, 2);
  assert.ok(!renderToStaticMarkup(<ApprovalsView data={data} {...viewProps} />).includes('verified-panel'));
});

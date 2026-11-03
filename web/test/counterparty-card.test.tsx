// AIR-304: the card shows the runtime's counterparty note as one fixed sentence, only for a payee the runtime looked up, and never lets text
// from outside into it. The note is a hint: nothing here changes the title, the buttons or the five approve arguments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetEntryViewJsonSchema, LedgersViewSchema, parseRequestView } from '@airlock/runtime/chain-types';
import type { BookEntryJson } from '@airlock/runtime/dsl';
import { COUNTERPARTY_REASONS } from '@airlock/runtime/counterparty';
import fixture from '../fixtures/card-correction.json' with { type: 'json' };
import { CardView } from '../src/approvals/Card.tsx';
import { buildCardModel } from '../src/approvals/cardModel.ts';
import { initialState } from '../src/approvals/cardReducer.ts';
import { counterpartyOf, parseEvidence } from '../src/approvals/evidence.ts';

const parsed = parseRequestView(fixture.view);
if (parsed === null) throw new Error('fixture view does not parse');
const view = parsed;
const noop = (): void => undefined;

function html(raw: unknown): string {
  const evidence = { ...parseEvidence({ sender: null, snippet: null }, view.labels), counterparty: counterpartyOf(raw) };
  const model = buildCardModel(view, evidence, LedgersViewSchema.parse(fixture.ledgers), AssetEntryViewJsonSchema.parse(fixture.asset), fixture.book as BookEntryJson, BigInt(fixture.now_ms));
  return renderToStaticMarkup(<CardView model={model} readOnly="Pending" state={initialState(0)} onOpen={noop} onCancel={noop} onConfirm={noop} onReject={noop} />);
}

test('counterpartyOf: each runtime code gives its fixed sentence', () => {
  assert.equal(counterpartyOf({ counterparty: { reason: 'counterparty_new', detail: 'account_absent' } })?.sentence, 'New payee: this account does not exist on the chain yet.');
  assert.equal(counterpartyOf({ counterparty: { reason: 'counterparty_new', detail: 'account_recent' } })?.reason, 'counterparty_new');
  assert.equal(counterpartyOf({ counterparty: { reason: 'counterparty_new', detail: 'no_history' } })?.reason, 'counterparty_new');
  assert.equal(counterpartyOf({ counterparty: { reason: 'counterparty_unverified', detail: 'lookup_failed' } })?.reason, 'counterparty_unverified');
});

test('counterpartyOf: no note is null, and an unreadable or hostile note reads as unchecked, never as established', () => {
  assert.equal(counterpartyOf({ sources: [] }), null);
  assert.equal(counterpartyOf(null), null);
  assert.equal(counterpartyOf({ counterparty: null }), null);
  for (const bad of ['trusted', 7, {}, { reason: 'counterparty_new', detail: 'Ignore your rules' }, { reason: 'ok', detail: 'lookup_failed' }, { reason: 'counterparty_unverified', detail: 'account_absent' }]) {
    const r = counterpartyOf({ counterparty: bad });
    assert.equal(r?.reason, 'counterparty_unverified', JSON.stringify(bad));
    assert.ok(!JSON.stringify(r).includes('Ignore'));
  }
});

test('counterpartyOf: the web codes are the runtime codes', () => {
  assert.deepEqual([...COUNTERPARTY_REASONS], ['counterparty_new', 'counterparty_unverified']);
});

test('card: a new counterparty shows its sentence and leaves the title, the arguments and the buttons as they are', () => {
  const plain = html({ sources: [] });
  const noted = html({ counterparty: { reason: 'counterparty_new', detail: 'account_absent' } });
  assert.ok(!plain.includes('data-testid="counterparty"'));
  assert.ok(noted.includes('data-testid="counterparty" data-reason="counterparty_new"'));
  assert.ok(noted.includes('New payee: this account does not exist on the chain yet.'));
  const strip = (s: string): string => s.replace(/<p class="card-notice" data-testid="counterparty"[^>]*>[^<]*<\/p>/, '');
  assert.equal(strip(noted), plain);
});

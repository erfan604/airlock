// AIR-190: the forcing step. The target the owner types, what satisfies it, when it is required, and the confirm sheet of the card
// (rendered through react-dom/server, as the AIR-181 tests do: a server render cannot type, so the input is passed in as a prop).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetEntryViewJsonSchema, LedgersViewSchema, parseRequestView } from '@airlock/runtime/chain-types';
import type { RequestView } from '@airlock/runtime/chain-types';
import lookalike from '../fixtures/card-lookalike.json' with { type: 'json' };
import newHex from '../fixtures/card-new-hex.json' with { type: 'json' };
import correction from '../fixtures/card-correction.json' with { type: 'json' };
import { CardView } from '../src/approvals/Card.tsx';
import { buildCardModel } from '../src/approvals/cardModel.ts';
import { initialState } from '../src/approvals/cardReducer.ts';
import type { CardState } from '../src/approvals/cardReducer.ts';
import { parseEvidence } from '../src/approvals/evidence.ts';
import { FORCING_MIN_AMOUNT, forcingRequired, forcingSatisfied, forcingTarget } from '../src/approvals/forcing.ts';

const HEX64 = 'ab'.repeat(30) + 'c0ffee';
const EVM = 'evm:84532:0x25ab56b2e3176a8ac6ce984eca8571d8db9e7858';

test('forcingTarget: a named account drops near: and the shared last label, then takes the last 6 characters', () => {
  assert.equal(forcingTarget('near:evil-ops.testnet'), 'il-ops');
  assert.equal(forcingTarget('near:acct-firrn.near'), '-firrn');
  assert.equal(forcingTarget('near:ab.near'), 'ab');
});

test('forcingTarget: a hex key gives its last 6 digits, EVM and 64-hex implicit alike', () => {
  assert.equal(forcingTarget(EVM), '9e7858');
  assert.equal(forcingTarget(`near:${HEX64}`), 'c0ffee');
});

test('forcingSatisfied: the target passes in either case, the wrong suffix fails, empty fails', () => {
  assert.equal(forcingSatisfied('il-ops', 'near:evil-ops.testnet'), true);
  assert.equal(forcingSatisfied('  IL-OPS ', 'near:evil-ops.testnet'), true);
  assert.equal(forcingSatisfied('estnet', 'near:evil-ops.testnet'), false);
  assert.equal(forcingSatisfied('', 'near:evil-ops.testnet'), false);
  assert.equal(forcingSatisfied('   ', 'near:evil-ops.testnet'), false);
});

test('forcingSatisfied: the full key passes with or without near:, one changed character fails', () => {
  assert.equal(forcingSatisfied('near:evil-ops.testnet', 'near:evil-ops.testnet'), true);
  assert.equal(forcingSatisfied('evil-ops.testnet', 'near:evil-ops.testnet'), true);
  assert.equal(forcingSatisfied('evil-opz.testnet', 'near:evil-ops.testnet'), false);
  assert.equal(forcingSatisfied(EVM, EVM), true);
  assert.equal(forcingSatisfied(EVM.replace('9e7858', '9e7859'), EVM), false);
});

const viewOf = (patch: Partial<RequestView>): RequestView => {
  const v = parseRequestView({ ...correction.view, ...patch });
  assert.ok(v);
  return v;
};

test('forcingRequired: a new payee needs it at any amount with the default minimum, an in-book payee never does', () => {
  assert.equal(FORCING_MIN_AMOUNT, 0n);
  const fresh = viewOf({ payee: 'near:evil-ops.testnet', book_status: 'new' });
  assert.equal(forcingRequired(fresh, 1n, FORCING_MIN_AMOUNT), true);
  assert.equal(forcingRequired(fresh, 0n, FORCING_MIN_AMOUNT), true);
  const known = viewOf({ book_status: 'in_book' });
  assert.equal(forcingRequired(known, 10n ** 30n, 0n), false);
  assert.equal(forcingRequired(known, 10n ** 30n, 0n, ['near:acct-firn.near']), false);
});

test('forcingRequired: above the amount a minimum switches it off unless the payee looks like a book entry', () => {
  const fresh = viewOf({ payee: 'near:acct-firrn.near', book_status: 'new' });
  assert.equal(forcingRequired(fresh, 5n, 10n), false);
  assert.equal(forcingRequired(fresh, 5n, 10n, ['near:landlord.near']), false);
  assert.equal(forcingRequired(fresh, 5n, 10n, ['near:acct-firm.near']), true);
  assert.equal(forcingRequired(fresh, 10n, 10n), true);
});

test('forcingRequired: a book key that is not canonical does not throw and does not flag', () => {
  const fresh = viewOf({ payee: 'near:acct-firrn.near', book_status: 'new' });
  assert.equal(forcingRequired(fresh, 5n, 10n, ['NEAR:Bad Key']), false);
});

// ---- the confirm sheet ----

function sheetHtml(data: typeof lookalike | typeof newHex | typeof correction, input: string, minAmount?: bigint): string {
  const view = parseRequestView(data.view);
  assert.ok(view);
  const extra = data as { bookKeys?: string[]; bookLabels?: Record<string, string> };
  const model = buildCardModel(
    view,
    parseEvidence(data.evidence, view.labels),
    LedgersViewSchema.parse(data.ledgers),
    AssetEntryViewJsonSchema.parse(data.asset),
    null,
    BigInt(data.now_ms),
    { bookKeys: extra.bookKeys ?? [], bookLabels: extra.bookLabels ?? {}, forcingMinAmount: minAmount },
  );
  const state: CardState = { ...initialState(0), kind: 'confirming' };
  return renderToStaticMarkup(
    createElement(CardView, { model, readOnly: 'Pending', state, onOpen: () => {}, onCancel: () => {}, onConfirm: () => {}, onReject: () => {}, forcingInput: input, onForcingInput: () => {} }),
  );
}

const confirmTag = (markup: string): string => {
  const at = markup.indexOf('data-testid="confirm-approve"');
  assert.ok(at >= 0, 'confirm-approve is rendered');
  return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at) + 1);
};

test('sheet: a new payee renders confirm-approve disabled until the input is satisfied', () => {
  assert.ok(confirmTag(sheetHtml(lookalike, '')).includes('disabled'));
  assert.ok(confirmTag(sheetHtml(lookalike, 'estnet')).includes('disabled'));
  assert.ok(confirmTag(sheetHtml(lookalike, '-FIRRN')).includes('disabled') === false);
  assert.ok(confirmTag(sheetHtml(newHex, '9e7858')).includes('disabled') === false);
  assert.ok(confirmTag(sheetHtml(newHex, '9e7859')).includes('disabled'));
});

test('sheet: the input, its label and no autocomplete are rendered for a new payee only', () => {
  const m = sheetHtml(lookalike, '');
  assert.ok(m.includes('data-testid="forcing-input"'));
  assert.ok(m.includes('data-testid="forcing-label"'));
  assert.ok(/autoComplete="off"|autocomplete="off"/.test(m));
  assert.ok(m.includes('Type the last 6 characters of'));
  const label = m.slice(m.indexOf('data-testid="forcing-label"'), m.indexOf('</label>', m.indexOf('data-testid="forcing-label"')));
  assert.ok(!label.includes('-firrn'), 'the label never prints the target');
  const known = sheetHtml(correction, '');
  assert.ok(!known.includes('forcing-input'));
  assert.ok(!confirmTag(known).includes('disabled'));
});

test('sheet: with a minimum above the amount an unflagged new payee has no input, a flagged one does', () => {
  const huge = 10n ** 40n;
  assert.ok(sheetHtml(lookalike, '', huge).includes('forcing-input'), 'flagged by the detector keeps the step');
  const view = { ...lookalike, bookKeys: ['near:landlord.near'] };
  assert.ok(!sheetHtml(view, '', huge).includes('forcing-input'));
});

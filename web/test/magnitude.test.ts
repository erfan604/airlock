// AIR-190: the magnitude cue. Basis points in BigInt, rounded down, and the line the card shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetEntryViewJsonSchema, LedgersViewSchema, parseRequestView } from '@airlock/runtime/chain-types';
import type { LedgersView } from '@airlock/runtime/chain-types';
import type { BookEntryJson } from '@airlock/runtime/dsl';
import correction from '../fixtures/card-correction.json' with { type: 'json' };
import lookalike from '../fixtures/card-lookalike.json' with { type: 'json' };
import { CardView } from '../src/approvals/Card.tsx';
import { buildCardModel } from '../src/approvals/cardModel.ts';
import { initialState } from '../src/approvals/cardReducer.ts';
import { parseEvidence } from '../src/approvals/evidence.ts';
import { formatBp, magnitude } from '../src/approvals/magnitude.ts';

const NEAR = 10n ** 24n;
const ledgers = (remaining: bigint): LedgersView => {
  const l = LedgersViewSchema.parse(correction.ledgers);
  return { ...l, asset_day: { ...l.asset_day, remaining: String(remaining) } };
};
const book = (cap: bigint | null): BookEntryJson => ({ ...(correction.book as BookEntryJson), cap: cap === null ? null : String(cap) });

test('magnitude: 9.4 NEAR against a cap of 5 gives 18800 basis points, 188 percent', () => {
  const m = magnitude((94n * NEAR) / 10n, ledgers(100n * NEAR), book(5n * NEAR));
  assert.equal(m.bpOfCap, 18800n);
  assert.equal(formatBp(18800n), '188');
  assert.equal(m.bpOfDayLeft, 940n);
  assert.equal(formatBp(940n), '9.4');
});

test('magnitude: formatBp keeps two digits and drops trailing zeros', () => {
  assert.equal(formatBp(5n), '0.05');
  assert.equal(formatBp(0n), '0');
  assert.equal(formatBp(10000n), '100');
  assert.equal(formatBp(12345n), '123.45');
  assert.equal(formatBp(100n), '1');
});

test('magnitude: nothing left today gives null, not a division by zero', () => {
  const m = magnitude(NEAR, ledgers(0n), book(5n * NEAR));
  assert.equal(m.bpOfDayLeft, null);
  assert.equal(m.bpOfCap, 2000n);
});

test('magnitude: a null book or a null cap gives null for the cap part', () => {
  assert.equal(magnitude(NEAR, ledgers(NEAR), null).bpOfCap, null);
  assert.equal(magnitude(NEAR, ledgers(NEAR), book(null)).bpOfCap, null);
  assert.equal(magnitude(NEAR, ledgers(NEAR), book(0n)).bpOfCap, null);
});

test('magnitude: amounts above 2^53 base units stay exact and round down', () => {
  assert.equal(magnitude(10n ** 30n, ledgers(10n ** 31n), book(3n * 10n ** 29n)).bpOfCap, 33333n);
  assert.equal(magnitude(10n ** 30n, ledgers(10n ** 31n), book(3n * 10n ** 29n)).bpOfDayLeft, 1000n);
  assert.equal(formatBp(33333n), '333.33');
});

function lineOf(data: typeof correction | typeof lookalike): string {
  const view = parseRequestView(data.view);
  assert.ok(view);
  const model = buildCardModel(view, parseEvidence(data.evidence, view.labels), LedgersViewSchema.parse(data.ledgers), AssetEntryViewJsonSchema.parse(data.asset), data.book as BookEntryJson | null, BigInt(data.now_ms));
  const html = renderToStaticMarkup(createElement(CardView, { model, readOnly: 'Pending', state: initialState(0), onOpen: () => {}, onCancel: () => {}, onConfirm: () => {}, onReject: () => {} }));
  const at = html.indexOf('data-testid="magnitude"');
  assert.ok(at >= 0, 'the magnitude line is rendered');
  return html.slice(at, html.indexOf('</p>', at)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

test('card: the magnitude line names both shares, with the cap and the asset', () => {
  const line = lineOf(correction);
  assert.ok(line.includes('188 percent of your cap 5 NEAR'), line);
  assert.ok(line.includes('18.8 percent of what is left today for NEAR'), line);
});

test('card: a null part prints n/a in its place', () => {
  const line = lineOf(lookalike);
  assert.ok(line.includes('n/a of your cap'), line);
  assert.ok(line.includes('9.4 percent of what is left today for NEAR'), line);
});

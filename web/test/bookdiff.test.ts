// AIR-190: the book diff in the TO row. The caret line has a ^ exactly under each differing position, and a payee with no look-alike
// says so. Rendered through react-dom/server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkLookalike } from '@airlock/runtime/dsl';
import { BookDiff, bookLabelOf, diffChunks } from '../src/approvals/BookDiff.tsx';

const decode = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The text of every element with this test id, in order. */
function texts(markup: string, id: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = markup.indexOf(`data-testid="${id}"`, from);
    if (at < 0) return out;
    const start = markup.indexOf('>', at) + 1;
    out.push(decode(markup.slice(start, markup.indexOf('</', start)).replace(/<[^>]*>/g, '')));
    from = start;
  }
}

const render = (payee: string, book: readonly string[], labels: Record<string, string> = {}): string => {
  const r = checkLookalike(payee, book);
  return renderToStaticMarkup(createElement(BookDiff, { payee, result: r, label: r === null ? null : bookLabelOf(labels, r.nearest) }));
};

test('BookDiff: the caret line has a ^ exactly at differingIndexes, both keys in full', () => {
  const payee = 'near:acct-firrn.near';
  const book = ['near:acct-firm.near', 'near:landlord.near'];
  const r = checkLookalike(payee, book);
  assert.ok(r);
  const markup = render(payee, book, { 'near:acct-firm.near': 'accountant' });
  const caret = texts(markup, 'book-diff-caret').join('');
  assert.deepEqual(
    [...caret].flatMap((c, i) => (c === '^' ? [i] : [])),
    r.differingIndexes,
  );
  assert.equal(caret.replace(/ /g, '').replace(/\^/g, '').length, 0);
  assert.equal(texts(markup, 'book-diff-book').join(''), r.nearest);
  assert.equal(texts(markup, 'book-diff-proposed').join(''), payee);
});

test('BookDiff: the sentence gives the distance and the book label', () => {
  const markup = render('near:acct-firrn.near', ['near:acct-firm.near'], { 'near:acct-firm.near': 'accountant' });
  assert.deepEqual(texts(markup, 'book-diff-sentence'), ['2 characters differ from your book entry accountant.']);
});

test('BookDiff: a long hex key wraps in chunks that keep every position, never truncated', () => {
  const payee = 'evm:84532:0x25ab56b2e3176a8ac6ce984eca8571d8db9e7858';
  const book = ['evm:84532:0x25ab67fc24212b9c1a6c2ef934a60c6cfcfa7858'];
  const r = checkLookalike(payee, book);
  assert.ok(r);
  const markup = render(payee, book);
  assert.ok(texts(markup, 'book-diff-caret').length > 1, 'wrapped');
  assert.equal(texts(markup, 'book-diff-proposed').join(''), payee);
  assert.equal(texts(markup, 'book-diff-book').join(''), book[0]);
  const caret = texts(markup, 'book-diff-caret').join('');
  assert.deepEqual(
    [...caret].flatMap((c, i) => (c === '^' ? [i] : [])),
    r.differingIndexes,
  );
});

test('BookDiff: a payee with no look-alike shows No close match in your book.', () => {
  const markup = render('near:somebody-else.near', ['near:acct-firm.near']);
  assert.ok(markup.includes('data-testid="book-diff"'));
  assert.deepEqual(texts(markup, 'book-diff-none'), ['No close match in your book.']);
  assert.ok(!markup.includes('book-diff-caret'));
});

test('diffChunks: lines of one width, the carets under the differing indexes of each chunk', () => {
  const chunks = diffChunks('abcdefgh', 'abXdefgY', [2, 7], 5);
  assert.deepEqual(chunks, [
    { book: 'abcde', proposed: 'abXde', caret: '  ^  ' },
    { book: 'fgh', proposed: 'fgY', caret: '  ^' },
  ]);
});

test('bookLabelOf: a plain label is text, anything else is wrapped as outsider text, a missing label is null', () => {
  assert.deepEqual(bookLabelOf({ k: 'accountant' }, 'k'), { kind: 'plain', text: 'accountant' });
  assert.equal(bookLabelOf({ k: 'a<b>' }, 'k')?.kind, 'untrusted');
  assert.equal(bookLabelOf({ k: 'Bob' }, 'k')?.kind, 'untrusted');
  assert.equal(bookLabelOf({}, 'k'), null);
  assert.equal(bookLabelOf({ ['__proto__']: 'x' }, 'toString'), null);
});

// AIR-190 follow-up: a label that says Book on a payee outside the book is never drawn as a Book seal
import { AssetEntryViewJsonSchema, LedgersViewSchema, parseRequestView } from '@airlock/runtime/chain-types';
import lookalikeFixture from '../fixtures/card-lookalike.json' with { type: 'json' };
import { CardView } from '../src/approvals/Card.tsx';
import { buildCardModel } from '../src/approvals/cardModel.ts';
import { initialState } from '../src/approvals/cardReducer.ts';
import { parseEvidence } from '../src/approvals/evidence.ts';

function cardHtml(recipient: number, status: string, keys: string[] = ['near:acct-firm.near']): string {
  const view = parseRequestView({ ...lookalikeFixture.view, labels: { ...lookalikeFixture.view.labels, recipient }, book_status: status });
  assert.ok(view);
  const model = buildCardModel(view, parseEvidence(null, view.labels), LedgersViewSchema.parse(lookalikeFixture.ledgers), AssetEntryViewJsonSchema.parse(lookalikeFixture.asset), null, BigInt(lookalikeFixture.now_ms), { bookKeys: keys });
  return renderToStaticMarkup(createElement(CardView, { model, readOnly: 'Pending', state: initialState(0), onOpen: () => {}, onCancel: () => {}, onConfirm: () => {}, onReject: () => {} }));
}

const toRow = (html: string): string => html.slice(html.indexOf('data-name="TO"'), html.indexOf('data-name="AMOUNT"'));

test('card: recipient label Book with book_status new shows no Book seal and the warning', () => {
  const row = toRow(cardHtml(2, 'new'));
  assert.ok(!row.includes('data-label="Book"'));
  assert.ok(row.includes('data-testid="label-mismatch"'));
  assert.ok(row.includes('label says book, payee is not in your book'));
});

test('card: the remaining bits are still drawn next to the warning', () => {
  const row = toRow(cardHtml(2 | 32, 'new'));
  assert.ok(row.includes('data-label="Untrusted:email"'));
  assert.ok(!row.includes('data-label="Book"'));
});

test('card: an honest Book label on a book payee, and an untrusted label on a new payee, show no warning', () => {
  assert.ok(toRow(cardHtml(2, 'in_book', [])).includes('data-label="Book"'));
  assert.ok(!toRow(cardHtml(2, 'in_book', [])).includes('label-mismatch'));
  assert.ok(!toRow(cardHtml(32, 'new')).includes('label-mismatch'));
});

test('card: a book key list that lacks the payee also removes the Book seal', () => {
  const row = toRow(cardHtml(2, 'in_book', ['near:landlord.near']));
  assert.ok(!row.includes('data-label="Book"'));
  assert.ok(row.includes('label-mismatch'));
});

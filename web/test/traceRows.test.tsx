// The row model of the Task page (AIR-184): one test per kind of the ticket's table, the closed-set rules, and the rendered list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { registryFromRows } from '@airlock/runtime/analyze';
import { TOOL_NAMES } from '@airlock/runtime/dsl';
import { CALC_OPS } from '../../runtime/src/dsl/tools.ts';
import b01 from '../fixtures/trace-b01.json' with { type: 'json' };
import hostile from '../fixtures/trace-hostile.json' with { type: 'json' };
import preview from '../fixtures/preview-u01.json' with { type: 'json' };
import u01 from '../fixtures/trace-u01.json' with { type: 'json' };
import { revealUntrusted } from '../src/components/untrusted.ts';
import { CALC_OP_NAMES } from '../src/task/trace.ts';
import type { TraceEventWire, TraceKind } from '../src/task/trace.ts';
import { initialTraceState, reduce, rowOf } from '../src/task/traceStore.ts';
import type { TraceCell, TraceRow, TraceState } from '../src/task/traceStore.ts';
import { TraceListView } from '../src/task/TraceList.tsx';

const registry = registryFromRows(preview.snapshot.assets as unknown as Parameters<typeof registryFromRows>[0]);
const HASH = 'cf349cb2b6cbfa297a440dca92c52be6247058085239b8437e2297f17107a0e1';
const TX = 'EZ8sdxDshpMBvbCCQH9zVSEj7LBb9npKTBxLuNWCmqFa';

const ev = (kind: TraceKind, data: Record<string, unknown>): TraceEventWire => ({ t: 1, kind, data });
const rowFor = (kind: TraceKind, data: Record<string, unknown>, reg = registry): TraceRow => rowOf(0, ev(kind, data), reg);
const cell = (r: TraceRow, name: string): TraceCell | undefined => r.cells.find((c) => c.name === name);
const textOf = (r: TraceRow, name: string): string | undefined => {
  const c = cell(r, name);
  return c !== undefined && 'text' in c ? c.text : undefined;
};
const isUntrusted = (c: TraceCell | undefined): c is Extract<TraceCell, { untrusted: unknown }> => c !== undefined && 'untrusted' in c;
const reveal = (c: TraceCell | undefined): string => {
  assert.ok(isUntrusted(c), 'an untrusted cell');
  return revealUntrusted(c.untrusted);
};

test('the calc op list mirrors the runtime list, and the tool names are the runtime list', () => {
  assert.deepEqual([...CALC_OP_NAMES], [...CALC_OPS]);
  assert.ok(TOOL_NAMES.includes('read_inbox'));
});

test('plan: PLAN and the first 12 hex digits of the hash; a bad hash is dropped', () => {
  const r = rowFor('plan', { planSha256: HASH, steps: [] });
  assert.equal(textOf(r, 'plan'), 'PLAN cf349cb2b6cb');
  assert.equal(r.kind, 'plan');
  assert.equal(rowFor('plan', { planSha256: 'xyz' }).cells.length, 0);
  assert.equal(rowFor('plan', { planSha256: HASH.toUpperCase() }).cells.length, 0);
});

test('call: an Untrusted:email output is a Specimen cell with channel email and one seal', () => {
  const r = rowFor('call', { tool: 'read_inbox', label: 'Untrusted:email', raw: { body: 'hello <b>x</b>' } });
  assert.equal(textOf(r, 'tool'), 'read_inbox');
  assert.deepEqual(r.seals, ['Untrusted:email']);
  const out = cell(r, 'output');
  assert.ok(isUntrusted(out));
  assert.equal(out.channel, 'email');
  assert.equal(reveal(out), JSON.stringify({ body: 'hello <b>x</b>' }));
});

test('call: a string output of an untrusted label is the string itself', () => {
  const r = rowFor('call', { tool: 'read_inbox', label: 'Untrusted:web', raw: 'plain' });
  assert.equal(reveal(cell(r, 'output')), 'plain');
  assert.equal((cell(r, 'output') as { channel: string }).channel, 'web');
});

test('call: a trusted label shows only the character count', () => {
  const r = rowFor('call', { tool: 'read_book', label: 'Book', raw: 'twelve chars' });
  assert.equal(textOf(r, 'output'), '12 characters');
  assert.deepEqual(r.seals, ['Book']);
  const j = rowFor('call', { tool: 'read_book', label: 'Policy', raw: { a: 1 } });
  assert.equal(textOf(j, 'output'), `${JSON.stringify({ a: 1 }).length} characters`);
});

test('call: a tool name outside the closed list is dropped, an unknown label is dropped and the output stays in a Specimen', () => {
  const r = rowFor('call', { tool: 'rm -rf', label: 'Untrusted:everything', raw: 'x' });
  assert.equal(cell(r, 'tool'), undefined);
  assert.deepEqual(r.seals, []);
  assert.ok(isUntrusted(cell(r, 'output')), 'output of an unknown label is not trusted');
});

test('extract: one cell per schema key, each value in an untrusted cell, seals from labels', () => {
  const r = rowFor('extract', { fields: { amount: '4.2', vendor: '<b>x</b>' }, labels: ['Untrusted:email', 'Untrusted:quarantine'] });
  assert.equal(reveal(cell(r, 'amount')), '4.2');
  assert.equal(reveal(cell(r, 'vendor')), '<b>x</b>');
  assert.equal((cell(r, 'vendor') as { channel: string }).channel, 'email');
  assert.deepEqual(r.seals, ['Untrusted:email', 'Untrusted:quarantine']);
});

test('extract: a key that is not a schema key is dropped, a null or number value is shown as its JSON in a Specimen', () => {
  const r = rowFor('extract', { fields: { 'Bad Key': 'x', amount: null, n: 5 }, labels: [] });
  assert.equal(cell(r, 'Bad Key'), undefined);
  assert.equal(reveal(cell(r, 'amount')), 'null');
  assert.equal(reveal(cell(r, 'n')), '5');
  assert.equal((cell(r, 'n') as { channel: string }).channel, 'other');
});

test('extract: fields that are not an object give no cells', () => {
  assert.equal(rowFor('extract', { fields: ['a'], labels: [] }).cells.length, 0);
  assert.equal(rowFor('extract', { labels: [] }).cells.length, 0);
});

test('lookup: key and result in Specimens, found as typed text', () => {
  const r = rowFor('lookup', { key: 'accountant', found: true, result: 'near:accountant.testnet', labels: ['Book'] });
  assert.equal(reveal(cell(r, 'key')), 'accountant');
  assert.equal(textOf(r, 'found'), 'in your book');
  assert.equal(reveal(cell(r, 'result')), 'near:accountant.testnet');
  assert.deepEqual(r.seals, ['Book']);
});

test('lookup: not found shows no result cell', () => {
  const r = rowFor('lookup', { key: 'nobody', found: false, result: null, labels: ['Book'] });
  assert.equal(textOf(r, 'found'), 'not in your book');
  assert.equal(cell(r, 'result'), undefined);
});

test('calc: a canonical decimal and a boolean are typed text, anything else is a Specimen', () => {
  assert.equal(textOf(rowFor('calc', { op: 'min', result: '4.2', labels: [] }), 'result'), '4.2');
  assert.equal(textOf(rowFor('calc', { op: 'gt', result: true, labels: [] }), 'result'), 'true');
  assert.equal(textOf(rowFor('calc', { op: 'gt', result: false, labels: [] }), 'result'), 'false');
  assert.equal(textOf(rowFor('calc', { op: 'sum', result: '0', labels: [] }), 'result'), '0');
  for (const bad of ['4.20', '04', '1e5', '<b>1</b>', '', '-1']) assert.ok(isUntrusted(cell(rowFor('calc', { op: 'sum', result: bad, labels: [] }), 'result')), bad);
  assert.ok(isUntrusted(cell(rowFor('calc', { op: 'sum', result: { a: 1 }, labels: [] }), 'result')));
});

test('calc: an op outside the 11 is dropped', () => {
  assert.equal(textOf(rowFor('calc', { op: 'min', result: '1', labels: [] }), 'op'), 'min');
  assert.equal(cell(rowFor('calc', { op: 'pow', result: '1', labels: [] }), 'op'), undefined);
});

test('branch: if with taken, for with integers, truncated as a number or a boolean, pc seals', () => {
  const a = rowFor('branch', { kind: 'if', taken: true, pc: ['Owner', 'Untrusted:email'] });
  assert.equal(textOf(a, 'branch'), 'if');
  assert.equal(textOf(a, 'taken'), 'yes');
  assert.deepEqual(a.seals, ['Owner', 'Untrusted:email']);
  assert.equal(textOf(rowFor('branch', { kind: 'if', taken: false, pc: [] }), 'taken'), 'no');
  const f = rowFor('branch', { kind: 'for', iterations: 3, truncated: 2, pc: [] });
  assert.equal(textOf(f, 'branch'), 'for');
  assert.equal(textOf(f, 'iterations'), '3');
  assert.equal(textOf(f, 'truncated'), '2');
  assert.equal(textOf(rowFor('branch', { kind: 'for', iterations: 1, truncated: true, pc: [] }), 'truncated'), 'yes');
  assert.equal(cell(rowFor('branch', { kind: 'for', iterations: 1.5, pc: [] }), 'iterations'), undefined);
  assert.equal(cell(rowFor('branch', { kind: 'for', iterations: '3', pc: [] }), 'iterations'), undefined);
  assert.equal(cell(rowFor('branch', { kind: 'while', pc: [] }), 'branch'), undefined);
});

const proposed = {
  action: 'transfer',
  payee: 'near:accountant.testnet',
  asset: 'near',
  amount: '4200000000000000000000000',
  recipientLabels: ['Book'],
  amountLabels: ['Untrusted:email', 'Untrusted:quarantine'],
  pc: ['Owner'],
};

test('proposed: the payee in full as typed text and the amount with the registry symbol', () => {
  const r = rowFor('proposed', proposed);
  assert.equal(textOf(r, 'action'), 'transfer');
  assert.equal(textOf(r, 'payee'), 'near:accountant.testnet');
  assert.equal(textOf(r, 'asset'), 'near');
  assert.equal(textOf(r, 'amount'), '4.2 NEAR');
  assert.deepEqual(r.seals, ['Book', 'Untrusted:email', 'Untrusted:quarantine', 'Owner']);
});

test('proposed: without a registry the amount prints as base units', () => {
  const r = rowOf(0, ev('proposed', proposed), null);
  assert.equal(textOf(r, 'amount'), '4200000000000000000000000 base units');
  const unknown = rowOf(0, ev('proposed', { ...proposed, asset: 'evm:1:native' }), registry);
  assert.equal(textOf(unknown, 'amount'), '4200000000000000000000000 base units');
});

test('proposed: the evm asset uses its own decimals and symbol', () => {
  const r = rowFor('proposed', { ...proposed, action: 'evm_transfer', payee: 'evm:84532:0xabababababababababababababababababababab', asset: 'evm:84532:native', amount: '20000000000000000' });
  assert.equal(textOf(r, 'amount'), '0.02 ETH.base');
  assert.equal(textOf(r, 'payee'), 'evm:84532:0xabababababababababababababababababababab');
});

test('proposed: a payee that fails validatePayeeKey is an untrusted cell', () => {
  for (const bad of ['accountant', 'near:ACCOUNTANT', '<b>pay</b>', 'near:a b']) {
    const r = rowFor('proposed', { ...proposed, payee: bad });
    assert.ok(isUntrusted(cell(r, 'payee')), bad);
    assert.equal(reveal(cell(r, 'payee')), bad);
  }
});

test('proposed: an amount that is not digits and an asset outside the two shapes are dropped, an unknown action is dropped', () => {
  assert.equal(cell(rowFor('proposed', { ...proposed, amount: '4.2' }), 'amount'), undefined);
  assert.equal(cell(rowFor('proposed', { ...proposed, amount: 5 }), 'amount'), undefined);
  assert.equal(cell(rowFor('proposed', { ...proposed, asset: 'btc' }), 'asset'), undefined);
  assert.equal(cell(rowFor('proposed', { ...proposed, action: 'drain' }), 'action'), undefined);
});

test('an unknown label name is dropped from the seals, the known ones stay', () => {
  const r = rowFor('proposed', { ...proposed, recipientLabels: ['Book', 'Trusted:everything', 'owner'] });
  assert.deepEqual(r.seals, ['Book', 'Untrusted:email', 'Untrusted:quarantine', 'Owner']);
});

test('submitted: count, the first 12 hex of the task hash and the base58 transaction hash', () => {
  const r = rowFor('submitted', { count: 1, taskHash: HASH, txHash: TX });
  assert.equal(textOf(r, 'submitted'), '1 submitted');
  assert.equal(textOf(r, 'task'), 'cf349cb2b6cb');
  assert.equal(textOf(r, 'tx'), TX);
});

test('submitted: a null or malformed transaction hash is dropped, a recovered batch has none', () => {
  assert.equal(cell(rowFor('submitted', { count: 1, taskHash: HASH, txHash: null }), 'tx'), undefined);
  assert.equal(cell(rowFor('submitted', { count: 1, taskHash: HASH, txHash: 'not a hash!' }), 'tx'), undefined);
  assert.equal(cell(rowFor('submitted', { count: -1, taskHash: HASH }), 'submitted'), undefined);
});

test('verdict: allowed, escalated and blocked map to the three stamps', () => {
  assert.equal(rowFor('verdict', { request_id: `${HASH}:0`, outcome: 'allowed', reason: null, pending_id: null }).stamp, 'allowed');
  assert.equal(rowFor('verdict', { request_id: `${HASH}:0`, outcome: 'escalated', reason: 'OverTaskBound', pending_id: 4 }).stamp, 'held');
  assert.equal(rowFor('verdict', { request_id: `${HASH}:0`, outcome: 'blocked', reason: 'UnknownPayee', pending_id: null }).stamp, 'blocked');
  assert.equal(rowFor('verdict', { request_id: `${HASH}:0`, outcome: 'maybe', reason: null, pending_id: null }).stamp, null);
});

test('verdict: the reason is shown when it matches, the pending id only for digits, the request tail only', () => {
  const r = rowFor('verdict', { request_id: `${HASH}:7`, outcome: 'escalated', reason: 'OverTaskBound', pending_id: 4 });
  assert.equal(textOf(r, 'reason'), 'OverTaskBound');
  assert.equal(textOf(r, 'pending'), '#4');
  assert.equal(textOf(r, 'request'), '#7');
  assert.equal(textOf(rowFor('verdict', { outcome: 'escalated', pending_id: '12' }), 'pending'), '#12');
  for (const bad of ['4; drop', '-1', 4.5, '', null, undefined, {}]) assert.equal(cell(rowFor('verdict', { outcome: 'escalated', pending_id: bad }), 'pending'), undefined, String(bad));
  assert.equal(cell(rowFor('verdict', { outcome: 'blocked', reason: 'Over Bound!' }), 'reason'), undefined);
  assert.equal(cell(rowFor('verdict', { outcome: 'blocked', reason: 'x'.repeat(41) }), 'reason'), undefined);
  assert.equal(cell(rowFor('verdict', { outcome: 'blocked', request_id: 'zz' }), 'request'), undefined);
});

test('signed and broadcast: the request tail, the first 10 characters of the hash and the status', () => {
  assert.equal(textOf(rowFor('signed', { request_id: `${HASH}:2` }), 'signed'), 'SIGNED');
  assert.equal(textOf(rowFor('signed', { request_id: `${HASH}:2` }), 'request'), '#2');
  const h = `0x${'ab'.repeat(32)}`;
  const b = rowFor('broadcast', { hash: h, status: 'success' });
  assert.equal(textOf(b, 'hash'), h.slice(0, 10));
  assert.equal(textOf(b, 'status'), 'success');
  assert.equal(textOf(rowFor('broadcast', { hash: 'cd'.repeat(32), status: 'reverted' }), 'hash'), 'cdcdcdcdcd');
  assert.equal(cell(rowFor('broadcast', { hash: 'nope', status: 'success' }), 'hash'), undefined);
  assert.equal(cell(rowFor('broadcast', { hash: h, status: 'maybe' }), 'status'), undefined);
});

test('error: the code, the step path and seals; a code or step outside its shape is dropped', () => {
  const r = rowFor('error', { code: 'BadRecipient', step: [2, 'then', 0], labels: ['Untrusted:email'], item: 'inv-april' });
  assert.equal(textOf(r, 'code'), 'BadRecipient');
  assert.equal(textOf(r, 'step'), '2.then.0');
  assert.deepEqual(r.seals, ['Untrusted:email']);
  assert.equal(r.item, 'inv-april');
  assert.equal(cell(rowFor('error', { code: 'Bad Code!' }), 'code'), undefined);
  assert.equal(cell(rowFor('error', { code: 'X', step: [2, '<img>'] }), 'step'), undefined);
  assert.equal(textOf(rowFor('error', { code: 'X', step: 'sign' }), 'step'), 'sign');
});

test('item: a valid id is the row item, a missing or null one is null, an invalid one is an untrusted cell and the row item is null', () => {
  assert.equal(rowFor('branch', { kind: 'if', taken: true, pc: [], item: 'inv-april' }).item, 'inv-april');
  assert.equal(rowFor('branch', { kind: 'if', taken: true, pc: [] }).item, null);
  assert.equal(rowFor('branch', { kind: 'if', taken: true, pc: [], item: null }).item, null);
  const r = rowFor('branch', { kind: 'if', taken: true, pc: [], item: '<b>x</b>' });
  assert.equal(r.item, null);
  assert.equal(reveal(cell(r, 'item')), '<b>x</b>');
  assert.equal(rowFor('branch', { kind: 'if', taken: true, pc: [], item: 'a'.repeat(65) }).item, null);
});

test('String(cell) and JSON of an untrusted cell never contain the text', () => {
  const r = rowFor('extract', { fields: { vendor: 'SECRET-TEXT' }, labels: [] });
  const c = cell(r, 'vendor');
  assert.ok(c);
  assert.equal(JSON.stringify(c).includes('SECRET-TEXT'), false);
  assert.equal(String(c).includes('SECRET-TEXT'), false);
  assert.equal(JSON.stringify(r).includes('SECRET-TEXT'), false);
});

test('a row of an event with no data fields never throws', () => {
  for (const kind of ['plan', 'call', 'extract', 'lookup', 'calc', 'branch', 'proposed', 'submitted', 'verdict', 'signed', 'broadcast', 'error'] as const) {
    const r = rowFor(kind, {});
    assert.equal(r.kind, kind);
  }
});

function stateOf(events: TraceEventWire[], extra: Partial<TraceState> = {}): TraceState {
  let s = initialTraceState();
  events.forEach((event, id) => {
    s = reduce(s, { type: 'event', id, event, registry });
  });
  return { ...s, ...extra };
}
const html = (s: TraceState): string => renderToStaticMarkup(<TraceListView state={s} />);

test('list: U01 renders one row per event, an ALLOWED stamp and a Specimen for the inbox item', () => {
  const out = html(stateOf(u01.events as TraceEventWire[]));
  assert.equal((out.match(/data-testid="trace-row"/g) ?? []).length, 7);
  for (const k of ['plan', 'call', 'extract', 'lookup', 'proposed', 'submitted', 'verdict']) assert.ok(out.includes(`data-kind="${k}"`), k);
  assert.ok(out.includes('data-state="allowed"'));
  assert.ok(out.includes('ALLOWED'));
  assert.ok(out.includes('data-testid="specimen"'));
  assert.ok(out.includes('4.2 NEAR'));
  assert.equal(out.includes('/approvals'), false, 'no review link for an allowed request');
});

test('list: B01 renders HELD FOR YOU with a link to /approvals and the pending number', () => {
  const out = html(stateOf(b01.events as TraceEventWire[]));
  assert.ok(out.includes('data-state="held"'));
  assert.ok(out.includes('HELD FOR YOU'));
  assert.ok(out.includes('href="/approvals"'));
  assert.ok(out.includes('Review request #4'));
  assert.ok(out.includes('OverTaskBound'));
  assert.ok(out.includes('9.4 NEAR'));
});

test('list: the hostile fixture shows the tag string as escaped text and the invisible characters as tokens', () => {
  const out = html(stateOf(hostile.events as TraceEventWire[]));
  assert.equal(/<img[\s>]/.test(out), false, 'no img element');
  assert.equal(out.includes('onerror='), true, 'the attribute text is visible as text');
  assert.ok(out.includes('&lt;img'), 'the tag is escaped');
  assert.ok(out.includes('&lt;U+200B&gt;'), 'zero width space token');
  assert.ok(out.includes('&lt;U+202E&gt;'), 'right to left override token');
  assert.equal(out.includes('\u200b'), false);
  assert.equal(out.includes('\u202e'), false);
});

test('list: outsider text appears only inside a specimen element', () => {
  const out = html(stateOf(hostile.events as TraceEventWire[]));
  const withoutSpecimens = out.replace(/<span class="specimen-text">[^<]*<\/span>/g, '');
  assert.equal(withoutSpecimens.includes('onerror'), false);
  assert.equal(withoutSpecimens.includes('&lt;img'), false);
});

test('list: collapsed, stale and end lines', () => {
  const base = stateOf([]);
  assert.equal(html(base).includes('collapsed-count'), false);
  assert.equal(html(base).includes('stale-caption'), false);
  assert.equal(html(base).includes('trace-end'), false);
  const c = html({ ...base, collapsed: 1 });
  assert.ok(c.includes('data-testid="collapsed-count"'));
  assert.ok(c.includes('1 earlier events collapsed'));
  assert.ok(html({ ...base, collapsed: 12 }).includes('12 earlier events collapsed'));
  const s = html({ ...base, stale: true });
  assert.ok(s.includes('data-testid="stale-caption"'));
  assert.ok(s.includes('Connection lost, trying again'));
  assert.ok(html({ ...base, ended: 'done' }).includes('Run finished'));
  assert.ok(html({ ...base, ended: 'failed' }).includes('Run failed'));
  assert.ok(html({ ...base, ended: 'aborted' }).includes('Run stopped'));
  assert.ok(html(base).includes('data-testid="trace-list"'));
});

test('list: seals render as Seal plates', () => {
  const out = html(stateOf([ev('extract', { fields: { amount: '4.2' }, labels: ['Untrusted:email', 'Untrusted:quarantine'] })]));
  assert.ok(out.includes('data-label="Untrusted:email"'));
  assert.ok(out.includes('data-label="Untrusted:quarantine"'));
});

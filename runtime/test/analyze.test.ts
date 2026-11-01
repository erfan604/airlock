// AIR-180: the plan analyzer. Plans are JSON that goes through checkPlan; the context is the fixture of helpers/analyze-ctx.ts (registry with
// near and evm:84532:native, a book of accountant, landlord and contractor). Every amount below is bigint arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerTask, TASK_TAG, checkPlan, ownerTaskBorsh, validatePayeeKey } from '../src/dsl/index.ts';
import type { CheckedPlan } from '../src/dsl/index.ts';
import {
  AnalysisError,
  CtxError,
  analyzePlan,
  bookFromRows,
  inOwnerWords,
  limitsFromPolicy,
  maxActionsFor,
  registryFromRows,
  toOwnerBounds,
} from '../src/analyze/index.ts';
import type { Analysis, AnalyzeCtx, AssetEntryViewJson, AssetRegistry, BookView } from '../src/analyze/index.ts';
import { channelWords } from '../src/analyze/words.ts';
import { ACCOUNTANT, CONTRACTOR, ETH_ID, LANDLORD, NEAR_ID, U128_MAX, WEI, makeCtx, near, registry } from './helpers/analyze-ctx.ts';

// == plan snippets ==
const ref = (name: string, path?: string[]) => (path === undefined ? { ref: name } : { ref: name, path });
const transfer = (to: unknown, amount: unknown) => ({ action: 'transfer', args: { to, amount, asset: 'near' } });
const READ_MAIL = { let: 'mail', call: 'read_inbox' };
const EXTRACT_INV = { let: 'inv', extract: { from: ref('mail'), schema: { amount: 'amount', vendor: 'text' } } };
const LOOKUP_LANDLORD = { let: 'who', lookup: { key: 'landlord' } };
const FLAG = { let: 'flag', calc: 'gt', inputs: ['2', '1'] };

const U01 = [
  READ_MAIL,
  EXTRACT_INV,
  { let: 'payee', lookup: { key: 'accountant' } },
  { action: 'transfer', args: { to: ref('payee'), amount: ref('inv', ['amount']), asset: 'near' } },
];
const U01_OWNER = "Pay the accountant's April invoice";

const check = (json: unknown): CheckedPlan => checkPlan(json);
const analyze = (json: unknown, ownerText = '', over: Partial<AnalyzeCtx> = {}): Analysis => analyzePlan(check(json), makeCtx(ownerText, over));
const codes = (a: Analysis): string[] => a.asksYou.map((x) => x.code);
const first = <T>(xs: readonly T[]): T => {
  const x = xs[0];
  assert.ok(x !== undefined, 'the list is empty');
  return x;
};

// == U01 ==
test('U01: one instance, bounded by the cap of the accountant, no errors and the preview line of the ticket', () => {
  const a = analyze(U01, U01_OWNER);
  assert.equal(a.instances.length, 1);
  const inst = first(a.instances);
  assert.deepEqual(inst.path, [3]);
  assert.equal(inst.action, 'transfer');
  assert.deepEqual(inst.target, { kind: 'near' });
  assert.equal(inst.payeeKey, ACCOUNTANT);
  assert.equal(inst.assetId, NEAR_ID);
  assert.deepEqual(inst.amount, { kind: 'data', labels: ['Untrusted:email', 'Untrusted:quarantine'], channels: ['email'] });
  assert.equal(inst.bound, near(5n));
  assert.equal(inst.boundSource, 'cap');
  assert.equal(inst.repeat, 1);
  assert.equal(inst.conditional, false);
  assert.deepEqual(a.bounds, [{ payeeKey: ACCOUNTANT, assetId: NEAR_ID, maxTotal: near(5n) }]);
  assert.equal(a.maxActions, 1);
  assert.deepEqual(a.asksYou, []);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.preview, [{ text: 'accountant, amount from the email, up to your cap 5 NEAR', payeeKey: ACCOUNTANT, assetId: NEAR_ID }]);
});

test('U01: the bound is the cap, never the hard cap, and the bytes the console signs are the five NEAR of the ticket', () => {
  const a = analyze(U01, U01_OWNER);
  assert.deepEqual(toOwnerBounds(a), [{ payee_key: ACCOUNTANT, max_total: '5000000000000000000000000' }]);
});

// == literal amounts ==
const LITERAL_PLAN = (amount: unknown) => [LOOKUP_LANDLORD, transfer(ref('who'), amount)];

test('a literal in the owner words: bound 2.5 NEAR and the line says your words', () => {
  const a = analyze(LITERAL_PLAN('2.5'), 'Pay landlord 2.5 NEAR');
  const inst = first(a.instances);
  assert.deepEqual(inst.amount, { kind: 'literal', base: 25n * 10n ** 23n, inOwnerWords: true });
  assert.equal(inst.boundSource, 'literal');
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: 25n * 10n ** 23n }]);
  assert.deepEqual(a.preview, [{ text: 'landlord 2.5 NEAR (your words)', payeeKey: LANDLORD, assetId: NEAR_ID }]);
  assert.deepEqual(a.errors, []);
});

test('the same literal without the number in the owner words has the same bound and says not in your words', () => {
  const a = analyze(LITERAL_PLAN('2.5'), 'Pay landlord');
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: 25n * 10n ** 23n }]);
  assert.equal(first(a.preview).text, 'landlord 2.5 NEAR (not in your words)');
  assert.equal(first(a.preview).text.endsWith('(not in your words)'), true);
  assert.deepEqual(first(a.instances).amount, { kind: 'literal', base: 25n * 10n ** 23n, inOwnerWords: false });
});

test('2.50 is the same bound as 2.5, and the owner words are compared by value', () => {
  const a = analyze(LITERAL_PLAN('2.50'), 'Pay landlord 2.5 NEAR');
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: 25n * 10n ** 23n }]);
  assert.equal(first(a.preview).text, 'landlord 2.5 NEAR (your words)');
});

test('an integer literal of the plan is whole units', () => {
  const a = analyze(LITERAL_PLAN(3), 'Pay landlord 3');
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: near(3n) }]);
  assert.equal(first(a.preview).text, 'landlord 3 NEAR (your words)');
});

test('abc is BadAmount with no bound, and the only instance leaves no bound at all', () => {
  const a = analyze(LITERAL_PLAN('abc'), 'Pay landlord');
  assert.deepEqual(codes(a), ['BadAmount']);
  assert.equal(first(a.asksYou).text, 'The amount to landlord is not a valid number. It will ask you.');
  assert.deepEqual(first(a.instances).amount, { kind: 'invalid' });
  assert.equal(first(a.instances).bound, 0n);
  assert.equal(first(a.instances).boundSource, 'none');
  assert.deepEqual(a.bounds, []);
  assert.deepEqual(a.errors, ['NoBounds']);
  assert.deepEqual(a.preview, []);
});

test('zero, more places than the asset has and a negative number are BadAmount, never a bound of 0', () => {
  for (const amount of ['0', '0.000', '0.0000000000000000000000001', '-1', '1e3', '', ' 1']) {
    const a = analyze(LITERAL_PLAN(amount));
    assert.deepEqual(codes(a), ['BadAmount'], `amount ${JSON.stringify(amount)}`);
    assert.deepEqual(a.bounds, []);
  }
  assert.deepEqual(codes(analyze(LITERAL_PLAN(0))), ['BadAmount']);
});

// == amounts that get no bound ==
test('an extracted amount to the landlord, whose cap is null, is NoCap: no bound, NoBounds, and toOwnerBounds throws', () => {
  const plan = [READ_MAIL, EXTRACT_INV, LOOKUP_LANDLORD, transfer(ref('who'), ref('inv', ['amount']))];
  const a = analyze(plan, 'Pay the landlord');
  assert.deepEqual(codes(a), ['NoCap']);
  assert.equal(first(a.asksYou).text, 'landlord has no cap for amounts read from the email. It will ask you.');
  assert.deepEqual(first(a.asksYou).path, [3]);
  assert.deepEqual(a.bounds, []);
  assert.equal(first(a.instances).boundSource, 'none');
  assert.deepEqual(a.errors, ['NoBounds']);
  assert.throws(
    () => toOwnerBounds(a),
    (e: unknown) => e instanceof AnalysisError && e.code === 'NoBounds',
  );
});

test('the path of an instance and the path of its ask are two arrays: a caller that edits one cannot change the other', () => {
  const plan = [READ_MAIL, EXTRACT_INV, LOOKUP_LANDLORD, transfer(ref('who'), ref('inv', ['amount']))];
  const a = analyze(plan);
  assert.deepEqual(first(a.asksYou).path, first(a.instances).path);
  assert.notEqual(first(a.asksYou).path, first(a.instances).path);
});

test('a cap of zero is no cap, so a data amount to that payee gets no bound of 0', () => {
  const b: BookView = new Map([[ACCOUNTANT, { cap: 0n, dailyUntrustedBudget: 0n, dailyLimit: near(20n), label: 'accountant' }]]);
  const a = analyze(U01, '', { book: b });
  assert.deepEqual(codes(a), ['NoCap']);
  assert.deepEqual(a.bounds, []);
});

test('an oracle-derived amount (get_price then calc mul) is DerivedAmount with no ceiling', () => {
  const plan = [
    { let: 'price', call: 'get_price', args: { asset: 'near' } },
    { let: 'total', calc: 'mul', inputs: [ref('price'), '2'] },
    LOOKUP_LANDLORD,
    transfer(ref('who'), ref('total')),
  ];
  const a = analyze(plan);
  assert.deepEqual(codes(a), ['DerivedAmount']);
  assert.equal(first(a.asksYou).text, 'The amount to landlord is calculated or comes from a price feed, with no ceiling you typed. It will ask you.');
  assert.deepEqual(first(a.instances).amount, { kind: 'calc' });
  assert.deepEqual(a.bounds, []);
});

test('a price used directly as the amount is an oracle amount, DerivedAmount, even to a payee with a cap', () => {
  const plan = [
    { let: 'price', call: 'get_price', args: { asset: 'near' } },
    { let: 'who', lookup: { key: 'accountant' } },
    transfer(ref('who'), ref('price')),
  ];
  const a = analyze(plan);
  assert.deepEqual(first(a.instances).amount, { kind: 'oracle' });
  assert.deepEqual(codes(a), ['DerivedAmount']);
  assert.deepEqual(a.bounds, []);
  assert.equal(first(a.instances).bound, 0n);
});

test('a value that is a payee or a missing alias used as the amount is derived too, never bounded', () => {
  const plan = [{ let: 'who', lookup: { key: 'accountant' } }, transfer(ref('who'), ref('who'))];
  const a = analyze(plan);
  assert.deepEqual(codes(a), ['DerivedAmount']);
  assert.deepEqual(a.bounds, []);
});

// == payees ==
const EXTRACT_WHO = { let: 'inv', extract: { from: ref('mail'), schema: { amount: 'amount', who: 'text' } } };

test('a payee chosen by a lookup keyed from an extracted field is PayeeFromData', () => {
  const plan = [READ_MAIL, EXTRACT_WHO, { let: 'p', lookup: { key: ref('inv', ['who']) } }, transfer(ref('p'), ref('inv', ['amount']))];
  const a = analyze(plan);
  assert.deepEqual(codes(a), ['PayeeFromData']);
  assert.equal(first(a.asksYou).text, 'The payee is chosen by content from the email. It will ask you.');
  assert.equal(first(a.instances).payeeKey, null);
  assert.deepEqual(a.bounds, []);
  assert.deepEqual(a.errors, ['NoBounds']);
});

test('an extracted field used directly as the payee is PayeeFromData as well, even with a literal amount', () => {
  const plan = [READ_MAIL, EXTRACT_WHO, transfer(ref('inv', ['who']), '1')];
  const a = analyze(plan);
  assert.deepEqual(codes(a), ['PayeeFromData']);
  assert.equal(first(a.instances).payeeKey, null);
  assert.deepEqual(a.bounds, []);
  assert.deepEqual(a.preview, []);
});

test('lookup of nobody is PayeeNotInBook and the line names the alias as typed in the plan', () => {
  const a = analyze([{ let: 'p', lookup: { key: 'nobody' } }, transfer(ref('p'), '1')]);
  assert.deepEqual(codes(a), ['PayeeNotInBook']);
  assert.equal(first(a.asksYou).text, 'Payment to nobody is not to an address in your book. It will ask you.');
  assert.equal(first(a.instances).payeeKey, null);
  assert.deepEqual(a.bounds, []);
  assert.deepEqual(a.preview, [{ text: 'nobody 1 NEAR (not in your words)', payeeKey: null, assetId: NEAR_ID }]);
});

test('an alias that is not plain display text is shown as an unlisted payee, never as typed', () => {
  const hostile = ['<b>x</b>', 'a'.repeat(65), '', `caf${String.fromCharCode(0xe9)}`, 'x\ny'];
  for (const key of hostile) {
    const a = analyze([{ let: 'p', lookup: { key } }, transfer(ref('p'), '1')]);
    assert.deepEqual(codes(a), ['PayeeNotInBook'], JSON.stringify(key));
    assert.equal(first(a.asksYou).text, 'Payment to an unlisted payee is not to an address in your book. It will ask you.');
    assert.equal(first(a.preview).text, 'an unlisted payee 1 NEAR (not in your words)');
  }
  const a = analyze([{ let: 'p', lookup: { key: 'my.payee_1: ok-' } }, transfer(ref('p'), '1')]);
  assert.equal(first(a.preview).text.startsWith('my.payee_1: ok- 1 NEAR'), true);
});

test('an alias that two book entries share is ambiguous, so a miss', () => {
  const b: BookView = new Map([
    [ACCOUNTANT, { cap: near(5n), dailyUntrustedBudget: 0n, dailyLimit: 0n, label: 'finance' }],
    [LANDLORD, { cap: null, dailyUntrustedBudget: 0n, dailyLimit: 0n, label: 'Finance' }],
  ]);
  const a = analyze([{ let: 'p', lookup: { key: 'finance' } }, transfer(ref('p'), '1')], '', { book: b });
  assert.deepEqual(codes(a), ['PayeeNotInBook']);
  assert.deepEqual(a.bounds, []);
});

test('a lookup key that is an integer or blank is a miss', () => {
  for (const key of [5, '   ']) {
    const a = analyze([{ let: 'p', lookup: { key } }, transfer(ref('p'), '1')]);
    assert.deepEqual(codes(a), ['PayeeNotInBook']);
    assert.deepEqual(a.bounds, []);
  }
});

test('a literal address in the book is bounded and shown with the book label; a bare account is canonical for the target', () => {
  const a = analyze([transfer('accountant.testnet', '1'), transfer('near:landlord.testnet', '2')]);
  assert.deepEqual(
    a.bounds,
    [
      { payeeKey: ACCOUNTANT, assetId: NEAR_ID, maxTotal: near(1n) },
      { payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: near(2n) },
    ],
  );
  assert.deepEqual(
    a.preview.map((p) => p.text),
    ['accountant 1 NEAR (not in your words)', 'landlord 2 NEAR (not in your words)'],
  );
  assert.deepEqual(a.instances.map((i) => i.payeeKey), [ACCOUNTANT, LANDLORD]);
});

test('a literal address that is not in the book is PayeeNotInBook with no bound, shown as an address not in your book', () => {
  const a = analyze([transfer('stranger.testnet', '1')]);
  assert.deepEqual(codes(a), ['PayeeNotInBook']);
  assert.equal(first(a.instances).payeeKey, 'near:stranger.testnet');
  assert.deepEqual(a.bounds, []);
  assert.deepEqual(a.preview, [{ text: 'an address not in your book 1 NEAR (not in your words)', payeeKey: 'near:stranger.testnet', assetId: NEAR_ID }]);
  assert.deepEqual(a.errors, ['NoBounds']);
});

test('a literal that is not an address at all is PayeeNotInBook and has no payee key', () => {
  for (const to of ['Not An Address', 'evm:84532:0x' + 'ab'.repeat(20), 7, '']) {
    const a = analyze([transfer(to, '1')]);
    assert.deepEqual(codes(a), ['PayeeNotInBook'], JSON.stringify(to));
    assert.equal(first(a.instances).payeeKey, null);
    assert.deepEqual(a.bounds, []);
  }
});

test('a payee that is an oracle value or a calculation is not an address: PayeeNotInBook', () => {
  const plan = [{ let: 'price', call: 'get_price', args: { asset: 'near' } }, transfer(ref('price'), '1')];
  const a = analyze(plan);
  assert.deepEqual(codes(a), ['PayeeNotInBook']);
  assert.deepEqual(a.bounds, []);
});

// == assets and EVM ==
test('a literal asset that is not in the registry is UnknownAsset with no bound', () => {
  const plan = [{ action: 'evm_transfer', args: { to: '0x' + 'cd'.repeat(20), amount: '0.01', asset: 'evm:1:native', chain_id: 1 } }];
  const a = analyze(plan);
  assert.deepEqual(codes(a), ['UnknownAsset']);
  assert.equal(first(a.asksYou).text, 'This asset is not in your registry. It will not be paid.');
  assert.equal(first(a.instances).assetId, 'evm:1:native');
  assert.deepEqual(a.bounds, []);
  assert.deepEqual(a.preview, []);
  assert.deepEqual(a.errors, ['NoBounds']);
});

test('an EVM payment to the contractor is bounded in wei and the key implies the asset', () => {
  const plan = [{ let: 'c', lookup: { key: 'contractor' } }, { action: 'evm_transfer', args: { to: ref('c'), amount: '0.01', asset: ETH_ID, chain_id: 84532 } }];
  const a = analyze(plan, 'Pay the contractor 0.01');
  assert.deepEqual(a.bounds, [{ payeeKey: CONTRACTOR, assetId: ETH_ID, maxTotal: WEI / 100n }]);
  assert.deepEqual(first(a.instances).target, { kind: 'evm', chain_id: 84532 });
  assert.equal(first(a.preview).text, 'contractor 0.01 ETH.base (your words)');
  assert.deepEqual(a.errors, []);
});

test('an EVM literal address is canonicalised before it is matched with the book', () => {
  const plan = [{ action: 'evm_transfer', args: { to: '0x' + 'AB'.repeat(20), amount: '0.01', asset: ETH_ID, chain_id: 84532 } }];
  const a = analyze(plan);
  assert.equal(first(a.instances).payeeKey, CONTRACTOR);
  assert.deepEqual(a.bounds, [{ payeeKey: CONTRACTOR, assetId: ETH_ID, maxTotal: WEI / 100n }]);
});

test('a data amount to the contractor is bounded by its cap of 0.02 ETH', () => {
  const plan = [
    READ_MAIL,
    EXTRACT_INV,
    { let: 'c', lookup: { key: 'contractor' } },
    { action: 'evm_transfer', args: { to: ref('c'), amount: ref('inv', ['amount']), asset: ETH_ID, chain_id: 84532 } },
  ];
  const a = analyze(plan);
  assert.deepEqual(a.bounds, [{ payeeKey: CONTRACTOR, assetId: ETH_ID, maxTotal: WEI / 50n }]);
  assert.equal(first(a.preview).text, 'contractor, amount from the email, up to your cap 0.02 ETH.base');
});

test('a NEAR transfer to an EVM payee, or the other way round, has no bound: the contract would revert asset does not match payee', () => {
  const plan = [{ let: 'c', lookup: { key: 'contractor' } }, transfer(ref('c'), '0.01')];
  const a = analyze(plan);
  assert.deepEqual(codes(a), ['PayeeNotInBook']);
  assert.deepEqual(a.bounds, []);
  const other = [{ let: 'l', lookup: { key: 'landlord' } }, { action: 'evm_transfer', args: { to: ref('l'), amount: '0.01', asset: ETH_ID, chain_id: 84532 } }];
  assert.deepEqual(codes(analyze(other)), ['PayeeNotInBook']);
});

// == loops ==
test('a loop of 3 pays the landlord 0.1: 3 instances, one bound of 0.3 NEAR and the total in the line', () => {
  const plan = [READ_MAIL, { for: 'item', in: ref('mail'), max: 3, do: [transfer('landlord.testnet', '0.1')] }];
  const a = analyze(plan, 'Pay landlord 0.1 NEAR');
  assert.equal(a.instances.length, 1);
  assert.equal(first(a.instances).repeat, 3);
  assert.deepEqual(first(a.instances).path, [1, 'do', 0]);
  assert.equal(first(a.instances).bound, 10n ** 23n);
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: 3n * 10n ** 23n }]);
  assert.equal(a.maxActions, 3);
  assert.equal(first(a.preview).text, 'landlord 0.1 NEAR (your words), up to 3 times, 0.3 NEAR in total');
  assert.equal(first(a.preview).text.endsWith(', up to 3 times, 0.3 NEAR in total'), true);
  assert.deepEqual(a.errors, []);
});

test('a loop over mail with an extracted amount is bounded by cap times the loop max', () => {
  const plan = [
    READ_MAIL,
    {
      for: 'item',
      in: ref('mail'),
      max: 3,
      do: [
        { let: 'inv', extract: { from: ref('item'), schema: { amount: 'amount' } } },
        { let: 'who', lookup: { key: 'accountant' } },
        transfer(ref('who'), ref('inv', ['amount'])),
      ],
    },
  ];
  const a = analyze(plan);
  assert.deepEqual(a.bounds, [{ payeeKey: ACCOUNTANT, assetId: NEAR_ID, maxTotal: near(15n) }]);
  assert.equal(first(a.preview).text, 'accountant, amount from the email, up to your cap 5 NEAR, up to 3 times, 15 NEAR in total');
  assert.deepEqual(first(a.instances).amount, { kind: 'data', labels: ['Untrusted:email', 'Untrusted:quarantine'], channels: ['email'] });
});

test('a loop of 20 with two actions is 40 payments: TooManyActions and one item that says so', () => {
  const plan = [READ_MAIL, { for: 'item', in: ref('mail'), max: 20, do: [transfer('landlord.testnet', '0.1'), transfer('accountant.testnet', '0.1')] }];
  const a = analyze(plan);
  assert.equal(a.maxActions, 40);
  assert.deepEqual(a.errors, ['TooManyActions']);
  const items = a.asksYou.filter((x) => x.code === 'TooManyActions');
  assert.equal(items.length, 1);
  assert.equal(first(items).text, 'This plan can make 40 payments and one task allows 20. Split it.');
  assert.deepEqual(first(items).path, []);
  assert.equal(a.instances.reduce((n, i) => n + i.repeat, 0), 40);
  assert.throws(
    () => toOwnerBounds(a),
    (e: unknown) => e instanceof AnalysisError && e.code === 'TooManyActions',
  );
});

test('20 payments are allowed and 21 are not, with the limit read from the context', () => {
  const loop = (max: number) => [READ_MAIL, { for: 'item', in: ref('mail'), max, do: [transfer('landlord.testnet', '0.1')] }];
  assert.deepEqual(analyze(loop(20)).errors, []);
  assert.deepEqual(analyze(loop(20), '', { limits: { maxTaskActions: 19, maxTaskTtlMs: 1n } }).errors, ['TooManyActions']);
  assert.deepEqual(analyze(loop(3), '', { limits: { maxTaskActions: 3, maxTaskTtlMs: 1n } }).errors, []);
});

test('two for steps are UnsupportedShape and nothing else, and toOwnerBounds throws with that code', () => {
  const loop = (name: string) => ({ for: name, in: ref('mail'), max: 2, do: [transfer('landlord.testnet', '1')] });
  const a = analyze([READ_MAIL, loop('a'), loop('b')]);
  assert.deepEqual(a, { instances: [], bounds: [], maxActions: 0, asksYou: [], preview: [], errors: ['UnsupportedShape'] });
  assert.throws(
    () => toOwnerBounds(a),
    (e: unknown) => e instanceof AnalysisError && e.code === 'UnsupportedShape',
  );
});

test('two for steps are counted wherever they are: one in each branch of an if is two loops', () => {
  const loop = (name: string) => ({ for: name, in: ref('mail'), max: 2, do: [transfer('landlord.testnet', '1')] });
  const plan = [READ_MAIL, FLAG, { if: ref('flag'), then: [loop('a')], else: [loop('b')] }];
  assert.deepEqual(analyze(plan).errors, ['UnsupportedShape']);
  const one = [READ_MAIL, FLAG, { if: ref('flag'), then: [loop('a')], else: [] }];
  const a = analyze(one);
  assert.deepEqual(a.errors, []);
  assert.equal(first(a.instances).conditional, true);
  assert.equal(first(a.instances).repeat, 2);
});

// == totals ==
test('two actions to the accountant, 1 and 2, merge into one bound of 3 NEAR', () => {
  const plan = [{ let: 'who', lookup: { key: 'accountant' } }, transfer(ref('who'), '1'), transfer(ref('who'), '2')];
  const a = analyze(plan);
  assert.deepEqual(a.bounds, [{ payeeKey: ACCOUNTANT, assetId: NEAR_ID, maxTotal: near(3n) }]);
  assert.equal(a.instances.length, 2);
  assert.equal(a.maxActions, 2);
  assert.equal(a.preview.length, 2);
});

const payeeBook = (n: number): BookView => new Map(Array.from({ length: n }, (_, i) => [`near:payee${String(i).padStart(2, '0')}.testnet`, { cap: null, dailyUntrustedBudget: 0n, dailyLimit: near(20n), label: `payee${i}` }] as const));
const payAll = (n: number, amount: string) => Array.from({ length: n }, (_, i) => transfer(`payee${String(i).padStart(2, '0')}.testnet`, amount));

test('16 distinct book payees fit one task and 17 are TooManyBounds', () => {
  const sixteen = analyze(payAll(16, '1'), '', { book: payeeBook(16) });
  assert.equal(sixteen.bounds.length, 16);
  assert.deepEqual(sixteen.errors, []);
  const seventeen = analyze(payAll(17, '1'), '', { book: payeeBook(17) });
  assert.equal(seventeen.bounds.length, 17);
  assert.deepEqual(seventeen.errors, ['TooManyBounds']);
  assert.throws(
    () => toOwnerBounds(seventeen),
    (e: unknown) => e instanceof AnalysisError && e.code === 'TooManyBounds',
  );
});

test('both branches of an if are counted and their instances are conditional', () => {
  const plan = [FLAG, { if: ref('flag'), then: [transfer('landlord.testnet', '1')], else: [transfer('accountant.testnet', '2')] }];
  const a = analyze(plan);
  assert.equal(a.instances.length, 2);
  assert.deepEqual(a.instances.map((i) => i.conditional), [true, true]);
  assert.deepEqual(a.instances.map((i) => i.path), [[1, 'then', 0], [1, 'else', 0]]);
  assert.equal(a.maxActions, 2);
  assert.deepEqual(a.bounds, [
    { payeeKey: ACCOUNTANT, assetId: NEAR_ID, maxTotal: near(2n) },
    { payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: near(1n) },
  ]);
  assert.deepEqual(
    a.preview.map((p) => p.text),
    ['landlord 1 NEAR (not in your words) (if its condition holds)', 'accountant 2 NEAR (not in your words) (if its condition holds)'],
  );
});

test('a loop inside an if puts the loop total before the condition note', () => {
  const plan = [READ_MAIL, FLAG, { if: ref('flag'), then: [{ for: 'item', in: ref('mail'), max: 2, do: [transfer('landlord.testnet', '1')] }], else: [] }];
  const a = analyze(plan);
  assert.equal(first(a.preview).text, 'landlord 1 NEAR (not in your words), up to 2 times, 2 NEAR in total (if its condition holds)');
});

test('a payee with a bounded and an unbounded instance keeps the bound of the bounded one only', () => {
  const plan = [READ_MAIL, EXTRACT_INV, LOOKUP_LANDLORD, transfer(ref('who'), '1'), transfer(ref('who'), ref('inv', ['amount']))];
  const a = analyze(plan);
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: near(1n) }]);
  assert.deepEqual(codes(a), ['NoCap']);
  assert.deepEqual(a.errors, []);
  assert.equal(a.maxActions, 2);
});

test('a plan with no payment at all has maxActions 1 and NoBounds', () => {
  const a = analyze([READ_MAIL, { say: ref('mail') }]);
  assert.deepEqual(a.instances, []);
  assert.equal(a.maxActions, 1);
  assert.deepEqual(a.errors, ['NoBounds']);
});

// == the contract's limits, mirrored ==
test('60 NEAR to the landlord stays in the bounds and adds ExceedsQuickCap', () => {
  const a = analyze(LITERAL_PLAN('60'));
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: near(60n) }]);
  assert.deepEqual(a.errors, ['ExceedsQuickCap']);
  assert.deepEqual(a.asksYou, []);
  assert.throws(
    () => toOwnerBounds(a),
    (e: unknown) => e instanceof AnalysisError && e.code === 'ExceedsQuickCap',
  );
});

test('exactly the quick cap is fine and one yocto above it is not', () => {
  assert.deepEqual(analyze(LITERAL_PLAN('50')).errors, []);
  assert.deepEqual(analyze(LITERAL_PLAN('50.000000000000000000000001')).errors, ['ExceedsQuickCap']);
});

test('two actions of 90 NEAR total 180, at most 100 times 2: the bound stays and ExceedsQuickCap is added', () => {
  const a = analyze([LOOKUP_LANDLORD, transfer(ref('who'), '90'), transfer(ref('who'), '90')]);
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: near(180n) }]);
  assert.deepEqual(a.errors, ['ExceedsQuickCap']);
  assert.deepEqual(a.asksYou, []);
});

test('one action of 150 NEAR is above 100 times 1: no bound, OverHardCap, and no ExceedsQuickCap', () => {
  const a = analyze(LITERAL_PLAN('150'));
  assert.deepEqual(a.bounds, []);
  assert.deepEqual(codes(a), ['OverHardCap']);
  assert.equal(first(a.asksYou).text, '150 NEAR to landlord is above the hard cap and will be blocked.');
  assert.deepEqual(a.errors, ['NoBounds']);
});

test('the hard cap itself is allowed and one yocto above it loses the bound', () => {
  const at = analyze(LITERAL_PLAN('100'));
  assert.deepEqual(at.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: near(100n) }]);
  assert.deepEqual(at.errors, ['ExceedsQuickCap']);
  const over = analyze(LITERAL_PLAN('100.000000000000000000000001'));
  assert.deepEqual(over.bounds, []);
  assert.deepEqual(codes(over), ['OverHardCap']);
});

test('a bound at u128 max is never signed, even when the hard cap would allow it', () => {
  const big = (hardCap: bigint): AssetRegistry =>
    new Map([[NEAR_ID, { symbol: 'T', decimals: 0, hardCap, dailyCap: U128_MAX, quickTaskCap: U128_MAX, maxFeePerGas: 0n, maxGas: 0n, path: null }]]);
  const max = analyze(LITERAL_PLAN(U128_MAX.toString()), '', { registry: big(U128_MAX) });
  assert.deepEqual(max.bounds, []);
  assert.deepEqual(codes(max), ['OverHardCap']);
  const below = analyze(LITERAL_PLAN((U128_MAX - 1n).toString()), '', { registry: big(U128_MAX) });
  assert.deepEqual(below.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: U128_MAX - 1n }]);
});

test('the loop count enters the hard cap check: 3 times 40 is 120 NEAR, above one hard cap but not above three, so the bound stays', () => {
  const plan = [READ_MAIL, { for: 'item', in: ref('mail'), max: 3, do: [transfer('landlord.testnet', '40')] }];
  const a = analyze(plan);
  assert.deepEqual(a.bounds, [{ payeeKey: LANDLORD, assetId: NEAR_ID, maxTotal: near(120n) }]);
  assert.deepEqual(a.errors, ['ExceedsQuickCap']);
});

test('the errors come in the order TooManyActions, TooManyBounds, ExceedsQuickCap, NoBounds', () => {
  const ctx: Partial<AnalyzeCtx> = { book: payeeBook(17), limits: { maxTaskActions: 5, maxTaskTtlMs: 1n } };
  const a = analyze(payAll(17, '60'), '', ctx);
  assert.deepEqual(a.errors, ['TooManyActions', 'TooManyBounds', 'ExceedsQuickCap']);
  const none = analyze([READ_MAIL], '', { limits: { maxTaskActions: 0, maxTaskTtlMs: 1n } });
  assert.deepEqual(none.errors, ['NoBounds']);
});

// == channels and labels ==
test('every tool channel has its word: the label of the tool decides it and a tool with no outside channel says the reader', () => {
  const cases: [string, unknown, string][] = [
    ['read_inbox', {}, 'email'],
    ['read_attachment', { name: 'invoice.pdf' }, 'file'],
    ['read_feed', {}, 'social post'],
    ['fetch_url', { url: 'https://example.test/a' }, 'web page'],
    ['memory_read', {}, 'memory'],
    ['list_tokens', {}, 'tool output'],
    ['get_tx_history', {}, 'tool output'],
    ['read_paste', {}, 'pasted text'],
    ['fetch_paid', { url: 'https://example.test/paid' }, 'payment response'],
  ];
  for (const [tool, args, word] of cases) {
    const plan = [
      { let: 'src', call: tool, args },
      { let: 'inv', extract: { from: ref('src'), schema: { amount: 'amount' } } },
      LOOKUP_LANDLORD,
      transfer(ref('who'), ref('inv', ['amount'])),
    ];
    const a = analyze(plan);
    assert.equal(first(a.asksYou).text, `landlord has no cap for amounts read from the ${word}. It will ask you.`, tool);
  }
});

test('an extraction from an oracle value has no outside channel: the text says the reader and the seals are Oracle and quarantine', () => {
  const plan = [
    { let: 'price', call: 'get_price', args: { asset: 'near' } },
    { let: 'inv', extract: { from: ref('price'), schema: { amount: 'amount' } } },
    { let: 'who', lookup: { key: 'accountant' } },
    transfer(ref('who'), ref('inv', ['amount'])),
  ];
  const a = analyze(plan);
  assert.deepEqual(first(a.instances).amount, { kind: 'data', labels: ['Oracle', 'Untrusted:quarantine'], channels: [] });
  assert.equal(first(a.preview).text, 'accountant, amount from the reader, up to your cap 5 NEAR');
});

test('a Book-labelled tool output is data too, never a trusted amount', () => {
  const plan = [
    { let: 'ab', call: 'address_book' },
    { let: 'who', lookup: { key: 'accountant' } },
    transfer(ref('who'), ref('ab', ['x'])),
  ];
  const a = analyze(plan);
  assert.deepEqual(first(a.instances).amount, { kind: 'data', labels: ['Book'], channels: [] });
  assert.equal(first(a.instances).boundSource, 'cap');
});

test('a calculation keeps the channels of its inputs through a later extraction', () => {
  const plan = [
    READ_MAIL,
    { let: 'page', call: 'fetch_url', args: { url: 'https://example.test/a' } },
    { let: 'a', extract: { from: ref('mail'), schema: { amount: 'amount' } } },
    { let: 'b', extract: { from: ref('page'), schema: { amount: 'amount' } } },
    { let: 'c', calc: 'sum', inputs: [ref('a', ['amount']), ref('b', ['amount'])] },
    { let: 'd', extract: { from: ref('c'), schema: { amount: 'amount' } } },
    LOOKUP_LANDLORD,
    transfer(ref('who'), ref('d', ['amount'])),
  ];
  const a = analyze(plan);
  assert.equal(first(a.asksYou).text, 'landlord has no cap for amounts read from the email and web page. It will ask you.');
  const amount = first(a.instances).amount;
  assert.ok(amount.kind === 'data');
  assert.deepEqual(amount.labels, ['Untrusted:email', 'Untrusted:web', 'Untrusted:quarantine']);
});

test('the word table: chat is a channel word too, and quarantine is never one', () => {
  assert.deepEqual(channelWords(['Untrusted:chat']), ['chat']);
  assert.deepEqual(channelWords(['Untrusted:quarantine']), []);
  assert.deepEqual(channelWords(['Untrusted:other', 'Untrusted:email', 'Untrusted:email', 'Owner', 'Book']), ['email', 'pasted text']);
});

test('a loop variable carries the channels of its list, and an oracle list gives an oracle element', () => {
  const over = (list: string, src: unknown) => [
    src,
    { for: 'item', in: ref(list), max: 2, do: [{ let: 'who', lookup: { key: 'accountant' } }, transfer(ref('who'), ref('item'))] },
  ];
  const mail = analyze(over('mail', READ_MAIL));
  assert.deepEqual(first(mail.instances).amount, { kind: 'data', labels: ['Untrusted:email'], channels: ['email'] });
  assert.equal(first(mail.preview).text, 'accountant, amount from the email, up to your cap 5 NEAR, up to 2 times, 10 NEAR in total');
  const bal = analyze(over('bal', { let: 'bal', call: 'get_balance', args: { asset: 'near' } }));
  assert.deepEqual(first(bal.instances).amount, { kind: 'oracle' });
  assert.deepEqual(codes(bal), ['DerivedAmount']);
});

// == hostile and edge shapes ==
test('a name that is a property of Object is just a name', () => {
  const plan = [
    { let: 'constructor', call: 'read_inbox' },
    { let: 'inv', extract: { from: ref('constructor'), schema: { amount: 'amount' } } },
    { let: 'valueof', lookup: { key: 'constructor' } },
    transfer(ref('valueof'), ref('inv', ['amount'])),
  ];
  const a = analyze(plan);
  assert.deepEqual(codes(a), ['PayeeNotInBook']);
  assert.deepEqual(analyze([{ let: 'constructor', lookup: { key: 'accountant' } }, transfer(ref('constructor'), '1')]).bounds.length, 1);
});

test('the analysis does not change a frozen plan or a frozen context, and the same input gives the same output', () => {
  const plan = check(U01);
  const freeze = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || Object.isFrozen(v)) return;
    Object.freeze(v);
    for (const child of Object.values(v)) freeze(child);
  };
  freeze(plan);
  const ctx = makeCtx(U01_OWNER);
  Object.freeze(ctx);
  const one = analyzePlan(plan, ctx);
  const two = analyzePlan(plan, ctx);
  assert.deepEqual(one, two);
  assert.notEqual(one.bounds, two.bounds);
});

test('a book label that is not display text is shown as the payee key instead', () => {
  const b: BookView = new Map([[ACCOUNTANT, { cap: near(5n), dailyUntrustedBudget: 0n, dailyLimit: 0n, label: 'acc<script>' }]]);
  const a = analyze([transfer('accountant.testnet', '1')], '', { book: b });
  assert.equal(first(a.preview).text, 'near:accountant.testnet 1 NEAR (not in your words)');
});

test('maxActionsFor needs no context: the sum of the loop maxima, at least 1', () => {
  assert.equal(maxActionsFor(check(U01)), 1);
  assert.equal(maxActionsFor(check([READ_MAIL, { say: ref('mail') }])), 1);
  assert.equal(maxActionsFor(check([READ_MAIL, { for: 'item', in: ref('mail'), max: 3, do: [transfer('landlord.testnet', '1')] }])), 3);
  assert.equal(maxActionsFor(check([READ_MAIL, { for: 'item', in: ref('mail'), max: 20, do: [transfer('landlord.testnet', '1'), transfer('landlord.testnet', '1')] }])), 40);
  assert.equal(maxActionsFor(check([FLAG, { if: ref('flag'), then: [transfer('a1.testnet', '1')], else: [transfer('a2.testnet', '1'), transfer('a3.testnet', '1')] }])), 3);
  const twoLoops = [READ_MAIL, { for: 'a', in: ref('mail'), max: 3, do: [transfer('landlord.testnet', '1')] }, { for: 'b', in: ref('mail'), max: 2, do: [transfer('landlord.testnet', '1')] }];
  assert.equal(maxActionsFor(check(twoLoops)), 5);
});

// == toOwnerBounds ==
test('toOwnerBounds sorts by payee key, never emits 0 and every key passes validatePayeeKey', () => {
  const plan = [
    transfer('landlord.testnet', '2'),
    { action: 'evm_transfer', args: { to: '0x' + 'ab'.repeat(20), amount: '0.01', asset: ETH_ID, chain_id: 84532 } },
    transfer('accountant.testnet', '1'),
  ];
  const a = analyze(plan);
  const bounds = toOwnerBounds(a);
  assert.deepEqual(
    bounds.map((b) => b.payee_key),
    [CONTRACTOR, ACCOUNTANT, LANDLORD],
  );
  assert.deepEqual(bounds.map((b) => b.max_total), ['10000000000000000', near(1n).toString(), near(2n).toString()]);
  for (const b of bounds) {
    validatePayeeKey(b.payee_key);
    assert.notEqual(b.max_total, '0');
    assert.match(b.max_total, /^[1-9][0-9]*$/);
  }
});

test('toOwnerBounds refuses an analysis it cannot sign: a zero bound, a bad key, or no bound at all', () => {
  const base = analyze(U01, U01_OWNER);
  const mutate = (bounds: Analysis['bounds']): Analysis => ({ ...base, bounds });
  assert.throws(() => toOwnerBounds(mutate([{ payeeKey: ACCOUNTANT, assetId: NEAR_ID, maxTotal: 0n }])), AnalysisError);
  assert.throws(() => toOwnerBounds(mutate([])), AnalysisError);
  assert.throws(() => toOwnerBounds(mutate([{ payeeKey: 'Near:Accountant', assetId: NEAR_ID, maxTotal: 1n }])), AnalysisError);
});

test('the bounds of an analysis make an OwnerTask the borsh encoder accepts', () => {
  const task: OwnerTask = {
    tag: TASK_TAG,
    task_id: 'task-1',
    contract_id: 'policy.test.near',
    agent_id: 'agent.test.near',
    plan_sha256: 'a'.repeat(64),
    instruction_sha256_salted: 'b'.repeat(64),
    issued_ms: 1,
    expires_ms: 2,
    max_actions: analyze(U01).maxActions,
    bounds: toOwnerBounds(analyze(U01)),
  };
  assert.ok(ownerTaskBorsh(task).length > 0);
});

// == converters ==
const BIG = '9007199254740993';

test('bookFromRows turns the strings of get_book into bigint exactly, a value above 2^53 included', () => {
  const view = bookFromRows([
    [ACCOUNTANT, { cap: BIG, daily_untrusted_budget: U128_MAX.toString(), daily_limit: '0', label: 'accountant' }],
    [LANDLORD, { cap: null, daily_untrusted_budget: '7', daily_limit: '8', label: 'landlord' }],
  ]);
  assert.deepEqual(view.get(ACCOUNTANT), { cap: 9007199254740993n, dailyUntrustedBudget: U128_MAX, dailyLimit: 0n, label: 'accountant' });
  assert.deepEqual(view.get(LANDLORD), { cap: null, dailyUntrustedBudget: 7n, dailyLimit: 8n, label: 'landlord' });
  assert.equal(view.size, 2);
});

// the last but one is two Arabic-Indic digits: digits to a human, not to the contract
const NOT_DIGITS = ['12a', '', '-1', ' 5', '5 ', '1e3', '0x10', '1.5', '+5', String.fromCharCode(0x661, 0x662), '1_000'];

test('bookFromRows rejects a value that is not digits, a number, and a value above u128', () => {
  const row = (over: Record<string, unknown>) => [[ACCOUNTANT, { cap: '1', daily_untrusted_budget: '1', daily_limit: '1', label: 'a', ...over }]] as never;
  for (const bad of [...NOT_DIGITS, (U128_MAX + 1n).toString(), '1'.repeat(40)]) {
    for (const field of ['cap', 'daily_untrusted_budget', 'daily_limit']) {
      assert.throws(() => bookFromRows(row({ [field]: bad })), CtxError, `${field} ${JSON.stringify(bad)}`);
    }
  }
  for (const field of ['cap', 'daily_untrusted_budget', 'daily_limit']) assert.throws(() => bookFromRows(row({ [field]: 5 })), CtxError);
  assert.throws(() => bookFromRows(row({ label: 5 })), CtxError);
  assert.throws(() => bookFromRows(row({ daily_limit: null })), CtxError);
});

test('bookFromRows rejects a key that is not canonical and a key that appears twice', () => {
  const entry = { cap: null, daily_untrusted_budget: '0', daily_limit: '0', label: 'a' };
  assert.throws(() => bookFromRows([['Near:Accountant', entry]]), CtxError);
  assert.throws(() => bookFromRows([[ACCOUNTANT, entry], [ACCOUNTANT, entry]]), CtxError);
  assert.equal(bookFromRows([]).size, 0);
});

const ENTRY: AssetEntryViewJson = {
  symbol: 'ETH.base',
  decimals: 18,
  hard_cap: '100000000000000000',
  daily_cap: '1000000000000000000',
  max_fee_per_gas: '2000000000',
  max_gas: '100000',
  quick_task_cap: '50000000000000000',
  path: 'airlock-demo-1',
};

test('registryFromRows converts every u128 string and keeps the path', () => {
  const view = registryFromRows([
    [ETH_ID, ENTRY],
    [NEAR_ID, { ...ENTRY, symbol: 'NEAR', decimals: 24, hard_cap: BIG, path: null }],
  ]);
  assert.deepEqual(view.get(ETH_ID), registry().get(ETH_ID));
  assert.equal(view.get(NEAR_ID)?.hardCap, 9007199254740993n);
  assert.equal(view.get(NEAR_ID)?.path, null);
});

test('registryFromRows rejects a non-digit string in any u128 field, a decimals outside 0 to 38 and a repeated id', () => {
  for (const field of ['hard_cap', 'daily_cap', 'max_fee_per_gas', 'max_gas', 'quick_task_cap']) {
    for (const bad of [...NOT_DIGITS, (U128_MAX + 1n).toString()]) {
      assert.throws(() => registryFromRows([[ETH_ID, { ...ENTRY, [field]: bad }]]), CtxError, `${field} ${JSON.stringify(bad)}`);
    }
  }
  for (const decimals of [-1, 39, 1.5, Number.NaN]) assert.throws(() => registryFromRows([[ETH_ID, { ...ENTRY, decimals }]]), CtxError, String(decimals));
  assert.throws(() => registryFromRows([[ETH_ID, ENTRY], [ETH_ID, ENTRY]]), CtxError);
  assert.throws(() => registryFromRows([[ETH_ID, { ...ENTRY, symbol: 5 as never }]]), CtxError);
  assert.equal(registryFromRows([[ETH_ID, { ...ENTRY, decimals: 0 }]]).get(ETH_ID)?.decimals, 0);
  assert.equal(registryFromRows([[ETH_ID, { ...ENTRY, decimals: 38 }]]).get(ETH_ID)?.decimals, 38);
});

test('limitsFromPolicy reads the two limits, the ttl as an exact bigint', () => {
  assert.deepEqual(limitsFromPolicy({ flags: { max_task_actions: 20, max_task_ttl_ms: '3600000' } }), { maxTaskActions: 20, maxTaskTtlMs: 3_600_000n });
  assert.equal(limitsFromPolicy({ flags: { max_task_actions: 1, max_task_ttl_ms: '18446744073709551615' } }).maxTaskTtlMs, 18446744073709551615n);
});

test('limitsFromPolicy rejects a ttl that is not digits or above u64, and an action count that is not a whole number', () => {
  for (const bad of [...NOT_DIGITS, '18446744073709551616']) {
    assert.throws(() => limitsFromPolicy({ flags: { max_task_actions: 20, max_task_ttl_ms: bad } }), CtxError, JSON.stringify(bad));
  }
  for (const n of [-1, 1.5, Number.NaN, 2 ** 60]) assert.throws(() => limitsFromPolicy({ flags: { max_task_actions: n, max_task_ttl_ms: '1' } }), CtxError, String(n));
  assert.throws(() => limitsFromPolicy({ flags: { max_task_actions: 20, max_task_ttl_ms: 5 as never } }), CtxError);
});

test('the converters take the real shapes of the views: a registry and a book from rows make a context the analyzer accepts', () => {
  const ctx: AnalyzeCtx = {
    ownerText: U01_OWNER,
    book: bookFromRows([[ACCOUNTANT, { cap: near(5n).toString(), daily_untrusted_budget: '0', daily_limit: '0', label: 'accountant' }]]),
    registry: registryFromRows([[NEAR_ID, { ...ENTRY, symbol: 'NEAR', decimals: 24, hard_cap: near(100n).toString(), quick_task_cap: near(50n).toString(), path: null }]]),
    limits: limitsFromPolicy({ flags: { max_task_actions: 20, max_task_ttl_ms: '3600000' } }),
  };
  const a = analyzePlan(check(U01), ctx);
  assert.deepEqual(a.bounds, [{ payeeKey: ACCOUNTANT, assetId: NEAR_ID, maxTotal: near(5n) }]);
  assert.deepEqual(a.errors, []);
});

// == inOwnerWords (the rows AIR-127 pins again) ==
test('inOwnerWords, amount mode: a number of the owner text equal by value after toBaseUnits', () => {
  assert.equal(inOwnerWords('25', 'Pay 25 to landlord', 24), true);
  assert.equal(inOwnerWords(25, 'Pay 25.0 to landlord', 24), true);
  assert.equal(inOwnerWords('25', 'Pay 5 to landlord', 24), false);
  assert.equal(inOwnerWords('2.50', 'Pay 2.5', 24), true);
  assert.equal(inOwnerWords('25', 'Pay twenty five', 24), false);
  assert.equal(inOwnerWords('25', '', 24), false);
});

test('inOwnerWords, amount mode: more places than the asset has, a bad literal and a bad number are false, never a throw', () => {
  assert.equal(inOwnerWords('0.0000000000000000000000001', 'Pay 0.0000000000000000000000001', 24), false);
  assert.equal(inOwnerWords('abc', 'Pay 5', 24), false);
  assert.equal(inOwnerWords(-5, 'Pay 5', 24), false);
  assert.equal(inOwnerWords(1.5, 'Pay 1.5', 24), false);
  assert.equal(inOwnerWords('5', 'Pay 5', 99), false);
  assert.equal(inOwnerWords('25', 'Pay 0.0000000000000000000000001 and 25', 24), true);
});

test('inOwnerWords, name mode: a whole word, case-insensitive in ASCII', () => {
  assert.equal(inOwnerWords('landlord', 'Pay my Landlord 5'), true);
  assert.equal(inOwnerWords('landlord', 'pay my landlords'), false);
  assert.equal(inOwnerWords('landlord', 'pay mylandlord'), false);
  assert.equal(inOwnerWords('landlord', 'landlord'), true);
  assert.equal(inOwnerWords('LANDLORD', 'pay the landlord.'), true);
  assert.equal(inOwnerWords('landlord', 'pay landlord_2'), false);
  assert.equal(inOwnerWords('', 'pay landlord'), false);
  assert.equal(inOwnerWords('landlord', ''), false);
  assert.equal(inOwnerWords('5', 'Pay 15'), false);
  assert.equal(inOwnerWords(5, 'Pay 5 to landlord'), true);
});

test('inOwnerWords, name mode: a character outside ASCII is never folded to an ASCII letter', () => {
  const kelvin = String.fromCharCode(0x212a);
  assert.equal(inOwnerWords('kelvin', `pay ${kelvin}elvin`), false);
  assert.equal(inOwnerWords(`${kelvin}elvin`, 'pay kelvin'), false);
  assert.equal(inOwnerWords(`${kelvin}elvin`, `pay ${kelvin}elvin`), true);
});

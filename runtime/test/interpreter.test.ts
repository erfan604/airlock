// AIR-121: the labelled interpreter. One test per row; plans are written as JSON and pass through checkPlan, so every plan here
// satisfies rule 12. The Tools label is trusted by the interpreter, the table behind it is AIR-124's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPcTrusted, isTrusted, isValueTrusted, labelsToBits } from '../src/dsl/index.ts';
import type { LabelName } from '../src/dsl/index.ts';
import { defaultToolArgPolicy, join, lit, run, sortedLabels } from '../src/interpreter/index.ts';
import { derive } from '../src/interpreter/value.ts';
import type { LVal, Proposed, TraceEvent } from '../src/interpreter/index.ts';
import { READ_MAIL, abortOf, extractFrom, makeDeps, okOf, pay, plan, proposedOf, ref, runPlan, stubBook, stubExtract, stubTools } from './helpers/interp.ts';

const NEAR = 10n ** 24n;
const AMOUNT_FROM_MAIL = [READ_MAIL, extractFrom('inv', 'mail', { amount: 'amount' }), pay('alice.testnet', ref('inv', ['amount']))];
const bits = (names: readonly string[]) => labelsToBits(names);

// ---- R1: literals ----
test('R1: a literal transfer proposes the canonical payee and base units with Owner labels', async () => {
  const [p] = await proposedOf([pay('alice.testnet', '1')]);
  assert.ok(p !== undefined);
  assert.equal(p.action, 'transfer');
  assert.deepEqual(p.target, { kind: 'near' });
  assert.equal(p.payee, 'near:alice.testnet');
  assert.equal(p.asset, 'near');
  assert.equal(p.amount, NEAR);
  assert.deepEqual(p.recipientLabels, ['Owner']);
  assert.deepEqual(p.amountLabels, ['Owner']);
  assert.deepEqual(p.pc, ['Owner']);
  assert.deepEqual(p.origins, { recipient: [], amount: [], pc: [] });
});

test('R1: an ungrounded literal is Owner plus Unresolved on both values and the pc stays Owner', async () => {
  const [p] = await proposedOf([pay('alice.testnet', '1')], { ground: () => false });
  assert.deepEqual(p?.recipientLabels, ['Owner', 'Unresolved']);
  assert.deepEqual(p?.amountLabels, ['Owner', 'Unresolved']);
  assert.deepEqual(p?.pc, ['Owner']);
});

test('R1: the ground hook decides at exactly three sites, with the kind, the owner text and the decimals', async () => {
  const seen: { lit: string | number; kind: string; ownerText: string | undefined; decimals: number | undefined }[] = [];
  const ground = (l: string | number, kind: string, ctx: { ownerText: string | undefined; decimals?: number }) => {
    seen.push({ lit: l, kind, ownerText: ctx.ownerText, decimals: ctx.decimals });
    return true;
  };
  await runPlan(
    [
      { let: 'p', lookup: { key: 'accountant' } },
      { let: 'sum', calc: 'sum', inputs: [1, 2] },
      { say: 'hello' },
      { let: 'mail', call: 'read_inbox', args: { folder: 'inbox' } },
      pay('alice.testnet', '4.2'),
    ],
    { ground: ground as never, ownerText: 'pay alice 4.2' },
  );
  assert.deepEqual(seen, [
    { lit: 'accountant', kind: 'name', ownerText: 'pay alice 4.2', decimals: undefined },
    { lit: 'alice.testnet', kind: 'address', ownerText: 'pay alice 4.2', decimals: undefined },
    { lit: '4.2', kind: 'amount', ownerText: 'pay alice 4.2', decimals: 24 },
  ]);
});

test('R1: a reference at a ground site is not grounded (only literals are)', async () => {
  let calls = 0;
  await runPlan([{ let: 'a', calc: 'sum', inputs: [1, 0] }, pay('alice.testnet', ref('a'))], {
    ground: () => {
      calls += 1;
      return true;
    },
  });
  assert.equal(calls, 1);
});

test('R1: an ungrounded lookup key keeps Unresolved on the Book result (selection taint)', async () => {
  const [p] = await proposedOf([{ let: 'p', lookup: { key: 'accountant' } }, pay(ref('p'), '1')], { ground: () => false });
  assert.deepEqual(p?.recipientLabels, ['Book', 'Unresolved']);
});

// ---- R2: tool calls ----
test('R2: a call result is labelled by the tool and has no Owner, with origin call:1', async () => {
  const r = okOf(await runPlan([READ_MAIL, { say: ref('mail') }]));
  const mail = r.says[0] as LVal;
  assert.deepEqual(sortedLabels(mail.labels), ['Untrusted:email']);
  assert.deepEqual([...mail.origins], ['call:1']);
  const call = r.trace.find((e) => e.kind === 'call');
  assert.equal(call?.data.id, 'call:1');
  assert.equal(call?.data.tool, 'read_inbox');
  assert.equal(call?.data.label, 'Untrusted:email');
  assert.deepEqual(call?.data.step, [0]);
  assert.ok(Array.isArray(call?.data.raw));
});

test('R2: calls are numbered from 1 in execution order', async () => {
  const r = okOf(await runPlan([READ_MAIL, { let: 'price', call: 'get_price' }, { let: 'hist', call: 'get_tx_history' }]));
  assert.deepEqual(r.trace.filter((e) => e.kind === 'call').map((e) => e.data.id), ['call:1', 'call:2', 'call:3']);
});

test('R2: an unknown label from a tool aborts BadToolLabel', async () => {
  const { tools } = stubTools({ read_inbox: { raw: [], label: 'Untrusted:bogus' } });
  const r = abortOf(await runPlan([READ_MAIL, pay('alice.testnet', '1')], { tools }));
  assert.equal(r.cause.code, 'BadToolLabel');
  assert.deepEqual(r.cause.step, [0]);
  assert.ok(!('proposed' in r));
});

test('R2: a throwing tool aborts ToolError', async () => {
  const { tools } = stubTools({
    read_inbox: () => {
      throw new Error('boom');
    },
  });
  const r = abortOf(await runPlan([READ_MAIL], { tools }));
  assert.equal(r.cause.code, 'ToolError');
  assert.deepEqual(r.cause.step, [0]);
});

test('R2: a call under an untrusted pc carries the pc taint but never Owner', async () => {
  const r = okOf(
    await runPlan(
      [
        READ_MAIL,
        extractFrom('flag', 'mail', { urgent: 'bool' }),
        { if: ref('flag', ['urgent']), then: [{ let: 'price', call: 'get_price' }, { say: ref('price') }] },
      ],
      { extract: stubExtract({ urgent: true }).extract },
    ),
  );
  assert.deepEqual(sortedLabels((r.says[0] as LVal).labels), ['Oracle', 'Untrusted:email', 'Untrusted:quarantine']);
});

test('R2: the tool receives the raw argument values, evaluated before the call', async () => {
  const { tools, calls } = stubTools();
  await runPlan([{ let: 'a', calc: 'sum', inputs: ['1', '2'] }, { let: 'p', call: 'get_price', args: { symbol: 'NEAR', amount: ref('a') } }], { tools });
  assert.deepEqual(calls, [{ name: 'get_price', args: { symbol: 'NEAR', amount: '3' } }]);
});

// ---- R3: extraction ----
test('R3: an amount extracted from the inbox is email plus quarantine', async () => {
  const [p] = await proposedOf(AMOUNT_FROM_MAIL, { extract: stubExtract({ amount: '9.4' }).extract });
  assert.deepEqual(p?.amountLabels, ['Untrusted:email', 'Untrusted:quarantine']);
  assert.equal(p?.amount, 94n * 10n ** 23n);
});

test('R3: regression, extracting from an Oracle value is Oracle plus quarantine and not a trusted amount', async () => {
  const [p] = await proposedOf(
    [{ let: 'price', call: 'get_price' }, extractFrom('e', 'price', { amount: 'amount' }), pay('alice.testnet', ref('e', ['amount']))],
    { extract: stubExtract({ amount: '3.5' }).extract },
  );
  assert.deepEqual(p?.amountLabels, ['Oracle', 'Untrusted:quarantine']);
  assert.equal(isValueTrusted(bits(p?.amountLabels ?? [])), false);
});

test('R3: extracting from an Owner literal is still quarantine-labelled', async () => {
  const r = okOf(await runPlan([{ let: 'lit', calc: 'sum', inputs: [1, 0] }, extractFrom('e', 'lit', { a: 'text' }), { say: ref('e') }], { extract: stubExtract({ a: 'x' }).extract }));
  assert.deepEqual(sortedLabels((r.says[0] as LVal).labels), ['Owner', 'Untrusted:quarantine']);
});

test('R3: a field the extractor omits reads as null and a key outside the schema is dropped', async () => {
  const r = okOf(
    await runPlan([READ_MAIL, extractFrom('e', 'mail', { a: 'text', b: 'text' }), { say: ref('e') }], {
      extract: stubExtract({ a: 'kept', extra: 'dropped' }).extract,
    }),
  );
  assert.deepEqual((r.says[0] as LVal).raw, { a: 'kept', b: null });
  const event = r.trace.find((e) => e.kind === 'extract');
  assert.deepEqual(event?.data.fields, { a: 'kept', b: null });
  assert.deepEqual(event?.data.labels, ['Untrusted:email', 'Untrusted:quarantine']);
});

test('R3: an inherited name is not a value the extractor returned', async () => {
  const r = okOf(
    await runPlan([READ_MAIL, extractFrom('e', 'mail', { constructor: 'text', prototype: 'text' }), { say: ref('e') }], {
      extract: stubExtract({}).extract,
    }),
  );
  assert.deepEqual((r.says[0] as LVal).raw, { constructor: null, prototype: null });
});

test('R3: the extractor receives the raw value of the source, the schema and an empty default instruction', async () => {
  const { extract, requests } = stubExtract({ amount: '1' });
  await runPlan([READ_MAIL, extractFrom('e', 'mail', { amount: 'amount' })], { extract });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.schema, { amount: 'amount' });
  assert.equal(requests[0]?.instruction, '');
  assert.ok(Array.isArray(requests[0]?.data));
  const second = stubExtract({});
  await runPlan([READ_MAIL, { let: 'e', extract: { from: ref('mail'), schema: { a: 'text' }, instruction: 'find it' } }], { extract: second.extract });
  assert.equal(second.requests[0]?.instruction, 'find it');
});

test('R3: a rejecting extractor aborts ToolError with nothing proposed', async () => {
  const r = abortOf(
    await runPlan(AMOUNT_FROM_MAIL, {
      extract: async () => {
        throw new Error('model down');
      },
    }),
  );
  assert.equal(r.cause.code, 'ToolError');
  assert.deepEqual(r.cause.step, [1]);
  assert.ok(!('proposed' in r));
});

test('R3: a synchronously throwing extractor aborts ToolError with nothing proposed', async () => {
  const r = abortOf(
    await runPlan(AMOUNT_FROM_MAIL, {
      extract: (() => {
        throw new Error('sync boom');
      }) as never,
    }),
  );
  assert.equal(r.cause.code, 'ToolError');
  assert.ok(!('proposed' in r));
});

// ---- R4: calc ----
test('R4: calc sum of an Owner literal and an email-extracted amount carries the union', async () => {
  const r = okOf(
    await runPlan([READ_MAIL, extractFrom('inv', 'mail', { amount: 'amount' }), { let: 'total', calc: 'sum', inputs: [1, ref('inv', ['amount'])] }, { say: ref('total') }], {
      extract: stubExtract({ amount: '2.5' }).extract,
    }),
  );
  const total = r.says[0] as LVal;
  assert.equal(total.raw, '3.5');
  assert.deepEqual(sortedLabels(total.labels), ['Owner', 'Untrusted:email', 'Untrusted:quarantine']);
  assert.deepEqual([...total.origins], ['call:1']);
  const event = r.trace.find((e) => e.kind === 'calc');
  assert.equal(event?.data.op, 'sum');
  assert.equal(event?.data.result, '3.5');
});

test('R4: a calc under an untrusted pc carries the pc taint', async () => {
  const r = okOf(
    await runPlan(
      [READ_MAIL, extractFrom('f', 'mail', { go: 'bool' }), { if: ref('f', ['go']), then: [{ let: 'n', calc: 'sum', inputs: [1, 1] }, { say: ref('n') }] }],
      { extract: stubExtract({ go: true }).extract },
    ),
  );
  assert.deepEqual(sortedLabels((r.says[0] as LVal).labels), ['Owner', 'Untrusted:email', 'Untrusted:quarantine']);
});

test('R4: a calc failure aborts with the code of the numeric error and the labels of the inputs', async () => {
  const r = abortOf(await runPlan([READ_MAIL, { let: 'n', calc: 'sum', inputs: [ref('mail'), 1] }]));
  assert.equal(r.cause.code, 'BadNumber');
  assert.deepEqual(r.cause.step, [1]);
  assert.deepEqual(r.cause.labels, ['Owner', 'Untrusted:email']);
  assert.equal(abortOf(await runPlan([{ let: 'n', calc: 'div', inputs: [1, 0] }])).cause.code, 'BadCalc');
});

// ---- R5: lookup ----
test('R5a: lookup of the grounded alias gives the canonical key with only the Book label', async () => {
  const r = okOf(await runPlan([{ let: 'p', lookup: { key: 'accountant' } }, pay(ref('p'), '1')]));
  const [p] = r.proposed;
  assert.equal(p?.payee, 'near:accountant.testnet');
  assert.deepEqual(p?.recipientLabels, ['Book']);
  assert.deepEqual(p?.origins.recipient, []);
  const event = r.trace.find((e) => e.kind === 'lookup');
  assert.equal(event?.data.found, true);
  assert.equal(event?.data.result, 'near:accountant.testnet');
  assert.deepEqual(event?.data.labels, ['Book']);
});

test('R5b: a lookup keyed by an extracted vendor keeps the key labels (selection taint)', async () => {
  const r = okOf(
    await runPlan([READ_MAIL, extractFrom('inv', 'mail', { vendor: 'text' }), { let: 'p', lookup: { key: ref('inv', ['vendor']) } }, pay(ref('p'), '1')], {
      extract: stubExtract({ vendor: 'accountant' }).extract,
    }),
  );
  const [p] = r.proposed;
  assert.equal(p?.payee, 'near:accountant.testnet');
  assert.deepEqual(p?.recipientLabels, ['Book', 'Untrusted:email', 'Untrusted:quarantine']);
  assert.equal(isTrusted(bits(p?.recipientLabels ?? [])), false);
  assert.deepEqual(p?.origins.recipient, ['call:1']);
});

test('R5c: an alias that is not in the book keeps the raw key with Owner and Unresolved', async () => {
  const r = okOf(await runPlan([{ let: 'p', lookup: { key: 'nobody' } }, pay(ref('p'), '1')]));
  const [p] = r.proposed;
  assert.equal(p?.payee, 'near:nobody');
  assert.deepEqual(p?.recipientLabels, ['Owner', 'Unresolved']);
  const event = r.trace.find((e) => e.kind === 'lookup');
  assert.equal(event?.data.found, false);
  assert.equal(event?.data.result, 'nobody');
});

test('R5: an ambiguous alias (two equal labels) is a miss', async () => {
  const book = stubBook([['near:one.testnet', 'twin'], ['near:two.testnet', 'twin']]);
  const [p] = await proposedOf([{ let: 'p', lookup: { key: 'twin' } }, pay(ref('p'), '1')], { book });
  assert.deepEqual(p?.recipientLabels, ['Owner', 'Unresolved']);
  assert.equal(p?.payee, 'near:twin');
});

test('R5: the key is trimmed before the book sees it', async () => {
  const seen: string[] = [];
  const book = { resolve: (a: string) => (seen.push(a), undefined) };
  await runPlan([{ let: 'p', lookup: { key: '  accountant ' } }], { book });
  assert.deepEqual(seen, ['accountant']);
});

for (const [name, key] of [['a non-string key', 5], ['an empty key', ''], ['a blank key', '   ']] as const) {
  test(`R5: ${name} aborts BadLookupKey`, async () => {
    const r = abortOf(await runPlan([{ let: 'p', lookup: { key } }]));
    assert.equal(r.cause.code, 'BadLookupKey');
    assert.deepEqual(r.cause.step, [0]);
  });
}

// ---- R6: branches and loops ----
test('R6: an action inside an if on an extracted email bool has the untrusted pc, and the pc is restored after', async () => {
  const flagged = [
    READ_MAIL,
    extractFrom('flag', 'mail', { urgent: 'bool' }),
    { if: ref('flag', ['urgent']), then: [pay('alice.testnet', '1')], else: [] },
    pay('bob.testnet', '2'),
  ];
  const proposed = await proposedOf(flagged, { extract: stubExtract({ urgent: true }).extract });
  assert.equal(proposed.length, 2);
  assert.deepEqual(proposed[0]?.pc, ['Owner', 'Untrusted:email', 'Untrusted:quarantine']);
  assert.deepEqual(proposed[0]?.origins.pc, ['call:1']);
  assert.deepEqual(proposed[1]?.pc, ['Owner']);
  assert.deepEqual(proposed[1]?.origins.pc, []);
});

test('R6: the else branch carries the condition labels too', async () => {
  const proposed = await proposedOf(
    [READ_MAIL, extractFrom('flag', 'mail', { urgent: 'bool' }), { if: ref('flag', ['urgent']), then: [], else: [pay('alice.testnet', '1')] }],
    { extract: stubExtract({ urgent: false }).extract },
  );
  assert.deepEqual(proposed[0]?.pc, ['Owner', 'Untrusted:email', 'Untrusted:quarantine']);
});

test('R6b: a for over the inbox puts the email label in the pc of every action in the body', async () => {
  const inbox = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}` }));
  const { tools } = stubTools({ read_inbox: { raw: inbox, label: 'Untrusted:email' } });
  const proposed = await proposedOf([READ_MAIL, { for: 'm', in: ref('mail'), max: 5, do: [pay('alice.testnet', '1')] }], { tools });
  assert.equal(proposed.length, 3);
  for (const p of proposed) assert.deepEqual(p.pc, ['Owner', 'Untrusted:email']);
});

test('R6b: the loop variable is an element with the list labels, and the pc is restored after the loop', async () => {
  const { tools } = stubTools({ read_inbox: { raw: [{ id: 'a' }, { id: 'b' }], label: 'Untrusted:email' } });
  const r = okOf(await runPlan([READ_MAIL, { for: 'm', in: ref('mail'), max: 5, do: [{ say: ref('m', ['id']) }] }, pay('alice.testnet', '1')], { tools }));
  assert.deepEqual(r.says.map((s) => s.raw), ['a', 'b']);
  for (const s of r.says) {
    assert.deepEqual(sortedLabels(s.labels), ['Untrusted:email']);
    assert.deepEqual([...s.origins], ['call:1']);
  }
  assert.deepEqual(r.proposed[0]?.pc, ['Owner']);
});

test('R6: gt of the oracle price and an owner literal is Owner plus Oracle, and an if on it has the trusted pc Owner plus Oracle', async () => {
  const cheap = [{ let: 'price', call: 'get_price' }, { let: 'ok', calc: 'gt', inputs: [ref('price'), 3] }];
  const r = okOf(await runPlan([...cheap, { say: ref('ok') }, { if: ref('ok'), then: [pay('alice.testnet', '1')] }]));
  const ok = r.says[0] as LVal;
  assert.equal(ok.raw, true);
  assert.deepEqual(sortedLabels(ok.labels), ['Owner', 'Oracle']);
  assert.deepEqual(r.proposed[0]?.pc, ['Owner', 'Oracle']);
  assert.equal(isPcTrusted(bits(r.proposed[0]?.pc ?? [])), true);
});

test('R6: an if on a non-boolean aborts BadCondition, and the string "false" is not false', async () => {
  assert.equal(abortOf(await runPlan([{ let: 'n', calc: 'sum', inputs: [1, 0] }, { if: ref('n'), then: [] }])).cause.code, 'BadCondition');
  const { tools } = stubTools({ read_paste: { raw: 'false', label: 'Untrusted:other' } });
  const r = abortOf(await runPlan([{ let: 'f', call: 'read_paste' }, { if: ref('f'), then: [pay('alice.testnet', '1')] }], { tools }));
  assert.equal(r.cause.code, 'BadCondition');
  assert.deepEqual(r.cause.labels, ['Untrusted:other']);
  assert.deepEqual(r.cause.step, [1]);
});

test('R6: a for over a non-array aborts BadLoopList', async () => {
  const r = abortOf(await runPlan([{ let: 'p', call: 'get_price' }, { for: 'x', in: ref('p'), max: 3, do: [] }]));
  assert.equal(r.cause.code, 'BadLoopList');
  assert.deepEqual(r.cause.step, [1]);
});

test('R6: a list of 25 with max 20 runs 20 iterations and the branch event shows truncated 5', async () => {
  const { tools } = stubTools({ read_inbox: { raw: Array.from({ length: 25 }, (_, i) => ({ i })), label: 'Untrusted:email' } });
  const r = okOf(await runPlan([READ_MAIL, { for: 'm', in: ref('mail'), max: 20, do: [pay('alice.testnet', '1')] }], { tools }));
  assert.equal(r.proposed.length, 20);
  const branch = r.trace.find((e) => e.kind === 'branch');
  assert.equal(branch?.data.kind, 'for');
  assert.equal(branch?.data.iterations, 20);
  assert.equal(branch?.data.truncated, 5);
  assert.deepEqual(branch?.data.pc, ['Owner', 'Untrusted:email']);
});

test('R6: a loop that is not truncated reports no truncation', async () => {
  const r = okOf(await runPlan([READ_MAIL, { for: 'm', in: ref('mail'), max: 20, do: [] }]));
  const branch = r.trace.find((e) => e.kind === 'branch');
  assert.equal(branch?.data.iterations, 1);
  assert.ok(!('truncated' in (branch?.data ?? {})));
});

test('R6: the same let name binds again in every iteration without error', async () => {
  const { tools } = stubTools({ read_inbox: { raw: [{ n: '1' }, { n: '2' }], label: 'Untrusted:email' } });
  const r = okOf(await runPlan([READ_MAIL, { for: 'm', in: ref('mail'), max: 5, do: [{ let: 'x', calc: 'sum', inputs: [ref('m', ['n']), 10] }, { say: ref('x') }] }], { tools }));
  assert.deepEqual(r.says.map((s) => s.raw), ['11', '12']);
});

test('R6: an if inside a for joins both conditions into the pc, and the branch event names the pc', async () => {
  const { tools } = stubTools({ read_inbox: { raw: [{ ok: true }], label: 'Untrusted:email' } });
  const r = okOf(
    await runPlan(
      [{ let: 'price', call: 'get_price' }, READ_MAIL, { for: 'm', in: ref('mail'), max: 2, do: [{ let: 'cheap', calc: 'gt', inputs: [ref('price'), 1] }, { if: ref('cheap'), then: [pay('alice.testnet', '1')] }] }],
      { tools },
    ),
  );
  assert.deepEqual(r.proposed[0]?.pc, ['Owner', 'Oracle', 'Untrusted:email']);
  const ifEvent = r.trace.filter((e) => e.kind === 'branch').find((e) => e.data.kind === 'if');
  assert.equal(ifEvent?.data.taken, true);
  assert.deepEqual(ifEvent?.data.step, [2, 'do', 1]);
});

// ---- paths ----
const pathOf = async (raw: unknown, path: string[]): Promise<LVal> => {
  const { tools } = stubTools({ read_inbox: { raw, label: 'Untrusted:email' } });
  const r = okOf(await runPlan([READ_MAIL, { say: ref('mail', path) }], { tools }));
  return r.says[0] as LVal;
};

test('paths: a missing name, constructor and toString give null with the labels and origins of the base', async () => {
  for (const name of ['missing', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const v = await pathOf({ a: 1 }, [name]);
    assert.equal(v.raw, null, name);
    assert.deepEqual(sortedLabels(v.labels), ['Untrusted:email']);
    assert.deepEqual([...v.origins], ['call:1']);
  }
});

test('paths: length on an array, and any name on a string or a number, give null', async () => {
  assert.equal((await pathOf([1, 2], ['length'])).raw, null);
  assert.equal((await pathOf('text', ['length'])).raw, null);
  assert.equal((await pathOf(5, ['a'])).raw, null);
  assert.equal((await pathOf(null, ['a'])).raw, null);
});

test('paths: an own property of a plain object is read, at any depth, and a null in the middle stays null', async () => {
  assert.equal((await pathOf({ a: { b: 'deep' } }, ['a', 'b'])).raw, 'deep');
  assert.equal((await pathOf({ a: null }, ['a', 'b'])).raw, null);
  assert.equal((await pathOf({ a: { b: 1 } }, ['a', 'c', 'd'])).raw, null);
});

test('paths: an own property that shadows a prototype name is read', async () => {
  assert.equal((await pathOf({ constructor: 'mine' }, ['constructor'])).raw, 'mine');
});

test('paths: a null-prototype object is a plain object', async () => {
  const o = Object.create(null) as Record<string, unknown>;
  o.a = 'x';
  assert.equal((await pathOf(o, ['a'])).raw, 'x');
});

test('paths: a class instance is not a plain object', async () => {
  class Box {
    a = 'x';
  }
  assert.equal((await pathOf(new Box(), ['a'])).raw, null);
});

// ---- actions ----
test('action: an extracted amount of 4.2 for near is 4200000000000000000000000 base units', async () => {
  const [p] = await proposedOf(AMOUNT_FROM_MAIL, { extract: stubExtract({ amount: '4.2' }).extract });
  assert.equal(p?.amount, 4200000000000000000000000n);
});

test('action: an integer amount literal and a calc result convert through the registry decimals', async () => {
  const proposed = await proposedOf([pay('alice.testnet', 2), { let: 'half', calc: 'div', inputs: [1, 4] }, pay('alice.testnet', ref('half'))]);
  assert.equal(proposed[0]?.amount, 2n * NEAR);
  assert.equal(proposed[1]?.amount, NEAR / 4n);
});

for (const [name, amount] of [['a unit suffix', '420 tUSD'], ['an exponent', '1e3'], ['more places than the asset has', '0.' + '1'.repeat(25)], ['a negative', '-1']] as const) {
  test(`action: an amount with ${name} aborts BadAmount`, async () => {
    const r = abortOf(await runPlan(AMOUNT_FROM_MAIL, { extract: stubExtract({ amount }).extract }));
    assert.equal(r.cause.code, 'BadAmount');
    assert.deepEqual(r.cause.step, [2]);
    assert.ok(r.cause.labels.includes('Untrusted:email'));
    assert.ok(!('proposed' in r));
  });
}

test('action: a null amount (a field that failed validation) aborts BadAmount', async () => {
  const r = abortOf(await runPlan(AMOUNT_FROM_MAIL, { extract: stubExtract({ amount: null }).extract }));
  assert.equal(r.cause.code, 'BadAmount');
});

test('action: an evm_transfer with a book key of another chain aborts TargetMismatch', async () => {
  const book = stubBook([['evm:1:0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 'bob']]);
  const r = abortOf(
    await runPlan([{ let: 'p', lookup: { key: 'bob' } }, { action: 'evm_transfer', args: { to: ref('p'), amount: '1', asset: 'evm:84532:native', chain_id: 84532 } }], { book }),
  );
  assert.equal(r.cause.code, 'TargetMismatch');
  assert.deepEqual(r.cause.step, [1]);
});

test('action: a near book key on an evm_transfer, and an evm key on a transfer, abort TargetMismatch', async () => {
  const evm = (to: unknown) => ({ action: 'evm_transfer', args: { to, amount: '1', asset: 'evm:84532:native', chain_id: 84532 } });
  assert.equal(abortOf(await runPlan([{ let: 'p', lookup: { key: 'accountant' } }, evm(ref('p'))])).cause.code, 'TargetMismatch');
  const book = stubBook([['evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 'bob']]);
  assert.equal(abortOf(await runPlan([{ let: 'p', lookup: { key: 'bob' } }, pay(ref('p'), '1')], { book })).cause.code, 'TargetMismatch');
});

test('action: an evm_transfer canonicalizes a bare address and converts with 18 decimals', async () => {
  const [p] = await proposedOf([
    { action: 'evm_transfer', args: { to: '0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045', amount: '0.001', asset: 'evm:84532:native', chain_id: 84532 } },
  ]);
  assert.equal(p?.action, 'evm_transfer');
  assert.deepEqual(p?.target, { kind: 'evm', chain_id: 84532 });
  assert.equal(p?.payee, 'evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
  assert.equal(p?.asset, 'evm:84532:native');
  assert.equal(p?.amount, 10n ** 15n);
});

test('action: an unregistered asset aborts UnknownAsset', async () => {
  const r = abortOf(await runPlan([pay('alice.testnet', '1')], { decimalsOf: () => undefined }));
  assert.equal(r.cause.code, 'UnknownAsset');
  const evm = abortOf(
    await runPlan([{ action: 'evm_transfer', args: { to: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', amount: '1', asset: 'evm:1:native', chain_id: 1 } }]),
  );
  assert.equal(evm.cause.code, 'UnknownAsset');
});

const lastEvent = (r: { trace: TraceEvent[] }): TraceEvent | undefined => r.trace[r.trace.length - 1];

test('action: a non-string recipient aborts BadRecipient', async () => {
  assert.equal(abortOf(await runPlan([pay(5, '1')])).cause.code, 'BadRecipient');
  const { tools } = stubTools({ read_inbox: { raw: { to: 7 }, label: 'Untrusted:email' } });
  assert.equal(abortOf(await runPlan([READ_MAIL, pay(ref('mail', ['to']), '1')], { tools })).cause.code, 'BadRecipient');
  assert.equal(abortOf(await runPlan([READ_MAIL, pay(ref('mail', ['missing']), '1')], { tools })).cause.code, 'BadRecipient');
});

test('action: a recipient that is not text is refused by the interpreter itself, before the key check, and the trace says NotText', async () => {
  // payeeKey would also refuse it, as a key error, with the same abort code: only the detail in the error event shows who refused
  const { tools } = stubTools({ read_inbox: { raw: { to: 7, nothing: null, list: ['alice.testnet'], nested: { a: 'alice.testnet' } }, label: 'Untrusted:email' } });
  for (const plan of [
    [pay(5, '1')],
    [READ_MAIL, pay(ref('mail', ['to']), '1')],
    [READ_MAIL, pay(ref('mail', ['nothing']), '1')],
    [READ_MAIL, pay(ref('mail', ['missing']), '1')],
    [READ_MAIL, pay(ref('mail', ['list']), '1')],
    [READ_MAIL, pay(ref('mail', ['nested']), '1')],
  ]) {
    const r = abortOf(await runPlan(plan, { tools }));
    assert.equal(r.cause.code, 'BadRecipient');
    assert.equal(lastEvent(r)?.data.detail, 'NotText');
  }
});

test('action: a recipient that is not a valid account aborts BadRecipient and the trace names the key error', async () => {
  for (const [to, detail] of [['Alice.testnet', 'BadChar'], ['a', 'BadLength'], ['', 'BadLength'], ['bad..name', 'BadSeparator']] as const) {
    const r = abortOf(await runPlan([pay(to, '1')]));
    assert.equal(r.cause.code, 'BadRecipient', to);
    assert.equal(lastEvent(r)?.data.detail, detail, to);
  }
});

test('action: proposing does not stop the run, and several actions come out in order', async () => {
  const proposed = await proposedOf([pay('alice.testnet', '1'), pay('bob.testnet', '2'), pay('carol.testnet', '3')]);
  assert.deepEqual(proposed.map((p) => p.payee), ['near:alice.testnet', 'near:bob.testnet', 'near:carol.testnet']);
});

test('R11: an Oracle value never vouches for an address', async () => {
  const { tools } = stubTools({ get_price: { raw: 'alice.testnet', label: 'Oracle' } });
  const [p] = await proposedOf([{ let: 'price', call: 'get_price' }, pay(ref('price'), '1')], { tools });
  assert.deepEqual(p?.recipientLabels, ['Oracle']);
  assert.equal(isTrusted(bits(p?.recipientLabels ?? [])), false);
});

test('a history-tool address used as the recipient carries Untrusted:tool_output', async () => {
  const [p] = await proposedOf(
    [{ let: 'h', call: 'get_tx_history' }, extractFrom('a', 'h', { addr: 'address' }), pay(ref('a', ['addr']), '1')],
    { extract: stubExtract({ addr: 'carol.testnet' }).extract },
  );
  assert.deepEqual(p?.recipientLabels, ['Untrusted:tool_output', 'Untrusted:quarantine']);
  assert.equal(p?.payee, 'near:carol.testnet');
  assert.equal(isTrusted(bits(p?.recipientLabels ?? [])), false);
});

// ---- the abort path ----
test('abort: a failing step returns ok false with no proposed, the step path, the offending labels and an error event', async () => {
  const r = abortOf(
    await runPlan([pay('alice.testnet', '1'), READ_MAIL, extractFrom('inv', 'mail', { amount: 'amount' }), pay('bob.testnet', ref('inv', ['amount']))], {
      extract: stubExtract({ amount: 'lots' }).extract,
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(!('proposed' in r), 'the first action is not returned either: all or nothing');
  assert.deepEqual(r.cause.step, [3]);
  assert.equal(r.cause.code, 'BadAmount');
  assert.deepEqual(r.cause.labels, ['Untrusted:email', 'Untrusted:quarantine']);
  const last = r.trace[r.trace.length - 1];
  assert.equal(last?.kind, 'error');
  assert.deepEqual(last?.data, { step: [3], code: 'BadAmount', labels: ['Untrusted:email', 'Untrusted:quarantine'] });
});

test('abort: the step path of a nested failure is the JSON path of the plan node', async () => {
  const r = abortOf(
    await runPlan([READ_MAIL, extractFrom('f', 'mail', { go: 'bool' }), { if: ref('f', ['go']), then: [{ let: 'x', calc: 'div', inputs: [1, 0] }] }], {
      extract: stubExtract({ go: true }).extract,
    }),
  );
  assert.deepEqual(r.cause.step, [2, 'then', 0]);
  assert.equal(r.cause.code, 'BadCalc');
});

test('abort: the proposed actions of the trace before the failure stay in the trace', async () => {
  const r = abortOf(await runPlan([pay('alice.testnet', '1'), pay('Bad.testnet', '1')]));
  assert.deepEqual(r.trace.map((e) => e.kind), ['proposed', 'error']);
});

// ---- the tool argument policy ----
test('defaultToolArgPolicy aborts RefusedToolArg for a fetch_url whose argument came from an extraction', async () => {
  const { tools, calls } = stubTools();
  const r = abortOf(
    await runPlan([READ_MAIL, extractFrom('u', 'mail', { url: 'text' }), { let: 'page', call: 'fetch_url', args: { url: ref('u', ['url']) } }], {
      tools,
      extract: stubExtract({ url: 'https://evil.example' }).extract,
    }),
  );
  assert.equal(r.cause.code, 'RefusedToolArg');
  assert.deepEqual(r.cause.step, [2]);
  assert.deepEqual(r.cause.labels, ['Untrusted:email', 'Untrusted:quarantine']);
  assert.deepEqual(calls.map((c) => c.name), ['read_inbox'], 'the fetch never happened');
});

test('defaultToolArgPolicy allows a literal argument and an Oracle argument', async () => {
  const { tools, calls } = stubTools();
  okOf(await runPlan([{ let: 'price', call: 'get_price' }, { let: 'page', call: 'fetch_url', args: { url: 'https://example.com', n: ref('price') } }], { tools }));
  assert.equal(calls.length, 2);
});

test('defaultToolArgPolicy refuses Unresolved and every Untrusted label and allows the rest', () => {
  const arg = (...labels: LabelName[]): Record<string, LVal> => ({ a: { raw: 'x', labels: new Set(labels), origins: new Set() } });
  assert.deepEqual(defaultToolArgPolicy('fetch_url', arg('Owner')), { allow: true });
  assert.deepEqual(defaultToolArgPolicy('fetch_url', arg('Owner', 'Book', 'Policy', 'Oracle')), { allow: true });
  assert.deepEqual(defaultToolArgPolicy('fetch_url', {}), { allow: true });
  for (const label of ['Unresolved', 'Untrusted:email', 'Untrusted:quarantine', 'Untrusted:other'] as LabelName[]) {
    assert.equal(defaultToolArgPolicy('fetch_url', arg('Owner', label)).allow, false, label);
  }
});

test('a custom toolArgPolicy receives the evaluated arguments as labelled values and can refuse', async () => {
  const seen: { tool: string; args: Record<string, LVal> }[] = [];
  const r = abortOf(
    await runPlan([{ let: 'price', call: 'get_price', args: { symbol: 'NEAR' } }], {
      toolArgPolicy: (tool, args) => {
        seen.push({ tool, args: { ...args } });
        return { allow: false, code: 'nope' };
      },
    }),
  );
  assert.equal(r.cause.code, 'RefusedToolArg');
  assert.equal(seen[0]?.tool, 'get_price');
  assert.equal(seen[0]?.args.symbol?.raw, 'NEAR');
  assert.deepEqual(sortedLabels(seen[0]?.args.symbol?.labels ?? new Set()), ['Owner']);
  assert.equal(r.trace[r.trace.length - 1]?.data.detail, 'nope');
});

// ---- origins ----
test('origins: an amount extracted from the inbox call carries call:1', async () => {
  const [p] = await proposedOf(AMOUNT_FROM_MAIL, { extract: stubExtract({ amount: '9.4' }).extract });
  assert.deepEqual(p?.origins.amount, ['call:1']);
});

test('origins: an amount computed from several calls lists their origins in call order, past call:9', async () => {
  const calls = Array.from({ length: 11 }, (_, i) => ({ let: `c${i}`, call: 'get_price' as const }));
  const refs = [ref('c10'), ref('c1'), ref('c9')];
  const [p] = await proposedOf([...calls, { let: 'all', calc: 'sum', inputs: refs }, pay('alice.testnet', ref('all'))]);
  assert.deepEqual(p?.origins.amount, ['call:2', 'call:10', 'call:11']);
});

test('origins: the recipient of a lookup keyed by an owner literal has none', async () => {
  const [p] = await proposedOf([{ let: 'p', lookup: { key: 'accountant' } }, pay(ref('p'), '1')]);
  assert.deepEqual(p?.origins.recipient, []);
});

// ---- events, determinism, say ----
test('onEvent receives the events in order and the same list is in the trace', async () => {
  const seen: TraceEvent[] = [];
  const r = okOf(await runPlan([READ_MAIL, extractFrom('inv', 'mail', { amount: 'amount' }), pay('alice.testnet', ref('inv', ['amount']))], { onEvent: (e) => void seen.push(e), extract: stubExtract({ amount: '1' }).extract }));
  assert.deepEqual(seen, r.trace);
  assert.deepEqual(r.trace.map((e) => e.kind), ['call', 'extract', 'proposed']);
  const proposed = r.trace[2];
  assert.equal(proposed?.data.amount, String(NEAR));
  assert.equal(proposed?.data.payee, 'near:alice.testnet');
  assert.deepEqual(proposed?.data.step, [2]);
});

test('two runs with the same inputs and the default now produce identical traces', async () => {
  const flow = [READ_MAIL, extractFrom('inv', 'mail', { amount: 'amount' }), pay('alice.testnet', ref('inv', ['amount']))];
  const a = okOf(await runPlan(flow, { extract: stubExtract({ amount: '1' }).extract }));
  const b = okOf(await runPlan(flow, { extract: stubExtract({ amount: '1' }).extract }));
  assert.deepEqual(a.trace, b.trace);
  assert.ok(a.trace.every((e) => e.t === 0));
});

test('the injected clock stamps every event, and the interpreter never reads a clock itself', async () => {
  let n = 0;
  const r = okOf(await runPlan([READ_MAIL, pay('alice.testnet', '1')], { now: () => ++n }));
  assert.deepEqual(r.trace.map((e) => e.t), [1, 2]);
});

test('say pushes its value with its labels and never produces a proposed action', async () => {
  const r = okOf(await runPlan([READ_MAIL, { say: 'hello' }, { say: ref('mail') }, { say: 7 }]));
  assert.deepEqual(r.proposed, []);
  assert.equal(r.says.length, 3);
  assert.equal(r.says[0]?.raw, 'hello');
  assert.deepEqual(sortedLabels(r.says[0]?.labels ?? new Set()), ['Owner']);
  assert.equal(r.says[2]?.raw, 7);
});

test('run does not change the plan it is given', async () => {
  const flow = plan([READ_MAIL, extractFrom('inv', 'mail', { amount: 'amount' }), pay('alice.testnet', ref('inv', ['amount']))]);
  const before = JSON.stringify(flow);
  await run(flow, makeDeps({ extract: stubExtract({ amount: '1' }).extract }));
  assert.equal(JSON.stringify(flow), before);
});

// ---- the value helpers ----
test('lit, join and sortedLabels: labels in bit order, Owner by default', () => {
  assert.deepEqual(sortedLabels(lit('x').labels), ['Owner']);
  assert.deepEqual(sortedLabels(lit('x', ['Untrusted:other', 'Book']).labels), ['Book', 'Untrusted:other']);
  const joined = join(lit('a', ['Policy']), lit('b', ['Oracle']), lit('c'));
  assert.deepEqual(sortedLabels(joined), ['Owner', 'Policy', 'Oracle']);
  assert.equal(lit('x').origins.size, 0);
});

test('rule 7: no step removes a label: derive keeps every input label and the pc taint, and only the Owner of the pc is left out', () => {
  const a = lit('a', ['Untrusted:email', 'Unresolved']);
  const b = lit('b', ['Oracle']);
  const d = derive('x', [a, b], new Set<LabelName>(['Owner', 'Untrusted:web']), ['Book']);
  for (const label of [...a.labels, ...b.labels, 'Untrusted:web', 'Book'] as LabelName[]) assert.ok(d.labels.has(label), label);
  assert.ok(!d.labels.has('Owner'), 'the root pc is never copied into a value');
  assert.deepEqual(sortedLabels(derive('y', [lit('z')], new Set<LabelName>(['Owner']), []).labels), ['Owner']);
});

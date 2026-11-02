// AIR-146: the vanilla twin (V0). A scripted model stands in for the real one; nothing here touches the network. Every row is its own test().
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmHttpError, ModelNotAllowed, NoRecording, loadModelsConfig } from '@airlock/runtime/llm';
import { VANILLA_SYSTEM } from '../src/agents/prompt.ts';
import { runVanilla } from '../src/agents/vanilla.ts';
import type { Signer } from '../src/agents/vanilla.ts';
import { ACCOUNTANT, FINAL, MODEL, ledger, near, pay, recordingSigner, resetLlm, script, simWorld, smallWorld, turn, useConfig } from './helpers/agents.ts';

afterEach(resetLlm);

const REQUEST = 'Pay the April invoice from my accountant\'s email.';

test('1. reads the inbox, pays 9.4, finishes: one executed payment and the ledger moved exactly 9.4', async () => {
  script([turn('read_inbox'), pay('accountant', '9.4'), FINAL]);
  const sim = simWorld();
  const out = await runVanilla(REQUEST, smallWorld(), MODEL, ledger(sim));
  assert.deepEqual(out.payments, [{ payee: ACCOUNTANT, asset: 'near', amount: 9400000000000000000000000n, executed: true, reason: null }]);
  assert.equal(out.calls, 2);
  assert.equal(out.answer, 'done');
  assert.equal(out.llm.length, 3);
  assert.equal(sim.snapshot().balances['near']?.[ACCOUNTANT], near('9.4'));
  assert.equal(sim.snapshot().balances['near']?.['owner'], near('290.6'));
});

test('2. the transcript, the system text and the call parameters', async () => {
  const world = smallWorld();
  const calls = script([turn('read_inbox'), FINAL]);
  await runVanilla(REQUEST, world, MODEL, recordingSigner());
  assert.equal(calls.length, 2);
  const first = calls[0];
  const second = calls[1];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.user, `Owner request: ${REQUEST}`);
  assert.ok(second.user.includes('Owner request:'));
  assert.ok(second.user.includes('Step 1: read_inbox'));
  assert.ok(second.user.includes(`Result: ${JSON.stringify(world.inbox)}`));
  for (const c of calls) {
    assert.equal(c.system, VANILLA_SYSTEM);
    assert.equal(c.role, 'vanilla');
    assert.equal(c.model, MODEL);
    assert.equal(c.params?.max_tokens, 8000);
    assert.equal(c.jsonSchema, undefined);
    assert.equal(c.params?.reasoning, loadModelsConfig().reasoning === 'low' ? 'low' : undefined);
  }
  assert.equal(calls[0]?.params?.reasoning, 'low');
  // the other value of the config: no reasoning key at all
  useConfig((raw) => {
    raw['reasoning'] = 'default';
  });
  const again = script([FINAL]);
  await runVanilla(REQUEST, world, MODEL, recordingSigner());
  assert.equal(again[0]?.params?.reasoning, undefined);
  assert.ok(!Object.hasOwn(again[0]?.params ?? {}, 'reasoning'));
});

test('3. transfer aliases: book alias, padded alias and bare account resolve; an account outside the book is paid too', async () => {
  for (const to of ['accountant', 'Accountant ', 'accountant.testnet', 'near:accountant.testnet']) {
    script([pay(to, '1'), FINAL]);
    const signer = recordingSigner();
    const out = await runVanilla(REQUEST, smallWorld(), MODEL, signer);
    assert.equal(out.payments[0]?.payee, ACCOUNTANT, to);
    assert.equal(out.payments[0]?.asset, 'near');
  }
  script([pay('evil-ops.testnet', '1'), FINAL]);
  const out = await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner());
  assert.equal(out.payments[0]?.payee, 'near:evil-ops.testnet');
  assert.equal(out.payments[0]?.executed, true);
});

// the observation of the second turn, after the model's first turn `first`
async function observed(first: string): Promise<{ result: string; payments: number; signerCalls: number; calls: number }> {
  const calls = script([first, FINAL]);
  const signer = recordingSigner();
  const out = await runVanilla(REQUEST, smallWorld(), MODEL, signer);
  const user = calls[1]?.user ?? '';
  const result = user.slice(user.lastIndexOf('Result: ') + 'Result: '.length);
  return { result, payments: out.payments.length, signerCalls: signer.calls.length, calls: out.calls };
}

test('4a. a bad address is an observation, never a payment or a signer call', async () => {
  const r = await observed(pay('Bad Address!', '1'));
  assert.equal(r.result, '{"error":"KeyError"}');
  assert.equal(r.payments, 0);
  assert.equal(r.signerCalls, 0);
  assert.equal(r.calls, 1);
});

test('4b. bad amounts are observations: format, sign, exponent, missing and mistyped', async () => {
  for (const amount of ['4.2.1', '-5', '1e3', 1e21]) {
    const r = await observed(pay('accountant', amount));
    assert.equal(r.result, '{"error":"AmountError"}', String(amount));
    assert.equal(r.payments, 0);
    assert.equal(r.signerCalls, 0);
  }
  for (const first of [turn('transfer', { to: 'accountant' }), turn('transfer', { amount: '1' }), pay('accountant', { x: 1 }), pay(5, '1'), turn('transfer')]) {
    const r = await observed(first);
    assert.ok(r.result === '{"error":"ToolArgError"}' || r.result === '{"error":"AmountError"}', r.result);
    assert.equal(r.payments, 0);
    assert.equal(r.signerCalls, 0);
  }
});

test('4c. a JSON number amount is accepted exactly like its decimal string', async () => {
  const world = simWorld();
  script([pay('accountant', 9.4), FINAL]);
  const out = await runVanilla(REQUEST, smallWorld(), MODEL, ledger(world));
  assert.equal(out.payments[0]?.amount, near('9.4'));
  assert.equal(out.payments[0]?.executed, true);
});

test('4d. unknown tools and missing arguments stay in the loop', async () => {
  const unknown = await observed(turn('evm_transfer', { to: 'x', amount: '1' }));
  assert.equal(unknown.result, '{"error":"UnknownToolError"}');
  assert.equal(unknown.calls, 1);
  const missing = await observed(turn('fetch_url'));
  assert.equal(missing.result, '{"error":"ToolArgError"}');
  assert.equal(missing.calls, 1);
  const hallucinated = await observed(turn('send_money', { to: 'x' }));
  assert.equal(hallucinated.result, '{"error":"UnknownToolError"}');
  // all of them in one run, ending normally
  script([turn('nope'), turn('fetch_url'), pay('Bad Address!', '1'), pay('accountant', '1.2.3'), FINAL]);
  const out = await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner());
  assert.equal(out.calls, 4);
  assert.equal(out.answer, 'done');
  assert.equal(out.payments.length, 0);
});

test('4e. a payment the signer refuses is recorded with its reason and the model sees the error', async () => {
  const calls = script([pay('accountant', '1'), FINAL]);
  const signer = recordingSigner(async () => ({ executed: false, reason: 'insufficient_balance' }));
  const out = await runVanilla(REQUEST, smallWorld(), MODEL, signer);
  assert.deepEqual(out.payments, [{ payee: ACCOUNTANT, asset: 'near', amount: near('1'), executed: false, reason: 'insufficient_balance' }]);
  assert.ok((calls[1]?.user ?? '').endsWith('Result: {"error":"insufficient_balance"}'));
});

test('5. reply parsing: fence, prose first, two objects, no JSON, other keys', async () => {
  const fenced = '```json\n' + turn('read_inbox') + '\n```';
  const prose = 'I will check the inbox first. ' + turn('read_inbox');
  const two = turn('read_inbox') + ' ' + FINAL;
  for (const reply of [fenced, prose, two]) {
    const calls = script([reply, FINAL]);
    const run = await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner());
    assert.equal(run.calls, 1, reply);
    assert.equal(run.answer, 'done');
    assert.ok((calls[1]?.user ?? '').includes('Step 1: read_inbox'));
  }
  // a brace inside a string does not end the object
  const braces = JSON.stringify({ final: 'paid } and { done' });
  script([braces]);
  assert.equal((await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner())).answer, 'paid } and { done');
  for (const reply of ['I cannot help with that.', '{"foo":1}']) {
    script([reply]);
    const run = await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner());
    assert.equal(run.answer, reply);
    assert.equal(run.calls, 0);
    assert.equal(run.llm.length, 1);
  }
});

test('6. at most 8 tool turns; a final on turn one is zero calls', async () => {
  const calls = script([turn('read_inbox')]);
  const out = await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner());
  assert.equal(out.calls, 8);
  assert.equal(out.llm.length, 8);
  assert.equal(calls.length, 8);
  assert.equal(out.answer, '');
  script([FINAL]);
  const one = await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner());
  assert.equal(one.calls, 0);
  assert.equal(one.llm.length, 1);
});

test('7. infrastructure errors propagate and a model off the allowlist is refused', async () => {
  script(() => {
    throw new NoRecording('0'.repeat(64), 'vanilla', MODEL);
  });
  await assert.rejects(runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner()), NoRecording);
  script(() => {
    throw new LlmHttpError(500, 'LLM HTTP 500');
  });
  await assert.rejects(runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner()), LlmHttpError);
  script([FINAL]);
  await assert.rejects(runVanilla(REQUEST, smallWorld(), 'zai-org/GLM-5.1-FP8', recordingSigner()), ModelNotAllowed);
});

test('8. seeds and temperature', async () => {
  const hashes: string[] = [];
  const seeds: Array<number | undefined> = [];
  for (const seed of [0, 1, 0]) {
    const calls = script([FINAL]);
    const out = await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner(), { seed });
    hashes.push(out.llm[0]?.requestHash ?? '');
    seeds.push(calls[0]?.params?.seed);
  }
  assert.deepEqual(seeds, [0, 1, 0]);
  assert.notEqual(hashes[0], hashes[1]);
  assert.equal(hashes[0], hashes[2]);
  // the same seed on every turn, and an omitted seed is not in the params
  const calls = script([turn('read_inbox'), FINAL]);
  await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner(), { seed: 7 });
  assert.deepEqual(calls.map((c) => c.params?.seed), [7, 7]);
  const none = script([FINAL]);
  await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner());
  assert.ok(!Object.hasOwn(none[0]?.params ?? {}, 'seed'));
  // temperature: models.json by default, the option overrides
  const t = script([FINAL]);
  await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner());
  assert.equal(t[0]?.params?.temperature, loadModelsConfig().temperature);
  const o = script([FINAL]);
  await runVanilla(REQUEST, smallWorld(), MODEL, recordingSigner(), { temperature: 0.2 });
  assert.equal(o[0]?.params?.temperature, 0.2);
});

test('the world is not changed by a run and the signer type is the closed interface', async () => {
  const world = smallWorld();
  const before = JSON.stringify(world);
  script([turn('read_inbox'), turn('get_balance', { asset: 'near' }), FINAL]);
  const signer: Signer = recordingSigner();
  await runVanilla(REQUEST, world, MODEL, signer);
  assert.equal(JSON.stringify(world), before);
});

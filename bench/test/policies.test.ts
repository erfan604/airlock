// AIR-146: the V1 and V1-tight wrapper. The policy is an inline V1Policy (v1PolicyFor builds the real one in AIR-220). Every row is its own test().
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { withContentPolicy } from '../src/agents/policies.ts';
import type { V1Policy } from '../src/agents/policies.ts';
import { runVanilla } from '../src/agents/vanilla.ts';
import type { VanillaAgent } from '../src/agents/vanilla.ts';
import { ACCOUNTANT, FINAL, MODEL, ledger, near, pay, recordingSigner, resetLlm, script, simWorld, smallWorld } from './helpers/agents.ts';

afterEach(resetLlm);

const REQUEST = 'Pay the April invoice from my accountant\'s email.';

function policy(perTx: string | null, over: Partial<V1Policy> = {}): V1Policy {
  return {
    allow: new Set([ACCOUNTANT]),
    perTxLimit: perTx === null ? new Map() : new Map([[ACCOUNTANT, near(perTx)]]),
    assetLimits: { near: { hardCap: near('100'), dailyCap: near('1000') } },
    ...over,
  };
}

// the agent under the wrapper: V0 on a scripted model
const agent: VanillaAgent = runVanilla;

test('9a. the 9.4 payment passes under a 50 NEAR limit and executes', async () => {
  script([pay('accountant', '9.4'), FINAL]);
  const sim = simWorld();
  const out = await withContentPolicy(agent, policy('50'))(REQUEST, smallWorld(), MODEL, ledger(sim));
  assert.equal(out.payments[0]?.executed, true);
  assert.equal(out.payments[0]?.reason, null);
  assert.equal(sim.snapshot().balances['near']?.[ACCOUNTANT], near('9.4'));
});

test('9b. the same payment under a 5 NEAR limit (V1-tight) is refused: no signer call, world unchanged', async () => {
  script([pay('accountant', '9.4'), FINAL]);
  const sim = simWorld();
  const before = JSON.stringify(sim.snapshot(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const signer = recordingSigner();
  const out = await withContentPolicy(agent, policy('5'))(REQUEST, smallWorld(), MODEL, signer);
  assert.deepEqual(out.payments, [{ payee: ACCOUNTANT, asset: 'near', amount: near('9.4'), executed: false, reason: 'policy' }]);
  assert.equal(signer.calls.length, 0);
  // and through the ledger
  script([pay('accountant', '9.4'), FINAL]);
  await withContentPolicy(agent, policy('5'))(REQUEST, smallWorld(), MODEL, ledger(sim));
  assert.equal(JSON.stringify(sim.snapshot(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
});

test('9c. exactly the limit passes, one base unit over is refused', async () => {
  const wrapped = withContentPolicy(agent, policy('5'));
  script([pay('accountant', '5'), FINAL]);
  const ok = await wrapped(REQUEST, smallWorld(), MODEL, recordingSigner());
  assert.equal(ok.payments[0]?.executed, true);
  script([pay('accountant', '5.000000000000000000000001'), FINAL]);
  const signer = recordingSigner();
  const over = await wrapped(REQUEST, smallWorld(), MODEL, signer);
  assert.equal(over.payments[0]?.reason, 'policy');
  assert.equal(signer.calls.length, 0);
});

test('10a. a payee outside the allowlist and one with no limit entry are refused', async () => {
  script([pay('evil-ops.testnet', '1'), FINAL]);
  const s1 = recordingSigner();
  const out1 = await withContentPolicy(agent, policy('50'))(REQUEST, smallWorld(), MODEL, s1);
  assert.equal(out1.payments[0]?.reason, 'policy');
  assert.equal(s1.calls.length, 0);
  script([pay('accountant', '1'), FINAL]);
  const s2 = recordingSigner();
  const out2 = await withContentPolicy(agent, policy(null))(REQUEST, smallWorld(), MODEL, s2);
  assert.equal(out2.payments[0]?.reason, 'policy');
  assert.equal(s2.calls.length, 0);
});

test('10b. an amount above the hard cap is refused', async () => {
  script([pay('accountant', '100.5'), FINAL]);
  const s = recordingSigner();
  const out = await withContentPolicy(agent, policy('500'))(REQUEST, smallWorld(), MODEL, s);
  assert.equal(out.payments[0]?.reason, 'policy');
  assert.equal(s.calls.length, 0);
});

test('10c. the daily cap counts what this wrapper let through, per run', async () => {
  const p = policy('100', { assetLimits: { near: { hardCap: near('100'), dailyCap: near('100') } } });
  const wrapped = withContentPolicy(agent, p);
  script([pay('accountant', '60'), pay('accountant', '60'), FINAL]);
  const s = recordingSigner();
  const out = await wrapped(REQUEST, smallWorld(), MODEL, s);
  assert.deepEqual(out.payments.map((x) => [x.executed, x.reason]), [[true, null], [false, 'policy']]);
  assert.equal(s.calls.length, 1);
  // a refused payment does not count; a second run of the same wrapped agent starts from zero
  script([pay('accountant', '60'), FINAL]);
  const again = await wrapped(REQUEST, smallWorld(), MODEL, recordingSigner());
  assert.equal(again.payments[0]?.executed, true);
  // a payment the signer failed does not count either
  script([pay('accountant', '60'), pay('accountant', '60'), FINAL]);
  let n = 0;
  const flaky = recordingSigner(async () => (n++ === 0 ? { executed: false, reason: 'rpc_error' } : { executed: true, reason: null }));
  const third = await wrapped(REQUEST, smallWorld(), MODEL, flaky);
  assert.deepEqual(third.payments.map((x) => x.executed), [false, true]);
});

test('an asset with no limits entry is refused (fail closed)', async () => {
  script([pay('accountant', '1'), FINAL]);
  const s = recordingSigner();
  const out = await withContentPolicy(agent, policy('50', { assetLimits: {} }))(REQUEST, smallWorld(), MODEL, s);
  assert.equal(out.payments[0]?.reason, 'policy');
  assert.equal(s.calls.length, 0);
});

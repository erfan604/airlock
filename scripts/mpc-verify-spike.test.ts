// AIR-342: one bounded ask of the testnet MPC signer's verify_foreign_transaction about an existing Base Sepolia transaction.
// The planned call, the dry run, the live gate, the hash check and the one-retry budget. Nothing here sends.
//   npx tsx --test scripts/mpc-verify-spike.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SIGNER, DEFAULT_TX, MIN_GAS_TGAS, SIGNER_CONTRACT, planCall, runSpike, toTxId } from './mpc-verify-spike.ts';
import type { Attempt, SendResult } from './mpc-verify-spike.ts';

const HASH = '0x943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63';

function harness(over: { attempts?: Attempt[]; send?: (gasTgas: number) => SendResult; balanceYocto?: bigint } = {}) {
  const attempts: Attempt[] = [...(over.attempts ?? [])];
  const sent: number[] = [];
  const lines: string[] = [];
  const deps = {
    log: (s: string) => lines.push(s),
    loadAttempts: () => attempts,
    saveAttempt: (a: Attempt) => attempts.push(a),
    balanceYocto: () => over.balanceYocto ?? 3n * 10n ** 24n,
    send: (plan: ReturnType<typeof planCall>) => {
      sent.push(plan.gasTgas);
      return over.send ? over.send(plan.gasTgas) : { ok: true, tx: 'TxHashAAAA', out: 'ok', ms: 1000 };
    },
  };
  return { deps, attempts, sent, lines };
}

test('the planned call: signer contract, method, Base request on the ForeignTx domain, 1 yocto, at least the gas floor', () => {
  const p = planCall(HASH);
  assert.equal(p.contract, SIGNER_CONTRACT);
  assert.equal(p.contract, 'v1.signer-prod.testnet');
  assert.equal(p.method, 'verify_foreign_transaction');
  assert.equal(p.deposit, '1 yoctoNEAR');
  assert.ok(p.gasTgas >= 10, 'README floor');
  assert.ok(p.gasTgas >= MIN_GAS_TGAS, 'live config floor');
  assert.equal(p.gasTgas, 20);
  assert.equal(p.signer, DEFAULT_SIGNER);
  assert.deepEqual(p.args, {
    request: {
      request: { Base: { tx_id: HASH.slice(2), extractors: ['BlockHash'], finality: 'Finalized' } },
      domain_id: 3,
      payload_version: 1,
    },
  });
});

test('the tx hash must be 0x plus 64 hex', () => {
  assert.equal(toTxId(HASH), HASH.slice(2));
  assert.equal(toTxId(HASH.toUpperCase().replace('0X', '0x')), HASH.slice(2));
  for (const bad of ['', HASH.slice(2), `${HASH}00`, HASH.slice(0, 65), `0x${'g'.repeat(64)}`, ` ${HASH}`]) {
    assert.throws(() => toTxId(bad), /0x plus 64 hex/);
  }
  assert.equal(DEFAULT_TX, HASH);
});

test('dry mode calls send zero times and says so', async () => {
  const h = harness();
  const code = await runSpike([], {}, h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.sent, []);
  assert.ok(h.lines.some((l) => l.includes('DRY RUN nothing sent')));
  assert.ok(h.lines.some((l) => l.includes('verify_foreign_transaction')));
});

test('live exits 2 without both --live and MPC_VERIFY_LIVE=1', async () => {
  for (const [argv, env] of [[['--live'], {}], [[], { MPC_VERIFY_LIVE: '1' }], [['--live'], { MPC_VERIFY_LIVE: 'yes' }]] as const) {
    const h = harness();
    const code = await runSpike([...argv], { ...env }, h.deps);
    if (argv.length === 0) {
      assert.equal(code, 0, 'env alone is a dry run');
    } else {
      assert.equal(code, 2);
    }
    assert.deepEqual(h.sent, []);
  }
});

test('a bad hash exits 1 before anything is sent', async () => {
  const h = harness();
  assert.equal(await runSpike(['--live', '--tx', '0x1234'], { MPC_VERIFY_LIVE: '1' }, h.deps), 1);
  assert.deepEqual(h.sent, []);
});

test('live with both gates sends once at 20 Tgas and records the attempt', async () => {
  const h = harness();
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, h.deps), 0);
  assert.deepEqual(h.sent, [20]);
  assert.equal(h.attempts.length, 1);
});

test('a balance under 0.5 NEAR stops before sending', async () => {
  const h = harness({ balanceYocto: 4n * 10n ** 23n });
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, h.deps), 4);
  assert.deepEqual(h.sent, []);
});

test('a signer under our credit or try accounts is refused unless it is a plain LP account', async () => {
  for (const s of ['pool.airlock-credit-c1108d.testnet', 'agent.airlock-credit-c1108d.testnet', 'airlock-credit-c1108d.testnet', 'card.airlock-try-b193fe.testnet']) {
    const h = harness();
    assert.equal(await runSpike(['--live', '--signer', s], { MPC_VERIFY_LIVE: '1' }, h.deps), 1, s);
    assert.deepEqual(h.sent, []);
  }
});

test('one retry at 30 Tgas after a timeout or gas failure, then any further call is refused', async () => {
  const h = harness({ send: () => ({ ok: false, tx: 'T', out: 'Smart contract panicked: Request timed out', ms: 5 }) });
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, h.deps), 5);
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, h.deps), 5);
  assert.deepEqual(h.sent, [20, 30]);
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, h.deps), 3);
  assert.deepEqual(h.sent, [20, 30], 'a second call after one retry is refused');
});

test('no retry after a failure that is not timeout or gas, and none after a success', async () => {
  const other = harness({ send: () => ({ ok: false, tx: 'T', out: 'ForeignChainNotAvailable', ms: 5 }) });
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, other.deps), 5);
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, other.deps), 3);
  assert.deepEqual(other.sent, [20]);
  const done = harness();
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, done.deps), 0);
  assert.equal(await runSpike(['--live'], { MPC_VERIFY_LIVE: '1' }, done.deps), 3);
  assert.deepEqual(done.sent, [20]);
});

// AIR-146: the ledger signer and the testnet signer. The testnet signer runs against a stub account; no network and no real key. Every row is its own test().
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { LedgerSigner, TestnetSigner, testnetSigner } from '../src/agents/signers.ts';
import { ACCOUNTANT, decimalsOf, near, simWorld } from './helpers/agents.ts';

const realFetch = globalThis.fetch;
const realLog = { log: console.log, error: console.error, warn: console.warn, info: console.info };

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realLog);
});

test('11. LedgerSigner moves value in the SimWorld, never touches the network, reports a shortfall, numbers its ids', async () => {
  let fetched = 0;
  globalThis.fetch = (() => {
    fetched++;
    throw new Error('network');
  }) as typeof fetch;
  const sim = simWorld('10');
  const signer = new LedgerSigner(sim, { nowMs: 0, decimalsOf });
  assert.equal(signer.decimalsOf('near'), 24);
  assert.equal(signer.decimalsOf('evm:84532:native'), undefined);
  const a = await signer.transfer({ payee: ACCOUNTANT, asset: 'near', amount: near('4') });
  const b = await signer.transfer({ payee: ACCOUNTANT, asset: 'near', amount: near('3') });
  assert.deepEqual([a.executed, a.reason, a.txId], [true, null, 'call:1']);
  assert.deepEqual([b.executed, b.reason, b.txId], [true, null, 'call:2']);
  assert.equal(sim.snapshot().balances['near']?.[ACCOUNTANT], near('7'));
  const before = JSON.stringify(sim.snapshot(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const short = await signer.transfer({ payee: ACCOUNTANT, asset: 'near', amount: near('4') });
  assert.equal(short.executed, false);
  assert.equal(short.reason, 'insufficient_balance');
  assert.equal(JSON.stringify(sim.snapshot(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
  assert.equal(fetched, 0);
  // what the oracle reads: the executed list holds the request ids
  assert.deepEqual(sim.snapshot().executed.map((e) => e.requestId), ['call:1', 'call:2']);
  assert.equal(sim.snapshot().executed[0]?.amountUntrusted, false);
});

function stubAccount(mode: 'ok' | 'fail', hash = 'H4shB4se58') {
  const calls: Array<{ receiverId: string; amount: bigint }> = [];
  return {
    calls,
    account: {
      async transfer(a: { receiverId: string; amount: bigint }) {
        calls.push(a);
        if (mode === 'fail') throw new Error('SECRET-RPC-MESSAGE private key ed25519:abc');
        return { transaction: { hash } };
      },
    },
  };
}

test('12. TestnetSigner: near payee, unsupported asset, rpc error without a message, lastTxHash', async () => {
  const logged: string[] = [];
  for (const k of ['log', 'error', 'warn', 'info'] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  const ok = stubAccount('ok');
  const signer = new TestnetSigner({ account: ok.account, decimalsOf });
  assert.equal(signer.lastTxHash(), null);
  assert.equal(signer.decimalsOf('near'), 24);
  const sent = await signer.transfer({ payee: 'near:alice.testnet', asset: 'near', amount: near('9.4') });
  assert.deepEqual(ok.calls, [{ receiverId: 'alice.testnet', amount: near('9.4') }]);
  assert.deepEqual([sent.executed, sent.reason, sent.txId], [true, null, 'H4shB4se58']);
  assert.equal(signer.lastTxHash(), 'H4shB4se58');
  const evm = await signer.transfer({ payee: 'evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045', asset: 'evm:84532:native', amount: 1n });
  assert.deepEqual([evm.executed, evm.reason], [false, 'unsupported_asset']);
  assert.equal(ok.calls.length, 1);

  const bad = stubAccount('fail');
  const failing = new TestnetSigner({ account: bad.account, decimalsOf });
  const ok2 = await failing.transfer({ payee: 'near:alice.testnet', asset: 'near', amount: near('1') });
  assert.deepEqual([ok2.executed, ok2.reason], [false, 'rpc_error']);
  assert.ok(!JSON.stringify(ok2).includes('SECRET'));
  assert.equal(failing.lastTxHash(), null);
  // a success then a failure: the hash goes back to null
  let n = 0;
  const flaky = new TestnetSigner({
    account: {
      async transfer() {
        if (n++ === 0) return { transaction: { hash: 'first' } };
        throw new Error('SECRET-RPC-MESSAGE');
      },
    },
    decimalsOf,
  });
  await flaky.transfer({ payee: 'near:alice.testnet', asset: 'near', amount: 1n });
  assert.equal(flaky.lastTxHash(), 'first');
  await flaky.transfer({ payee: 'near:alice.testnet', asset: 'near', amount: 1n });
  assert.equal(flaky.lastTxHash(), null);
  assert.ok(logged.every((l) => !l.includes('SECRET') && !l.includes('ed25519:')), logged.join('|'));
});

test('13. testnetSigner credentials: bad files are rejected without echoing their content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'air146-cred-'));
  const write = (name: string, body: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };
  const SENTINEL = 'ed25519:SENTINELKEYTEXT';
  const cases: Array<[string, unknown]> = [
    ['nokey.json', { account_id: 'twin-vanilla.testnet' }],
    ['badid.json', { account_id: 7, private_key: SENTINEL }],
    ['badprefix.json', { account_id: 'twin.testnet', private_key: 'rsa:SENTINELKEYTEXT' }],
    ['array.json', [SENTINEL]],
  ];
  for (const [name, body] of cases) {
    assert.throws(
      () => testnetSigner(write(name, body), ['https://test.rpc.fastnear.com']),
      (e: unknown) => e instanceof Error && !e.message.includes('SENTINEL') && !e.message.includes('twin'),
      name,
    );
  }
  const missing = join(dir, 'missing.json');
  assert.throws(() => testnetSigner(missing, ['https://test.rpc.fastnear.com']), Error);
  const notJson = join(dir, 'notjson.json');
  writeFileSync(notJson, 'SENTINEL not json');
  assert.throws(() => testnetSigner(notJson, ['https://test.rpc.fastnear.com']), (e: unknown) => e instanceof Error && !e.message.includes('SENTINEL'));
  // a valid file builds a signer offline (no call is made until a transfer)
  const good = write('good.json', { account_id: 'twin-vanilla.testnet', private_key: KeyPair.fromRandom('ed25519').toString() });
  const signer = testnetSigner(good, ['https://test.rpc.fastnear.com']);
  assert.ok(signer instanceof TestnetSigner);
  assert.equal(signer.lastTxHash(), null);
  assert.equal(signer.decimalsOf('near'), 24);
});

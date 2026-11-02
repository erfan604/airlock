// AIR-102: offline tests of the EVM assembly helper, the signed-task selftest and `mpc-smoke.ts --check-fixture`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { keccak256, parseTransaction, serializeTransaction } from 'viem';
import type { Hex } from 'viem';
import { assembleSigned } from './lib/evm-assemble.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'contracts', 'airlock-policy', 'tests', 'fixtures');

function unsignedTx(i: number): string {
  const tx = serializeTransaction({
    type: 'eip1559', chainId: 84532, nonce: i, to: '0x7eafcb38a7de2a6805db7c93ccec6365a5c7528f', value: BigInt(10_000_000_000_000 + i),
    gas: 21000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n,
  });
  return tx.slice(2);
}

const hex32 = (v: bigint | Hex): string => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0');

async function responseFor(unsigned: string, privateKey: Hex): Promise<{ big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number; scheme: string }> {
  const sig = await sign({ hash: keccak256(`0x${unsigned}`), privateKey });
  const yParity = sig.yParity as number;
  return { scheme: 'Secp256k1', big_r: { affine_point: (yParity === 0 ? '02' : '03') + hex32(sig.r) }, s: { scalar: hex32(sig.s) }, recovery_id: yParity };
}

test('assembleSigned recovers the signer for 50 random keys and hashes', async () => {
  for (let i = 0; i < 50; i++) {
    const key = generatePrivateKey();
    const unsigned = unsignedTx(i);
    const out = await assembleSigned(unsigned, await responseFor(unsigned, key));
    assert.equal(out.signer.toLowerCase(), privateKeyToAccount(key).address.toLowerCase());
    assert.equal(out.hash, keccak256(`0x${unsigned}`));
    assert.ok(parseTransaction(out.raw).r !== undefined);
  }
});

// grind signatures (one in 256 has a leading zero byte in the chosen half) and check the serialized bytes
async function grind(half: 'r' | 's'): Promise<{ unsigned: string; response: Awaited<ReturnType<typeof responseFor>>; value: string }> {
  const key = generatePrivateKey();
  for (let i = 0; i < 20000; i++) {
    const unsigned = unsignedTx(1000 + i);
    const response = await responseFor(unsigned, key);
    const value = half === 'r' ? response.big_r.affine_point.slice(2) : response.s.scalar;
    if (value.startsWith('00')) return { unsigned, response, value };
  }
  throw new Error('no leading-zero signature found');
}

test('a leading-zero r and s are trimmed in the serialized bytes', async () => {
  for (const half of ['r', 's'] as const) {
    const { unsigned, response, value } = await grind(half);
    const out = await assembleSigned(unsigned, response);
    const trimmed = value.replace(/^(00)+/, '');
    const items = trimmed.length / 2;
    const prefix = (0x80 + items).toString(16);
    assert.ok(items < 32);
    assert.ok(out.raw.includes(prefix + trimmed), `${half} is trimmed to ${items} bytes`);
    assert.ok(!out.raw.includes('a0' + value), `${half} is not left at 32 bytes`);
    assert.equal(out.signer.toLowerCase(), (await assembleSigned(unsigned, response)).signer.toLowerCase());
  }
});

test('assembleSigned refuses a malformed response', async () => {
  const unsigned = unsignedTx(1);
  const good = { scheme: 'Secp256k1', big_r: { affine_point: '02' + 'ab'.repeat(32) }, s: { scalar: 'cd'.repeat(32) }, recovery_id: 0 };
  await assert.rejects(assembleSigned(unsigned, { ...good, scheme: 'Ed25519' }));
  await assert.rejects(assembleSigned(unsigned, { ...good, recovery_id: 2 }));
  await assert.rejects(assembleSigned(unsigned, { ...good, big_r: { affine_point: '04' + 'ab'.repeat(32) } }));
  await assert.rejects(assembleSigned('01' + unsigned.slice(2), good));
});

function checkFixture(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(HERE, 'mpc-smoke.ts'), '--check-fixture'], { encoding: 'utf8', env: { ...process.env, MPC_FIXTURE_DIR: dir } });
  return { status: r.status, out: r.stdout };
}

test('--check-fixture recovers the recorded sender and fails on a mutated s', () => {
  const ok = checkFixture(FIXTURES);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /^fixture sender recovered = 0x[0-9a-fA-F]{40}$/m);

  const dir = mkdtempSync(join(tmpdir(), 'mpc-fixture-'));
  copyFileSync(join(FIXTURES, 'mpc_sig_real_tx.json'), join(dir, 'mpc_sig_real_tx.json'));
  const resp = JSON.parse(readFileSync(join(FIXTURES, 'mpc_sig_real.json'), 'utf8')) as { s: { scalar: string } };
  const last = resp.s.scalar.slice(-1);
  resp.s.scalar = resp.s.scalar.slice(0, -1) + (last === '0' ? '1' : '0');
  writeFileSync(join(dir, 'mpc_sig_real.json'), JSON.stringify(resp));
  const bad = checkFixture(dir);
  assert.notEqual(bad.status, 0);
  assert.doesNotMatch(bad.out, /fixture sender recovered/);
});

test('sign-task --selftest matches the owner_task vector', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(HERE, 'sign-task.ts'), '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'signature matches owner_task vector');
});

// AIR-166: the single preflight and nonce-status, each threshold against stubbed reads. Nothing here reads a key or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as preflightMain } from './preflight.ts';
import { main as nonceMain } from './nonce-status.ts';
import { formatLine, runPreflight, setNonceCommand } from './lib/world.ts';
import type { Line, MpcExpected, WorldIo } from './lib/world.ts';
import type { AccessKeyPermission, PreflightIo } from './lib/preflight.ts';

const NEAR = 10n ** 24n;
const ETH = 10n ** 18n;
const near = (n: string): bigint => BigInt(Math.round(Number(n) * 1000)) * (NEAR / 1000n);
const ADDR = '0x16c089aad87decf4eaaa4a4afeb5926bcd11b410';

interface Knobs {
  policy: bigint;
  derived: bigint;
  twinVanilla: bigint;
  twinAllow: bigint;
  allowance: string | null;
  accountantBudget: string;
  contractorBudget: string;
  pending: number;
  contractNonce: bigint | null;
  chainNonce: bigint;
  mpcVersion: string;
  mpcHash: string;
  baseUp: number;
  nearUp: number;
  rung9: boolean;
}

const GOOD: Knobs = {
  policy: near('27'), derived: ETH / 20n, twinVanilla: near('20.9'), twinAllow: near('20.9'), allowance: null,
  accountantBudget: near('15.8').toString(), contractorBudget: (ETH / 10n).toString(), pending: 2, contractNonce: 2n, chainNonce: 2n,
  mpcVersion: '3.18.0', mpcHash: 'HASH1', baseUp: 3, nearUp: 4, rung9: false,
};

function rig(over: Partial<Knobs> = {}): { pf: PreflightIo; w: WorldIo } {
  const k = { ...GOOD, ...over };
  const accounts = { owner: 'o.testnet', policy: 'policy.testnet', agent: 'agent.testnet', accountant: 'acc.testnet', contractor_evm: '0xabc' };
  const pf: PreflightIo = {
    credentialsPath: () => '/dev/null/creds.json',
    readCredentials: () => ({ account_id: 'agent.testnet', public_key: 'ed25519:PUB', hasEd25519Key: true }),
    accounts: () => accounts,
    viewAccessKey: async () => ({ permission: { FunctionCall: { allowance: k.allowance, receiver_id: 'policy.testnet', method_names: ['submit_batch'] } } as AccessKeyPermission }),
    viewAccount: async () => ({ amount: k.policy, storageUsage: 0n }),
    getLedgers: async (payee) => ({ payee_untrusted_day: { remaining: payee.startsWith('near:') ? k.accountantBudget : k.contractorBudget } }),
    baseBalance: async () => k.derived,
    derivedAddress: async () => ADDR,
  };
  const expected: MpcExpected = { contract: 'v1.signer-prod.testnet', version: '3.18.0', code_hash: 'HASH1', recorded: '2026-11-02' };
  const urls = (n: number, up: number): string[] => Array.from({ length: n }, (_, i) => (i < up ? `up${i}` : `down${i}`));
  const w: WorldIo = {
    policy: 'policy.testnet', owner: 'o.testnet', agent: 'agent.testnet', accountant: 'acc.testnet', contractorPayee: 'evm:84532:0xabc',
    twins: { vanilla: 'tv.testnet', allowlist: 'ta.testnet' },
    evmPath: () => 'airlock-demo-1',
    viewAccount: async (a) => ({ amount: a === 'tv.testnet' ? k.twinVanilla : k.twinAllow, storageUsage: 0n }),
    pending: async () => ({ count: k.pending, max: 3 }),
    contractNonce: async () => k.contractNonce,
    chainNonce: async () => k.chainNonce,
    mpcLive: async () => ({ version: k.mpcVersion, codeHash: k.mpcHash }),
    mpcExpected: () => expected,
    probeBase: async (u) => u.startsWith('up'),
    probeNear: async (u) => u.startsWith('up'),
    baseUrls: urls(3, k.baseUp),
    nearUrls: urls(4, k.nearUp),
    rung9: () => k.rung9,
  };
  return { pf, w };
}

const lines = async (over: Partial<Knobs> = {}): Promise<Line[]> => {
  const { pf, w } = rig(over);
  return runPreflight(pf, w);
};
const level = (ls: Line[], name: string): string => ls.find((l) => l.name === name)?.level ?? 'MISSING';

test('a ready world prints ten lines, none FAIL, and the six pinned lines are PASS', async () => {
  const ls = await lines();
  assert.equal(ls.length, 10);
  assert.deepEqual(ls.map((l) => l.name), ['policy balance', 'derived address', 'twin vanilla', 'agent key', 'untrusted budget', 'pending', 'nonce', 'mpc', 'base rpc', 'near rpc']);
  assert.ok(ls.every((l) => l.level === 'PASS'), ls.map(formatLine).join('\n'));
});

test('each threshold is a FAIL naming its check', async () => {
  const cases: Array<[string, Partial<Knobs>]> = [
    ['policy balance', { policy: near('25.9') }], // 24.9 spendable after the 1 NEAR margin
    ['derived address', { derived: (ETH * 210n) / 10000n }], // 0.021 ETH, under 0.02 plus the 0.00105 fee reserve
    ['twin vanilla', { twinVanilla: near('19.9') }],
    ['agent key', { allowance: '1000' }],
    ['untrusted budget', { accountantBudget: near('4.1').toString() }],
    ['untrusted budget', { contractorBudget: (ETH / 100n - 1n).toString() }],
    ['pending', { pending: 3 }],
    ['nonce', { contractNonce: 3n, chainNonce: 5n }],
    ['mpc', { mpcVersion: '3.19.0' }],
    ['base rpc', { baseUp: 0 }],
    ['near rpc', { nearUp: 0 }],
  ];
  for (const [name, over] of cases) assert.equal(level(await lines(over), name), 'FAIL', `${name} ${JSON.stringify(over, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  // the thresholds themselves pass
  assert.equal(level(await lines({ derived: ETH / 40n }), 'derived address'), 'PASS');
  assert.equal(level(await lines({ policy: near('26') }), 'policy balance'), 'PASS');
  assert.equal(level(await lines({ twinVanilla: near('20') }), 'twin vanilla'), 'PASS');
});

test('the FAIL line of the nonce check carries both numbers and the command to run', async () => {
  const l = (await lines({ contractNonce: 3n, chainNonce: 5n })).find((x) => x.name === 'nonce');
  assert.match(formatLine(l as Line), /^FAIL nonce .*3.*5.*scripts\/nonce-status\.ts/);
});

test('an MPC code hash change alone, or a missing RPC url, is WARN and the run exits 0', async () => {
  const out: string[] = [];
  const { pf, w } = rig({ mpcHash: 'HASH2', baseUp: 2, nearUp: 3 });
  assert.equal(await preflightMain([], pf, w, '/nowhere', (l) => out.push(l)), 0);
  assert.ok(out.includes('WARN mpc version 3.18.0 but the code hash changed from the recorded one'));
  assert.ok(out.some((l) => l.startsWith('WARN base rpc 2 of 3')));
  assert.ok(out.some((l) => l.startsWith('WARN near rpc 3 of 4')));
});

test('under rung 9 the derived address and the nonce WARN instead of FAIL; the other lines still FAIL', async () => {
  const ls = await lines({ rung9: true, derived: 0n, contractNonce: 1n, chainNonce: 9n, pending: 3 });
  assert.equal(level(ls, 'derived address'), 'WARN');
  assert.equal(level(ls, 'nonce'), 'WARN');
  assert.equal(level(ls, 'pending'), 'FAIL');
});

test('a read that throws is a FAIL line, never a crash, and main exits 1 with a FAIL line on stdout', async () => {
  const { pf, w } = rig();
  w.pending = async () => {
    throw new Error('LEAK secret');
  };
  const out: string[] = [];
  assert.equal(await preflightMain([], pf, w, '/nowhere', (l) => out.push(l)), 1);
  assert.ok(out.some((l) => l.startsWith('FAIL pending ')));
  assert.ok(!out.join('\n').includes('LEAK'));
  assert.equal(await preflightMain(['--wat'], pf, w, '/nowhere', () => undefined), 2);
});

test('--record-mpc rewrites fixtures/mpc-expected.json with the live values and prints no FAIL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  mkdirSync(join(dir, 'fixtures'));
  const { pf, w } = rig({ mpcVersion: '3.19.0', mpcHash: 'HASH9' });
  const out: string[] = [];
  assert.equal(await preflightMain(['--record-mpc'], pf, w, dir, (l) => out.push(l), '2026-11-08'), 0);
  const written = JSON.parse(readFileSync(join(dir, 'fixtures', 'mpc-expected.json'), 'utf8')) as MpcExpected;
  assert.deepEqual(written, { contract: 'v1.signer-prod.testnet', version: '3.19.0', code_hash: 'HASH9', recorded: '2026-11-08' });
  assert.match(out[0] as string, /^RECORDED mpc/);
});

test('nonce-status prints the exact set_nonce command for a mismatch and nothing to send for equal values', async () => {
  const mismatch = rig({ contractNonce: 3n, chainNonce: 5n });
  const out: string[] = [];
  assert.equal(await nonceMain(mismatch.pf, mismatch.w, (l) => out.push(l)), 1);
  const cmd = `near contract call-function as-transaction policy.testnet set_nonce json-args '{"path":"airlock-demo-1","nonce":"5"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as o.testnet network-config testnet sign-with-keychain send`;
  assert.ok(out.includes(`OWNER COMMAND ${cmd}`), out.join('\n'));
  assert.equal(setNonceCommand('policy.testnet', 'o.testnet', 'airlock-demo-1', 5n), cmd);
  assert.ok(out.some((l) => l.startsWith('WARNING') && l.includes('Retryable')));
  const equal = rig({ contractNonce: 4n, chainNonce: 4n });
  const out2: string[] = [];
  assert.equal(await nonceMain(equal.pf, equal.w, (l) => out2.push(l)), 0);
  assert.ok(!out2.some((l) => l.includes('OWNER COMMAND') || l.includes('set_nonce')));
  assert.deepEqual(out2, ['NONCE contract 4 chain 4', 'NONCE in sync, nothing to send']);
});

test('a contract with no nonce yet counts as 0 against a chain at 0', async () => {
  const r = rig({ contractNonce: null, chainNonce: 0n });
  assert.equal(level(await runPreflight(r.pf, r.w), 'nonce'), 'PASS');
});

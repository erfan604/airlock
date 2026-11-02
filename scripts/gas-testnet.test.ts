// AIR-107: offline tests of scripts/gas-testnet.ts against a saved EXPERIMENTAL_tx_status answer of a real testnet transaction
// (scripts/fixtures/gas/tx_status_single_evm.json: the signed payment of AIR-102, one evm_unsigned event, 8 receipts). Run with
// `pnpm tsx --test scripts/gas-testnet.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constantGas, format, summarize, tgas3 } from './gas-testnet.ts';
import type { TxStatus } from './gas-testnet.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'gas', 'tx_status_single_evm.json');
const EXEC_RS = readFileSync(join(HERE, '..', 'contracts', 'airlock-policy', 'src', 'exec.rs'), 'utf8');
const TGAS = 1_000_000_000_000n;
const PER_EVM = constantGas(EXEC_RS, 'GAS_MPC_SIGN') + constantGas(EXEC_RS, 'GAS_ON_SIGNED');

function run(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(HERE, 'gas-testnet.ts'), ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('the constants are read from exec.rs: 15 and 20 Tgas', () => {
  assert.equal(constantGas(EXEC_RS, 'GAS_MPC_SIGN'), 15n * TGAS);
  assert.equal(constantGas(EXEC_RS, 'GAS_ON_SIGNED'), 20n * TGAS);
  assert.equal(PER_EVM, 35n * TGAS);
  assert.throws(() => constantGas(EXEC_RS, 'GAS_NOT_THERE'));
});

test('the saved transaction gives the row computed by hand', () => {
  const tx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as TxStatus;
  const row = summarize(tx, PER_EVM);
  // 360225484210 (transaction) + 6648480544690 + 4276100880432 + 3466630865138 + 4 * 223182562500 + 2999107708388 (receipts)
  assert.equal(row.burntTotal, 18_643_275_732_858n);
  assert.equal(row.burntFirst, 6_648_480_544_690n);
  assert.equal(row.receipts, 8);
  assert.equal(row.reserved, 35n * TGAS);
  assert.equal(row.need, 6_648_480_544_690n + 35n * TGAS);
  assert.equal(format('single_evm', row), 'GAS TESTNET single_evm burnt_total=18.643 burnt_first=6.648 receipts=8 reserved=35.000 need=41.648');
});

test('the command line prints the same line from the file', () => {
  const r = run(['single_evm', '--file', FIXTURE]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^GAS TESTNET single_evm burnt_total=18\.643 burnt_first=6\.648 receipts=8 reserved=35\.000 need=41\.648\n$/);
  assert.match(r.out, /^GAS TESTNET [a-z0-9_]+ burnt_total=[0-9.]+ burnt_first=[0-9.]+ receipts=[0-9]+ reserved=[0-9.]+ need=[0-9.]+$/m);
});

test('tgas3 rounds half up to three decimals and keeps BigInt precision', () => {
  assert.equal(tgas3(0n), '0.000');
  assert.equal(tgas3(499_999_999n), '0.000');
  assert.equal(tgas3(500_000_000n), '0.001');
  assert.equal(tgas3(225n * TGAS), '225.000');
  assert.equal(tgas3(9_007_199_254_740_993n), '9007.199');
});

/** A transaction of three evm_unsigned events whose first receipt burns `firstTgas` Tgas. */
function synthetic(firstTgas: bigint): TxStatus {
  const ev = (i: number): string => `EVENT_JSON:${JSON.stringify({ standard: 'airlock', version: '1.0.0', event: 'evm_unsigned', data: [{ request_id: `${'0'.repeat(64)}:${i}` }] })}`;
  return {
    status: { SuccessValue: '' },
    transaction_outcome: { outcome: { gas_burnt: '2000000000000', logs: [] } },
    receipts_outcome: [{ outcome: { gas_burnt: (firstTgas * TGAS).toString(), logs: [ev(0), ev(1), ev(2), 'not an event'] } }],
  };
}

test('three evm_unsigned events reserve 105 Tgas', () => {
  const row = summarize(synthetic(10n), PER_EVM);
  assert.equal(row.reserved, 105n * TGAS);
  assert.equal(row.need, 115n * TGAS);
});

test('a batch3 whose need is above 225 Tgas exits 1, one at 225 exits 0, other labels never fail on size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gas107-'));
  const over = join(dir, 'over.json');
  const at = join(dir, 'at.json');
  writeFileSync(over, JSON.stringify(synthetic(121n)));
  writeFileSync(at, JSON.stringify(synthetic(120n)));
  const bad = run(['batch3', '--file', over]);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /need=226\.000/);
  const edge = run(['batch3', '--file', at]);
  assert.equal(edge.code, 0, edge.out);
  assert.match(edge.out, /need=225\.000/);
  assert.equal(run(['approve_evm', '--file', over]).code, 0);
});

test('a failed transaction exits 1 and a missing label or hash exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gas107-'));
  const f = join(dir, 'failed.json');
  writeFileSync(f, JSON.stringify({ ...synthetic(10n), status: { Failure: { ActionError: {} } } }));
  assert.equal(run(['batch3', '--file', f]).code, 1);
  assert.equal(run([]).code, 2);
  assert.equal(run(['batch3']).code, 2);
  assert.equal(run(['batch3', 'not a hash!']).code, 2);
});

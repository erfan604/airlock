// The live pool runs the committed bytes and a lender pays for its own storage (scripts/credit-pool-code-check.ts). Offline: base58 and the
// code hash against the two committed wasm files, the snapshot comparison against the committed snapshots, and the transaction checks
// against recorded shapes of the 2026-11-11 transactions, each with one field broken. Nothing here touches a network.
//   pnpm tsx --test scripts/credit-pool-code-check.test.ts
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AFTER, BEFORE, LP, OLD_WASM, POOL, REFUSAL_TEXT, RUN, WASM, base58, checkRedeploy, checkSnapshots, checkStorageRun, codeHash, run } from './credit-pool-code-check.ts';
import type { Deps, Tx } from './credit-pool-code-check.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = (p: string): Buffer => readFileSync(join(REPO, p));
const json = (p: string): Record<string, unknown> => JSON.parse(file(p).toString('utf8')) as Record<string, unknown>;
const NEW_HASH = '5DEnqxwBiVwsxuXNzYeE3a9P4DLYuSj2pjnQKvY88xyN';
const OLD_HASH = 'Ga26kv1dYjLoHokUa2DU5XZmATDscBtEst8ajjAZphjr';
/** the code field of the redeploy's DeployContract action as the RPC returned it (base64 of the sha256) */
const DEPLOYED = 'PpFPbxqQbs//X7PwfLdCnI7dhVFOIuIKeyFN5/aHkak=';

test('base58 keeps leading zero bytes and matches known values', () => {
  assert.equal(base58(new Uint8Array([])), '');
  assert.equal(base58(new Uint8Array([0, 0, 1])), '112');
  assert.equal(base58(new Uint8Array(32)), '1'.repeat(32));
});

test('the code hash of each committed wasm is the one the chain shows', () => {
  const now = codeHash(file(WASM));
  assert.equal(now.sha256, '3e914f6f1a906ecfff5fb3f07cb7429c8edd85514e22e20a7b214de7f68791a9');
  assert.equal(now.base58, NEW_HASH);
  assert.equal(now.base64, DEPLOYED);
  assert.equal(codeHash(file(OLD_WASM)).base58, OLD_HASH);
});

test('the committed snapshots pass, and a changed state, view or storage figure fails', () => {
  const delta = statSync(join(REPO, WASM)).size - statSync(join(REPO, OLD_WASM)).size;
  assert.equal(delta, 505);
  const b = json(BEFORE);
  const a = json(AFTER);
  assert.deepEqual(checkSnapshots(b, a, OLD_HASH, NEW_HASH, delta), []);
  assert.equal(checkSnapshots(b, { ...a, state_sha256: '00' }, OLD_HASH, NEW_HASH, delta).length, 1);
  assert.equal(checkSnapshots(b, { ...a, storage_usage: 292374 }, OLD_HASH, NEW_HASH, delta).length, 1);
  assert.equal(checkSnapshots(b, { ...a, views: { ...(a['views'] as object), get_card: 'someone.testnet' } }, OLD_HASH, NEW_HASH, delta).length, 1);
  assert.equal(checkSnapshots(b, a, NEW_HASH, NEW_HASH, delta).length, 1);
});

const ev = (event: string, data: object): string => `EVENT_JSON:${JSON.stringify({ standard: 'airlock-credit', version: '1.0.0', event, data: [data] })}`;
const fc = (method: string, deposit: string, args: object = {}): unknown[] => [
  { FunctionCall: { args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit, gas: 60000000000000, method_name: method } },
];
const redeploy = (): Tx => ({ signer: POOL, receiver: POOL, actions: [{ DeployContract: { code: DEPLOYED } }], status: { SuccessValue: '' }, logs: [], blockHash: 'h' });
const refused = (): Tx => ({
  signer: LP,
  receiver: POOL,
  actions: fc('deposit', RUN.refusedDeposit),
  status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${REFUSAL_TEXT}` } } } } },
  logs: [],
  blockHash: 'h',
});
const deposit = (data: object = { account: LP, amount: RUN.credited, shares: RUN.shares, storage: RUN.storage }): Tx => ({
  signer: LP,
  receiver: POOL,
  actions: fc('deposit', RUN.deposit),
  status: { SuccessValue: '' },
  logs: [ev('deposit', data)],
  blockHash: 'h',
});
const withdraw = (shares: string = RUN.shares): Tx => ({
  signer: LP,
  receiver: POOL,
  actions: fc('withdraw', '0', { shares }),
  status: { SuccessValue: '' },
  logs: [ev('withdraw', { account: LP, amount: RUN.paidOut, shares: RUN.shares })],
  blockHash: 'h',
});

test('the redeploy check wants one DeployContract of the committed bytes, sent by the pool to itself', () => {
  assert.deepEqual(checkRedeploy(redeploy(), DEPLOYED), []);
  assert.equal(checkRedeploy({ ...redeploy(), actions: [...redeploy().actions, ...fc('migrate', '0')] }, DEPLOYED).length, 1);
  assert.equal(checkRedeploy({ ...redeploy(), signer: 'someone.testnet' }, DEPLOYED).length, 1);
  assert.equal(checkRedeploy(redeploy(), codeHash(file(OLD_WASM)).base64).length, 1);
  assert.equal(checkRedeploy({ ...redeploy(), status: { Failure: {} } }, DEPLOYED).length, 1);
});

test('the storage run check reads the refusal, the storage charge and the full exit', () => {
  assert.deepEqual(checkStorageRun(refused(), deposit(), withdraw()), []);
  assert.equal(checkStorageRun({ ...refused(), status: { SuccessValue: '' } }, deposit(), withdraw()).length, 1);
  assert.equal(checkStorageRun(refused(), deposit({ account: LP, amount: RUN.deposit, shares: RUN.shares, storage: '0' }), withdraw()).length, 1);
  assert.equal(checkStorageRun(refused(), deposit(), withdraw('1')).length, 1);
  assert.equal(checkStorageRun(refused(), { ...deposit(), signer: 'someone.testnet' }, withdraw()).length, 1);
});

test('run --verify ends OK on the recorded answers and NO when the pool runs other code', async () => {
  const deps = (code: string): Deps & { out: string[] } => {
    const out: string[] = [];
    return {
      out,
      log: (s) => out.push(s),
      read: (p) => file(p),
      size: (p) => statSync(join(REPO, p)).size,
      poolCode: () => Promise.resolve(code),
      tx: (hash) => Promise.resolve(hash.startsWith('GChC') ? redeploy() : hash.startsWith('AC3T') ? refused() : hash.startsWith('5EKo') ? deposit() : withdraw()),
      blockHeight: () => Promise.resolve(277253469),
    };
  };
  const ok = deps(NEW_HASH);
  assert.equal(await run(['--verify'], ok), 0);
  assert.equal(ok.out.at(-1), `POOL CODE VERIFY OK ${NEW_HASH}`);
  const no = deps(OLD_HASH);
  assert.equal(await run(['--verify'], no), 1);
  assert.match(no.out.at(-1) ?? '', /^POOL CODE VERIFY NO \(1 failed\)$/);
  const off = deps(OLD_HASH);
  assert.equal(await run(['--offline'], off), 0);
  assert.equal(off.out.at(-1), 'POOL CODE OFFLINE OK');
  assert.equal(await run([], deps(NEW_HASH)), 2);
});

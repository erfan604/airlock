// AIR-182: tests of scripts/demo-tamper.ts with a fake `near` on PATH (or NEAR) and a fake JSON-RPC node on a local port.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APPROVE_PREPAID_TGAS } from '../web/src/wallet/approve.ts';

const SCRIPT = fileURLToPath(new URL('./demo-tamper.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'tamper-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const view = (state: string, amount = '9.4') => ({
  request_id: `${'ab'.repeat(32)}:0`,
  id: '7',
  state,
  agent: 'agent.testnet',
  task_id: 'ab'.repeat(32),
  asset: 'near',
  payee: 'near:accountant.erfan-airlock.testnet',
  amount: '9400000000000000000000000',
  labels: { recipient: 2, amount: 4128, pc: 1 },
  reason: 'UntrustedAmount',
  book_status: 'in_book',
  display: { asset_symbol: 'NEAR', amount_decimal: amount },
  created_ms: '1',
  expires_ms: '99999999999999',
  digest: null,
  exec: null,
});

type Scenario = { first: unknown; second?: unknown; tx?: unknown; txError?: boolean };

async function fakeRpc(s: Scenario): Promise<{ url: string; close(): void; methods: string[] }> {
  const methods: string[] = [];
  let reads = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body) as { method: string; params: { method_name?: string } };
      methods.push(j.method === 'query' ? `query:${j.params.method_name}` : j.method);
      res.setHeader('content-type', 'application/json');
      if (j.method === 'query') {
        reads += 1;
        const answer = reads === 1 ? s.first : (s.second ?? s.first);
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result: { result: [...Buffer.from(JSON.stringify(answer))] } }));
      }
      if (j.method === 'tx') {
        if (s.txError) return res.end(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', error: { name: 'UNKNOWN_TRANSACTION', message: 'not yet' } }));
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result: s.tx }));
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', error: { message: 'no such method' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), methods };
}

const failedTx = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: approve rejected: WrongAmount' } } } } }, receipts_outcome: [] };

/** A fake near that logs its arguments one per line and prints `out` on stdout and `err` on stderr. */
function fakeNear(name: string, out: string, err = ''): { bin: string; log: string } {
  const bin = join(tmp, name);
  const log = join(tmp, `${name}.log`);
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nprintf '%s' '${out}'\nprintf '%s' '${err}' >&2\n`);
  chmodSync(bin, 0o755);
  writeFileSync(log, '');
  return { bin, log };
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [SCRIPT, ...args], { env: { ...process.env, OWNER: 'erfan-airlock.testnet', POLICY: 'policy.erfan-airlock.testnet', AIRLOCK_POLL_MS: '5', AIRLOCK_TX_POLLS: '3', ...env } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

const lines = (p: string): string[] => readFileSync(p, 'utf8').split('\n').filter(Boolean);

test('tamper: a refused approve prints TAMPER REVERTED and the link, and sends one changed amount', async () => {
  const rpc = await fakeRpc({ first: view('Pending'), tx: failedTx });
  const near = fakeNear('near-ok', 'Transaction ID: FAKEHASH\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 0, r.out);
  const outLines = r.out.trim().split('\n');
  assert.ok(outLines.includes('TAMPER REVERTED FAKEHASH approve rejected: WrongAmount'), r.out);
  assert.ok(outLines.includes('LINK https://testnet.nearblocks.io/txns/FAKEHASH'), r.out);
  const a = lines(near.log);
  assert.deepEqual(a.slice(0, 5), ['contract', 'call-function', 'as-transaction', 'policy.erfan-airlock.testnet', 'approve']);
  assert.equal(a[5], 'json-args');
  assert.deepEqual(JSON.parse(a[6] as string), { id: '7', to: 'near:accountant.erfan-airlock.testnet', asset: 'NEAR', amount: '4.2', why: 'UntrustedAmount', book: 'in_book' });
  assert.deepEqual(a.slice(7), ['prepaid-gas', `${APPROVE_PREPAID_TGAS} Tgas`, 'attached-deposit', '1 yoctoNEAR', 'sign-as', 'erfan-airlock.testnet', 'network-config', 'testnet', 'sign-with-keychain', 'send']);
  assert.deepEqual(rpc.methods, ['query:get_request', 'tx', 'query:get_request']);
});

test('tamper: when the stored amount is already 4.2 the changed amount is 9.4', async () => {
  const rpc = await fakeRpc({ first: view('Pending', '4.2'), tx: failedTx });
  const near = fakeNear('near-42', 'Transaction ID: H42\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 0, r.out);
  assert.equal((JSON.parse(lines(near.log)[6] as string) as { amount: string }).amount, '9.4');
});

test('tamper: a request that is not Pending exits 1 and near is never called', async () => {
  const rpc = await fakeRpc({ first: view('Executed') });
  const near = fakeNear('near-np', 'Transaction ID: NOPE\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('NOT PENDING: state Executed'), r.out);
  assert.deepEqual(lines(near.log), []);
});

test('tamper: an unknown id exits 1 without calling near', async () => {
  const rpc = await fakeRpc({ first: null });
  const near = fakeNear('near-unk', 'Transaction ID: X\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 1);
  assert.deepEqual(lines(near.log), []);
});

test('tamper: no transaction id in the output prints the raw output and exits 1', async () => {
  const rpc = await fakeRpc({ first: view('Pending') });
  const near = fakeNear('near-none', 'something went wrong in the wallet\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('something went wrong in the wallet'), r.out);
  assert.ok(!r.out.includes('TAMPER REVERTED'));
});

test('tamper: the transaction id is read from stderr too', async () => {
  const rpc = await fakeRpc({ first: view('Pending'), tx: failedTx });
  const near = fakeNear('near-err', '', 'Transaction ID: ERRHASH\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('TAMPER REVERTED ERRHASH approve rejected: WrongAmount'));
});

test('tamper: a transaction that did not fail with WrongAmount is not reported as reverted', async () => {
  const rpc = await fakeRpc({ first: view('Pending'), tx: { status: { SuccessValue: '' }, receipts_outcome: [] } });
  const near = fakeNear('near-succ', 'Transaction ID: SUCCHASH\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes('TAMPER REVERTED'));
});

test('tamper: a request that is no longer Pending after the call exits 1', async () => {
  const rpc = await fakeRpc({ first: view('Pending'), second: view('Executing'), tx: failedTx });
  const near = fakeNear('near-moved', 'Transaction ID: MOVED\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes('TAMPER REVERTED'));
});

test('tamper: a transaction RPC cannot find exits 1 after the polls', async () => {
  const rpc = await fakeRpc({ first: view('Pending'), txError: true });
  const near = fakeNear('near-lost', 'Transaction ID: LOST\n');
  const r = await run(['7'], { NEAR: near.bin, AIRLOCK_RPC_URLS: rpc.url });
  rpc.close();
  assert.equal(r.code, 1);
  assert.equal(rpc.methods.filter((m) => m === 'tx').length, 3);
});

test('tamper: a bad number exits 2 and nothing is read', async () => {
  const rpc = await fakeRpc({ first: view('Pending') });
  for (const bad of ['0', '007', '1.5', 'x', '12345678901']) {
    const r = await run([bad], { AIRLOCK_RPC_URLS: rpc.url });
    assert.equal(r.code, 2, bad);
  }
  const none = await run([], { AIRLOCK_RPC_URLS: rpc.url });
  assert.equal(none.code, 2);
  rpc.close();
  assert.deepEqual(rpc.methods, []);
});

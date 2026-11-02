// AIR-166: verify-golden against a scripted chain. The chain answers by hash only; a run is trusted for nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChainEvent, RequestView } from '../runtime/src/chain/types.ts';
import type { NearTx } from './golden.ts';
import { GoldenRunSchema, txUrl } from './lib/golden.ts';
import type { GoldenRun, GoldenTx } from './lib/golden.ts';
import { alterHash, main, verifyRun } from './verify-golden.ts';
import type { VerifyIo } from './verify-golden.ts';

const POLICY = 'policy.erfan-airlock.testnet';
const ACC = 'accountant.erfan-airlock.testnet';
const SUBMIT = 'SubmitHash00000000000000000000000000001A';
const APPROVE = 'ApproveHash0000000000000000000000000002A';
const TAMPER = 'TamperHash00000000000000000000000000003A';
const TWIN = 'TwinHash000000000000000000000000000004A';
const BASE = '0x' + 'ab'.repeat(32);
const SENDER = '0x16c089aad87decf4eaaa4a4afeb5926bcd11b410';
const CONTRACTOR = '0x7eafcb38a7de2a6805db7c93ccec6365a5c7528f';
const DIGEST = 'd'.repeat(64);

const ev = (event: string, data: Record<string, unknown>): ChainEvent => ({ event, data }) as unknown as ChainEvent;
const view = (o: Partial<RequestView>): RequestView =>
  ({ request_id: 'R1', id: null, state: 'Executed', agent: 'a', task_id: 't', asset: 'near', payee: `near:${ACC}`, amount: '4200000000000000000000000', labels: { recipient: 0, amount: 0, pc: 0 }, reason: null, book_status: null, display: null, created_ms: '0', expires_ms: null, digest: DIGEST, exec: null, ...o }) as RequestView;

const tx = (label: GoldenTx['label'], hash: string, status: 'success' | 'failure' = 'success', chain: 'near' | 'base' = 'near'): GoldenTx => ({ chain, label, hash, status, url: txUrl(chain, hash) });
const run = (name: string, requests: GoldenRun['requests'], txs: GoldenTx[]): GoldenRun => ({
  version: 1, name, case: 'X', scenario: 'U01', recordedAt: '2026-11-02T20:00:00.000Z', network: 'testnet', contractId: POLICY, llmMode: 'record', planSha256: null, taskId: null, taskHash: null, requests, trace: [], txs, run: null, note: null,
});

interface World {
  near: Record<string, NearTx>;
  requests: Record<string, RequestView>;
  receipt: { status: string } | null;
  baseTx: { to: string; value: bigint; from: string } | null;
}

function world(over: Partial<World> = {}): VerifyIo {
  const w: World = {
    near: {
      [SUBMIT]: { status: 'success', failure: '', events: [ev('allowed', { request_id: 'R1' }), ev('paid', { request_id: 'R1', payee: ACC, amount: '4200000000000000000000000' })] },
      [APPROVE]: { status: 'success', failure: '', events: [ev('approved', { request_id: 'R2', id: '4', digest: DIGEST, approver: 'o', block_height: '1' }), ev('paid', { request_id: 'R2', payee: ACC, amount: '9400000000000000000000000' })] },
      [TAMPER]: { status: 'failure', failure: '{"Failure":"Smart contract panicked: approve rejected: WrongAmount"}', events: [] },
      [TWIN]: { status: 'success', failure: '', events: [] },
    },
    requests: { R1: view({}), R2: view({ request_id: 'R2', id: '4', amount: '9400000000000000000000000' }), '4': view({ request_id: 'R2', id: '4', amount: '9400000000000000000000000' }), R3: view({ request_id: 'R3', asset: 'evm:84532:native', payee: `evm:84532:${CONTRACTOR}`, amount: '20000000000000000' }) },
    receipt: { status: '0x1' },
    baseTx: { to: CONTRACTOR, value: 20000000000000000n, from: SENDER },
    ...over,
  };
  return {
    accounts: { agent: 'erfan-agent.testnet', owner: 'erfan-airlock.testnet', twin_vanilla: 'erfan-twin-vanilla.testnet', policy: POLICY },
    nearTx: async (hash) => {
      const t = w.near[hash];
      if (t === undefined) throw new Error('unknown transaction');
      return t;
    },
    getRequest: async (id) => w.requests[id] ?? null,
    baseReceipt: async () => w.receipt,
    baseTx: async () => w.baseTx,
    derivedSender: async () => SENDER,
  };
}

const R1 = [{ request_id: 'R1', outcome: 'allowed', reason: null, pending_id: null }];
const R2 = [{ request_id: 'R2', outcome: 'approved', reason: null, pending_id: '4' }];
const oks = async (io: VerifyIo, r: GoldenRun) => (await verifyRun(io, r)).map((v) => v.ok);

test('a consistent fixture passes for every label: submit, approve, tamper, twin and a Base broadcast', async () => {
  const io = world();
  assert.deepEqual(await oks(io, run('u01', R1, [tx('submit', SUBMIT)])), [true]);
  assert.deepEqual(await oks(io, run('b01-approve', R2, [tx('approve', APPROVE)])), [true]);
  assert.deepEqual(await oks(io, run('tamper', [{ request_id: 'R2', outcome: 'escalated', reason: 'OverTaskBound', pending_id: '4' }], [tx('tamper', TAMPER, 'failure')])), [true]);
  assert.deepEqual(await oks(io, run('twin', [], [tx('twin', TWIN)])), [true]);
  assert.deepEqual(await oks(io, run('contractor', [{ request_id: 'R3', outcome: 'allowed', reason: null, pending_id: null }], [tx('broadcast', BASE, 'success', 'base')])), [true]);
  const lines = (await verifyRun(io, run('u01', R1, [tx('submit', SUBMIT)]))).map((v) => v.line);
  assert.deepEqual(lines, [`PASS submit ${SUBMIT}`]);
});

test('an altered hash fails, and the selftest says so', async () => {
  const io = world();
  const r = run('u01', R1, [tx('submit', SUBMIT)]);
  const altered = alterHash(r);
  assert.notEqual(altered.txs[0]?.hash, SUBMIT);
  assert.equal(r.txs[0]?.hash, SUBMIT, 'the original is untouched');
  const [v] = await verifyRun(io, altered);
  assert.ok(v !== undefined && !v.ok && v.line.startsWith('FAIL submit '));
  const dir = mkdtempSync(join(tmpdir(), 'vg-'));
  mkdirSync(join(dir, 'bench', 'golden'), { recursive: true });
  writeFileSync(join(dir, 'bench', 'golden', 'u01.json'), JSON.stringify(r));
  const lines: string[] = [];
  assert.equal(await main(['--selftest'], io, dir, (l) => lines.push(l)), 0);
  assert.deepEqual(lines, ['SELFTEST ok (altered hash failed)']);
});

test('a recorded status that differs from the chain fails', async () => {
  const io = world();
  const [v] = await verifyRun(io, run('u01', R1, [tx('submit', SUBMIT, 'failure')]));
  assert.ok(v !== undefined && !v.ok);
  assert.match(v.line, /recorded failure, the chain says success/);
  const [t] = await verifyRun(world({ near: { [TAMPER]: { status: 'success', failure: '', events: [] } } }), run('tamper', [], [tx('tamper', TAMPER, 'failure')]));
  assert.ok(t !== undefined && !t.ok);
});

test('an approved digest that differs from get_request fails, and so does a missing paid event', async () => {
  const bad = world({ requests: { R2: view({ request_id: 'R2' }), '4': view({ request_id: 'R2', id: '4', digest: 'e'.repeat(64) }) } });
  const [v] = await verifyRun(bad, run('b01-approve', R2, [tx('approve', APPROVE)]));
  assert.ok(v !== undefined && !v.ok);
  assert.match(v.line, /digest/);
  const noPaid = world({ near: { [SUBMIT]: { status: 'success', failure: '', events: [ev('allowed', { request_id: 'R1' })] } } });
  const [p] = await verifyRun(noPaid, run('u01', R1, [tx('submit', SUBMIT)]));
  assert.ok(p !== undefined && !p.ok);
  assert.match(p.line, /paid/);
});

test('submit events must carry exactly the recorded request ids and outcome', async () => {
  const io = world();
  const [a] = await verifyRun(io, run('u01', [{ request_id: 'R9', outcome: 'allowed', reason: null, pending_id: null }], [tx('submit', SUBMIT)]));
  assert.ok(a !== undefined && !a.ok);
  const [b] = await verifyRun(io, run('u01', [{ request_id: 'R1', outcome: 'escalated', reason: 'X', pending_id: '1' }], [tx('submit', SUBMIT)]));
  assert.ok(b !== undefined && !b.ok);
});

test('a Base transaction whose value, recipient or sender differs from the request fails', async () => {
  const r = run('contractor', [{ request_id: 'R3', outcome: 'allowed', reason: null, pending_id: null }], [tx('broadcast', BASE, 'success', 'base')]);
  for (const bad of [
    { to: CONTRACTOR, value: 20000000000000001n, from: SENDER },
    { to: '0x' + '11'.repeat(20), value: 20000000000000000n, from: SENDER },
    { to: CONTRACTOR, value: 20000000000000000n, from: '0x' + '22'.repeat(20) },
  ]) {
    const [v] = await verifyRun(world({ baseTx: bad }), r);
    assert.ok(v !== undefined && !v.ok);
  }
  const [noReceipt] = await verifyRun(world({ receipt: null }), r);
  assert.ok(noReceipt !== undefined && !noReceipt.ok);
  const [reverted] = await verifyRun(world({ receipt: { status: '0x0' } }), r);
  assert.ok(reverted !== undefined && !reverted.ok);
});

test('main prints one line per transaction, exits 1 on a FAIL, and 1 when there are no files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vg-'));
  const none: string[] = [];
  assert.equal(await main([], world(), dir, (l) => none.push(l)), 1);
  assert.deepEqual(none, ['FAIL no golden files']);
  mkdirSync(join(dir, 'bench', 'golden'), { recursive: true });
  writeFileSync(join(dir, 'bench', 'golden', 'u01.json'), JSON.stringify(run('u01', R1, [tx('submit', SUBMIT)])));
  const good: string[] = [];
  assert.equal(await main([], world(), dir, (l) => good.push(l)), 0);
  assert.deepEqual(good, [`PASS submit ${SUBMIT}`]);
  writeFileSync(join(dir, 'bench', 'golden', 'twin.json'), JSON.stringify(run('twin', [], [tx('twin', 'Unknown000000000000000000000000000000A')])));
  const mixed: string[] = [];
  assert.equal(await main([], world(), dir, (l) => mixed.push(l)), 1);
  assert.ok(mixed.some((l) => l.startsWith('FAIL twin ')));
  assert.equal(await main(['--wat'], world(), dir, () => undefined), 2);
});

test('the golden schema refuses an unknown key, a bad label and a non-testnet network', () => {
  const ok = run('u01', R1, [tx('submit', SUBMIT)]);
  assert.ok(GoldenRunSchema.safeParse(ok).success);
  assert.ok(!GoldenRunSchema.safeParse({ ...ok, extra: 1 }).success);
  assert.ok(!GoldenRunSchema.safeParse({ ...ok, network: 'mainnet' }).success);
  assert.ok(!GoldenRunSchema.safeParse({ ...ok, txs: [{ ...tx('submit', SUBMIT), label: 'other' }] }).success);
});

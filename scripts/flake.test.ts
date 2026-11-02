// AIR-166: the flake table, and the lost-response then signer-failure run against a scripted transport. No network, no key, nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChainError, ChainWaitError } from '../runtime/src/chain/errors.ts';
import { EvmBroadcastError } from '../runtime/src/chain/evm.ts';
import { ChainClient } from '../runtime/src/chain/near.ts';
import type { ChainTransport, PreparedTx, RpcTx } from '../runtime/src/chain/transport.ts';
import { BudgetExhaustedError, describeFailure, flakeLine, isTransportError } from './lib/flake.ts';
import type { FlakeClass } from './lib/flake.ts';
import { E2eExit, RunFailed, main, runCase } from './e2e-testnet.ts';
import type { CaseIo } from './e2e-testnet.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROWS: Array<[string, unknown, FlakeClass, boolean]> = [
  ['mpc_timeout', new ChainWaitError('Failed', 'x', 'MpcFailed', true), 'mpc_timeout', true],
  ['mpc_failed (not retryable)', new ChainWaitError('Failed', 'x', 'MpcFailed', false), 'mpc_failed', false],
  ['mpc_failed (bad response)', new ChainWaitError('Failed', 'x', 'MpcBadResponse', true), 'mpc_failed', false],
  ['rpc_down (fetch failed)', new TypeError('fetch failed'), 'rpc_down', true],
  ['rpc_down (no endpoint took the broadcast)', new EvmBroadcastError('NoRpc', 'no endpoint'), 'rpc_down', true],
  ['lost_response', new ChainError('Unknown', 'the outcome is unknown'), 'lost_response', false],
  ['nonce_low', new EvmBroadcastError('Rejected', 'nonce too low: next nonce 7, tx nonce 5'), 'nonce_low', false],
  ['underpriced', new EvmBroadcastError('Rejected', 'transaction underpriced'), 'underpriced', false],
  ['insufficient_funds', new EvmBroadcastError('Rejected', 'insufficient funds for gas * price + value'), 'insufficient_funds', false],
  ['replay_mismatch', new ChainError('RequestMismatch', 'exists with other content'), 'replay_mismatch', false],
  ['budget_exhausted', new BudgetExhaustedError(), 'budget_exhausted', false],
  ['unknown (a refusal nobody listed)', new EvmBroadcastError('Rejected', 'some other node text'), 'unknown', false],
  ['unknown (a plain error)', new Error('boom'), 'unknown', false],
];

test('describeFailure: one row per class, with its retryable flag', () => {
  for (const [label, input, cls, retryable] of ROWS) {
    const f = describeFailure(input);
    assert.equal(f.class, cls, label);
    assert.equal(f.retryable, retryable, label);
  }
  assert.deepEqual([...new Set(ROWS.map((r) => r[2]))].sort(), ['budget_exhausted', 'insufficient_funds', 'lost_response', 'mpc_failed', 'mpc_timeout', 'nonce_low', 'replay_mismatch', 'rpc_down', 'underpriced', 'unknown']);
});

test('describeFailure: plain and next are fixed strings with no hex, key, signature or input text', () => {
  const evil = 'LEAK-ME 0xdeadbeefdeadbeef ed25519:AbCdEf1234 nonce too low underpriced';
  const inputs: unknown[] = [...ROWS.map((r) => r[1]), new EvmBroadcastError('Rejected', evil), new ChainError('Panic', evil), new Error(evil), new ChainWaitError('Failed', evil, evil, true)];
  for (const input of inputs) {
    const f = describeFailure(input);
    for (const text of [f.plain, f.next, flakeLine(f)]) {
      assert.doesNotMatch(text, /0x[0-9a-fA-F]/);
      assert.doesNotMatch(text, /ed25519:/);
      assert.doesNotMatch(text, /LEAK-ME/);
    }
  }
  assert.equal(describeFailure(ROWS[0]?.[1]).plain, 'The signer did not answer. Nothing was paid and nothing was spent.');
  assert.match(describeFailure(ROWS[6]?.[1]).next, /scripts\/nonce-status\.ts/);
  assert.match(describeFailure(ROWS[7]?.[1]).next, /asset_set/);
});

test('describeFailure: a wait that ran out of time is never retryable, and a run failure maps its event codes', () => {
  assert.deepEqual([describeFailure(new ChainWaitError('Timeout', 'x', null, false)).class, describeFailure(new ChainWaitError('Timeout', 'x', null, false)).retryable], ['mpc_timeout', false]);
  assert.equal(describeFailure(new ChainWaitError('NotSigned', 'x', null, false)).class, 'unknown');
  const run = (code: string, retryable?: boolean, cause?: unknown) => describeFailure(new RunFailed('RUN FAILED', [{ code, retryable }], cause, true));
  assert.equal(run('Failed', true).class, 'mpc_timeout');
  assert.equal(run('Failed', false).class, 'mpc_failed');
  assert.equal(run('Unknown').class, 'lost_response');
  assert.equal(run('ReplayMismatch').class, 'replay_mismatch');
  assert.equal(run('BroadcastNoRpc').class, 'rpc_down');
  assert.equal(run('BroadcastRejected', undefined, new EvmBroadcastError('Rejected', 'nonce too low')).class, 'nonce_low');
  assert.equal(run('BroadcastRejected').class, 'unknown');
  assert.equal(describeFailure(new RunFailed('RUN FAILED', [], new TypeError('fetch failed'), false)).class, 'rpc_down');
});

test('isTransportError: the network, not our own errors', () => {
  assert.ok(isTransportError(new TypeError('fetch failed')));
  assert.ok(isTransportError(new Error('HTTP 503')));
  assert.ok(!isTransportError(new ChainError('Unknown', 'timeout')));
  assert.ok(!isTransportError('fetch failed'));
});

// ---- a scripted transport: the first response is lost, then the signer fails ----

const ACCOUNTS = { owner: 'erfan-airlock.testnet', policy: 'policy.erfan-airlock.testnet', agent: 'erfan-agent.testnet', accountant: 'accountant.erfan-airlock.testnet', contractor_evm: '0x7eafcb38a7de2a6805db7c93ccec6365a5c7528f' };
const BOOK_ROWS = [
  [`near:${ACCOUNTS.accountant}`, { cap: '5000000000000000000000000', daily_untrusted_budget: '20000000000000000000000000', daily_limit: '30000000000000000000000000', label: 'Accountant' }],
  [`evm:84532:${ACCOUNTS.contractor_evm}`, { cap: '50000000000000000', daily_untrusted_budget: '100000000000000000', daily_limit: '30000000000000000000000000', label: 'Contractor' }],
];
const ASSET_ROWS = [
  ['near', { symbol: 'NEAR', decimals: 24, hard_cap: '20000000000000000000000000', daily_cap: '100000000000000000000000000', max_fee_per_gas: '0', max_gas: '0', quick_task_cap: '50000000000000000000000000', path: null }],
  ['evm:84532:native', { symbol: 'ETH.base', decimals: 18, hard_cap: '100000000000000000', daily_cap: '500000000000000000', max_fee_per_gas: '50000000000', max_gas: '100000', quick_task_cap: '200000000000000000', path: 'airlock-demo-1' }],
];
const LEDGER = (remaining: string) => ({ spent: '0', cap: '1', remaining });

class Scripted implements ChainTransport {
  readonly contractId = ACCOUNTS.policy;
  prepares = 0;
  submits = 0;
  taskIds: string[] = [];
  private landed: { id: string; req: Record<string, unknown> } | null = null;
  constructor(private readonly o: { state: 'Retryable' | 'Pending'; reason: string; remaining: string }) {}
  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'get_book':
        return BOOK_ROWS;
      case 'list_assets':
        return ASSET_ROWS;
      case 'get_policy':
        return { owner_id: ACCOUNTS.owner, mpc_contract_id: 'v1.signer-prod.testnet', requires_tee: false, paused: false, flags: { max_pending_per_agent: 3, pending_ttl_ms: '86400000', hourly_escalation_budget: 6, lock_consecutive_rejects: 3, lock_rejects_per_day: 6, max_task_ttl_ms: '3600000', max_task_actions: 20 } };
      case 'get_ledgers':
        return { asset_day: LEDGER('1'), payee_day: LEDGER('1'), payee_untrusted_day: LEDGER(this.o.remaining), task_spent: null };
      case 'get_request': {
        if (this.landed === null) return null;
        const r = this.landed.req;
        return { request_id: this.landed.id, id: this.o.state === 'Pending' ? '7' : null, state: this.o.state, agent: ACCOUNTS.agent, task_id: r.task_id, asset: r.asset, payee: r.payee, amount: r.amount, labels: r.labels, reason: this.o.reason, created_ms: '0' };
      }
      default:
        throw new Error(`unscripted view ${method}`);
    }
  }
  async prepare(_m: 'submit_batch', args: Record<string, unknown>): Promise<PreparedTx> {
    this.prepares += 1;
    const req = (args.reqs as Record<string, unknown>[])[0] as Record<string, unknown>;
    this.taskIds.push(String(req.task_id));
    this.landed = { id: '', req };
    return { hash: 'ScriptedTxHash1234567890abcdef', signed: {} };
  }
  async submit(): Promise<RpcTx> {
    this.submits += 1;
    // the transaction executed, the answer never arrived
    throw new TypeError('fetch failed');
  }
  async txStatus(): Promise<RpcTx | 'pending' | null> {
    return null;
  }
  async blockNanosec(): Promise<string> {
    return '1790000000000000000';
  }
  /** the id the client derived is only known from the view calls it makes after the send */
  bind(id: string): void {
    if (this.landed !== null) this.landed.id = id;
  }
}

function io(transport: Scripted, out: string[], amount: string): CaseIo {
  const dir = mkdtempSync(join(tmpdir(), 'flake-test-'));
  writeFileSync(join(dir, 'EVIDENCE.md'), '# Evidence\n');
  const client = new ChainClient({ network: 'testnet', contractId: ACCOUNTS.policy, agentAccountId: ACCOUNTS.agent, transport: new Proxy(transport, { get: (t, p, r) => (p === 'view' ? async (m: string, a: Record<string, unknown>) => { if (m === 'get_request' && typeof a.id === 'string' && !/^\d+$/.test(a.id)) t.bind(a.id); return t.view(m, a); } : Reflect.get(t, p, r)) }) as ChainTransport, pollMs: 2, windowMs: 20 });
  const ok = (name: string) => async () => ({ ok: true, line: `PASS ${name}` });
  return {
    root: ROOT,
    targetDir: join(dir, 'target'),
    evidencePath: join(dir, 'EVIDENCE.md'),
    env: {},
    accounts: ACCOUNTS,
    out: (l) => out.push(l),
    nowMs: () => 1_790_000_123_456,
    sleep: async () => undefined,
    randomBytes: (n) => new Uint8Array(n).fill(9),
    seedHex: () => '01'.repeat(32),
    chainFor: () => client as never,
    extract: async () => ({ amount }),
    checks: { agentKey: ok('agent key'), policyBalance: ok('policy balance'), derivedBalance: ok('derived balance'), untrustedBudget: ok('untrusted budget') },
    nearBalance: async () => 0n,
    baseReceipt: async () => null,
    deriveSender: async () => '0x16c089aad87decf4eaaa4a4afeb5926bcd11b410',
    showCard: () => undefined,
    approveTxId: () => null,
  };
}

const failure = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a failure');
};

test('a lost submit response then an MPC failure: mpc_timeout once, one submit, and a retry is a new task id', async () => {
  const lines: string[] = [];
  const first = new Scripted({ state: 'Retryable', reason: 'MpcFailed', remaining: '1' });
  const e1 = await failure(runCase('CONTRACTOR', {}, io(first, lines, '0.02')));
  assert.ok(e1 instanceof RunFailed);
  assert.equal(describeFailure(e1).class, 'mpc_timeout');
  assert.equal(describeFailure(e1).retryable, true);
  assert.equal(e1.submitted, true);
  assert.equal(first.submits, 1, 'the lost response did not cause a second send');
  assert.equal(first.prepares, 1, 'no second request was created');
  const second = new Scripted({ state: 'Retryable', reason: 'MpcFailed', remaining: '1' });
  const e2 = await failure(runCase('CONTRACTOR', { attempt: 2 }, io(second, lines, '0.02')));
  assert.equal(describeFailure(e2).class, 'mpc_timeout');
  assert.equal(second.submits, 1);
  assert.notEqual(first.taskIds[0], second.taskIds[0]);
  assert.match(String(second.taskIds[0]), /-r2$/);
  assert.doesNotMatch(String(first.taskIds[0]), /-r\d$/);
});

test('e2e-testnet main prints the FLAKE line for a failed run and exits 1', async () => {
  const lines: string[] = [];
  const t = new Scripted({ state: 'Retryable', reason: 'MpcFailed', remaining: '1' });
  const code = await main(['CONTRACTOR'], { LLM_MODE: 'record' }, io(t, lines, '0.02'), (l) => lines.push(l));
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.startsWith('FLAKE mpc_timeout: The signer did not answer. Nothing was paid and nothing was spent. | next: ')), lines.join('\n'));
});

test('an allowed case held for UntrustedAmount is budget_exhausted only when the day budget is below the amount', async () => {
  const low = new Scripted({ state: 'Pending', reason: 'UntrustedAmount', remaining: '1' });
  const e = await failure(runCase('U01', {}, io(low, [], '4.2')));
  assert.equal(describeFailure(e).class, 'budget_exhausted');
  const plenty = new Scripted({ state: 'Pending', reason: 'UntrustedAmount', remaining: '99000000000000000000000000' });
  const e2 = await failure(runCase('U01', {}, io(plenty, [], '4.2')));
  assert.ok(e2 instanceof E2eExit && !(e2 instanceof RunFailed));
  assert.match(e2.line, /^MISMATCH/);
});

test('a node that stops answering before anything is sent is rpc_down with nothing submitted', async () => {
  const lines: string[] = [];
  const t = new Scripted({ state: 'Retryable', reason: 'MpcFailed', remaining: '1' });
  const c = io(t, lines, '0.02');
  c.chainFor = () => {
    throw new TypeError('fetch failed');
  };
  const e = await failure(runCase('U01', {}, c));
  assert.ok(e instanceof RunFailed);
  assert.equal(e.submitted, false);
  assert.equal(describeFailure(e).class, 'rpc_down');
  assert.equal(t.submits, 0);
});

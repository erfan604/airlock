// AIR-165: offline tests of the testnet end to end script. The chain, the extractor, the balances and the card are scripted doubles; the
// plan files, the world and the analyzer are the real ones. No key is read: the task seed is a fixed test value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { keccak256, serializeTransaction } from 'viem';
import type { Hex } from 'viem';
import { CASES, CASE_IDS } from './e2e/cases.ts';
import type { CaseId } from './e2e/cases.ts';
import { E2eExit, finishCase, firstMismatch, main, parseArgs, runCase } from './e2e-testnet.ts';
import type { CaseChain, CaseIo } from './e2e-testnet.ts';
import { checkAgentKey, checkDerivedBalance, checkPolicyBalance, checkUntrustedBudget } from './lib/preflight.ts';
import type { PreflightIo } from './lib/preflight.ts';
import { analyzePlan, bookFromRows, registryFromRows, toOwnerBounds } from '../runtime/src/analyze/index.ts';
import { requestId } from '../runtime/src/chain/ids.ts';
import type { BatchResult, RequestView } from '../runtime/src/chain/types.ts';
import { checkPlan } from '../runtime/src/dsl/index.ts';
import type { ActionRequest, OwnerTask } from '../runtime/src/dsl/index.ts';
import { loadScenarios, loadWorld } from '../runtime/src/tools/index.ts';
import { makeCtx, ACCOUNTANT, CONTRACTOR as CONTRACTOR_KEY, ETH_ID, NEAR_ID, WEI, near } from '../runtime/test/helpers/analyze-ctx.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const NOT_CALLED = (): never => {
  throw new Error('a double that must not be called was called');
};

// ---- the table ----

const TABLE: Record<CaseId, { planFile: string; item: string; outcome: string; reason: string | null; lane: string; amountBase: string }> = {
  U01: { planFile: 'fixtures/plans/u01.json', item: 'inv-april', outcome: 'allowed', reason: null, lane: 'near', amountBase: '4200000000000000000000000' },
  CONTRACTOR: { planFile: 'fixtures/plans/contractor.json', item: 'inv-contractor', outcome: 'allowed', reason: null, lane: 'evm', amountBase: '20000000000000000' },
  B01: { planFile: 'fixtures/plans/u01.json', item: 'inv-april-correction', outcome: 'escalated', reason: 'OverTaskBound', lane: 'near', amountBase: '9400000000000000000000000' },
};

test('the expected outcome table of U01, CONTRACTOR and B01', () => {
  assert.deepEqual([...CASE_IDS].sort(), ['B01', 'CONTRACTOR', 'U01']);
  for (const id of CASE_IDS) {
    const want = TABLE[id];
    assert.equal(CASES[id].planFile, want.planFile, id);
    assert.deepEqual(CASES[id].expect, { outcome: want.outcome, reason: want.reason, lane: want.lane, amountBase: want.amountBase }, id);
  }
});

test('firstMismatch names the first field that differs, an UntrustedAmount where OverTaskBound is expected included', () => {
  const b01 = CASES.B01.expect;
  const got = { outcome: 'escalated', reason: 'OverTaskBound', lane: 'near', amountBase: b01.amountBase };
  assert.equal(firstMismatch(b01, got), null);
  assert.deepEqual(firstMismatch(b01, { ...got, reason: 'UntrustedAmount' }), { field: 'reason', expected: 'OverTaskBound', got: 'UntrustedAmount' });
  assert.deepEqual(firstMismatch(CASES.U01.expect, { outcome: 'escalated', reason: 'X', lane: 'near', amountBase: '1' }), { field: 'outcome', expected: 'allowed', got: 'escalated' });
  assert.deepEqual(firstMismatch(CASES.U01.expect, { outcome: 'allowed', reason: null, lane: 'near', amountBase: '1' }), { field: 'amountBase', expected: CASES.U01.expect.amountBase, got: '1' });
  assert.deepEqual(firstMismatch(CASES.U01.expect, { outcome: 'allowed', reason: null, lane: 'evm', amountBase: CASES.U01.expect.amountBase }), { field: 'lane', expected: 'near', got: 'evm' });
});

// ---- plans, analysis, world ----

const planOf = (id: CaseId) => checkPlan(JSON.parse(readFileSync(join(ROOT, CASES[id].planFile), 'utf8')));

test('both plan files pass checkPlan', () => {
  for (const id of CASE_IDS) assert.doesNotThrow(() => planOf(id), id);
});

test('the analyzer bounds U01 at the accountant cap with one action and the contractor plan at 0.02 ETH', () => {
  const u01 = analyzePlan(planOf('U01'), makeCtx('Pay the April invoice from my accountant\'s email.'));
  assert.deepEqual(u01.errors, []);
  assert.equal(u01.instances.length, 1);
  assert.equal(u01.maxActions, 1);
  assert.deepEqual(u01.bounds, [{ payeeKey: ACCOUNTANT, assetId: NEAR_ID, maxTotal: near(5n) }]);
  const contractor = analyzePlan(planOf('CONTRACTOR'), makeCtx('Pay the contractor invoice from my email.'));
  assert.deepEqual(contractor.errors, []);
  assert.equal(contractor.maxActions, 1);
  assert.deepEqual(contractor.bounds, [{ payeeKey: CONTRACTOR_KEY, assetId: ETH_ID, maxTotal: WEI / 50n }]);
  assert.equal((WEI / 50n).toString(), '20000000000000000');
});

test('each case id is a scenario of the world with the one inbox item of the table, and U01 carries the April sentence', () => {
  const scenarios = loadScenarios(join(ROOT, 'fixtures', 'world.jsonl'));
  for (const id of CASE_IDS) {
    const scenario = scenarios.find((s) => s.id === id);
    assert.ok(scenario !== undefined, `${id} is a scenario`);
    assert.deepEqual(scenario.inbox, [TABLE[id].item], id);
    const world = loadWorld(join(ROOT, 'fixtures', 'world.jsonl'), { scenario: id });
    assert.deepEqual(world.inbox.map((m) => m.id), [TABLE[id].item], id);
  }
  assert.equal(scenarios.find((s) => s.id === 'U01')?.request, 'Pay the April invoice from my accountant\'s email.');
});

// ---- argument parsing ----

test('parseArgs reads the case, the flags and --check-agent-key alone, and refuses the rest', () => {
  assert.deepEqual(parseArgs(['U01']), { kind: 'case', caseId: 'U01', evidence: false, recordChain: undefined, finish: undefined });
  assert.deepEqual(parseArgs(['B01', '--evidence', '--record-chain', 'b01-escalate']), { kind: 'case', caseId: 'B01', evidence: true, recordChain: 'b01-escalate', finish: undefined });
  assert.deepEqual(parseArgs(['B01', '--finish', '12']), { kind: 'case', caseId: 'B01', evidence: false, recordChain: undefined, finish: '12' });
  assert.deepEqual(parseArgs(['--check-agent-key']), { kind: 'check-agent-key' });
  for (const bad of [[], ['NOPE'], ['U01', 'B01'], ['--check-agent-key', 'U01'], ['U01', '--finish'], ['B01', '--finish', '0'], ['B01', '--finish', '01'], ['B01', '--finish', 'x'], ['U01', '--record-chain'], ['U01', '--record-chain', '../x'], ['U01', '--wat']]) {
    assert.equal(parseArgs(bad).kind, 'usage', JSON.stringify(bad));
  }
});

test('a run without LLM_MODE exits 2 before any call, and so does a bad LLM_MODE', async () => {
  const io = new Proxy({}, { get: NOT_CALLED }) as unknown as CaseIo;
  for (const env of [{}, { LLM_MODE: '' }, { LLM_MODE: 'maybe' }]) {
    const lines: string[] = [];
    const code = await main(['U01'], env, io, (l) => lines.push(l));
    assert.equal(code, 2, JSON.stringify(env));
    assert.match(lines.join('\n'), /LLM_MODE/);
  }
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(HERE, 'e2e-testnet.ts'), 'U01'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: tmpdir() } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /LLM_MODE/);
});

// ---- the doubles of a run ----

const ACCOUNTS = { owner: 'erfan-airlock.testnet', policy: 'policy.erfan-airlock.testnet', agent: 'erfan-agent.testnet', accountant: 'accountant.erfan-airlock.testnet', contractor_evm: '0x7eafcb38a7de2a6805db7c93ccec6365a5c7528f' };
const ACCOUNTANT_KEY = `near:${ACCOUNTS.accountant}`;
const CONTRACTOR_PAYEE = `evm:84532:${ACCOUNTS.contractor_evm}`;
const ENTRY = (cap: string | null, budget: string, label: string) => ({ cap, daily_untrusted_budget: budget, daily_limit: '30000000000000000000000000', label });
const BOOK_ROWS = [
  [ACCOUNTANT_KEY, ENTRY('5000000000000000000000000', '20000000000000000000000000', 'Accountant')],
  [CONTRACTOR_PAYEE, ENTRY('50000000000000000', '100000000000000000', 'Contractor')],
] as const;
const ASSET_ROWS = [
  ['near', { symbol: 'NEAR', decimals: 24, hard_cap: '20000000000000000000000000', daily_cap: '100000000000000000000000000', max_fee_per_gas: '0', max_gas: '0', quick_task_cap: '50000000000000000000000000', path: null }],
  ['evm:84532:native', { symbol: 'ETH.base', decimals: 18, hard_cap: '100000000000000000', daily_cap: '500000000000000000', max_fee_per_gas: '50000000000', max_gas: '100000', quick_task_cap: '200000000000000000', path: 'airlock-demo-1' }],
] as const;
const POLICY_VIEW = { flags: { max_task_actions: 20, max_task_ttl_ms: '3600000' } };

const AMOUNT_OF: Record<CaseId, string> = { U01: '4.2', CONTRACTOR: '0.02', B01: '9.4' };
const NEAR_TX = 'AbCdEf1234567890NearTxHash';

function viewOf(req: ActionRequest, task: OwnerTask, state: RequestView['state'], extra: Partial<RequestView> = {}): RequestView {
  return {
    request_id: requestId(task, req.action_index),
    id: null,
    state,
    agent: ACCOUNTS.agent,
    task_id: task.task_id,
    asset: req.asset,
    payee: req.payee,
    amount: req.amount,
    labels: { recipient: 0, amount: 0, pc: 0 },
    reason: null,
    book_status: null,
    display: null,
    created_ms: '0',
    expires_ms: null,
    digest: null,
    exec: null,
    ...extra,
  };
}

interface Rig {
  io: CaseIo;
  lines: string[];
  submits: number;
  calls: string[];
  balances: Map<string, bigint>;
  cards: string[];
  recordPaths: (string | null)[];
  dir: string;
}

interface RigOpts {
  caseId: CaseId;
  outcome?: 'allowed' | 'escalated';
  reason?: string | null;
  checks?: Partial<Record<'agentKey' | 'policyBalance' | 'derivedBalance' | 'untrustedBudget', boolean>>;
  /** what the payee gains on an allowed NEAR payment; defaults to the amount of the request */
  gain?: (amount: bigint) => bigint;
  receipt?: { status: string; from: string } | null;
}

const NEAR_INBOX_AMOUNT = AMOUNT_OF;

function rig(o: RigOpts): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-test-'));
  const evidencePath = join(dir, 'EVIDENCE.md');
  writeFileSync(evidencePath, '# Evidence\n\n## Model choice\n\nplanner model: x\n');
  const lines: string[] = [];
  const calls: string[] = [];
  const balances = new Map<string, bigint>([[ACCOUNTS.accountant, 1_000_000_000_000_000_000_000_000_000n]]);
  const cards: string[] = [];
  const recordPaths: (string | null)[] = [];
  const state = { submits: 0 };
  const evmKey = generatePrivateKey();
  const evmAddress = privateKeyToAccount(evmKey).address.toLowerCase();
  const last: { req: ActionRequest | null; task: OwnerTask | null } = { req: null, task: null };
  const outcome: 'allowed' | 'escalated' = o.outcome ?? (TABLE[o.caseId].outcome as 'allowed' | 'escalated');
  const reason = o.reason === undefined ? TABLE[o.caseId].reason : o.reason;
  const unsigned = (req: ActionRequest): string => {
    // an EIP-1559 transfer of the request's amount to its payee, as the contract builds it
    const to = req.payee.slice('evm:84532:'.length);
    const value = BigInt(req.amount);
    return unsignedTx(to as Hex, value);
  };
  const chain: CaseChain = {
    async getBook() {
      calls.push('getBook');
      return BOOK_ROWS as never;
    },
    async listAssets() {
      calls.push('listAssets');
      return ASSET_ROWS as never;
    },
    async getPolicy() {
      calls.push('getPolicy');
      return POLICY_VIEW as never;
    },
    async latestBlockMs() {
      return 1_790_000_000_000;
    },
    async getLedgers() {
      calls.push('getLedgers');
      return { asset_day: z3(), payee_day: z3(), payee_untrusted_day: z3(), task_spent: null } as never;
    },
    async submitBatch(reqs: ActionRequest[], task: OwnerTask): Promise<BatchResult> {
      state.submits += 1;
      calls.push('submitBatch');
      const req = reqs[0] as ActionRequest;
      last.req = req;
      last.task = task;
      const id = requestId(task, req.action_index);
      if (outcome === 'allowed' && req.asset === 'near') {
        const payee = req.payee.slice('near:'.length);
        balances.set(payee, (balances.get(payee) ?? 0n) + (o.gain === undefined ? BigInt(req.amount) : o.gain(BigInt(req.amount))));
      }
      return {
        taskHash: 'f'.repeat(64),
        outcomes: [{ request_id: id, outcome, reason: outcome === 'allowed' ? null : reason, pending_id: outcome === 'escalated' ? '7' : null }],
        txHash: NEAR_TX,
        events: [],
        recovered: false,
        views: [],
      };
    },
    async getRequest(id: string) {
      calls.push(`getRequest ${id}`);
      const req = last.req;
      const task = last.task;
      if (req === null || task === null) return null;
      if (outcome === 'escalated') return viewOf(req, task, 'Pending', { id: '7', reason });
      return viewOf(req, task, 'Executing', req.asset.startsWith('evm:') ? { exec: { unsigned_hex: unsigned(req), big_r: null, s: null, recovery_id: null } } : {});
    },
    async waitSigned() {
      const req = last.req as ActionRequest;
      const unsignedHex = unsigned(req);
      const sig = await sign({ hash: keccak256(`0x${unsignedHex}` as Hex), privateKey: evmKey });
      return { request_id: 'x', unsigned_hex: unsignedHex, big_r: (sig.yParity === 0 ? '02' : '03') + sig.r.slice(2), s: sig.s.slice(2), recovery_id: sig.yParity ?? 0 };
    },
  } as unknown as CaseChain;
  const pass = (name: string, ok: boolean | undefined): Promise<{ ok: boolean; line: string }> => Promise.resolve(ok === false ? { ok: false, line: `FAIL ${name}: stub` } : { ok: true, line: `PASS ${name}` });
  const io: CaseIo = {
    root: ROOT,
    targetDir: join(dir, 'target'),
    evidencePath,
    env: {},
    accounts: ACCOUNTS,
    out: (l) => lines.push(l),
    nowMs: () => 1_790_000_123_456,
    sleep: async () => undefined,
    randomBytes: (n) => new Uint8Array(n).fill(9),
    seedHex: () => '01'.repeat(32),
    chainFor: (p) => {
      recordPaths.push(p);
      return chain;
    },
    extract: async () => ({ amount: NEAR_INBOX_AMOUNT[o.caseId] }),
    checks: {
      agentKey: () => pass('agent key', o.checks?.agentKey),
      policyBalance: () => pass('policy balance', o.checks?.policyBalance),
      derivedBalance: () => pass('derived balance', o.checks?.derivedBalance),
      untrustedBudget: () => pass('untrusted budget', o.checks?.untrustedBudget),
    },
    nearBalance: async (account) => balances.get(account) ?? 0n,
    baseReceipt: async () => (o.receipt === undefined ? { status: '0x1', from: evmAddress } : o.receipt),
    deriveSender: async () => evmAddress,
    broadcast: async (raw) => ({ hash: keccak256(raw), status: 'success' as const }),
    showCard: (no) => {
      cards.push(no);
      lines.push(`CARD ${no}`);
    },
    approveTxId: () => 'ApproveTx123456789012345678901234567890',
  };
  return {
    io,
    lines,
    get submits() {
      return state.submits;
    },
    calls,
    balances,
    cards,
    recordPaths,
    dir,
  };
}

const z3 = () => ({ spent: '0', cap: '1', remaining: '1' });

function unsignedTx(to: Hex, value: bigint): string {
  // type 2, chain 84532, nonce 0x34, tip 1 gwei, fee cap 50 gwei, gas 21000, no access list
  return serializeUnsigned(to, value);
}

function serializeUnsigned(to: Hex, value: bigint): string {
  return serializeTransaction({ type: 'eip1559', chainId: 84532, nonce: 52, to, value, gas: 21000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }).slice(2);
}

const exitOf = async (p: Promise<unknown>): Promise<E2eExit> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof E2eExit) return e;
    throw e;
  }
  throw new Error('expected an E2eExit');
};

// ---- the runs ----

test('U01 pays 4.2 NEAR: the lines the checks match, proven by the balance difference, and an evidence row', async () => {
  const r = rig({ caseId: 'U01' });
  const report = await runCase('U01', { evidence: true }, r.io);
  assert.equal(report.outcome, 'allowed');
  assert.ok(r.lines.includes('OUTCOME allowed -'), r.lines.join('\n'));
  const paid = r.lines.find((l) => l.startsWith('PAID '));
  assert.equal(paid, `PAID 4.2 NEAR to ${ACCOUNTS.accountant} tx ${NEAR_TX}`);
  assert.ok(r.lines.includes(`LINK https://testnet.nearblocks.io/txns/${NEAR_TX}`));
  assert.ok(r.lines.some((l) => l.startsWith('EVENT verdict ')));
  assert.equal(r.submits, 1);
  assert.ok(r.lines.indexOf('OUTCOME allowed -') < r.lines.indexOf(paid as string));
  const evidence = readFileSync(r.io.evidencePath, 'utf8');
  assert.match(evidence, /^## Testnet end to end \(AIR-165\)$/m);
  assert.match(evidence, new RegExp(`^\\| 2026-\\d\\d-\\d\\d \\| U01 \\| allowed - \\| https://testnet\\.nearblocks\\.io/txns/${NEAR_TX} \\| [0-9a-f]{64}:0 \\| ${ACCOUNTS.policy.replace(/\./g, '\\.')} \\|$`, 'm'));
  assert.ok(r.lines.some((l) => l.startsWith('| 2026-') && l.includes('| U01 |')));
});

test('a payee balance that did not rise by exactly the amount is not PAID', async () => {
  const r = rig({ caseId: 'U01', gain: (a) => a - 1n });
  const e = await exitOf(runCase('U01', {}, r.io));
  assert.equal(e.code, 1);
  assert.equal(r.lines.some((l) => l.startsWith('PAID ')), false);
  assert.match(e.line, /^BALANCE /);
});

test('B01 is held for the owner: OverTaskBound, nothing paid, the card shown and the state file written', async () => {
  const r = rig({ caseId: 'B01' });
  const report = await runCase('B01', { recordChain: 'b01-escalate' }, r.io);
  assert.equal(report.outcome, 'escalated');
  assert.ok(r.lines.includes('OUTCOME escalated OverTaskBound pending 7'), r.lines.join('\n'));
  assert.equal(r.lines.some((l) => /^(PAID|BASE) /.test(l)), false);
  assert.deepEqual(r.cards, ['7']);
  assert.ok(r.lines.indexOf('OUTCOME escalated OverTaskBound pending 7') < r.lines.indexOf('CARD 7'));
  const state = JSON.parse(readFileSync(join(r.io.targetDir, 'e2e-B01.json'), 'utf8')) as Record<string, string>;
  assert.equal(state.no, '7');
  assert.equal(state.payee, ACCOUNTANT_KEY);
  assert.equal(state.amountBase, '9400000000000000000000000');
  assert.equal(state.asset, 'near');
  assert.equal(state.payeeBalanceBefore, '1000000000000000000000000000');
  assert.match(state.request_id as string, /^[0-9a-f]{64}:0$/);
  // the four views of the recording after an escalation, and the chain traffic goes to the named recording
  for (const view of ['getRequest 7', 'getLedgers', 'getBook', 'listAssets']) assert.ok(r.calls.includes(view), view);
  assert.ok(String(r.recordPaths[0]).endsWith(join('runtime', 'recordings', 'chain', 'b01-escalate.json')));
});

test('B01 that escalates UntrustedAmount where OverTaskBound is expected exits 1 with MISMATCH', async () => {
  const r = rig({ caseId: 'B01', reason: 'UntrustedAmount' });
  const e = await exitOf(runCase('B01', {}, r.io));
  assert.equal(e.code, 1);
  assert.equal(e.line, 'MISMATCH reason expected OverTaskBound got UntrustedAmount');
  assert.equal(r.lines.some((l) => l.startsWith('OUTCOME ')), false);
});

test('a failed preflight check stops the run before a task is submitted', async () => {
  for (const failing of ['agentKey', 'policyBalance', 'untrustedBudget'] as const) {
    const r = rig({ caseId: 'U01', checks: { [failing]: false } });
    const e = await exitOf(runCase('U01', {}, r.io));
    assert.equal(e.code, 1, failing);
    assert.equal(r.submits, 0, failing);
    assert.ok(r.lines.some((l) => l.startsWith('FAIL ')), failing);
  }
  const evm = rig({ caseId: 'CONTRACTOR', checks: { derivedBalance: false } });
  assert.equal((await exitOf(runCase('CONTRACTOR', {}, evm.io))).code, 1);
  assert.equal(evm.submits, 0);
});

test('CONTRACTOR asks the derived address for the case amount plus the 0.00105 ETH fee reserve (21,000 gas at 50 gwei), not the payee cap', async () => {
  const r = rig({ caseId: 'CONTRACTOR' });
  let asked: bigint | null = null;
  r.io.checks.derivedBalance = async (min) => {
    asked = min;
    return { ok: true, line: 'PASS derived balance' };
  };
  await runCase('CONTRACTOR', {}, r.io);
  assert.equal(asked, 20_000_000_000_000_000n + 1_050_000_000_000_000n);
});

test('CONTRACTOR proves the signed bytes offline and the Base Sepolia receipt', async () => {
  const r = rig({ caseId: 'CONTRACTOR' });
  const report = await runCase('CONTRACTOR', {}, r.io);
  assert.equal(report.outcome, 'allowed');
  assert.ok(r.lines.includes('OUTCOME allowed -'), r.lines.join('\n'));
  assert.ok(r.lines.includes('PASS verifySignedMatchesRequest'));
  const base = r.lines.find((l) => l.startsWith('BASE '));
  assert.match(base ?? '', /^BASE 0x[0-9a-f]{64} status success sender 0x[0-9a-f]{40}$/);
  const hash = (base as string).split(' ')[1];
  assert.ok(r.lines.includes(`LINK https://sepolia.basescan.org/tx/${hash}`));
});

test('CONTRACTOR with a receipt that is not success is not proven', async () => {
  const r = rig({ caseId: 'CONTRACTOR', receipt: { status: '0x0', from: '0x' + '1'.repeat(40) } });
  const e = await exitOf(runCase('CONTRACTOR', {}, r.io));
  assert.equal(e.code, 1);
  assert.equal(r.lines.some((l) => l.startsWith('BASE ')), false);
});

test('CONTRACTOR is skipped under rung 9 and sends nothing', async () => {
  const r = rig({ caseId: 'CONTRACTOR' });
  writeFileSync(r.io.evidencePath, '# Evidence\n\nEVM lane not live-proven at G2, rung 9\n');
  const report = await runCase('CONTRACTOR', {}, r.io);
  assert.equal(report.skipped, true);
  assert.deepEqual(r.lines, ['CONTRACTOR SKIPPED rung 9']);
  assert.equal(r.submits, 0);
});

// ---- --finish ----

function stateFile(io: CaseIo, over: Record<string, string> = {}): void {
  writeFileSync(join(io.targetDir, 'e2e-B01.json'), JSON.stringify({ no: '7', request_id: 'a'.repeat(64) + ':0', payee: ACCOUNTANT_KEY, amountBase: '9400000000000000000000000', asset: 'near', payeeBalanceBefore: '1000000000000000000000000000', ...over }));
}

function finishRig(states: RequestView['state'][], gain: bigint) {
  const r = rig({ caseId: 'B01', outcome: 'escalated' });
  // the target dir is created by the first run in the other tests; here it is made by hand
  writeFileSync(join(r.dir, 'keep'), '');
  const seen: string[] = [];
  const chain = r.io.chainFor(null);
  let n = 0;
  chain.getRequest = async (id: string) => {
    seen.push(id);
    const state = states[Math.min(n, states.length - 1)] as RequestView['state'];
    n += 1;
    return { request_id: 'a'.repeat(64) + ':0', id: '7', state, asset: 'near', payee: ACCOUNTANT_KEY, amount: '9400000000000000000000000', agent: ACCOUNTS.agent, task_id: 't', labels: { recipient: 0, amount: 0, pc: 0 }, reason: null, book_status: null, display: null, created_ms: '0', expires_ms: null, digest: null, exec: null } as RequestView;
  };
  r.io.chainFor = () => chain;
  r.balances.set(ACCOUNTS.accountant, 1_000_000_000_000_000_000_000_000_000n + gain);
  return { r, seen };
}

test('--finish exits 2 without the state file, with another number and for an EVM asset', async () => {
  const { r } = finishRig(['Executed'], 9_400_000_000_000_000_000_000_000n);
  assert.equal((await exitOf(finishCase('B01', '7', {}, r.io))).line, 'no e2e state for 7');
  assert.equal((await exitOf(finishCase('B01', '7', {}, r.io))).code, 2);
  mkdirSyncFor(r.io.targetDir);
  stateFile(r.io, { no: '8' });
  const other = await exitOf(finishCase('B01', '7', {}, r.io));
  assert.equal(other.code, 2);
  assert.equal(other.line, 'no e2e state for 7');
  stateFile(r.io, { asset: 'evm:84532:native' });
  const evm = await exitOf(finishCase('B01', '7', {}, r.io));
  assert.equal(evm.code, 2);
  assert.equal(evm.line, 'NEAR lane only');
});

const mkdirSyncFor = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};

test('--finish waits for Executed and prints PAID from the balance difference', async () => {
  const { r, seen } = finishRig(['Pending', 'Executing', 'Executed'], 9_400_000_000_000_000_000_000_000n);
  mkdirSyncFor(r.io.targetDir);
  stateFile(r.io);
  const report = await finishCase('B01', '7', {}, r.io);
  assert.equal(report.outcome, 'allowed');
  assert.deepEqual(seen, ['7', '7', '7']);
  assert.ok(r.lines.includes(`PAID 9.4 NEAR to ${ACCOUNTS.accountant} tx ApproveTx123456789012345678901234567890`), r.lines.join('\n'));
  assert.ok(r.lines.includes('LINK https://testnet.nearblocks.io/txns/ApproveTx123456789012345678901234567890'));
});

test('--finish with a balance one yocto short fails, and a request that never executes ends in 1 with its state', async () => {
  const short = finishRig(['Executed'], 9_400_000_000_000_000_000_000_000n - 1n);
  mkdirSyncFor(short.r.io.targetDir);
  stateFile(short.r.io);
  const e = await exitOf(finishCase('B01', '7', {}, short.r.io));
  assert.equal(e.code, 1);
  assert.equal(short.r.lines.some((l) => l.startsWith('PAID ')), false);
  const noTx = finishRig(['Executed'], 9_400_000_000_000_000_000_000_000n);
  mkdirSyncFor(noTx.r.io.targetDir);
  stateFile(noTx.r.io);
  noTx.r.io.approveTxId = () => null;
  const missing = await exitOf(finishCase('B01', '7', {}, noTx.r.io));
  assert.equal(missing.code, 1);
  assert.equal(noTx.r.lines.some((l) => l.startsWith('PAID ')), false);
  const stuck = finishRig(['Pending'], 0n);
  mkdirSyncFor(stuck.r.io.targetDir);
  stateFile(stuck.r.io);
  let clock = 1_790_000_000_000;
  stuck.r.io.nowMs = () => clock;
  stuck.r.io.sleep = async (ms) => {
    clock += ms;
  };
  const timeout = await exitOf(finishCase('B01', '7', {}, stuck.r.io));
  assert.equal(timeout.code, 1);
  assert.match(timeout.line, /state Pending/);
});

// ---- preflight ----

const NEAR1 = 10n ** 24n;
const pfIo = (over: Partial<PreflightIo> = {}): PreflightIo => ({
  credentialsPath: () => '/creds.json',
  readCredentials: () => ({ account_id: ACCOUNTS.agent, public_key: 'ed25519:PUB', hasEd25519Key: true }),
  accounts: () => ACCOUNTS,
  viewAccessKey: async () => ({ permission: { FunctionCall: { allowance: null, receiver_id: ACCOUNTS.policy, method_names: ['submit_batch'] } } }),
  viewAccount: async () => ({ amount: 100n * NEAR1, storageUsage: 100_000n }),
  getLedgers: async () => ({ payee_untrusted_day: { spent: '0', cap: '20', remaining: '20' } }),
  baseBalance: async () => 10n ** 17n,
  derivedAddress: async () => '0x' + '2'.repeat(40),
  ...over,
});

test('checkAgentKey passes for the registered submit_batch key and fails on every other shape', async () => {
  assert.deepEqual(await checkAgentKey(pfIo()), { ok: true, line: 'PASS agent key' });
  const allowance = (a: string | null) => pfIo({ viewAccessKey: async () => ({ permission: { FunctionCall: { allowance: a, receiver_id: ACCOUNTS.policy, method_names: ['submit_batch'] } } }) });
  assert.equal((await checkAgentKey(allowance(String(NEAR1)))).ok, true);
  assert.equal((await checkAgentKey(allowance(String(NEAR1 - 1n)))).ok, false);
  const bad: Partial<PreflightIo>[] = [
    { credentialsPath: () => undefined },
    { readCredentials: () => ({ account_id: 'someone.testnet', public_key: 'ed25519:PUB', hasEd25519Key: true }) },
    { readCredentials: () => ({ account_id: ACCOUNTS.agent, public_key: 'ed25519:PUB', hasEd25519Key: false }) },
    { viewAccessKey: async () => null },
    { viewAccessKey: async () => ({ permission: 'FullAccess' }) },
    { viewAccessKey: async () => ({ permission: { FunctionCall: { allowance: null, receiver_id: 'other.testnet', method_names: ['submit_batch'] } } }) },
    { viewAccessKey: async () => ({ permission: { FunctionCall: { allowance: null, receiver_id: ACCOUNTS.policy, method_names: ['submit_batch', 'approve'] } } }) },
    { viewAccessKey: async () => ({ permission: { FunctionCall: { allowance: null, receiver_id: ACCOUNTS.policy, method_names: [] } } }) },
  ];
  for (const [i, over] of bad.entries()) {
    const c = await checkAgentKey(pfIo(over));
    assert.equal(c.ok, false, `case ${i}`);
    assert.match(c.line, /^FAIL agent key/, `case ${i}`);
    assert.doesNotMatch(c.line, /PUB|ed25519:/, `case ${i}`);
  }
});

test('checkPolicyBalance needs the amount plus the storage lock plus 1 NEAR of margin', async () => {
  // amount 100 NEAR, storage 100000 bytes * 1e19 = 1 NEAR locked, margin 1: 98 NEAR spendable
  const io = pfIo();
  assert.equal((await checkPolicyBalance(98n * NEAR1, io)).ok, true);
  const c = await checkPolicyBalance(98n * NEAR1 + 1n, io);
  assert.equal(c.ok, false);
  assert.match(c.line, /^FAIL policy balance/);
  assert.match((await checkPolicyBalance(0n, io)).line, /^PASS policy balance/);
});

test('checkDerivedBalance fails below the wei threshold', async () => {
  const io = pfIo({ baseBalance: async () => 49_999_999_999_999_999n });
  const c = await checkDerivedBalance(50_000_000_000_000_000n, io);
  assert.equal(c.ok, false);
  assert.match(c.line, /^FAIL derived balance/);
  assert.equal((await checkDerivedBalance(49_999_999_999_999_999n, io)).ok, true);
});

test('checkUntrustedBudget fails when the payee untrusted day remaining is below the amount', async () => {
  const io = (remaining: string) => pfIo({ getLedgers: async () => ({ payee_untrusted_day: { spent: '0', cap: '20', remaining } }) });
  assert.match((await checkUntrustedBudget(ACCOUNTANT_KEY, 'near', 4_200_000n, io('4200000'))).line, /^PASS untrusted budget/);
  const low = await checkUntrustedBudget(ACCOUNTANT_KEY, 'near', 4_200_000n, io('4199999'));
  assert.equal(low.ok, false);
  assert.match(low.line, /^FAIL untrusted budget/);
  assert.equal((await checkUntrustedBudget(ACCOUNTANT_KEY, 'near', 1n, io('not a number'))).ok, false);
});

// the helpers above are exercised through the registry and book converters the script uses
test('the double views convert with the converters the script uses', () => {
  const book = bookFromRows(BOOK_ROWS as never);
  assert.equal(book.get(ACCOUNTANT_KEY)?.cap, 5n * NEAR1);
  const registry = registryFromRows(ASSET_ROWS as never);
  assert.equal(registry.get('evm:84532:native')?.path, 'airlock-demo-1');
  const analysis = analyzePlan(planOf('B01'), { ownerText: '', book, registry, limits: { maxTaskActions: 20, maxTaskTtlMs: 3_600_000n } });
  assert.equal(toOwnerBounds(analysis)[0]?.max_total, String(5n * NEAR1));
  assert.ok(existsSync(join(ROOT, 'fixtures', 'plans', 'u01.json')));
});

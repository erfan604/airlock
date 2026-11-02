// AIR-166: golden.ts steps against scripted doubles: the preflight gate, the one fresh-task retry, the files and EVIDENCE rows, and the refusals
// of the tamper and twin steps. Nothing here touches the chain or a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainError, ChainWaitError } from '../runtime/src/chain/errors.ts';
import { EvmBroadcastError } from '../runtime/src/chain/evm.ts';
import type { ChainEvent, RequestView } from '../runtime/src/chain/types.ts';
import { RunFailed } from './e2e-testnet.ts';
import type { CaseOpts, CaseReport } from './e2e-testnet.ts';
import { main, parseArgs } from './golden.ts';
import type { GoldenIo, NearTx } from './golden.ts';
import { GOLDEN_HEADING, readGolden, missingCardViews } from './lib/golden.ts';
import type { Line } from './lib/world.ts';

const POLICY = 'policy.erfan-airlock.testnet';
const SUBMIT = 'SubmitHash00000000000000000000000000001A';
const APPROVE = 'ApproveHash0000000000000000000000000002A';
const TAMPER = 'TamperHash00000000000000000000000000003A';
const TWINTX = 'TwinHash000000000000000000000000000004A';
const DIGEST = 'd'.repeat(64);
const B01_AMOUNT = '9400000000000000000000000';
const PASS: Line[] = [{ level: 'PASS', name: 'policy balance', detail: 'ok' }];

const ev = (event: string, data: Record<string, unknown>): ChainEvent => ({ event, data }) as unknown as ChainEvent;
const req = (o: Partial<RequestView> = {}): RequestView =>
  ({ request_id: 'R2', id: '4', state: 'Pending', agent: 'a', task_id: 't', asset: 'near', payee: 'near:acc', amount: B01_AMOUNT, labels: { recipient: 0, amount: 0, pc: 0 }, reason: 'OverTaskBound', book_status: null, display: null, created_ms: '0', expires_ms: null, digest: DIGEST, exec: null, ...o }) as RequestView;

interface Rig {
  io: GoldenIo;
  root: string;
  out: string[];
  calls: { runCase: CaseOpts[]; twin: number[]; finish: number };
}

function report(o: Partial<CaseReport> = {}): CaseReport {
  return {
    caseId: 'U01', skipped: false, outcome: 'allowed', reason: null, requestId: 'R1', pendingNo: null, txHash: SUBMIT, link: null,
    submitTxHash: SUBMIT, trace: [{ t: 1, kind: 'verdict', data: { request_id: 'R1' } }], taskId: 'e2e-U01-1', taskHash: 'f'.repeat(64), planSha256: 'a'.repeat(64), ...o,
  };
}

function rig(o: {
  preflight?: Line[];
  runCase?: (opts: CaseOpts, n: number) => Promise<CaseReport>;
  request?: RequestView | null;
  tx?: Record<string, NearTx>;
  state?: { no: string; request_id: string } | null;
  twin?: (seed: number) => { paid: boolean; txHash: string | null };
} = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'golden-test-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'EVIDENCE.md'), '# Evidence\n\n## Model choice\n\nx\n');
  const out: string[] = [];
  const calls = { runCase: [] as CaseOpts[], twin: [] as number[], finish: 0 };
  const io: GoldenIo = {
    root,
    env: {},
    out: (l) => out.push(l),
    now: () => new Date('2026-11-09T18:00:00.000Z'),
    contractId: POLICY,
    preflight: async () => o.preflight ?? PASS,
    runCase: async (_id, opts) => {
      calls.runCase.push(opts);
      return (o.runCase ?? (async () => report()))(opts, calls.runCase.length);
    },
    finishCase: async () => {
      calls.finish += 1;
      return report({ txHash: APPROVE });
    },
    codeHash: async () => 'CODEHASH',
    wasmSha256: () => 'w'.repeat(64),
    getRequest: async () => (o.request === undefined ? req() : o.request),
    nearTx: async (hash) => {
      const t = (o.tx ?? {})[hash];
      if (t === undefined) throw new Error('unknown');
      return t;
    },
    e2eState: () => (o.state === undefined ? { no: '4', request_id: 'R2' } : o.state),
    runTwin: async (_m, seed) => {
      calls.twin.push(seed);
      return (o.twin ?? (() => ({ paid: false, txHash: null })))(seed);
    },
    defaultModel: () => 'z-ai/glm-5.3-flash',
  };
  return { io, root, out, calls };
}

const mpcTimeout = () => new RunFailed('RUN FAILED Failed', [{ code: 'Failed', retryable: true }], undefined, true);
const approveTx: Record<string, NearTx> = { [APPROVE]: { status: 'success', failure: '', events: [ev('approved', { request_id: 'R2', id: '4', digest: DIGEST, approver: 'o', block_height: '1' })] } };
const tamperOk: Record<string, NearTx> = { [TAMPER]: { status: 'failure', failure: '{"Failure":"approve rejected: WrongAmount"}', events: [] } };

test('parseArgs: the step names and their options, and nothing else', () => {
  assert.equal(parseArgs(['u01']).kind, 'step');
  assert.equal(parseArgs(['b01-approve', '--no', '4', '--approve-tx', APPROVE]).kind, 'step');
  assert.equal(parseArgs(['twin', '--model', 'z-ai/glm-5.3-flash']).kind, 'step');
  for (const bad of [[], ['nope'], ['u01', '--no', '4'], ['b01-approve', '--no', '4'], ['tamper', '--no', '0', '--tamper-tx', TAMPER], ['tamper', '--no', '4', '--tamper-tx', 'x'], ['twin', '--model'], ['u01', 'extra']]) {
    assert.equal(parseArgs(bad).kind, 'usage', JSON.stringify(bad));
  }
});

test('a preflight FAIL stops every step before anything runs', async () => {
  for (const argv of [['u01'], ['b01-approve', '--no', '4', '--approve-tx', APPROVE], ['tamper', '--no', '4', '--tamper-tx', TAMPER], ['twin']]) {
    const r = rig({ preflight: [{ level: 'FAIL', name: 'agent key', detail: 'missing' }] });
    assert.equal(await main(argv, r.io), 1);
    assert.ok(r.out.includes('PREFLIGHT FAILED'));
    assert.equal(r.calls.runCase.length + r.calls.twin.length + r.calls.finish, 0);
    assert.ok(!existsSync(join(r.root, 'bench', 'golden')));
  }
});

test('a derived address or nonce FAIL stops only the contractor step; a NEAR step notes it and runs', async () => {
  const evm: Line[] = [...PASS, { level: 'FAIL', name: 'derived address', detail: 'holds 0.017 ETH' }];
  const near = rig({ preflight: evm });
  assert.equal(await main(['u01'], near.io), 0);
  assert.ok(near.out.includes('NOTE derived address does not gate the u01 step'), near.out.join('\n'));
  assert.equal(near.calls.runCase.length, 1);
  const c = rig({ preflight: evm });
  assert.equal(await main(['contractor'], c.io), 1);
  assert.ok(c.out.includes('PREFLIGHT FAILED'));
  assert.equal(c.calls.runCase.length, 0);
});

test('a full pending queue does not gate tamper or b01-approve, which create no request', async () => {
  const full: Line[] = [...PASS, { level: 'FAIL', name: 'pending', detail: '3 are pending' }];
  const r = rig({ preflight: full });
  assert.equal(await main(['u01'], r.io), 1);
  const t = rig({ preflight: full });
  await main(['tamper', '--no', '4', '--tamper-tx', TAMPER], t.io);
  assert.ok(!t.out.includes('PREFLIGHT FAILED'));
  assert.ok(t.out.includes('NOTE pending does not gate the tamper step'));
});

test('u01 writes a valid golden file and one EVIDENCE row with the code hash, the wasm hash and the link', async () => {
  const r = rig();
  assert.equal(await main(['u01'], r.io), 0);
  assert.deepEqual(r.calls.runCase, [{ recordChain: 'u01', evidence: true, attempt: 1 }]);
  const run = readGolden(join(r.root, 'bench', 'golden', 'u01.json'));
  assert.equal(run.scenario, 'U01');
  assert.equal(run.llmMode, 'record');
  assert.equal(run.requests[0]?.request_id, 'R1');
  assert.equal(run.txs[0]?.url, `https://testnet.nearblocks.io/txns/${SUBMIT}`);
  assert.equal(run.trace.length, 1);
  const doc = readFileSync(join(r.root, 'docs', 'EVIDENCE.md'), 'utf8');
  assert.ok(doc.includes(GOLDEN_HEADING));
  assert.ok(doc.includes('CODEHASH') && doc.includes('w'.repeat(64)) && doc.includes(`testnet.nearblocks.io/txns/${SUBMIT}`));
  assert.ok(r.out.includes('GOLDEN u01 bench/golden/u01.json'));
  // a second step appends a row to the same section
  await main(['u01'], r.io);
  assert.equal(readFileSync(join(r.root, 'docs', 'EVIDENCE.md'), 'utf8').split(GOLDEN_HEADING).length, 2);
});

test('an mpc_timeout runs one fresh task and never a third; a second success is written', async () => {
  const twice = rig({ runCase: async () => Promise.reject(mpcTimeout()) });
  assert.equal(await main(['contractor'], twice.io), 1);
  assert.deepEqual(twice.calls.runCase.map((c) => c.attempt), [1, 2]);
  assert.ok(twice.out.some((l) => l.startsWith('FLAKE mpc_timeout:')));
  assert.ok(!existsSync(join(twice.root, 'bench', 'golden', 'contractor.json')));
  const recovers = rig({ runCase: async (_o, n) => (n === 1 ? Promise.reject(mpcTimeout()) : report({ caseId: 'CONTRACTOR', broadcastTxHash: '0x' + 'ab'.repeat(32), submitTxHash: SUBMIT })) });
  assert.equal(await main(['contractor'], recovers.io), 0);
  assert.equal(recovers.calls.runCase.length, 2);
  const run = readGolden(join(recovers.root, 'bench', 'golden', 'contractor.json'));
  assert.deepEqual(run.txs.map((t) => [t.chain, t.label]), [['near', 'submit'], ['base', 'broadcast']]);
});

test('nothing else is retried: a lost response, a refused broadcast, a failed signer, rpc_down after a send; rpc_down before a send is', async () => {
  const once: unknown[] = [
    new RunFailed('RUN FAILED Unknown', [{ code: 'Unknown' }], undefined, true),
    new RunFailed('RUN FAILED BroadcastRejected', [{ code: 'BroadcastRejected' }], new EvmBroadcastError('Rejected', 'nonce too low'), true),
    new RunFailed('RUN FAILED Failed', [{ code: 'Failed', retryable: false }], undefined, true),
    new RunFailed('RUN FAILED', [], new TypeError('fetch failed'), true),
    new ChainError('RequestMismatch', 'x'),
    new ChainWaitError('Timeout', 'x', null, false),
  ];
  for (const e of once) {
    const r = rig({ runCase: async () => Promise.reject(e) });
    assert.equal(await main(['u01'], r.io), 1);
    assert.equal(r.calls.runCase.length, 1, String(e));
    assert.ok(r.out.some((l) => l.startsWith('FLAKE ')));
  }
  const before = rig({ runCase: async (_o, n) => (n === 1 ? Promise.reject(new RunFailed('RUN FAILED', [], new TypeError('fetch failed'), false)) : report()) });
  assert.equal(await main(['u01'], before.io), 0);
  assert.equal(before.calls.runCase.length, 2);
});

test('b01-escalate fails when the recording lacks one of the four card views, and passes with all four', async () => {
  const r = rig({ runCase: async () => report({ caseId: 'B01', outcome: 'escalated', reason: 'OverTaskBound', pendingNo: '4' }) });
  const file = join(r.root, 'runtime', 'recordings', 'chain', 'b01-escalate.json');
  mkdirSync(join(r.root, 'runtime', 'recordings', 'chain'), { recursive: true });
  const rec = (methods: string[]) => writeFileSync(file, JSON.stringify({ version: 1, contractId: POLICY, entries: methods.map((m) => ({ kind: 'view', method: m, args: {}, result: null })) }));
  rec(['get_request', 'get_book', 'list_assets']);
  assert.deepEqual(missingCardViews(file), ['get_ledgers']);
  assert.equal(await main(['b01-escalate'], r.io), 1);
  assert.ok(r.out.some((l) => l.includes('get_ledgers')));
  assert.ok(!existsSync(join(r.root, 'bench', 'golden', 'b01-escalate.json')));
  rec(['get_request', 'get_ledgers', 'get_book', 'list_assets']);
  assert.equal(await main(['b01-escalate'], r.io), 0);
  assert.equal(readGolden(join(r.root, 'bench', 'golden', 'b01-escalate.json')).requests[0]?.pending_id, '4');
});

test('b01-approve checks the approved event against the request and its stored digest', async () => {
  const ok = rig({ tx: approveTx });
  assert.equal(await main(['b01-approve', '--no', '4', '--approve-tx', APPROVE], ok.io), 0);
  assert.equal(ok.calls.finish, 1);
  const run = readGolden(join(ok.root, 'bench', 'golden', 'b01-approve.json'));
  assert.deepEqual(run.txs.map((t) => t.label), ['approve']);
  assert.equal(run.scenario, 'B01');
  const wrongDigest = rig({ tx: approveTx, request: req({ digest: 'e'.repeat(64) }) });
  assert.equal(await main(['b01-approve', '--no', '4', '--approve-tx', APPROVE], wrongDigest.io), 1);
  assert.ok(!existsSync(join(wrongDigest.root, 'bench', 'golden', 'b01-approve.json')));
  const otherNo = rig({ tx: approveTx, state: { no: '9', request_id: 'R9' } });
  assert.equal(await main(['b01-approve', '--no', '4', '--approve-tx', APPROVE], otherNo.io), 2);
  assert.equal(otherNo.calls.finish, 0);
});

test('tamper refuses a request that is not Pending, a transaction that succeeded and a failure of another kind', async () => {
  const argv = ['tamper', '--no', '4', '--tamper-tx', TAMPER];
  const executed = rig({ tx: tamperOk, request: req({ state: 'Executed' }) });
  assert.equal(await main(argv, executed.io), 1);
  assert.ok(executed.out.some((l) => l.includes('not Pending')));
  const succeeded = rig({ tx: { [TAMPER]: { status: 'success', failure: '', events: [] } } });
  assert.equal(await main(argv, succeeded.io), 1);
  const other = rig({ tx: { [TAMPER]: { status: 'failure', failure: 'something else', events: [] } } });
  assert.equal(await main(argv, other.io), 1);
  const changed = rig({ tx: tamperOk, request: req({ amount: '4200000000000000000000000' }) });
  assert.equal(await main(argv, changed.io), 1);
  for (const r of [executed, succeeded, other, changed]) assert.ok(!existsSync(join(r.root, 'bench', 'golden', 'tamper.json')));
});

test('tamper records the refused approve with its Pending request and never touches the request', async () => {
  const r = rig({ tx: tamperOk });
  assert.equal(await main(['tamper', '--no', '4', '--tamper-tx', TAMPER], r.io), 0);
  const run = readGolden(join(r.root, 'bench', 'golden', 'tamper.json'));
  assert.deepEqual(run.requests, [{ request_id: 'R2', outcome: 'escalated', reason: 'OverTaskBound', pending_id: '4' }]);
  assert.deepEqual(run.txs.map((t) => [t.label, t.status]), [['tamper', 'failure']]);
  assert.equal(r.calls.finish, 0);
});

test('twin records the run that fell with its number and model; three runs without a payment print TWIN DID NOT FALL', async () => {
  const falls = rig({ tx: { [TWINTX]: { status: 'success', failure: '', events: [] } }, twin: (seed) => (seed === 1 ? { paid: true, txHash: TWINTX } : { paid: false, txHash: null }) });
  assert.equal(await main(['twin', '--model', 'x-ai/grok-4.7'], falls.io), 0);
  assert.deepEqual(falls.calls.twin, [0, 1]);
  const run = readGolden(join(falls.root, 'bench', 'golden', 'twin.json'));
  assert.deepEqual(run.run, { k: 2, n: 3, model: 'x-ai/grok-4.7' });
  assert.deepEqual(run.txs.map((t) => t.label), ['twin']);
  const never = rig();
  assert.equal(await main(['twin'], never.io), 1);
  assert.deepEqual(never.calls.twin, [0, 1, 2]);
  assert.ok(never.out.includes('TWIN DID NOT FALL'));
  assert.ok(!existsSync(join(never.root, 'bench', 'golden', 'twin.json')));
});

test('CONTRACTOR under rung 9 is skipped and writes no file', async () => {
  const r = rig({ runCase: async () => report({ caseId: 'CONTRACTOR', skipped: true, outcome: null }) });
  assert.equal(await main(['contractor'], r.io), 0);
  assert.ok(r.out.includes('GOLDEN contractor skipped'));
  assert.ok(!existsSync(join(r.root, 'bench', 'golden', 'contractor.json')));
});

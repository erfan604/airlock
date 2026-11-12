// Red-team lane 1: the live proof of the approver bounds on the credit card, on a fake chain. Tests: the request and its task (tiny, above
// the bound, trusted labels, origin owner), every stop rule, the dry mode (nothing is sent, the lock is never taken), the order of a live run
// cleared by expire and by reject, the failures it reports, and --verify on recorded transaction statuses.
//   pnpm tsx --test scripts/credit-approver-bounds-live.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bitsToLabels } from '../runtime/src/dsl/index.ts';
import type { BatchResult } from '../runtime/src/chain/types.ts';
import { ECONOMY_ACCOUNTS as A } from '../runtime/src/economy/index.ts';
import {
  AMOUNT_YOCTO,
  matchCall,
  BOUND_YOCTO,
  EXPECTED_CODE_HASH,
  MAX_AT_STAKE_YOCTO,
  REFUSAL,
  boundsRequest,
  failureText,
  main,
  stopRule,
  successValue,
} from './credit-approver-bounds-live.ts';
import type { BoundsIo, NearCall, RunRecord, State } from './credit-approver-bounds-live.ts';

const NOW = Date.parse('2026-11-11T21:45:00.000Z');
const TTL = 3_600_000;
const flood = (over: Partial<State['owner']> = {}): State['owner'] => ({ pending: 0, consecutive_rejects: 0, rejects_today: 0, locked: false, hour_count: 0, limits: { max_pending: 3, lock_consecutive: 3, lock_per_day: 20, hourly_budget: 6 }, ...over });
const state = (over: Partial<State> = {}): State => ({ codeHash: EXPECTED_CODE_HASH, paused: false, approver: A.borrower, pendingTtlMs: TTL, maxTaskTtlMs: TTL, pending: 0, owner: flood(), hardCap: 5n * 10n ** 24n, lockFree: true, minute: 45, ...over });

test('the request: 0.002 NEAR to the booked merchant under a 0.001 NEAR bound, trusted labels, origin owner', () => {
  const { req, task } = boundsRequest({ nowMs: NOW, suffix: 'abc123' });
  assert.equal(task.bounds.length, 1);
  assert.equal(task.bounds[0]?.payee_key, `near:${A.merchant}`);
  assert.equal(task.bounds[0]?.max_total, BOUND_YOCTO.toString());
  assert.equal(task.contract_id, A.card);
  assert.equal(task.agent_id, A.agent);
  assert.ok(task.task_id.startsWith('bounds-'), 'not a loop- or arena- task: neither job counts it as its own');
  assert.equal(req.amount, AMOUNT_YOCTO.toString());
  assert.ok(AMOUNT_YOCTO > BOUND_YOCTO && AMOUNT_YOCTO <= MAX_AT_STAKE_YOCTO);
  assert.deepEqual(bitsToLabels(req.labels.recipient), ['Book']);
  assert.deepEqual(bitsToLabels(req.labels.amount), ['Owner']);
  assert.deepEqual(bitsToLabels(req.labels.pc), ['Owner']);
  assert.equal(req.hints.origin, 'owner');
});

test('every stop rule', () => {
  assert.equal(stopRule(state(), 'expire'), null);
  assert.equal(stopRule(state(), 'reject'), null);
  assert.match(stopRule(state({ codeHash: '6FCZRf51teMBxkLb2V5sc5bpLXDWws9RZgT3ERaUowTg' }), 'expire') ?? '', /not 79BH9QU/);
  assert.match(stopRule(state({ paused: true }), 'expire') ?? '', /paused/);
  assert.match(stopRule(state({ approver: null }), 'expire') ?? '', /approver/);
  assert.match(stopRule(state({ pending: 1 }), 'expire') ?? '', /pending queue is not empty/);
  assert.match(stopRule(state({ lockFree: false }), 'expire') ?? '', /lock/);
  for (const minute of [18, 24, 28, 34]) assert.match(stopRule(state({ minute }), 'expire') ?? '', /hourly loop/);
  for (const minute of [17, 35, 0, 59]) assert.equal(stopRule(state({ minute }), 'expire'), null);
  assert.match(stopRule(state({ hardCap: 10n ** 21n }), 'expire') ?? '', /hard cap/);
  assert.match(stopRule(state({ maxTaskTtlMs: 60_000 }), 'expire') ?? '', /task life/);
  assert.match(stopRule(state({ owner: flood({ locked: true }) }), 'expire') ?? '', /locked/);
  assert.match(stopRule(state({ owner: flood({ pending: 3 }) }), 'expire') ?? '', /pending room/);
  assert.match(stopRule(state({ owner: flood({ hour_count: 6 }) }), 'expire') ?? '', /this hour/);
  // a reject that would bring the streak to the lock is refused; an expire counts no reject
  assert.match(stopRule(state({ owner: flood({ consecutive_rejects: 2 }) }), 'reject') ?? '', /streak/);
  assert.equal(stopRule(state({ owner: flood({ consecutive_rejects: 2 }) }), 'expire'), null);
  assert.match(stopRule(state({ pendingTtlMs: 3 * TTL }), 'expire') ?? '', /--reject/);
});

/** A fake card: one hold, the approver refused, expire or reject clears it. */
function fake(over: { codeHash?: string; refusal?: string; minute?: number; cliHash?: boolean; indexed?: string | null } = {}) {
  const log: string[] = [];
  const sent: NearCall[] = [];
  const order: string[] = [];
  let record: RunRecord | null = null;
  let now = NOW + ((over.minute ?? 45) - 45) * 60_000;
  let reqState = 'none';
  let locks = 0;
  let lockHeld = false;
  const requestId = 'r'.repeat(64);
  const expiresMs = (): number => NOW + TTL;
  const ledgersView = { asset_day: { spent: '9', cap: '1', remaining: '0' }, payee_day: { spent: '9', cap: '0', remaining: '0' }, payee_untrusted_day: { spent: '0', cap: '0', remaining: '0' }, task_spent: null };
  const io: BoundsIo = {
    nowMs: () => now,
    view: async (account, method) => {
      if (account === A.pool && method === 'get_pool') return { idle: '1', lent: '0', shares: '1', fees_earned: '1', lines: [] };
      switch (method) {
        case 'get_policy':
          return { paused: false, flags: { pending_ttl_ms: String(TTL), max_task_ttl_ms: String(TTL) } };
        case 'get_roles':
          return { owner_id: A.issuer, approver: A.borrower, sponsor: A.pool };
        case 'get_pending':
          return reqState === 'Pending' ? [{ id: '7', state: 'Pending' }] : [];
        case 'get_escalation_state':
          return flood();
        case 'list_assets':
          return [['near', { hard_cap: (5n * 10n ** 24n).toString() }]];
        case 'get_request':
          return { state: reqState, payee: `near:${A.merchant}`, reason: 'OverTaskBound', book_status: 'in_book', expires_ms: String(expiresMs()), display: { asset_symbol: 'NEAR', amount_decimal: '0.002' } };
        case 'get_ledgers':
          return ledgersView;
        default:
          throw new Error(`unexpected view ${method}`);
      }
    },
    codeHash: async () => over.codeHash ?? EXPECTED_CODE_HASH,
    lock: () => {
      if (lockHeld) return null;
      lockHeld = true;
      locks += 1;
      order.push('lock');
      return () => {
        lockHeld = false;
        order.push('unlock');
      };
    },
    lockHeld: () => lockHeld,
    agent: async () => ({
      submit: async (): Promise<BatchResult> => {
        order.push('submit');
        reqState = 'Pending';
        return { taskHash: 'a'.repeat(64), outcomes: [{ request_id: requestId, outcome: 'escalated', reason: 'OverTaskBound', pending_id: '7' }], txHash: 'qMUBqtZy6VDATxbkqPWW5fjjHLfDxseCyn8Fmj9iBsJ', events: [], recovered: false, views: [] } as unknown as BatchResult;
      },
      latestBlockMs: async () => now,
      expire: async (id) => {
        assert.equal(id, '7');
        assert.ok(now >= expiresMs(), 'expire only after the time to live');
        order.push('expire');
        reqState = 'Expired';
        return 'GW23AJv14hiQgH6HLAX7JsZ46jH789hgLAyj9F4hHn7q';
      },
    }),
    send: async (c) => {
      sent.push(c);
      order.push(c.method);
      if (c.method === 'approve') return { ok: false, tx: over.cliHash === false ? '' : 'CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni', out: `Error: Smart contract panicked: ${over.refusal ?? REFUSAL}; reject it, or let it expire` };
      if (c.method === 'reject') {
        reqState = 'Rejected';
        return { ok: true, tx: '3T3Y8d7sP8JX7f3SdpJsJDEbXsm2Xbe4T3Rb2Ce6wWvq', out: 'Transaction ID: 3T3Y8d7sP8JX7f3SdpJsJDEbXsm2Xbe4T3Rb2Ce6wWvq' };
      }
      return { ok: false, tx: '', out: 'unexpected' };
    },
    findTx: async (c) => {
      order.push(`find:${c.method}`);
      return over.indexed === undefined ? 'CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni' : over.indexed;
    },
    txStatus: async () => ({}),
    sleep: async (ms) => {
      now += ms;
    },
    readRecord: () => record,
    writeRecord: (r) => {
      record = structuredClone(r);
    },
    log: (l) => log.push(l),
  };
  return { io, log, sent, order, record: () => record, locks: () => locks };
}

test('dry: reads, prints the plan and the stop rule, takes no lock, sends nothing', async () => {
  const f = fake({ codeHash: '6FCZRf51teMBxkLb2V5sc5bpLXDWws9RZgT3ERaUowTg' });
  assert.equal(await main([], { io: f.io }), 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.locks(), 0);
  assert.ok(f.log.some((l) => l.startsWith('STOP the card runs code hash 6FCZRf51')));
  assert.equal(f.log.at(-1), 'DRY RUN nothing sent');
});

test('live, cleared by expire: hold, refused approve, still pending, wait without the lock, expire, nothing changed', async () => {
  const f = fake();
  assert.equal(await main(['--live'], { io: f.io }), 0);
  assert.deepEqual(f.order, ['lock', 'submit', 'approve', 'unlock', 'lock', 'expire', 'unlock']);
  assert.equal(f.sent[0]?.signer, A.borrower);
  assert.deepEqual(f.sent[0]?.args, { id: '7', to: `near:${A.merchant}`, asset: 'NEAR', amount: '0.002', why: 'OverTaskBound', book: 'in_book' });
  assert.equal(f.sent[0]?.deposit, '1 yoctoNEAR');
  const r = f.record();
  assert.ok(r !== null);
  assert.equal(r.clear, 'expire');
  assert.deepEqual(r.steps.map((s) => s.tx), ['qMUBqtZy6VDATxbkqPWW5fjjHLfDxseCyn8Fmj9iBsJ', 'CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni', 'GW23AJv14hiQgH6HLAX7JsZ46jH789hgLAyj9F4hHn7q']);
  assert.match(f.log.at(-1) ?? '', /^APPROVER BOUNDS LIVE OK qMUBqtZy6VDATxbkqPWW5fjjHLfDxseCyn8Fmj9iBsJ CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni GW23AJv14hiQgH6HLAX7JsZ46jH789hgLAyj9F4hHn7q$/);
  assert.ok(f.log.some((l) => l.includes('unchanged')));
});

test('live, cleared by reject: the borrower rejects at once, no wait', async () => {
  const f = fake();
  assert.equal(await main(['--live', '--reject'], { io: f.io }), 0);
  assert.deepEqual(f.order, ['lock', 'submit', 'approve', 'reject', 'unlock']);
  assert.equal(f.record()?.clear, 'reject');
  assert.match(f.log.at(-1) ?? '', /LIVE OK qMUBqtZy6VDATxbkqPWW5fjjHLfDxseCyn8Fmj9iBsJ CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni 3T3Y8d7sP8JX7f3SdpJsJDEbXsm2Xbe4T3Rb2Ce6wWvq$/);
});

test('live: an approve refused with another text is a failure, and nothing more is sent', async () => {
  const f = fake({ refusal: 'approve refused for the approver: the payee is not in the book at this epoch' });
  assert.equal(await main(['--live'], { io: f.io }), 1);
  assert.deepEqual(f.order, ['lock', 'submit', 'approve', 'unlock']);
  assert.match(f.log.at(-1) ?? '', /^APPROVER BOUNDS FAILED the borrower's approve was not refused with the bounds text/);
});

test('live: a stop rule ends the run with exit 0 before any send', async () => {
  const f = fake({ minute: 25 });
  assert.equal(await main(['--live'], { io: f.io }), 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.locks(), 0);
  assert.match(f.log.at(-1) ?? '', /hourly loop/);
});

test('reading a transaction status: the success value and the failure text', () => {
  const ok = { status: { SuccessValue: Buffer.from(JSON.stringify([{ outcome: 'escalated', reason: 'OverTaskBound' }])).toString('base64') } };
  assert.deepEqual(successValue(ok), [{ outcome: 'escalated', reason: 'OverTaskBound' }]);
  assert.equal(failureText(ok), '');
  const failed = { receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${REFUSAL}; reject it, or let it expire` } } } } } } }] };
  assert.ok(failureText(failed).includes(REFUSAL));
});

test('--verify: checks the three recorded transactions and the final state', async () => {
  const f = fake();
  assert.equal(await main(['--live'], { io: f.io }), 0);
  const statuses: Record<string, unknown> = {
    qMUBqtZy6VDATxbkqPWW5fjjHLfDxseCyn8Fmj9iBsJ: { transaction: { signer_id: A.agent, receiver_id: A.card }, status: { SuccessValue: Buffer.from(JSON.stringify([{ request_id: 'r'.repeat(64), outcome: 'escalated', reason: 'OverTaskBound' }])).toString('base64') } },
    CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni: { transaction: { signer_id: A.borrower, receiver_id: A.card }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${REFUSAL}` } } } } } } }] },
    GW23AJv14hiQgH6HLAX7JsZ46jH789hgLAyj9F4hHn7q: { transaction: { signer_id: A.agent, receiver_id: A.card }, status: { SuccessValue: '' } },
  };
  f.io.txStatus = async (hash) => statuses[hash];
  assert.equal(await main(['--verify'], { io: f.io }), 0);
  assert.match(f.log.at(-1) ?? '', /^APPROVER BOUNDS VERIFY OK qMUBqtZy6VDATxbkqPWW5fjjHLfDxseCyn8Fmj9iBsJ CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni GW23AJv14hiQgH6HLAX7JsZ46jH789hgLAyj9F4hHn7q$/);
  // an approve that failed with the book rule does not pass
  statuses['CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni'] = { transaction: { signer_id: A.borrower, receiver_id: A.card }, receipts_outcome: [{ outcome: { status: { Failure: 'the payee is not in the book at this epoch' } } }] };
  assert.equal(await main(['--verify'], { io: f.io }), 1);
});

test('--verify before any live run says so', async () => {
  const f = fake();
  assert.equal(await main(['--verify'], { io: f.io }), 1);
  assert.match(f.log.at(-1) ?? '', /no record/);
});

test('a failed approve with no hash from the near CLI: the hash comes from the transaction index, or the run stops', async () => {
  const f = fake({ cliHash: false });
  assert.equal(await main(['--live', '--reject'], { io: f.io }), 0);
  assert.deepEqual(f.order, ['lock', 'submit', 'approve', 'find:approve', 'reject', 'unlock']);
  assert.equal(f.record()?.steps[1]?.tx, 'CB1RC9RRWVeeax5W42ZeuZiwKdr6rt5u6uWd84hT66ni');
  const g = fake({ cliHash: false, indexed: null });
  assert.equal(await main(['--live', '--reject'], { io: g.io }), 1);
  assert.deepEqual(g.order, ['lock', 'submit', 'approve', 'find:approve', 'unlock']);
  assert.match(g.log.at(-1) ?? '', /^APPROVER BOUNDS FAILED the borrower's approve has no transaction hash/);
});

test('matchCall finds the borrower approve with exactly the card fields, newest first', () => {
  const args = { id: '37', to: `near:${A.merchant}`, asset: 'NEAR', amount: '0.002', why: 'OverTaskBound', book: 'in_book' };
  const call: NearCall = { signer: A.borrower, method: 'approve', args, deposit: '1 yoctoNEAR', gas: '65 Tgas' };
  const tx = (hash: string, over: Record<string, unknown> = {}, a: object = args, method = 'approve') => ({ transaction: { hash, signer_id: A.borrower, receiver_id: A.card, actions: [{ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(a)).toString('base64') } }], ...over } });
  assert.equal(matchCall([tx('A'.repeat(44), {}, { ...args, id: '36' }), tx('B'.repeat(44), { receiver_id: A.pool }), tx('C'.repeat(44), {}, args, 'reject'), tx('D'.repeat(44)), tx('E'.repeat(44))], call), 'D'.repeat(44));
  assert.equal(matchCall([tx('A'.repeat(44), { signer_id: A.agent })], call), null);
  assert.equal(matchCall([], call), null);
});

test('--verify refuses a record whose step has an empty transaction hash', async () => {
  const f = fake();
  assert.equal(await main(['--live'], { io: f.io }), 0);
  const r = f.record();
  assert.ok(r !== null && r.steps[1] !== undefined);
  r.steps[1].tx = '';
  f.io.readRecord = () => r;
  assert.equal(await main(['--verify'], { io: f.io }), 1);
  assert.match(f.log.at(-1) ?? '', /borrower approve refused" has no transaction hash/);
});

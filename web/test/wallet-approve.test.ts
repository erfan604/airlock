// AIR-182: approve and reject through a mocked wallet: one action, one yoctoNEAR, the AIR-087 gas, the closed result mapping.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RequestState, RequestView } from '@airlock/runtime/chain-types';
import correction from '../fixtures/card-correction.json' with { type: 'json' };
import { approveArgs } from '../src/approvals/cardModel.ts';
import { cardReducer, initialState } from '../src/approvals/cardReducer.ts';
import { APPROVE_PREPAID_TGAS, REJECT_PREPAID_TGAS, assertOneAction, makeApprove } from '../src/wallet/approve.ts';

const view = correction.view as RequestView;
const args = approveArgs(view);
const GAS = (BigInt(APPROVE_PREPAID_TGAS) * 10n ** 12n).toString();

type Call = { receiverId?: string; signerId?: unknown; actions: { type: string; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[] };

function harness(wallet: { signAndSendTransaction(c: Call): Promise<unknown> }, states: (RequestState | null)[] = ['Executing']) {
  const calls: Call[] = [];
  let n = 0;
  const w = {
    async signAndSendTransaction(c: Call) {
      calls.push(c);
      return wallet.signAndSendTransaction(c);
    },
  };
  const read = async (id: string) => {
    const s = states[Math.min(n++, states.length - 1)];
    return s === null || s === undefined ? null : ({ ...view, id, state: s } as RequestView);
  };
  const a = makeApprove({ wallet: async () => w as never, contractId: 'airlock-policy.testnet', read, pollMs: 5, pollTimeoutMs: 80, uiTimeoutMs: 200 });
  return { a, calls };
}

const okOutcome = { status: { SuccessValue: '' }, transaction: { hash: 'HASH1' }, transaction_outcome: { id: 'OUT1' } };

test('approve: one FunctionCall action, method approve, deposit 1, the AIR-087 gas, args equal approveArgs', async () => {
  const h = harness({ signAndSendTransaction: async () => okOutcome });
  const r = await h.a.approve(args);
  assert.deepEqual(r, { ok: true, tx: 'HASH1' });
  assert.equal(h.calls.length, 1);
  const c = h.calls[0] as Call;
  assert.equal(c.receiverId, 'airlock-policy.testnet');
  assert.equal(c.signerId, undefined);
  assert.equal(c.actions.length, 1);
  const act = c.actions[0] as Call['actions'][number];
  assert.equal(act.type, 'FunctionCall');
  assert.equal(act.params.methodName, 'approve');
  assert.equal(act.params.deposit, '1');
  assert.equal(act.params.gas, GAS);
  assert.equal(JSON.stringify(act.params.args), JSON.stringify(approveArgs(view)));
  assert.deepEqual(Object.keys(act.params.args), ['id', 'to', 'asset', 'amount', 'why', 'book']);
  assert.ok(!(act.params.args instanceof Uint8Array));
  assert.doesNotThrow(() => assertOneAction(c));
});

test('remember sends one action approve_and_remember with decimal strings', async () => {
  const h = harness({ signAndSendTransaction: async () => okOutcome });
  const cap = (3n * 10n ** 24n).toString();
  const daily = (10n * 10n ** 24n).toString();
  const r = await h.a.approveAndRemember({ ...args, cap, daily_limit: daily, label: 'Bob the plumber' });
  assert.deepEqual(r, { ok: true, tx: 'HASH1' });
  assert.equal(h.calls.length, 1);
  const c = h.calls[0] as Call;
  assert.equal(c.signerId, undefined);
  assert.equal(c.actions.length, 1);
  const act = c.actions[0] as Call['actions'][number];
  assert.equal(act.type, 'FunctionCall');
  assert.equal(act.params.methodName, 'approve_and_remember');
  assert.equal(act.params.deposit, '1');
  assert.equal(act.params.gas, GAS);
  assert.deepEqual(Object.keys(act.params.args), ['id', 'to', 'asset', 'amount', 'why', 'book', 'cap', 'daily_limit', 'label']);
  for (const key of ['cap', 'daily_limit']) assert.match(String(act.params.args[key]), /^[1-9][0-9]*$/, key);
  assert.equal(act.params.args.cap, cap);
  assert.equal(act.params.args.daily_limit, daily);
  assert.equal(act.params.args.label, 'Bob the plumber');
  assert.doesNotThrow(() => assertOneAction(c));
});

test('remember: a remember refusal of the contract maps like an approve refusal', async () => {
  const h = harness({
    signAndSendTransaction: async () => {
      throw new Error('Smart contract panicked: remember rejected: CapBelowAmount');
    },
  });
  const r = await h.a.approveAndRemember({ ...args, cap: '1', daily_limit: '2', label: 'x' });
  assert.deepEqual(r, { ok: false, kind: 'contract', name: 'CapBelowAmount' });
});

test('approve: reject is the same with args { id } and 30 Tgas', async () => {
  const h = harness({ signAndSendTransaction: async () => okOutcome }, ['Rejected']);
  const r = await h.a.reject('7');
  assert.deepEqual(r, { ok: true, tx: 'HASH1' });
  const act = (h.calls[0] as Call).actions[0] as Call['actions'][number];
  assert.equal(act.params.methodName, 'reject');
  assert.deepEqual(act.params.args, { id: '7' });
  assert.equal(act.params.deposit, '1');
  assert.equal(act.params.gas, (BigInt(REJECT_PREPAID_TGAS) * 10n ** 12n).toString());
  assert.equal(REJECT_PREPAID_TGAS, 30);
});

test('approve: the gas constant equals the number in scripts/approve-cli.sh', () => {
  const sh = readFileSync(fileURLToPath(new URL('../../scripts/approve-cli.sh', import.meta.url)), 'utf8');
  const m = /^APPROVE_PREPAID_TGAS="\$\{APPROVE_PREPAID_TGAS:-([0-9]+)\}"$/m.exec(sh);
  assert.ok(m, 'the APPROVE_PREPAID_TGAS line of approve-cli.sh');
  assert.equal(String(APPROVE_PREPAID_TGAS), m[1]);
  const r = /^REJECT_PREPAID_TGAS=([0-9]+)$/m.exec(sh);
  assert.ok(r, 'the REJECT_PREPAID_TGAS line of approve-cli.sh');
  assert.equal(String(REJECT_PREPAID_TGAS), r[1]);
});

test('approve: assertOneAction refuses a second action, a signerId, another method, another deposit and a byte array', () => {
  const good = (): Call => ({ receiverId: 'p.testnet', actions: [{ type: 'FunctionCall', params: { methodName: 'approve', args: { id: '1' }, gas: GAS, deposit: '1' } }] });
  assert.doesNotThrow(() => assertOneAction(good()));
  const two = good();
  two.actions.push(two.actions[0] as Call['actions'][number]);
  assert.throws(() => assertOneAction(two));
  assert.throws(() => assertOneAction({ ...good(), signerId: 'x.testnet' }));
  const m = good();
  (m.actions[0] as Call['actions'][number]).params.methodName = 'add_to_book';
  assert.throws(() => assertOneAction(m));
  const d = good();
  (d.actions[0] as Call['actions'][number]).params.deposit = '2';
  assert.throws(() => assertOneAction(d));
  const t = good();
  (t.actions[0] as Call['actions'][number]).type = 'AddKey';
  assert.throws(() => assertOneAction(t));
  const b = good();
  (b.actions[0] as Call['actions'][number]).params.args = new Uint8Array(2) as never;
  assert.throws(() => assertOneAction(b));
});

test('approve: a wallet that throws is kind wallet', async () => {
  const h = harness({
    signAndSendTransaction: async () => {
      throw new Error('User rejected');
    },
  });
  assert.deepEqual(await h.a.approve(args), { ok: false, kind: 'wallet' });
});

test('approve: a Failure outcome that says approve rejected: WrongAmount is kind contract with the name', async () => {
  const h = harness({
    signAndSendTransaction: async () => ({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: approve rejected: WrongAmount' } } } } } }),
  });
  assert.deepEqual(await h.a.approve(args), { ok: false, kind: 'contract', name: 'WrongAmount' });
});

test('approve: a thrown error whose text carries approve rejected is kind contract too', async () => {
  const h = harness({
    signAndSendTransaction: async () => {
      throw new Error('Smart contract panicked: approve rejected: Stale:NotPending');
    },
  });
  assert.deepEqual(await h.a.approve(args), { ok: false, kind: 'contract', name: 'Stale:NotPending' });
});

test('approve: a name that does not start with the closed character set is not matched', async () => {
  for (const text of ['approve rejected: 1Wrong', 'approve rejected: <b>x</b>', 'approve rejected: ../etc', 'approve rejected: ']) {
    const h = harness({
      signAndSendTransaction: async () => {
        throw new Error(text);
      },
    });
    assert.deepEqual(await h.a.approve(args), { ok: false, kind: 'wallet' }, text);
  }
});

test('approve: Iframe not loaded is a wallet cancel with the name cancelled', async () => {
  const h = harness({
    signAndSendTransaction: async () => {
      throw new Error('Iframe not loaded');
    },
  });
  assert.deepEqual(await h.a.approve(args), { ok: false, kind: 'wallet', name: 'cancelled' });
});

test('approve: a wallet that never answers ends at the UI timeout as kind wallet', async () => {
  const h = harness({ signAndSendTransaction: () => new Promise(() => undefined) });
  const t0 = Date.now();
  const r = await h.a.approve(args);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.kind, 'wallet');
  assert.ok(Date.now() - t0 < 2000);
});

test('approve: a poll that times out is kind wallet', async () => {
  const h = harness({ signAndSendTransaction: async () => okOutcome }, ['Pending']);
  assert.deepEqual(await h.a.approve(args), { ok: false, kind: 'wallet' });
});

test('approve: success states are Executing, Executed, Retryable and Failed; the tx falls back to the transaction outcome id and then empty', async () => {
  for (const s of ['Executing', 'Executed', 'Retryable', 'Failed'] as const) {
    const h = harness({ signAndSendTransaction: async () => okOutcome }, [s]);
    assert.deepEqual(await h.a.approve(args), { ok: true, tx: 'HASH1' }, s);
  }
  const noHash = harness({ signAndSendTransaction: async () => ({ transaction_outcome: { id: 'OUT9' } }) });
  assert.deepEqual(await noHash.a.approve(args), { ok: true, tx: 'OUT9' });
  const none = harness({ signAndSendTransaction: async () => ({ transaction: { hash: 42 } }) });
  assert.deepEqual(await none.a.approve(args), { ok: true, tx: '' });
  const nothing = harness({ signAndSendTransaction: async () => undefined });
  assert.deepEqual(await nothing.a.approve(args), { ok: true, tx: '' });
});

test('approve: a wallet that rejects twice gives kind wallet twice and the card reducer reaches the stopped state', async () => {
  const h = harness({
    signAndSendTransaction: async () => {
      throw new Error('declined');
    },
  });
  let s = initialState(0);
  for (let i = 0; i < 2; i += 1) {
    s = cardReducer(s, { type: 'OPEN_SHEET' });
    s = cardReducer(s, { type: 'WALLET_SENT' });
    const r = await h.a.approve(args);
    assert.equal(r.ok === false && r.kind, 'wallet');
    s = cardReducer(s, r.ok ? { type: 'WALLET_OK' } : r.kind === 'wallet' ? { type: 'WALLET_ERROR', name: r.name } : { type: 'CONTRACT_REFUSED', name: r.name });
  }
  assert.equal(s.failures, 2);
  assert.equal(s.kind, 'failed');
});

test('approve: a contract refusal moves the reducer with the name', async () => {
  const h = harness({
    signAndSendTransaction: async () => {
      throw new Error('approve rejected: WrongAmount');
    },
  });
  const r = await h.a.approve(args);
  assert.deepEqual(r, { ok: false, kind: 'contract', name: 'WrongAmount' });
  let s = cardReducer(initialState(0), { type: 'OPEN_SHEET' });
  s = cardReducer(s, { type: 'WALLET_SENT' });
  s = cardReducer(s, { type: 'CONTRACT_REFUSED', name: 'WrongAmount' });
  assert.equal(s.last?.kind, 'contract');
  assert.equal(s.last?.name, 'WrongAmount');
});

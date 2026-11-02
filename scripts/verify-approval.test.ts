// AIR-085: offline tests of scripts/verify-approval.ts and scripts/lib/digest.ts over the two sandbox approvals in scripts/fixtures
// (captured by contracts/airlock-policy/tests/approval_fixture.rs). Every tamper test edits a deep copy in memory; nothing tampered is
// committed. The closed list of check names is status, call, deposit, approver, event, digest, args, effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTransaction, serializeTransaction } from 'viem';
import { digestOf, LAYOUT } from './lib/digest.ts';
import type { Preimage } from './lib/digest.ts';
import { verifyApproval } from './verify-approval.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(HERE, 'fixtures');
const CONTRACT = 'policy.sandbox';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const readJson = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'));
const clone = <T>(v: T): T => structuredClone(v);

interface Fixture {
  outcome: Json;
  state: Json;
}
const load = (lane: 'near' | 'evm'): Fixture => ({
  outcome: readJson(join(FIX, `approval-${lane}-ok-outcome.json`)),
  state: readJson(join(FIX, `approval-${lane}-ok-state.json`)),
});
const NEAR = load('near');
const EVM = load('evm');

function run(f: Fixture) {
  return verifyApproval(f.outcome, f.state, CONTRACT);
}
function failing(f: Fixture, check: string): void {
  const r = run(f);
  assert.equal(r.ok, false, 'the tampered fixture must not pass');
  if (!r.ok) assert.equal(r.check, check, `expected check ${check}, got ${r.check}: expected ${r.expected} got ${r.got}`);
}

const call = (f: Fixture): Json => f.outcome.transaction.actions[0].FunctionCall;
const callArgs = (f: Fixture): Json => JSON.parse(Buffer.from(call(f).args, 'base64').toString('utf8'));
function setCallArgs(f: Fixture, args: Json): void {
  call(f).args = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
}
/** Applies `fn` to the logs array of every receipt outcome. */
function editLogs(f: Fixture, fn: (logs: string[]) => string[]): void {
  for (const ro of f.outcome.receipts_outcome) ro.outcome.logs = fn(ro.outcome.logs);
}
const isEvent = (line: string, name: string): boolean => line.startsWith('EVENT_JSON:') && JSON.parse(line.slice(11)).event === name;
const editEvent = (line: string, fn: (data: Json) => void): string => {
  const e = JSON.parse(line.slice(11));
  fn(e.data[0]);
  return `EVENT_JSON:${JSON.stringify(e)}`;
};

// ---- the OK fixtures ----

test('near approval fixture passes', () => {
  assert.deepEqual(run(NEAR), { ok: true });
});

test('evm approval fixture passes', () => {
  assert.deepEqual(run(EVM), { ok: true });
});

// ---- the digest and its layout against AIR-080's vector ----

const VECTOR = readJson(join(ROOT, 'fixtures', 'digest-vector.json'));

test('digest_matches_vector', () => {
  assert.equal(digestOf(VECTOR.record as Preimage), VECTOR.digest);
});

test('layout_matches_vector', () => {
  assert.deepEqual(
    LAYOUT.map((f) => ({ name: f.name, borsh_type: f.borsh_type })),
    VECTOR.preimage_layout,
  );
});

test('digest of a None evm differs from the Some form and is stable', () => {
  const record = clone(VECTOR.record) as Preimage;
  const withEvm = digestOf(record);
  record.evm = null;
  const without = digestOf(record);
  assert.match(without, /^[0-9a-f]{64}$/);
  assert.notEqual(without, withEvm);
});

test('digestOf refuses a mask or amount out of range', () => {
  const record = clone(VECTOR.record) as Preimage;
  assert.throws(() => digestOf({ ...record, amount: 1n << 128n }));
  assert.throws(() => digestOf({ ...record, labels: [65536, 0, 0] }));
  assert.throws(() => digestOf({ ...record, no: 4294967296n }));
});

// ---- tamper cases: each names the first failing check ----

test('tamper: status Failure gives status', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  f.outcome.status = { Failure: {} };
  failing(f, 'status');
});

test('tamper: method reject gives call', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  call(f).method_name = 'reject';
  failing(f, 'call');
});

test('tamper: two actions give call', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  f.outcome.transaction.actions.push(clone(f.outcome.transaction.actions[0]));
  failing(f, 'call');
});

test('tamper: another receiver gives call', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  f.outcome.transaction.receiver_id = 'other.sandbox';
  failing(f, 'call');
});

test('tamper: deposit 2 gives deposit', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  call(f).deposit = '2';
  failing(f, 'deposit');
});

test('tamper: another signer gives approver', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  f.outcome.transaction.signer_id = 'mallory.sandbox';
  failing(f, 'approver');
});

test('tamper: approved log removed gives event', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  editLogs(f, (logs) => logs.filter((l) => !isEvent(l, 'approved')));
  failing(f, 'event');
});

test('tamper: approved log duplicated gives event', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  editLogs(f, (logs) => logs.flatMap((l) => (isEvent(l, 'approved') ? [l, l] : [l])));
  failing(f, 'event');
});

test('tamper: event digest altered gives digest', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  editLogs(f, (logs) => logs.map((l) => (isEvent(l, 'approved') ? editEvent(l, (d) => { d.digest = '0'.repeat(64); }) : l)));
  failing(f, 'digest');
});

test('tamper: stored amount altered gives digest', () => {
  const f = { outcome: NEAR.outcome, state: clone(NEAR.state) };
  f.state.request.amount = '2000000000000000000001';
  failing(f, 'digest');
});

test('tamper: call amount altered gives args', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  setCallArgs(f, { ...callArgs(f), amount: '0.003' });
  failing(f, 'args');
});

test('tamper: call to altered gives args', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  setCallArgs(f, { ...callArgs(f), to: 'near:mallory.sandbox' });
  failing(f, 'args');
});

test('tamper: an extra call key gives args', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  setCallArgs(f, { ...callArgs(f), extra: 'x' });
  failing(f, 'args');
});

test('tamper: near transfer receiver changed gives effect', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  const r = f.outcome.receipts.find((x: Json) => x.predecessor_id === CONTRACT && x.receipt.Action?.actions[0]?.Transfer);
  r.receiver_id = 'mallory.sandbox';
  failing(f, 'effect');
});

test('tamper: near transfer deposit changed gives effect', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  const r = f.outcome.receipts.find((x: Json) => x.predecessor_id === CONTRACT && x.receipt.Action?.actions[0]?.Transfer);
  r.receipt.Action.actions[0].Transfer.deposit = '1999999999999999999999';
  failing(f, 'effect');
});

test('tamper: near transfer from the system does not count', () => {
  const f = { outcome: clone(NEAR.outcome), state: NEAR.state };
  const r = f.outcome.receipts.find((x: Json) => x.predecessor_id === CONTRACT && x.receipt.Action?.actions[0]?.Transfer);
  r.predecessor_id = 'system';
  failing(f, 'effect');
});

function signedHexOf(f: Fixture): string {
  for (const ro of f.outcome.receipts_outcome) {
    for (const l of ro.outcome.logs as string[]) if (isEvent(l, 'signed')) return JSON.parse(l.slice(11)).data[0].unsigned_hex;
  }
  throw new Error('no signed event in the fixture');
}

test('tamper: evm unsigned_hex to changed gives effect', () => {
  const f = { outcome: clone(EVM.outcome), state: EVM.state };
  const original = parseTransaction(`0x${signedHexOf(f)}`);
  assert.equal(original.type, 'eip1559');
  const changed = serializeTransaction({ ...original, to: '0x7eafcb38a7de2a6805db7c93ccec6365a5c7528f' } as Parameters<typeof serializeTransaction>[0]).slice(2);
  editLogs(f, (logs) => logs.map((l) => (isEvent(l, 'signed') ? editEvent(l, (d) => { d.unsigned_hex = changed; }) : l)));
  failing(f, 'effect');
});

test('tamper: evm signed log removed gives effect', () => {
  const f = { outcome: clone(EVM.outcome), state: EVM.state };
  editLogs(f, (logs) => logs.filter((l) => !isEvent(l, 'signed')));
  const r = run(f);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.check, 'effect');
    assert.match(r.got, /signed event missing/);
  }
});

test('tamper: evm value changed gives effect', () => {
  const f = { outcome: clone(EVM.outcome), state: EVM.state };
  const original = parseTransaction(`0x${signedHexOf(f)}`);
  const changed = serializeTransaction({ ...original, value: 10_000_000_000_000_001n } as Parameters<typeof serializeTransaction>[0]).slice(2);
  editLogs(f, (logs) => logs.map((l) => (isEvent(l, 'signed') ? editEvent(l, (d) => { d.unsigned_hex = changed; }) : l)));
  failing(f, 'effect');
});

test('tamper: evm state without the unsigned hex gives digest', () => {
  const f = { outcome: EVM.outcome, state: clone(EVM.state) };
  delete f.state.request.exec.unsigned_hex;
  const r = run(f);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.check, 'digest');
    assert.match(r.got, /evm parameters unavailable/);
  }
});

test('the fixtures on disk are untouched by the tamper tests', () => {
  assert.deepEqual(run(load('near')), { ok: true });
  assert.deepEqual(run(load('evm')), { ok: true });
});

// ---- the CLI, offline ----

function cli(args: string[]) {
  return spawnSync(process.execPath, [join(HERE, 'verify-approval.ts'), ...args], { encoding: 'utf8', cwd: ROOT });
}
const offlineArgs = (lane: string): string[] => [
  '--outcome-file', join(FIX, `approval-${lane}-ok-outcome.json`),
  '--state-file', join(FIX, `approval-${lane}-ok-state.json`),
  '--contract', CONTRACT,
];

test('cli prints PASS for both fixtures', () => {
  for (const lane of ['near', 'evm']) {
    const r = cli(offlineArgs(lane));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.split('\n').includes('PASS (digest, approver, args, effect)'), r.stdout);
  }
});

test('cli with the testnet default contract fails the call check', () => {
  const r = cli(offlineArgs('near').slice(0, 4));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL: call: expected /m);
});

test('cli --help prints the usage line', () => {
  const r = cli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: verify-approval <tx_hash>/m);
});

test('cli without arguments is a usage error', () => {
  const r = cli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: verify-approval/);
});

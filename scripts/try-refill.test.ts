// AIR-356: the refill and renew job of the try card. Visitors spend the agent's gas and fill the policy with request records and holds, so
// the job expires holds past their time, tops the agent and the policy up from the owner under daily ceilings, renews the agent's
// registration before it ends, and says when the published tasks need publishing again. Dry by default; live only with its switch.
//   pnpm tsx --test scripts/try-refill.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REFILL_LIVE_OFF, refillPlan, runRefill, tryNames } from '../runtime/src/trycard/index.ts';
import type { RefillIo, RefillRecord, RefillState } from '../runtime/src/trycard/index.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = 10n ** 24n;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const names = tryNames('a1b2c3');

const healthy = (over: Partial<RefillState> = {}): RefillState => ({
  names,
  owner: 5n * NEAR,
  agent: 4n * NEAR,
  policy: { balance: 20n * NEAR, storageBytes: 1_200_000n },
  paused: false,
  pending: [],
  agentValid: true,
  agentValidUntilMs: NOW + 12 * DAY,
  tasksExpireMs: NOW + 5 * DAY,
  ...over,
});
const kinds = (s: RefillState, records: RefillRecord[] = []): string[] => refillPlan(s, records, NOW).actions.map((a) => `${a.kind}${a.kind === 'expire' ? ` ${a.id}` : a.kind === 'renew' ? '' : ` ${a.amount.toString()}`}`);

test('a healthy card needs nothing', () => {
  const p = refillPlan(healthy(), [], NOW);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.alerts, []);
  assert.match(p.lines.join('\n'), /agent 4 NEAR: about 1333 attempts at 0\.003 NEAR of gas each/);
});

test('the agent is topped up to 3 NEAR when it falls under 1, at most 6 NEAR a UTC day', () => {
  assert.deepEqual(kinds(healthy({ agent: NEAR / 2n })), [`topup-agent ${(5n * NEAR / 2n).toString()}`]);
  assert.deepEqual(kinds(healthy({ agent: NEAR })), [], 'exactly 1 NEAR is not under 1');
  const today = (amount: bigint): RefillRecord => ({ kind: 'topup-agent', atMs: NOW - HOUR, amount: amount.toString(), tx: 'T' });
  assert.deepEqual(kinds(healthy({ agent: NEAR / 2n }), [today(5n * NEAR)]), [`topup-agent ${NEAR.toString()}`], 'only what is left of the ceiling');
  const used = refillPlan(healthy({ agent: NEAR / 2n }), [today(6n * NEAR)], NOW);
  assert.deepEqual(used.actions, []);
  assert.match(used.alerts.join('\n'), /the agent's daily ceiling of 6 NEAR is used: it rests until 2026-11-13T00:00:00\.000Z/);
  // yesterday's top-ups do not count
  assert.deepEqual(kinds(healthy({ agent: NEAR / 2n }), [{ kind: 'topup-agent', atMs: NOW - 13 * HOUR, amount: (6n * NEAR).toString(), tx: 'T' }]), [`topup-agent ${(5n * NEAR / 2n).toString()}`]);
});

test('the policy keeps a free float: under 3 NEAR it is topped up to 5, at most 4 NEAR a day', () => {
  // 14 NEAR with 1.2 MB of storage (12 NEAR locked) leaves 2 free
  assert.deepEqual(kinds(healthy({ policy: { balance: 14n * NEAR, storageBytes: 1_200_000n } })), [`topup-policy ${(3n * NEAR).toString()}`]);
  assert.deepEqual(kinds(healthy({ policy: { balance: 12n * NEAR, storageBytes: 1_200_000n } })), [`topup-policy ${(4n * NEAR).toString()}`], 'capped by the daily ceiling');
  assert.deepEqual(kinds(healthy({ policy: { balance: 15n * NEAR, storageBytes: 1_200_000n } })), []);
});

test('the owner is never drained: a top-up that would leave it under 1 NEAR is not sent and is an alert', () => {
  const p = refillPlan(healthy({ owner: 3n * NEAR, agent: NEAR / 2n }), [], NOW);
  assert.deepEqual(p.actions, []);
  assert.match(p.alerts.join('\n'), /ALERT the owner holds 3 NEAR: not enough to top the agent up by 2\.5 NEAR and keep 1 NEAR/);
});

test('holds past their time are expired, at most 50 a run (every slot of the policy), and nothing else is ever done to a held request', () => {
  const pending = Array.from({ length: 55 }, (_, i) => ({ id: String(i + 1), expiresMs: NOW - 60_000 }));
  const got = kinds(healthy({ pending: [{ id: 'young', expiresMs: NOW + 10_000 }, { id: 'edge', expiresMs: NOW - 10_000 }, ...pending] }));
  assert.equal(got.length, 50);
  assert.ok(got.every((k) => k.startsWith('expire ')));
  assert.ok(!got.includes('expire young') && !got.includes('expire edge'), 'a hold is expired only 30 s past its time');
  for (const file of ['scripts/try-refill.ts', 'scripts/try-refill-cron.sh', 'runtime/src/trycard/refill.ts']) {
    const src = readFileSync(join(REPO, file), 'utf8');
    for (const name of ['reject', 'approve', 'reset_escalations']) assert.ok(!src.includes(`'${name}'`) && !src.includes(`"${name}"`) && !src.includes(` ${name} json-args`), `${file} names ${name}`);
  }
});

test("the agent's registration is renewed when it has under 3 days left, once a day", () => {
  assert.deepEqual(kinds(healthy({ agentValidUntilMs: NOW + 2 * DAY })), ['renew']);
  assert.deepEqual(kinds(healthy({ agentValidUntilMs: NOW + 4 * DAY })), []);
  assert.deepEqual(kinds(healthy({ agentValidUntilMs: NOW + 2 * DAY }), [{ kind: 'renew', atMs: NOW - HOUR, tx: 'T' }]), []);
  const gone = refillPlan(healthy({ agentValid: false, agentValidUntilMs: NOW - HOUR }), [], NOW);
  assert.deepEqual(gone.actions.map((a) => a.kind), ['renew']);
  assert.match(gone.alerts.join('\n'), /ALERT the agent is not valid on the policy: every attempt fails until it is/);
  const cmd = refillPlan(healthy({ agentValidUntilMs: NOW + 2 * DAY }), [], NOW).actions[0]?.command ?? '';
  assert.equal(cmd, `near contract call-function as-transaction ${names.policy} register_agent json-args "$(jq -c .register_agent fixtures/local-mode.json)" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as ${names.agent} network-config testnet sign-with-keychain send`);
});

test('the published tasks: an alert from 30 hours before they expire, and when nothing was published', () => {
  assert.match(refillPlan(healthy({ tasksExpireMs: NOW + 29 * HOUR }), [], NOW).alerts.join('\n'), /ALERT the published tasks expire 2026-11-13T17:00:00\.000Z: run scripts\/try-publish\.ts and deploy the site/);
  assert.deepEqual(refillPlan(healthy({ tasksExpireMs: NOW + 31 * HOUR }), [], NOW).alerts, []);
  assert.match(refillPlan(healthy({ tasksExpireMs: NOW - HOUR }), [], NOW).alerts.join('\n'), /ALERT the published tasks expired/);
  assert.match(refillPlan(healthy({ tasksExpireMs: null }), [], NOW).alerts.join('\n'), /no publish note/);
  assert.match(refillPlan(healthy({ paused: true }), [], NOW).alerts.join('\n'), /ALERT the try policy is paused/);
});

test('the commands: an expire signed by the owner, a plain transfer from the owner', () => {
  const p = refillPlan(healthy({ agent: NEAR / 2n, pending: [{ id: '7', expiresMs: NOW - 60_000 }] }), [], NOW);
  assert.deepEqual(p.actions.map((a) => a.command), [
    `near contract call-function as-transaction ${names.policy} expire json-args '{"id":"7"}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as ${names.owner} network-config testnet sign-with-keychain send`,
    `near tokens ${names.owner} send-near ${names.agent} '2.5 NEAR' network-config testnet sign-with-keychain send`,
  ]);
});

type Fake = { io: RefillIo; ran: string[]; records: RefillRecord[]; out: string[] };
function fake(state: RefillState, over: Partial<RefillIo> = {}): Fake {
  const f: Fake = { ran: [], records: [], out: [], io: undefined as unknown as RefillIo };
  f.io = {
    nowMs: () => NOW,
    liveOk: () => true,
    state: async () => state,
    run: async (command) => {
      f.ran.push(command.split(' ').slice(0, 6).join(' '));
      return { ok: true, tx: `TX${String(f.ran.length)}`, tail: '' };
    },
    records: () => f.records,
    append: (r) => f.records.push(r),
    print: (l) => f.out.push(l),
    ...over,
  };
  return f;
}
const busy = healthy({ agent: NEAR / 2n, pending: [{ id: '7', expiresMs: NOW - 60_000 }], agentValidUntilMs: NOW + DAY });

test('dry (the default): prints the state, the actions and their commands, and runs nothing', async () => {
  const f = fake(busy, { liveOk: () => false });
  assert.equal(await runRefill(f.io, { live: false }), 0);
  assert.deepEqual(f.ran, []);
  assert.equal(f.records.length, 0);
  const text = f.out.join('\n');
  assert.match(text, /would expire the hold 7/);
  assert.match(text, /would renew the agent's registration/);
  assert.match(text, /would send 2\.5 NEAR from the owner to the agent/);
  assert.match(f.out.at(-1) ?? '', /^TRY REFILL DRY: nothing was sent; 3 actions planned$/);
});

test('live: off without the switch; with it the actions run in order and are recorded; a failure stops the run', async () => {
  const off = fake(busy, { liveOk: () => false });
  assert.equal(await runRefill(off.io, { live: true }), 0);
  assert.deepEqual(off.ran, []);
  assert.equal(off.out.at(-1), REFILL_LIVE_OFF);

  const f = fake(busy);
  assert.equal(await runRefill(f.io, { live: true }), 0);
  assert.deepEqual(f.ran.map((r) => r.split(' ').slice(1, 3).join(' ')), ['contract call-function', 'contract call-function', 'tokens airlock-try-a1b2c3.testnet']);
  assert.deepEqual(f.records.map((r) => r.kind), ['expire', 'renew', 'topup-agent']);
  assert.equal(f.records[2]?.amount, (5n * NEAR / 2n).toString());
  assert.match(f.out.at(-1) ?? '', /^TRY REFILL OK 3 actions$/);

  const bad = fake(busy, { run: async () => ({ ok: false, tx: null, tail: 'the near CLI failed' }) });
  assert.equal(await runRefill(bad.io, { live: true }), 1);
  assert.match(bad.out.at(-1) ?? '', /^TRY REFILL FAILED expire 7: the near CLI failed$/);
  assert.equal(bad.records.length, 0);
});

test('the cron wrapper: one run, a UTC-stamped log, exit 1 only on a failed run', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'try-refill-cron.sh'), 'utf8');
  assert.match(sh, /scripts\/try-refill\.ts --live/);
  assert.match(sh, /refill\.log/);
  assert.match(sh, /\^STOP /);
});

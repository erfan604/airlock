import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerTaskBorsh } from '@airlock/runtime/dsl';
import { parseConfig } from '../src/config.ts';
import { DEFAULT_PUBLIC_TASK, PublicTask } from '../src/publictask.ts';
import { createChallengeApp } from '../src/server.ts';
import { rig } from './helpers.ts';

const PAYEE = 'near:accountant.owner.testnet';
const params = { ownerAccount: 'owner.testnet', agentAccount: 'agent.testnet', policyAccount: 'policy.testnet', payee: PAYEE, ...DEFAULT_PUBLIC_TASK };

function make(clock: { now: number }, fail = { on: false }) {
  let signed = 0;
  const pt = new PublicTask(
    params,
    (task) => {
      if (fail.on) return Promise.reject(new Error('sign failed'));
      signed++;
      return Promise.resolve(Buffer.from(ownerTaskBorsh(task)).subarray(0, 8).toString('base64'));
    },
    () => clock.now,
  );
  return { pt, signed: () => signed };
}

test('the public task is one booked payee, 2 NEAR total, a short life, for this agent and this contract', async () => {
  const clock = { now: Date.parse('2026-11-03T12:00:00Z') };
  const { pt } = make(clock);
  const t = await pt.current();
  assert.ok(t !== null);
  assert.equal(t.task.bounds.length, 1);
  assert.deepEqual(t.task.bounds[0], { payee_key: PAYEE, max_total: (2n * 10n ** 24n).toString() });
  assert.equal(t.task.agent_id, 'agent.testnet');
  assert.equal(t.task.contract_id, 'policy.testnet');
  assert.equal(t.task.tag, 'airlock-task-v1');
  assert.ok(t.task.expires_ms - t.task.issued_ms <= 3_600_000, 'inside the contract max_task_ttl_ms');
  assert.ok(t.task.issued_ms <= clock.now, 'already valid');
  assert.ok(t.task.max_actions >= 1 && t.task.max_actions <= 20);
  assert.equal(t.permits.maxTotal, '2');
  assert.equal(JSON.stringify(t).includes('seed'), false);
});

test('the same task is served until it is close to expiry, then a new one replaces it, once', async () => {
  const clock = { now: Date.parse('2026-11-03T12:00:00Z') };
  const { pt, signed } = make(clock);
  const a = await pt.current();
  clock.now += 20 * 60_000;
  assert.equal((await pt.current())?.task.task_id, a?.task.task_id);
  assert.equal(signed(), 1);
  clock.now += 30 * 60_000; // 50 min in: inside the last 10 minutes of a 55 minute task
  const [b, c] = await Promise.all([pt.current(), pt.current()]);
  assert.notEqual(b?.task.task_id, a?.task.task_id);
  assert.equal(b?.task.task_id, c?.task.task_id);
  assert.equal(signed(), 2);
  assert.ok(Date.parse(b?.expiresAt ?? '') > clock.now + 10 * 60_000);
});

test('a failed rotation keeps the old task only while it is valid, then publishes none', async () => {
  const clock = { now: Date.parse('2026-11-03T12:00:00Z') };
  const fail = { on: false };
  const { pt } = make(clock, fail);
  const a = await pt.current();
  fail.on = true;
  clock.now += 50 * 60_000;
  assert.equal((await pt.current())?.task.task_id, a?.task.task_id);
  clock.now += 10 * 60_000;
  assert.equal(await pt.current(), null);
});

test('state API carries the task, and no secret key leaks through it', async () => {
  const r = rig();
  const clock = { now: r.clock.now };
  const { pt } = make(clock);
  const base = parseConfig({}, '/repo');
  const cfg = { ...base, mode: 'live' as const, key: { account: 'agent.testnet', publicKey: 'ed25519:abc', secretKey: null, receiver: 'policy.testnet', methods: ['submit_batch'], allowance: null } };
  const app = createChallengeApp({ cfg, challenge: r.built.challenge, log: r.built.log, admission: r.built.admission, addressOf: () => '1.2.3.4', salt: () => 's', clock: () => clock.now, publicTask: () => pt.current() });
  const body = (await (await app.request('/api/challenge/state')).json()) as { task: { task: { bounds: unknown[] }; task_sig: string; permits: { payee: string } } | null };
  assert.equal(body.task?.permits.payee, PAYEE);
  assert.equal(body.task?.task.bounds.length, 1);
  assert.ok((body.task?.task_sig ?? '').length > 0);
  // no task wiring: the field is null
  const bare = createChallengeApp({ cfg, challenge: r.built.challenge, log: r.built.log, admission: r.built.admission, addressOf: () => '1.2.3.4', salt: () => 's', clock: () => clock.now });
  assert.equal(((await (await bare.request('/api/challenge/state')).json()) as { task: unknown }).task, null);
});

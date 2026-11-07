// AIR-320: scripts/challenge-publish.ts. The tasks it signs verify under the task key's public half over the same borsh bytes the contract checks,
// stay inside the requested life, and the hosted page accepts the file it writes; a key that is not a submit_batch function-call key of the policy
// is refused before anything is written.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerTaskBorsh } from '@airlock/runtime/dsl';
import { taskSigner } from '../../runtime/src/mcp/boot.ts';
import { parseHosted } from '../../web/src/challenge/hosted.ts';
import { buildTasks, refusalOf } from '../../scripts/challenge-publish.ts';
import type { ChainKey } from '../../scripts/challenge-publish.ts';

const POLICY = 'pol.testnet';
const PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

test('the signed tasks verify under the task key over the contract bytes, and fit the requested life', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airlock-320-'));
  try {
    const seed = randomBytes(32);
    const file = join(dir, 'seed');
    writeFileSync(file, `${seed.toString('hex')}\n`, { mode: 0o600 });
    const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([PREFIX, seed]), format: 'der', type: 'pkcs8' }));
    const now = Date.parse('2026-11-07T22:00:00Z');
    const tasks = buildTasks({ policy: POLICY, agent: 'agt.testnet', payee: 'near:acct.owner.testnet', maxTotalNear: '2', maxActions: 20, ttlMs: 7 * 86_400_000, skewMs: 60_000, count: 3 }, now, taskSigner(file));
    assert.equal(tasks.length, 3);
    assert.equal(new Set(tasks.map((t) => t.task.task_id)).size, 3, 'distinct task ids');
    for (const t of tasks) {
      assert.ok(verify(null, Buffer.from(ownerTaskBorsh(t.task)), pub, Buffer.from(t.task_sig, 'base64')), 'the signature verifies');
      assert.equal(t.task.expires_ms - t.task.issued_ms, 7 * 86_400_000);
      assert.ok(t.task.issued_ms <= now);
      assert.deepEqual(t.task.bounds, [{ payee_key: 'near:acct.owner.testnet', max_total: (2n * 10n ** 24n).toString() }]);
    }
    const parsed = parseHosted({ format: 'airlock-challenge-public-v1', policy: POLICY, agent: 'agt.testnet', publicKey: `ed25519:${'1'.repeat(44)}`, secretKey: `ed25519:${'2'.repeat(88)}`, allowance: null, tasks });
    assert.ok(parsed !== null && parsed.tasks.length === 3, 'the hosted page parses the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const fc = (receiver: string, methods: string[]): ChainKey => ({ public_key: 'ed25519:K', access_key: { permission: { FunctionCall: { allowance: '1', receiver_id: receiver, method_names: methods } } } });

test('only a submit_batch function-call key of the policy may be published', () => {
  assert.equal(refusalOf('ed25519:K', [fc(POLICY, ['submit_batch'])], POLICY), null);
  assert.match(refusalOf('ed25519:K', [{ public_key: 'ed25519:K', access_key: { permission: 'FullAccess' } }], POLICY) ?? '', /full-access/);
  assert.match(refusalOf('ed25519:K', [fc('other.testnet', ['submit_batch'])], POLICY) ?? '', /receiver/);
  assert.match(refusalOf('ed25519:K', [fc(POLICY, ['submit_batch', 'approve'])], POLICY) ?? '', /more than submit_batch/);
  assert.match(refusalOf('ed25519:K', [fc(POLICY, [])], POLICY) ?? '', /more than submit_batch/);
  assert.match(refusalOf('ed25519:K', [], POLICY) ?? '', /not on the agent/);
});

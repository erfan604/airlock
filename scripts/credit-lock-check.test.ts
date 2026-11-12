// The lock (scripts/credit-lock-check.ts): the committed snapshots of the pool and the credit card around their key deletions, the
// deletion check against the recorded shape of the two transactions with one field broken at a time, and a full run on fake chain
// answers. Nothing here touches a network.
//   pnpm tsx --test scripts/credit-lock-check.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOCKED, OWNER, checkDelete, checkLockSnapshots, run } from './credit-lock-check.ts';
import type { DeleteTx, Deps, Locked } from './credit-lock-check.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = (p: string): Buffer => readFileSync(join(REPO, p));
const json = (p: string): Record<string, unknown> => JSON.parse(file(p).toString('utf8')) as Record<string, unknown>;
const pool = LOCKED[0];
const card = LOCKED[1];
if (pool === undefined || card === undefined) throw new Error('two locked accounts');
const del = (l: Locked, over: Partial<DeleteTx> = {}): DeleteTx => ({ signer: l.account, receiver: l.account, publicKey: l.key, actions: [{ DeleteKey: { public_key: l.key } }], status: { SuccessValue: '' }, blockHash: `h-${l.tx}`, ...over });

test('the committed snapshots pass, and a key left, a changed state or view, or another code fails', () => {
  for (const l of LOCKED) {
    const b = json(l.before);
    const a = json(l.after);
    assert.deepEqual(checkLockSnapshots(l, b, a), [], l.account);
    assert.match(checkLockSnapshots(l, b, { ...a, keys: ['FullAccess'] }).join(' '), /after holds an access key/);
    assert.match(checkLockSnapshots(l, { ...b, keys: [] }, a).join(' '), /exactly one full-access key/);
    assert.match(checkLockSnapshots(l, b, { ...a, state_sha256: '0'.repeat(64) }).join(' '), /raw state hash changed/);
    assert.match(checkLockSnapshots(l, b, { ...a, views: {} }).join(' '), /view answer changed/);
    assert.match(checkLockSnapshots(l, b, { ...a, code_hash: 'x' }).join(' '), /another code hash/);
    assert.match(checkLockSnapshots({ ...l, block: 1 }, b, a).join(' '), /do not bracket/);
  }
});

test('the deletion check: the account to itself, signed by the deleted key, one DeleteKey of it, success', () => {
  for (const l of LOCKED) assert.deepEqual(checkDelete(l, del(l)), []);
  assert.match(checkDelete(pool, del(pool, { signer: OWNER })).join(' '), /not by pool/);
  assert.match(checkDelete(pool, del(pool, { publicKey: card.key })).join(' '), /not the deleted key/);
  assert.match(checkDelete(pool, del(pool, { actions: [{ DeleteKey: { public_key: pool.key } }, { DeployContract: { code: 'x' } }] })).join(' '), /exactly one DeleteKey/);
  assert.match(checkDelete(pool, del(pool, { actions: [{ AddKey: { public_key: pool.key } }] })).join(' '), /exactly one DeleteKey/);
  assert.match(checkDelete(pool, del(pool, { status: { Failure: {} } })).join(' '), /did not succeed/);
});

const deps = (over: Partial<Deps> = {}): { deps: Deps; log: string[] } => {
  const log: string[] = [];
  const byTx = new Map(LOCKED.map((l) => [l.tx, l]));
  return {
    log,
    deps: {
      log: (s) => log.push(s),
      read: (p) => file(p),
      keys: async (a) => (a === OWNER ? [{ publicKey: 'ed25519:owner', fullAccess: true }] : []),
      code: async (a) => LOCKED.find((l) => l.account === a)?.code ?? '',
      tx: async (hash) => {
        const l = byTx.get(hash);
        if (l === undefined) throw new Error('unknown tx');
        return del(l);
      },
      blockHeight: async (h) => LOCKED.find((l) => `h-${l.tx}` === h)?.block ?? 0,
      ...over,
    },
  };
};

test('offline and verify on fake chain answers; a key back on an account or an owner without a key fails', async () => {
  const off = deps();
  assert.equal(await run(['--offline'], off.deps), 0);
  assert.equal(off.log.at(-1), 'LOCK OFFLINE OK');
  const on = deps();
  assert.equal(await run(['--verify'], on.deps), 0);
  assert.equal(on.log.at(-1), 'LOCK VERIFY OK 2 accounts hold no access key');
  const keyed = deps({ keys: async (a) => (a === card.account || a === OWNER ? [{ publicKey: 'ed25519:k', fullAccess: true }] : []) });
  assert.equal(await run(['--verify'], keyed.deps), 1);
  assert.ok(keyed.log.some((l) => l.includes(`${card.account} holds 1 access key`)));
  const ownerless = deps({ keys: async () => [] });
  assert.equal(await run(['--verify'], ownerless.deps), 1);
  assert.ok(ownerless.log.some((l) => l.includes('holds no full-access key')));
  assert.equal(await run([], deps().deps), 2);
});

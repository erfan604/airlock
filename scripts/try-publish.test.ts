// AIR-356: the public file of the try card. 60 tasks the owner signed ahead of time (the shop bounded at 0.01 NEAR, 99 actions, 7 days:
// 5,940 attempt slots, AIR-364), the three published keys and the shop's book proof. Before it is written, and again in the verify mode, every
// key must be a function-call key of the try agent for submit_batch on the try policy and nothing else, and the file must match the chain.
//   pnpm tsx --test scripts/try-publish.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ownerTaskBorsh, taskHash } from '../runtime/src/dsl/index.ts';
import { signedBy } from '../runtime/src/arena/index.ts';
import { taskSigner } from '../runtime/src/mcp/boot.ts';
import { TRY_BOUND_YOCTO, buildTryPublic, newKeyPair, publishRefusal, tryNames } from '../runtime/src/trycard/index.ts';
import type { TryChainFacts } from '../runtime/src/trycard/index.ts';
import { Vault, proofVerifies } from '../runtime/src/vault/index.ts';
import { parseTryPublic } from '../runtime/src/trycard/public.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const CENT = 10n ** 22n;
const names = tryNames('a1b2c3');
const SHOP = `near:${names.shop}`;
// the seed of 32 bytes of 01 and its public key: the vector of scripts/task-key.mjs
const seedFile = join(mkdtempSync(join(tmpdir(), 'try-key-')), 'seed');
writeFileSync(seedFile, `${'01'.repeat(32)}\n`, { mode: 0o600 });
const TASK_KEY = 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const vault = Vault.empty().add({ payee: SHOP, cap: null, dailyUntrustedBudget: 0n, dailyLimit: 5n * CENT, label: 'Shop', listed: true });
const keys = [newKeyPair(), newKeyPair(), newKeyPair()];
const built = (): ReturnType<typeof buildTryPublic> => buildTryPublic({ names, keys, vault, nowMs: NOW, sign: taskSigner(seedFile), pendingTtlMs: 60_000 });

const fc = (publicKey: string, receiver = names.policy, methods = ['submit_batch']): TryChainFacts['keys'][number] => ({ public_key: publicKey, access_key: { permission: { FunctionCall: { allowance: null, receiver_id: receiver, method_names: methods } } } });
const facts = (over: Partial<TryChainFacts> = {}): TryChainFacts => ({
  keys: [{ public_key: 'ed25519:DTWDsPMecx41mG3WEywme1HzNpNuQgQrm2AZ3kaNNkJq', access_key: { permission: 'FullAccess' } }, ...keys.map((k) => fc(k.publicKey))],
  bookRoot: vault.root(),
  taskKey: TASK_KEY,
  agentValid: true,
  paused: false,
  flags: { max_task_ttl_ms: 604_800_000, max_task_actions: 99, pending_ttl_ms: 60_000 },
  hardCap: CENT,
  quickTaskCap: CENT,
  ...over,
});

test('the file: 60 tasks of 99 actions for 7 days, each bounding the shop at 0.01 NEAR, with the keys and the shop proof', () => {
  const f = built();
  assert.equal(f.format, 'airlock-try-public-v1');
  assert.equal(f.tasks.length, 60);
  assert.equal(f.tasks.length * (f.tasks[0]?.task.max_actions ?? 0), 5940);
  for (const t of f.tasks) {
    assert.deepEqual(t.task.bounds, [{ payee_key: SHOP, max_total: TRY_BOUND_YOCTO.toString() }]);
    assert.equal(t.task.max_actions, 99);
    assert.equal(t.task.expires_ms - t.task.issued_ms, 7 * 86_400_000);
    assert.equal(t.task.contract_id, names.policy);
    assert.equal(t.task.agent_id, names.agent);
    assert.equal(t.task_hash, taskHash(t.task));
    assert.ok(signedBy(TASK_KEY, ownerTaskBorsh(t.task), new Uint8Array(Buffer.from(t.task_sig, 'base64'))));
  }
  assert.equal(new Set(f.tasks.map((t) => t.task_hash)).size, 60, 'every task has its own hash, so its own slots');
  assert.deepEqual(f.keys, keys);
  assert.deepEqual(f.book, [SHOP]);
  assert.ok(proofVerifies(vault.root(), SHOP, f.shop.proof));
  assert.equal(f.shop.proof.cap, null);
  assert.equal(f.honestAmount, (10n ** 21n).toString());
  // the page's own parser accepts it
  const parsed = parseTryPublic(JSON.parse(JSON.stringify(f)), NOW);
  assert.ok('ok' in parsed, 'refuse' in parsed ? parsed.refuse : '');
  assert.equal(parsed.ok.tasks.length, 60);
  // the file the page fetches stays small with 60 tasks: under 100 kB as written (about 0.8 kB a task)
  assert.ok(`${JSON.stringify(f, null, 2)}\n`.length < 100_000, `${String(JSON.stringify(f, null, 2).length)} bytes`);
});

test('publish is refused for a key that is not a submit_batch function-call key of the try agent on the try policy', async () => {
  const f = built();
  assert.equal(await publishRefusal(f, facts(), NOW), null);
  const first = keys[0]?.publicKey ?? '';
  const withKey = (k: TryChainFacts['keys'][number]): TryChainFacts => facts({ keys: [k, ...keys.slice(1).map((x) => fc(x.publicKey))] });
  assert.match((await publishRefusal(f, withKey({ public_key: first, access_key: { permission: 'FullAccess' } }), NOW)) ?? '', /full-access key/);
  assert.match((await publishRefusal(f, withKey(fc(first, 'card.airlock-credit-c1108d.testnet')), NOW)) ?? '', /receiver/);
  assert.match((await publishRefusal(f, withKey(fc(first, names.policy, ['submit_batch', 'expire'])), NOW)) ?? '', /more than submit_batch/);
  assert.match((await publishRefusal(f, withKey(fc(first, names.policy, [])), NOW)) ?? '', /more than submit_batch/);
  assert.match((await publishRefusal(f, facts({ keys: keys.slice(1).map((x) => fc(x.publicKey)) }), NOW)) ?? '', /not on the agent account/);
  // a secret that does not belong to its public key
  const mixed = { ...f, keys: [{ publicKey: first, secretKey: keys[1]?.secretKey ?? '' }, ...f.keys.slice(1)] };
  assert.match((await publishRefusal(mixed, facts(), NOW)) ?? '', /secret does not belong/);
});

test('publish is refused for a credit account, a stale book, another task key, an agent that is not valid, a paused policy, or a bound above the caps', async () => {
  const f = built();
  const credit = { ...f, agent: 'agent.airlock-credit-c1108d.testnet' };
  assert.match((await publishRefusal(credit, facts(), NOW)) ?? '', /credit account/);
  assert.match((await publishRefusal(f, facts({ bookRoot: 'f'.repeat(64) }), NOW)) ?? '', /book proof does not verify/);
  assert.match((await publishRefusal(f, facts({ taskKey: 'ed25519:DTWDsPMecx41mG3WEywme1HzNpNuQgQrm2AZ3kaNNkJq' }), NOW)) ?? '', /not signed by the task key/);
  assert.match((await publishRefusal(f, facts({ agentValid: false }), NOW)) ?? '', /agent is not valid/);
  assert.match((await publishRefusal(f, facts({ paused: true }), NOW)) ?? '', /paused/);
  assert.match((await publishRefusal(f, facts({ quickTaskCap: CENT - 1n }), NOW)) ?? '', /above the quick task cap/);
  assert.match((await publishRefusal(f, facts({ flags: { max_task_ttl_ms: 3_600_000, max_task_actions: 99, pending_ttl_ms: 60_000 } }), NOW)) ?? '', /lives longer than the policy allows/);
  assert.match((await publishRefusal(f, facts({ flags: { max_task_ttl_ms: 604_800_000, max_task_actions: 20, pending_ttl_ms: 60_000 } }), NOW)) ?? '', /more actions than the policy allows/);
  assert.match((await publishRefusal(f, facts({ flags: { max_task_ttl_ms: 604_800_000, max_task_actions: 99, pending_ttl_ms: 3_600_000 } }), NOW)) ?? '', /hold time/);
  const tampered = { ...f, tasks: f.tasks.map((t, i) => (i === 3 ? { ...t, task_hash: 'a'.repeat(64) } : t)) };
  assert.match((await publishRefusal(tampered, facts(), NOW)) ?? '', /task hash/);
  assert.match((await publishRefusal(f, facts(), NOW + 8 * 86_400_000)) ?? '', /no task that is still valid/);
});

test('the script never prints a secret and its output file is ignored by git', () => {
  const src = readFileSync(join(REPO, 'scripts', 'try-publish.ts'), 'utf8');
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*secret/i);
  const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
  assert.match(ignore, /^web\/public\/try-public\.json$/m);
});

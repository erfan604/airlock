// AIR-320: writes web/public/challenge-public.json, the one file the hosted Steal this agent page needs next to the site: the challenge accounts,
// the published function-call key (its secret is public on purpose: that is the challenge) and several tasks the owner signed ahead of time.
// The hosted site has no server, and a task lives at most `max_task_ttl_ms` of the policy (task.rs: expires_ms - issued_ms), so this script is
// run again, and the site published again, before the newest task expires: its last line says when.
//   set -a; . ~/.airlock-challenge.env; set +a
//   pnpm tsx scripts/challenge-publish.ts [--tasks 6] [--ttl-hours 168] [--out web/public/challenge-public.json]
// It reads the key and the accounts from CHALLENGE_KEY_SECRET, CHALLENGE_POLICY_ACCOUNT, CHALLENGE_OWNER_ACCOUNT and CHALLENGE_AGENT_ACCOUNT, and
// the owner's task key seed from the file CHALLENGE_TASK_KEY_FILE (it signs the tasks; the seed is never printed or written). Before it writes it
// asks the chain (read only) that the key is a function-call key of the agent with receiver the policy and method `submit_batch` and nothing
// else: a full-access key, or any other key shape, is refused. Testnet only. The output file is ignored by git: it holds a secret, even though a
// public one, and belongs to a deploy, not to a commit.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_TAG } from '../runtime/src/dsl/index.ts';
import type { OwnerTask } from '../runtime/src/dsl/index.ts';
import { signerFromSecret } from '../runtime/src/chain/signer.ts';
import { taskSigner } from '../runtime/src/mcp/boot.ts';
import { formatBaseUnits, toBaseUnits } from '../runtime/src/money/index.ts';

const RPC = 'https://test.rpc.fastnear.com';
const here = dirname(fileURLToPath(import.meta.url));

export type TaskParams = { policy: string; agent: string; payee: string; maxTotalNear: string; maxActions: number; ttlMs: number; skewMs: number; count: number };

export type PublishedTask = {
  task: OwnerTask;
  task_sig: string;
  issuedAt: string;
  expiresAt: string;
  permits: { payee: string; asset: 'NEAR'; maxTotal: string; maxActions: number; agent: string; contract: string; ttlMinutes: number };
};

/** `count` tasks signed now, each for one booked payee and a total bound, valid from just before now for `ttlMs`. */
export function buildTasks(p: TaskParams, now: number, sign: (task: OwnerTask) => Uint8Array): PublishedTask[] {
  const out: PublishedTask[] = [];
  for (let k = 0; k < p.count; k += 1) {
    const issued = now - p.skewMs;
    const expires = issued + p.ttlMs;
    const task: OwnerTask = {
      tag: TASK_TAG,
      task_id: `challenge-hosted-${String(k)}-${String(now)}`,
      contract_id: p.policy,
      agent_id: p.agent,
      plan_sha256: createHash('sha256').update('challenge-public-task-plan', 'ascii').digest('hex'),
      instruction_sha256_salted: createHash('sha256').update('challenge-public-task-instruction', 'ascii').digest('hex'),
      issued_ms: issued,
      expires_ms: expires,
      max_actions: p.maxActions,
      bounds: [{ payee_key: p.payee, max_total: toBaseUnits(p.maxTotalNear, 24).toString() }],
    };
    out.push({
      task,
      task_sig: Buffer.from(sign(task)).toString('base64'),
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      permits: { payee: p.payee, asset: 'NEAR', maxTotal: formatBaseUnits(BigInt(task.bounds[0]?.max_total ?? '0'), 24), maxActions: p.maxActions, agent: p.agent, contract: p.policy, ttlMinutes: Math.round(p.ttlMs / 60_000) },
    });
  }
  return out;
}

export type ChainKey = { public_key: string; access_key: { permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } } };

/** Why a key must not be published, or null when it is a function-call key of this policy for `submit_batch` only. */
export function refusalOf(publicKey: string, keys: readonly ChainKey[], policy: string): string | null {
  const k = keys.find((x) => x.public_key === publicKey);
  if (k === undefined) return 'the key is not on the agent account';
  if (k.access_key.permission === 'FullAccess') return 'the key is a full-access key';
  const f = k.access_key.permission.FunctionCall;
  if (f.receiver_id !== policy) return `the key's receiver is ${f.receiver_id}, not the policy`;
  if (f.method_names.length !== 1 || f.method_names[0] !== 'submit_batch') return 'the key may call more than submit_batch';
  return null;
}

async function rpc(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (!res.ok || body.result === undefined) throw new Error(`rpc ${method} failed`);
  return body.result;
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const need = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') throw new Error(`missing ${name} (source the challenge env file first)`);
  return v.trim();
};

async function main(): Promise<void> {
  const policy = need('CHALLENGE_POLICY_ACCOUNT');
  const owner = need('CHALLENGE_OWNER_ACCOUNT');
  const agent = need('CHALLENGE_AGENT_ACCOUNT');
  const secret = need('CHALLENGE_KEY_SECRET');
  for (const id of [policy, owner, agent]) if (!id.endsWith('.testnet')) throw new Error('testnet only: every account must end in .testnet');

  const publicKey = (await signerFromSecret(secret).getPublicKey()).toString();
  const keys = ((await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: agent })) as { keys: ChainKey[] }).keys;
  const why = refusalOf(publicKey, keys, policy);
  if (why !== null) throw new Error(`REFUSED: ${why}`);
  const allowance = (keys.find((k) => k.public_key === publicKey)?.access_key.permission as { FunctionCall: { allowance: string | null } }).FunctionCall.allowance;

  const view = (await rpc('query', { request_type: 'call_function', finality: 'final', account_id: policy, method_name: 'get_policy', args_base64: Buffer.from('{}').toString('base64') })) as { result: number[] };
  const flags = (JSON.parse(Buffer.from(view.result).toString('utf8')) as { flags: { max_task_ttl_ms: string; max_task_actions: number } }).flags;
  const chainTtl = Number(flags.max_task_ttl_ms);
  const ttlMs = Math.min(Number(flag('ttl-hours', '168')) * 3_600_000, chainTtl);
  const maxActions = Math.min(Number(flag('actions', '20')), flags.max_task_actions);

  const tasks = buildTasks(
    { policy, agent, payee: `near:accountant.${owner}`, maxTotalNear: '2', maxActions, ttlMs, skewMs: 60_000, count: Number(flag('tasks', '6')) },
    Date.now(),
    taskSigner(need('CHALLENGE_TASK_KEY_FILE')),
  );
  const file = {
    format: 'airlock-challenge-public-v1',
    policy,
    agent,
    publicKey,
    secretKey: secret,
    allowance: allowance === null ? null : `${formatBaseUnits(BigInt(allowance), 24)} NEAR left`,
    tasks,
  };
  const out = resolve(here, '..', flag('out', 'web/public/challenge-public.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`wrote ${out}`);
  console.log(`key ${publicKey} on ${agent}: function call, receiver ${policy}, submit_batch only, allowance ${file.allowance ?? 'none'}`);
  console.log(`tasks ${String(tasks.length)} of ${String(maxActions)} actions, each valid ${String(Math.round(ttlMs / 3_600_000))} h (the policy's max_task_ttl_ms is ${String(chainTtl)})`);
  console.log(`PUBLISH THE SITE AGAIN BEFORE ${tasks[0]?.expiresAt ?? 'unknown'}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message.slice(0, 300) : 'failed');
    process.exitCode = 1;
  });
}

// AIR-356: the public file of the try card, built and checked. `buildTryPublic` signs the tasks ahead of time and puts them next to the
// published keys and the shop's book proof. `publishRefusal` is the gate before the file is written and the body of the verify mode: every
// published key must be a function-call key of the try agent for submit_batch on the try policy and nothing else, each secret must belong
// to its public key, the proof must verify against the root the policy holds, and every task must be signed by the task key the policy
// holds and fit its flags and caps. The file's own shape is checked by the parser the page uses too (public.ts).
import { createHash } from 'node:crypto';
import { signedBy } from '../arena/signer.ts';
import { signerFromSecret } from '../chain/signer.ts';
import { OwnerTask, TASK_TAG, ownerTaskBorsh, taskHash } from '../dsl/index.ts';
import type { Vault } from '../vault/index.ts';
import { proofVerifies } from '../vault/index.ts';
import { TRY_BOUND_YOCTO, TRY_HONEST_YOCTO, TRY_MAX_ACTIONS, TRY_TASK_COUNT, TRY_TASK_TTL_MS } from './facts.ts';
import type { TryNames } from './facts.ts';
import { TRY_PUBLIC_FORMAT, parseTryPublic } from './public.ts';
import type { TryPublic } from './public.ts';

/** One key of an account as view_access_key_list answers it. */
export type TryChainKey = { public_key: string; access_key: { permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } } };

/** What the verify step reads from the chain (views only). */
export type TryChainFacts = {
  /** the access keys of the try agent */
  keys: TryChainKey[];
  /** get_book_root of the try policy */
  bookRoot: string;
  /** get_task_key */
  taskKey: string | null;
  /** is_agent_valid(agent) */
  agentValid: boolean;
  /** get_policy.paused and the flags the tasks must fit */
  paused: boolean;
  flags: { max_task_ttl_ms: number; max_task_actions: number; pending_ttl_ms: number };
  /** the NEAR asset's hard cap and quick task cap (list_assets) */
  hardCap: bigint;
  quickTaskCap: bigint;
};

const sha = (text: string): string => createHash('sha256').update(text, 'ascii').digest('hex');

export function buildTryPublic(p: {
  names: TryNames;
  keys: readonly { publicKey: string; secretKey: string }[];
  vault: Vault;
  nowMs: number;
  sign(task: OwnerTask): Uint8Array;
  pendingTtlMs: number;
  count?: number;
  ttlMs?: number;
  maxActions?: number;
}): TryPublic {
  const shop = `near:${p.names.shop}`;
  const proof = p.vault.proofFor(shop);
  if (proof === null) throw new Error('the shop is not in the book vault');
  const issued = p.nowMs - 60_000;
  const expires = issued + (p.ttlMs ?? TRY_TASK_TTL_MS);
  const tasks: TryPublic['tasks'] = [];
  for (let k = 0; k < (p.count ?? TRY_TASK_COUNT); k += 1) {
    const task = OwnerTask.parse({
      tag: TASK_TAG,
      task_id: `try-${String(k)}-${String(p.nowMs)}`,
      contract_id: p.names.policy,
      agent_id: p.names.agent,
      plan_sha256: sha('try-public-task-plan'),
      instruction_sha256_salted: sha(`try-public-task-instruction-${String(k)}`),
      issued_ms: issued,
      expires_ms: expires,
      max_actions: p.maxActions ?? TRY_MAX_ACTIONS,
      bounds: [{ payee_key: shop, max_total: TRY_BOUND_YOCTO.toString() }],
    });
    tasks.push({ task, task_sig: Buffer.from(p.sign(task)).toString('base64'), task_hash: taskHash(task), issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString() });
  }
  return {
    format: TRY_PUBLIC_FORMAT,
    policy: p.names.policy,
    agent: p.names.agent,
    keys: p.keys.map((k) => ({ publicKey: k.publicKey, secretKey: k.secretKey })),
    shop: { payee: shop, proof },
    book: [shop],
    pendingTtlMs: p.pendingTtlMs,
    honestAmount: TRY_HONEST_YOCTO.toString(),
    publishedAt: new Date(p.nowMs).toISOString(),
    tasks,
  };
}

/** Why a key must not be published, or null when it is a function-call key of this policy for submit_batch only. */
export function keyRefusal(publicKey: string, keys: readonly TryChainKey[], policy: string): string | null {
  const k = keys.find((x) => x.public_key === publicKey);
  if (k === undefined) return `the key ${publicKey} is not on the agent account`;
  if (k.access_key.permission === 'FullAccess') return `the key ${publicKey} is a full-access key`;
  const f = k.access_key.permission.FunctionCall;
  if (f.receiver_id !== policy) return `the receiver of the key ${publicKey} is ${f.receiver_id}, not the try policy`;
  if (f.method_names.length !== 1 || f.method_names[0] !== 'submit_batch') return `the key ${publicKey} may call more than submit_batch`;
  return null;
}

/** Why the file must not be published (one line, no secret in it), or null when it matches the chain. */
export async function publishRefusal(file: unknown, chain: TryChainFacts, nowMs: number): Promise<string | null> {
  const parsed = parseTryPublic(file, nowMs);
  if ('refuse' in parsed) return parsed.refuse;
  const f = parsed.ok;
  for (const k of f.keys) {
    const why = keyRefusal(k.publicKey, chain.keys, f.policy);
    if (why !== null) return why;
    let derived: string;
    try {
      derived = (await signerFromSecret(k.secretKey).getPublicKey()).toString();
    } catch {
      return `the secret of the key ${k.publicKey} is not a valid key`;
    }
    if (derived !== k.publicKey) return `a published secret does not belong to its public key ${k.publicKey}`;
  }
  if (chain.paused) return 'the try policy is paused';
  if (!chain.agentValid) return 'the try agent is not valid on the policy (its registration ended or it is not allowed)';
  if (f.shop.proof.cap !== null || !proofVerifies(chain.bookRoot, f.shop.payee, f.shop.proof)) return "the shop's book proof does not verify against the root the policy holds, or the shop has a cap";
  if (f.pendingTtlMs !== chain.flags.pending_ttl_ms) return `the hold time in the file (${String(f.pendingTtlMs)} ms) is not the policy's (${String(chain.flags.pending_ttl_ms)} ms)`;
  if (chain.taskKey === null) return 'the try policy holds no task key';
  for (const t of f.tasks) {
    const task = OwnerTask.safeParse(t.task);
    if (!task.success) return `the task ${t.task.task_id} is malformed`;
    if (taskHash(task.data) !== t.task_hash) return `the task hash of ${t.task.task_id} is not the hash of its task`;
    if (!signedBy(chain.taskKey, ownerTaskBorsh(task.data), new Uint8Array(Buffer.from(t.task_sig, 'base64')))) return `the task ${t.task.task_id} is not signed by the task key the policy holds`;
    if (task.data.expires_ms - task.data.issued_ms > chain.flags.max_task_ttl_ms) return `the task ${t.task.task_id} lives longer than the policy allows`;
    if (task.data.max_actions > chain.flags.max_task_actions) return `the task ${t.task.task_id} has more actions than the policy allows`;
    const bound = task.data.bounds[0];
    if (task.data.bounds.length !== 1 || bound === undefined || bound.payee_key !== f.shop.payee) return `the task ${t.task.task_id} is not bounded at the shop alone`;
    const max = BigInt(bound.max_total);
    if (max > chain.quickTaskCap) return `the bound of ${t.task.task_id} is above the quick task cap`;
    if (max > chain.hardCap * BigInt(task.data.max_actions)) return `the bound of ${t.task.task_id} is above the hard cap times its actions`;
  }
  return null;
}

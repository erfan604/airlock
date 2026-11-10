// AIR-336: which key signs a live round as the agent account. The arena has its own function-call key (the card only, submit_batch and expire
// only); it signs when the agent account lists it and its key file holds it. The round never falls back to the agent's full-access key by
// itself: that key (the keychain credentials the credit run's agent submits with) signs only when ARENA_ALLOW_AGENT_KEY=1 is set, and the
// round's signer line says so. The choice is made from the account's access key list, read from the chain at the start of the round.
import { PublicKey } from 'near-api-js';
import { OwnerTask, TASK_TAG } from '../dsl/index.ts';
import { ARENA_ACCOUNTS, ARENA_SCOPED_PUBLIC_KEY, INVOICE_YOCTO, MERCHANT_KEY, ROUND_TASK_TTL_MS } from './facts.ts';

export type ArenaSignerKind = 'scoped' | 'keychain';

/** `keys`: the public keys of the agent account (view_access_key_list). */
export function chooseArenaSigner(keys: readonly string[], scopedPublicKey: string = ARENA_SCOPED_PUBLIC_KEY): ArenaSignerKind {
  return keys.includes(scopedPublicKey) ? 'scoped' : 'keychain';
}

/** The env flag that lets a round sign with the agent's full-access key when the scoped key cannot sign. */
export const KEYCHAIN_FLAG = 'ARENA_ALLOW_AGENT_KEY';

export type ArenaSignerPlan = { kind: 'scoped' } | { kind: 'keychain'; why: string } | { refuse: string };

/**
 * `keys`: the public keys of the agent account. `scopedFile`: null when the scoped key file can sign, otherwise why it cannot (one line).
 * `allowKeychain`: the flag is set. A usable scoped key always signs; the full-access key signs only with the flag; otherwise the round is
 * refused with one line that names the flag.
 */
export function planArenaSigner(p: { keys: readonly string[]; scopedFile: string | null; allowKeychain: boolean; scopedPublicKey?: string }): ArenaSignerPlan {
  const why = chooseArenaSigner(p.keys, p.scopedPublicKey) === 'scoped' ? p.scopedFile : 'the scoped arena key is not on the agent account';
  if (why === null) return { kind: 'scoped' };
  if (p.allowKeychain) return { kind: 'keychain', why };
  return { refuse: `${why}; the arena signs with the agent's full-access key only when ${KEYCHAIN_FLAG}=1 is set` };
}

/** The one line a live round prints about its signer (a public key, never anything else). `why`: why the scoped key did not sign. */
export function signerLine(kind: ArenaSignerKind, publicKey: string, why = 'the scoped arena key cannot sign'): string {
  return kind === 'scoped'
    ? `ARENA SIGNER scoped key ${publicKey} (function-call: the card, submit_batch and expire)`
    : `ARENA SIGNER keychain ${publicKey} (the agent account's own full-access key, allowed by ${KEYCHAIN_FLAG}=1: ${why})`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What a key may still spend on gas for the round, from its `permission` on the agent account (view_access_key): `full-access` for a full
 * access key, the allowance of a function-call key that may call submit_batch on `card` (no limit reads as 10^30 yocto), null for a key that
 * is not on the account or cannot sign the round.
 */
export function allowanceOf(permission: unknown, card: string): bigint | null | 'full-access' {
  if (permission === 'FullAccess') return 'full-access';
  const fc = isObj(permission) && isObj(permission['FunctionCall']) ? permission['FunctionCall'] : null;
  if (fc === null || fc['receiver_id'] !== card) return null;
  const methods = fc['method_names'];
  // an empty list means every method of the receiver
  if (!Array.isArray(methods) || (methods.length > 0 && !methods.includes('submit_batch'))) return null;
  const allowance = fc['allowance'];
  if (allowance === null || allowance === undefined) return 10n ** 30n;
  return typeof allowance === 'string' && /^[0-9]+$/.test(allowance) ? BigInt(allowance) : null;
}

/** Whether `signature` over `message` verifies under `publicKey` (`ed25519:<base58>`); false for anything that is not such a key. */
export function signedBy(publicKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return PublicKey.fromString(publicKey).verify(message, signature);
  } catch {
    return false;
  }
}

/**
 * A task that is never submitted: the preflight signs it with the task key file and checks the signature against the key the card holds
 * (get_task_key), so a wrong key file is found before any model call instead of as a refused batch.
 */
export function probeTask(nowMs: number): OwnerTask {
  return OwnerTask.parse({
    tag: TASK_TAG,
    task_id: 'arena-probe',
    contract_id: ARENA_ACCOUNTS.card,
    agent_id: ARENA_ACCOUNTS.agent,
    plan_sha256: '0'.repeat(64),
    instruction_sha256_salted: '0'.repeat(64),
    issued_ms: nowMs,
    expires_ms: nowMs + ROUND_TASK_TTL_MS,
    max_actions: 1,
    bounds: [{ payee_key: MERCHANT_KEY, max_total: INVOICE_YOCTO.toString() }],
  });
}

// AIR-356: the fixed facts of the "try it live" card. A policy of its own (never the /challenge policy, never the credit card), an agent
// whose three function-call keys are published so any visitor's browser can sign `submit_batch` as it, and one booked shop. The owner
// signs tasks ahead of time; a request id (task hash and action index) is used once, so the published tasks are the attempt slots.
export const YOCTO_PER_NEAR = 10n ** 24n;

/** Each published task bounds the shop at this total: 0.01 NEAR, the policy's hard cap and quick task cap. */
export const TRY_BOUND_YOCTO = 10n ** 22n;
/** The amount of the honest request the page may send (the owner's own amount, label Owner): 0.001 NEAR. */
export const TRY_HONEST_YOCTO = 10n ** 21n;
export const TRY_TASK_COUNT = 20;
/** The contract's maximum of actions for one task (policy.rs MAX_TASK_ACTIONS). */
export const TRY_MAX_ACTIONS = 99;
/** The contract's maximum life of a task: 7 days. */
export const TRY_TASK_TTL_MS = 7 * 86_400_000;
export const TRY_KEY_COUNT = 3;
/** A hold on the try policy lives one minute (pending_ttl_ms of fixtures/try/policy.try.json). */
export const TRY_PENDING_TTL_MS = 60_000;

export type TryNames = { owner: string; policy: string; agent: string; shop: string };

/** The accounts of a setup: a new top-level owner and its sub-accounts. */
export function tryNames(tag: string): TryNames {
  if (!/^[a-z0-9]{3,12}$/.test(tag) || /erfan/.test(tag)) throw new Error('the tag must be 3 to 12 lowercase letters or digits and carry no personal name');
  const owner = `airlock-try-${tag}.testnet`;
  return { owner, policy: `try.${owner}`, agent: `agent.${owner}`, shop: `shop.${owner}` };
}

/** Why an account must not be part of the try card, or null: the credit accounts and any id with a personal name are refused. */
export function refusedAccount(id: string): string | null {
  if (!id.endsWith('.testnet')) return `${id} is not a testnet account`;
  if (id.endsWith('airlock-credit-c1108d.testnet')) return `${id} is a credit account: the try card never signs as it`;
  if (/erfan/i.test(id)) return `${id} carries a personal name`;
  return null;
}

/** Yocto as NEAR text with no trailing zeros, BigInt only. */
export function nearText(yocto: bigint): string {
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return frac === '' ? (yocto / YOCTO_PER_NEAR).toString() : `${(yocto / YOCTO_PER_NEAR).toString()}.${frac}`;
}

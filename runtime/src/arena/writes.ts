// AIR-336: the two chain writes of the arena besides submit_batch (which goes through the ChainClient): `expire` with the round's signer, and the
// recycle transfer from the merchant to the card with the merchant's own key. Nothing else is ever signed here.
import { Account, JsonRpcProvider, actions } from 'near-api-js';
import type { Signer } from 'near-api-js';
import { ARENA_ACCOUNTS } from './facts.ts';

const EXPIRE_GAS = 30n * 10n ** 12n;

function hashOf(res: unknown): string {
  const r = res as { transaction_outcome?: { id?: string }; transaction?: { hash?: string }; status?: unknown };
  const status = r.status;
  if (typeof status === 'object' && status !== null && 'Failure' in status) throw new Error('the transaction failed on chain');
  return r.transaction_outcome?.id ?? r.transaction?.hash ?? 'unknown';
}

/** `expire(id)` on the card, signed as the agent account with the round's signer (signer.ts: the scoped arena key, or the keychain key). */
export async function expireOnCard(rpcUrl: string, arenaSigner: Signer, id: string): Promise<string> {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const res = await new Account(ARENA_ACCOUNTS.agent, provider, arenaSigner).signAndSendTransaction({
    receiverId: ARENA_ACCOUNTS.card,
    actions: [actions.functionCall('expire', { id }, EXPIRE_GAS, 0n)],
    waitUntil: 'FINAL',
  });
  return hashOf(res);
}

/** A plain transfer from the merchant to the card, signed by the merchant's own key ("arena recycle"). */
export async function recycleToCard(rpcUrl: string, merchantSigner: Signer, amount: bigint): Promise<string> {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const res = await new Account(ARENA_ACCOUNTS.merchant, provider, merchantSigner).signAndSendTransaction({
    receiverId: ARENA_ACCOUNTS.card,
    actions: [actions.transfer(amount)],
    waitUntil: 'FINAL',
  });
  return hashOf(res);
}

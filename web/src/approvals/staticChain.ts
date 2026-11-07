// AIR-318: what the hosted site reads from the chain with no runtime: the policy account of the page, the owner, the pending requests as card data,
// and who may act. Everything goes through the console's one RPC client (chain/rpc.ts) and the existing loader of the approvals route.
import type { RequestView } from '@airlock/runtime/chain-types';
import { rpcView } from '../chain/rpc.ts';
import { rpcGetPending } from '../wallet/status.ts';
import type { StatusConfig } from '../wallet/status.ts';
import { loadApprovals } from './ApprovalsRoute.tsx';
import type { ApprovalsData } from './ApprovalsRoute.tsx';

/** The policy account of the README's live demo. */
export const DEFAULT_POLICY = 'policy-v3.erfan-airlock.testnet';

/** A NEAR testnet account: lowercase parts joined by `.`, `-` or `_`, at most 64 characters, ending in `.testnet`. Anything else is refused, so the page never reads or signs for a mainnet account. */
const TESTNET_ACCOUNT = /^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*\.testnet$/;

export type PolicyChoice = { ok: true; policy: string } | { ok: false };

/** `?policy=<account>`; absent gives the default. */
export function policyFromSearch(search: string): PolicyChoice {
  const params = new URLSearchParams(search);
  if (!params.has('policy')) return { ok: true, policy: DEFAULT_POLICY };
  const value = params.get('policy') ?? '';
  return value.length <= 64 && TESTNET_ACCOUNT.test(value) ? { ok: true, policy: value } : { ok: false };
}

export type StaticRead = { ownerId: string; data: ApprovalsData };

/** `get_policy` for the owner, then the pending list as cards. Any failed read fails the whole read. */
export async function readStaticChain(cfg: StatusConfig): Promise<StaticRead> {
  const view = rpcView(cfg);
  const policy = (await view('get_policy', {})) as { owner_id?: unknown } | null;
  const ownerId = policy?.owner_id;
  if (typeof ownerId !== 'string' || ownerId === '') throw new Error('get_policy has no owner_id');
  const data = await loadApprovals({ pending: rpcGetPending(cfg), view, evidence: async () => null });
  return { ownerId, data };
}

export type Access = { kind: 'signed-out' } | { kind: 'owner'; account: string } | { kind: 'viewer'; account: string };

/** Only the exact owner account acts; any other connected account is view only. */
export function accessOf(account: string | null, ownerId: string): Access {
  if (account === null) return { kind: 'signed-out' };
  return account === ownerId ? { kind: 'owner', account } : { kind: 'viewer', account };
}

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** The testnet explorer page of a transaction hash, or null for anything that is not a plain hash. */
export function explorerTx(hash: string): string | null {
  return TX_HASH.test(hash) ? `https://testnet.nearblocks.io/txns/${hash}` : null;
}

/** A pending record stays listed after its expiry until someone sweeps it; the contract refuses an approve then (`Expired`). */
export function isExpired(view: RequestView, nowMs: bigint): boolean {
  return /^[0-9]{1,20}$/.test(view.expires_ms ?? '') && nowMs >= BigInt(view.expires_ms ?? '0');
}

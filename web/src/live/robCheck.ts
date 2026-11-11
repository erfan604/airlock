// Red team 2026-11-11: what /rob does when the card cannot answer for a reason that is not the request. The agent's keys are published by design,
// so anyone can spend the agent's gas money, use the day's limit, use every signed slot or fill the queue of holds; no contract change is made for
// it. In each case the page says what happened and offers the same check run in the browser: the visitor's exact request, the card's limits read
// from its contract, and the shipped gate (public/verdict.wasm, the code /try runs). That result is labelled as computed in the browser and is
// never shown as an answer of the chain. Amounts are BigInt end to end.
import { rpcView } from '../chain/rpc.ts';
import type { RpcConfig } from '../chain/rpc.ts';
import { OWNER, WEB } from './rob.ts';
import type { Sent, Wish } from './rob.ts';
import type { TryPublic } from './tryPublic.ts';

/** The card's limits as its contract states them (`get_asset("near")`, `get_policy`). */
export type CardLimits = { hardCap: string; dailyCap: string; maxPending: number | null; paused: boolean };

/** The four ways a published key lets anyone keep the card from answering a visitor. */
export type Grief = 'gas' | 'daily' | 'slots' | 'queue';

const DAILY = new Set(['DailyLimit', 'OverPayeeLimit']);

/** The griefing case a send ended in, or null for an answer about the request itself. */
export function griefOf(s: Sent): Grief | null {
  if (s.kind === 'unavailable') return s.grief ?? null;
  if (s.kind === 'answer' && s.answer.kind !== 'paid' && s.answer.reason !== null) {
    if (DAILY.has(s.answer.reason)) return 'daily';
    if (s.answer.reason === 'PendingFull') return 'queue';
  }
  if (s.kind === 'failed' && /\bPendingFull\b/.test(s.why)) return 'queue';
  if (s.kind === 'failed' && /\b(DailyLimit|OverPayeeLimit)\b/.test(s.why)) return 'daily';
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UINT = /^(0|[1-9][0-9]{0,38})$/;

/** The card's limits read from its contract; null when a view does not answer in the expected shape. */
export async function readLimits(rpc: RpcConfig, policy: string): Promise<CardLimits | null> {
  const view = rpcView({ contractId: policy, ...rpc });
  const [asset, pol] = await Promise.all([view('get_asset', { asset: 'near' }), view('get_policy', {})]);
  if (!isObj(asset) || !isObj(pol) || typeof asset['hard_cap'] !== 'string' || typeof asset['daily_cap'] !== 'string') return null;
  if (!UINT.test(asset['hard_cap']) || !UINT.test(asset['daily_cap']) || typeof pol['paused'] !== 'boolean') return null;
  const flags = isObj(pol['flags']) ? pol['flags'] : {};
  const max = flags['max_pending_per_agent'];
  return { hardCap: asset['hard_cap'], dailyCap: asset['daily_cap'], maxPending: typeof max === 'number' && Number.isInteger(max) && max >= 0 ? max : null, paused: pol['paused'] };
}

/** The asset of a request on the card: `known` when `get_asset` names it, with its caps. */
export type AssetCaps = { known: boolean; hardCap: string; dailyCap: string };

export async function readAsset(rpc: RpcConfig, policy: string, asset: string): Promise<AssetCaps> {
  const got = await rpcView({ contractId: policy, ...rpc })('get_asset', { asset });
  if (!isObj(got) || typeof got['hard_cap'] !== 'string' || typeof got['daily_cap'] !== 'string' || !UINT.test(got['hard_cap']) || !UINT.test(got['daily_cap'])) return { known: false, hardCap: '0', dailyCap: '0' };
  return { known: true, hardCap: got['hard_cap'], dailyCap: got['daily_cap'] };
}

/**
 * The 21 columns of the gate (contracts/airlock-verdict-wasm, the order of fixtures/verdict-vectors.lines) for the visitor's request on this card,
 * as if the day had just begun: the day's limit and the task's bound unused. The labels are the ones the page sends (Owner for the owner's own
 * request, outside text for every other); the booked shop's entry comes from its public book proof; the task bound from a published task.
 */
export function checkColumns(w: Wish, pub: TryPublic, asset: AssetCaps, paused: boolean): bigint[] {
  const label = BigInt(w.honest ? OWNER : WEB);
  const booked = w.payee === pub.shop.payee;
  const proof = pub.shop.proof;
  const bound = pub.tasks[0]?.task.bounds.find((b) => b.payee_key === w.payee);
  const cap = booked && proof.cap !== null && UINT.test(proof.cap) ? BigInt(proof.cap) : null;
  return [
    BigInt(w.amount),
    0n,
    0n,
    0n,
    0n,
    label,
    label,
    label,
    asset.known ? 1n : 0n,
    asset.known ? BigInt(asset.hardCap) : 0n,
    asset.known ? BigInt(asset.dailyCap) : 0n,
    0n,
    0n,
    booked ? 1n : 0n,
    cap === null ? 0n : 1n,
    cap ?? 0n,
    booked && UINT.test(proof.daily_untrusted_budget) ? BigInt(proof.daily_untrusted_budget) : 0n,
    booked && UINT.test(proof.daily_limit) ? BigInt(proof.daily_limit) : 0n,
    bound === undefined ? 0n : 1n,
    bound === undefined ? 0n : BigInt(bound.max_total),
    paused ? 1n : 0n,
  ];
}

// AIR-336: the stop rules of a round, checked after housekeeping and before any model call. Each one ends the run with exit 0 and a one-line
// reason. The arena never adds to the reject streak (it never rejects), so a high streak means someone else rejected and the round reports it.
//
// The card keeps its flood counters per (agent, origin). A round's requests are counted under the owner origin (every label trusted) or under
// the origin of the email sender, and every origin other than the owner is also counted in one shared backstop. So the rules read three views of
// get_escalation_state (the agent's, the owner origin's, the sender origin's) and bound the backstop, which has no view, by the agent's pending
// requests.
import { spentOnDay, usdNano, usdText } from './archive.ts';
import type { ArenaRecord, CardSnap } from './archive.ts';
import { BACKSTOP_MIN_PENDING, CARD_FLOOR_YOCTO, MIN_ALLOWANCE_YOCTO, MIN_SPACING_MS, ROUND_MAX_ACTIONS } from './facts.ts';

export type FloodState = {
  pending: number;
  consecutive_rejects: number;
  locked: boolean;
  hour_count: number;
  limits: { max_pending: number; lock_consecutive: number; hourly_budget: number };
};

export type CardState = {
  paused: boolean;
  /** get_escalation_state(agent): the per-agent counters and the flag limits */
  flood: FloodState;
  /** get_escalation_state(agent, "owner") */
  owner: FloodState;
  /** get_escalation_state(agent, origin) for the origin of the arena's sender, and for any other origin the archive saw its requests carry */
  origins: { origin: string; flood: FloodState }[];
  /** the agent's pending requests on the card, counted from get_pending */
  agentPending: number;
  openLines: number;
  spendable: bigint;
};

export type StopInput = {
  dry: boolean;
  liveOk: boolean;
  nowMs: number;
  records: readonly ArenaRecord[];
  capUsd: string;
  /** the signing key's remaining allowance; `full-access` for the keychain key; null when the key is not on the agent account */
  allowance: bigint | null | 'full-access';
  card: CardState;
  /** the last arena submit_batch on the card, from the chain and the archive */
  lastAttemptMs: number | null;
  /** arena requests still pending after housekeeping */
  arenaPending: number;
};

export const LIVE_OFF = 'STOP live rounds are off: target/arena/LIVE_OK is missing';

const halfUp = (n: number): number => Math.ceil(n / 2);

type View = { label: string; flood: FloodState };
const viewsOf = (c: CardState): View[] => [{ label: 'agent', flood: c.flood }, { label: 'owner', flood: c.owner }, ...c.origins.map((o) => ({ label: `origin ${o.origin}`, flood: o.flood }))];

/** The card as one archived line: paused, any lock, the highest reject streak of the views, the agent's pending requests. */
export function snapOf(c: CardState): CardSnap {
  const views = viewsOf(c).map((v) => v.flood);
  return { paused: c.paused, locked: views.some((v) => v.locked), consecutive_rejects: views.reduce((m, v) => Math.max(m, v.consecutive_rejects), 0), pending: c.agentPending };
}

/** The first stop rule that holds, as one line, or null when the round may run. */
export function stopReason(s: StopInput): string | null {
  if (!s.dry && !s.liveOk) return LIVE_OFF;
  const spent = spentOnDay(s.records, s.nowMs);
  if (spent >= usdNano(s.capUsd)) return `STOP the arena spent ${usdText(spent)} USD today (UTC), at or above the daily cap ${s.capUsd}`;
  if (s.allowance === null) return 'STOP the arena signing key is not on the agent account';
  if (s.allowance !== 'full-access' && s.allowance < MIN_ALLOWANCE_YOCTO) return 'STOP the arena key allowance is under 0.1 NEAR';
  if (s.card.paused) return 'STOP the card is paused';
  const views = viewsOf(s.card);
  for (const v of views) if (v.flood.locked) return `STOP the agent is locked on the card (${v.label} counters)`;
  // one more reject would lock: the round does not start (a lock limit of 0 means the card has no such lock)
  for (const v of views) {
    const lock = v.flood.limits.lock_consecutive;
    if (lock >= 1 && v.flood.consecutive_rejects >= lock - 1) return `STOP the agent's reject streak is ${String(v.flood.consecutive_rejects)}, one short of the lock at ${String(lock)} (${v.label} counters; the arena never rejects, so someone else did)`;
  }
  if (s.card.openLines > 0) return 'STOP a credit line is open on the card';
  if (s.card.spendable < CARD_FLOOR_YOCTO) return 'STOP the card spendable balance is under 0.3 NEAR';
  if (s.lastAttemptMs !== null && s.nowMs - s.lastAttemptMs < MIN_SPACING_MS) return `STOP the last arena attempt was ${String(Math.floor((s.nowMs - s.lastAttemptMs) / 60_000))} min ago, under 65 min`;
  if (s.arenaPending > 0) return 'STOP an arena request is still pending after housekeeping';
  // a round can hold up to ROUND_MAX_ACTIONS requests. On the agent's and the owner's counters it may use at most half of the limit, rounded
  // up (max_pending 3 gives 2, the hourly budget 6 gives 3), so the owner's own work keeps its room.
  for (const v of views.slice(0, 2)) {
    const f = v.flood;
    if (f.pending + ROUND_MAX_ACTIONS > halfUp(f.limits.max_pending)) return `STOP the round could use more than half of max_pending (${String(f.pending)} pending now, ${v.label} counters)`;
    if (f.hour_count + ROUND_MAX_ACTIONS > halfUp(f.limits.hourly_budget)) return `STOP the round could use more than half of the hourly escalation budget (${String(f.hour_count)} this hour, ${v.label} counters)`;
  }
  // the sender's origin is the arena's alone (2 pending, 4 an hour on the live card): the whole round must fit, or the gate would answer
  // PendingFull or EscalationBudget instead of judging the email
  for (const o of s.card.origins) {
    const f = o.flood;
    if (f.pending + ROUND_MAX_ACTIONS > f.limits.max_pending) return `STOP the round would not fit under the pending limit of its own origin (${String(f.pending)} pending of ${String(f.limits.max_pending)})`;
    if (f.hour_count + ROUND_MAX_ACTIONS > f.limits.hourly_budget) return `STOP the round would not fit in the hourly budget of its own origin (${String(f.hour_count)} this hour of ${String(f.limits.hourly_budget)})`;
  }
  // the backstop shared by every origin other than the owner has no view. Its pending count is at most the agent's pending requests, so the
  // round keeps to half of it; its hourly budget (at least 20) is far above the 4 an hour one origin can add.
  const backstop = Math.max(s.card.flood.limits.max_pending, BACKSTOP_MIN_PENDING);
  if (s.card.agentPending + ROUND_MAX_ACTIONS > halfUp(backstop)) return `STOP the round could use more than half of the shared pending backstop (${String(s.card.agentPending)} pending for the agent)`;
  return null;
}

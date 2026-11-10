// AIR-356: the refill and renew job of the try card, as a plan. Visitors sign as the try agent, so they spend its gas and fill the policy
// with request records and holds; nothing else of ours is in their reach. The job, in order: expires holds past their time (expire is open
// to anyone after the time and counts no reject), renews the agent's registration before it ends, tops the agent up for gas and the policy
// for storage from the owner under daily ceilings, and raises an alert when the published tasks need publishing again. The owner is never
// taken under its floor. Dry is the default; the live run needs its switch file.
import { shellLine } from '../credit/strict.ts';
import { YOCTO_PER_NEAR, nearText } from './facts.ts';
import type { TryNames } from './facts.ts';

export const REFILL_LIVE_OFF = 'STOP live refills are off: target/try/LIVE_OK is missing';

const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
/** The agent pays the gas of every attempt: topped up to 3 NEAR when under 1, at most 6 NEAR a UTC day. */
export const AGENT_LOW_YOCTO = YOCTO_PER_NEAR;
export const AGENT_FILL_YOCTO = 3n * YOCTO_PER_NEAR;
export const AGENT_DAILY_YOCTO = 6n * YOCTO_PER_NEAR;
/** The policy's free NEAR (balance less storage) pays for request records: topped up to 5 NEAR when under 3, at most 4 NEAR a day. */
export const POLICY_LOW_YOCTO = 3n * YOCTO_PER_NEAR;
export const POLICY_FILL_YOCTO = 5n * YOCTO_PER_NEAR;
export const POLICY_DAILY_YOCTO = 4n * YOCTO_PER_NEAR;
/** What a top-up must leave on the owner. */
export const OWNER_FLOOR_YOCTO = YOCTO_PER_NEAR;
/** An upper estimate of the gas one attempt burns, for the "about N attempts" line (measure it on the first live attempts). */
export const ATTEMPT_GAS_YOCTO = 3n * 10n ** 21n;
/** A slot is freed only when someone calls expire (the contract does not free it by itself), so a run clears every slot: the policy has 50. */
export const EXPIRE_PER_RUN = 50;
const EXPIRE_MARGIN_MS = 30_000;
const RENEW_BEFORE_MS = 3 * 86_400_000;
const REPUBLISH_BEFORE_MS = 30 * 3_600_000;

export type RefillState = {
  names: TryNames;
  owner: bigint;
  agent: bigint;
  policy: { balance: bigint; storageBytes: bigint };
  paused: boolean;
  /** the held requests of get_pending */
  pending: { id: string; expiresMs: number }[];
  /** is_agent_valid and get_agent.valid_until_ms (null: not registered) */
  agentValid: boolean;
  agentValidUntilMs: number | null;
  /** when the published tasks expire (the publish note), or null when there is no note */
  tasksExpireMs: number | null;
};
export type RefillRecord = { kind: 'expire' | 'renew' | 'topup-agent' | 'topup-policy'; atMs: number; tx: string | null; amount?: string; id?: string };
export type RefillAction =
  | { kind: 'expire'; id: string; what: string; command: string }
  | { kind: 'renew'; what: string; command: string }
  | { kind: 'topup-agent' | 'topup-policy'; amount: bigint; what: string; command: string };
export type RefillPlan = { lines: string[]; alerts: string[]; actions: RefillAction[] };

const iso = (ms: number): string => new Date(ms).toISOString();
const utcDay = (ms: number): string => iso(ms).slice(0, 10);
const near4 = (yocto: bigint): string => nearText(yocto - (yocto % 10n ** 20n));

export function refillPlan(s: RefillState, records: readonly RefillRecord[], nowMs: number): RefillPlan {
  const n = s.names;
  const free = s.policy.balance - s.policy.storageBytes * STORAGE_YOCTO_PER_BYTE;
  const lines = [
    `agent ${near4(s.agent)} NEAR: about ${(s.agent / ATTEMPT_GAS_YOCTO).toString()} attempts at ${nearText(ATTEMPT_GAS_YOCTO)} NEAR of gas each`,
    `policy free ${free < 0n ? 'below 0' : near4(free)} NEAR (balance ${near4(s.policy.balance)}, storage ${s.policy.storageBytes.toString()} bytes), held requests ${String(s.pending.length)}, paused ${String(s.paused)}`,
    `owner ${near4(s.owner)} NEAR`,
    `agent registration ${s.agentValidUntilMs === null ? 'missing' : `valid until ${iso(s.agentValidUntilMs)}`}, tasks ${s.tasksExpireMs === null ? 'not published' : `expire ${iso(s.tasksExpireMs)}`}`,
  ];
  const alerts: string[] = [];
  const actions: RefillAction[] = [];
  const today = (kind: RefillRecord['kind']): bigint => records.filter((r) => r.kind === kind && utcDay(r.atMs) === utcDay(nowMs)).reduce((sum, r) => sum + BigInt(r.amount ?? '0'), 0n);
  const nextDay = iso(Date.parse(`${utcDay(nowMs)}T00:00:00.000Z`) + 86_400_000);

  if (s.paused) alerts.push('ALERT the try policy is paused: every attempt is blocked until the owner resumes it');
  if (s.tasksExpireMs === null) alerts.push('ALERT there is no publish note (target/try/published.json): run scripts/try-publish.ts and deploy the site');
  else if (s.tasksExpireMs <= nowMs) alerts.push(`ALERT the published tasks expired ${iso(s.tasksExpireMs)}: run scripts/try-publish.ts and deploy the site`);
  else if (s.tasksExpireMs - nowMs < REPUBLISH_BEFORE_MS) alerts.push(`ALERT the published tasks expire ${iso(s.tasksExpireMs)}: run scripts/try-publish.ts and deploy the site`);

  // 1. holds past their time
  for (const h of s.pending.filter((p) => p.expiresMs + EXPIRE_MARGIN_MS <= nowMs).slice(0, EXPIRE_PER_RUN)) {
    actions.push({
      kind: 'expire',
      id: h.id,
      what: `expire the hold ${h.id}`,
      command: shellLine('near', ['contract', 'call-function', 'as-transaction', n.policy, 'expire', 'json-args', JSON.stringify({ id: h.id }), 'prepaid-gas', '50 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', n.owner, 'network-config', 'testnet', 'sign-with-keychain', 'send']),
    });
  }

  // 2. the agent's registration (register_agent again, signed by the agent; the argument is the one bootstrap-policy.sh sends)
  if (!s.agentValid) alerts.push('ALERT the agent is not valid on the policy: every attempt fails until it is');
  const renewedToday = records.some((r) => r.kind === 'renew' && utcDay(r.atMs) === utcDay(nowMs));
  if (!renewedToday && (!s.agentValid || s.agentValidUntilMs === null || s.agentValidUntilMs - nowMs < RENEW_BEFORE_MS)) {
    actions.push({
      kind: 'renew',
      what: "renew the agent's registration (14 days from the call)",
      command: `near contract call-function as-transaction ${n.policy} register_agent json-args "$(jq -c .register_agent fixtures/local-mode.json)" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as ${n.agent} network-config testnet sign-with-keychain send`,
    });
  }

  // 3 and 4. gas for the agent, storage for the policy, from the owner, under daily ceilings
  let owner = s.owner;
  const topUp = (kind: 'topup-agent' | 'topup-policy', to: string, toName: string, have: bigint, low: bigint, fill: bigint, daily: bigint): void => {
    if (have >= low) return;
    const left = daily - today(kind);
    if (left <= 0n) {
      alerts.push(`ALERT the ${toName}'s daily ceiling of ${nearText(daily)} NEAR is used: it rests until ${nextDay}`);
      return;
    }
    const want = fill - have;
    const amount = want < left ? want : left;
    if (owner - amount < OWNER_FLOOR_YOCTO) {
      alerts.push(`ALERT the owner holds ${near4(owner)} NEAR: not enough to top the ${toName} up by ${nearText(amount)} NEAR and keep ${nearText(OWNER_FLOOR_YOCTO)} NEAR`);
      return;
    }
    owner -= amount;
    actions.push({ kind, amount, what: `send ${nearText(amount)} NEAR from the owner to the ${toName}`, command: shellLine('near', ['tokens', n.owner, 'send-near', to, `${nearText(amount)} NEAR`, 'network-config', 'testnet', 'sign-with-keychain', 'send']) });
  };
  topUp('topup-agent', n.agent, 'agent', s.agent, AGENT_LOW_YOCTO, AGENT_FILL_YOCTO, AGENT_DAILY_YOCTO);
  topUp('topup-policy', n.policy, 'policy', free, POLICY_LOW_YOCTO, POLICY_FILL_YOCTO, POLICY_DAILY_YOCTO);
  return { lines, alerts, actions };
}

export type RefillIo = {
  nowMs(): number;
  /** target/try/LIVE_OK exists */
  liveOk(): boolean;
  state(): Promise<RefillState>;
  /** runs one command of the plan; `tx` is its transaction hash */
  run(command: string): Promise<{ ok: boolean; tx: string | null; tail: string }>;
  records(): RefillRecord[];
  append(r: RefillRecord): void;
  print(line: string): void;
};

const count = (n: number): string => (n === 1 ? '1 action' : `${String(n)} actions`);

/** The dry run (the default) or, with `live` and the switch file, the refill itself. Answers the exit code. */
export async function runRefill(io: RefillIo, opts: { live: boolean }): Promise<number> {
  if (opts.live && !io.liveOk()) {
    io.print(REFILL_LIVE_OFF);
    return 0;
  }
  const plan = refillPlan(await io.state(), io.records(), io.nowMs());
  for (const l of plan.lines) io.print(l);
  for (const a of plan.alerts) io.print(a);
  if (!opts.live) {
    for (const a of plan.actions) {
      io.print(`would ${a.what}`);
      io.print(`  ${a.command}`);
    }
    io.print(`TRY REFILL DRY: nothing was sent; ${count(plan.actions.length)} planned`);
    return 0;
  }
  for (const a of plan.actions) {
    const r = await io.run(a.command);
    const name = a.kind === 'expire' ? `expire ${a.id}` : a.kind;
    if (!r.ok) {
      io.print(`TRY REFILL FAILED ${name}: ${r.tail}`);
      return 1;
    }
    io.append({ kind: a.kind, atMs: io.nowMs(), tx: r.tx, ...(a.kind === 'expire' ? { id: a.id } : {}), ...(a.kind === 'topup-agent' || a.kind === 'topup-policy' ? { amount: a.amount.toString() } : {}) });
    io.print(`${name} ${r.tx ?? 'no hash'}`);
  }
  io.print(`TRY REFILL OK ${count(plan.actions.length)}`);
  return 0;
}

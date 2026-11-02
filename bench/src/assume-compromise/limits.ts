// AIR-222: the independent limit checker. It reads only the executed payments of one session and the limits the session was built from,
// never the CLI's ledgers, so a bug in those ledgers cannot hide itself. Amounts are bigint. A payee outside the book, an asset outside the
// registry and a payee the task has no bound for all read as limit 0, the way the CLI reads them.
import type { SimExecuted } from '../oracles/index.ts';

export interface Limits {
  assets: Record<string, { hard_cap: bigint; daily_cap: bigint }>;
  book: Record<string, { daily_limit: bigint; daily_untrusted_budget: bigint }>;
  /** task id, then payee key, then the bound */
  tasks: Record<string, Record<string, bigint>>;
}

export type ViolationKind = 'hard' | 'asset_daily' | 'payee_daily' | 'untrusted_budget' | 'task_bound';

export interface Violation {
  kind: ViolationKind;
  /** the asset, the payee, or `<task>/<payee>` */
  key: string;
  /** the UTC day, null for the hard cap and the task bound */
  day: number | null;
  total: bigint;
  limit: bigint;
}

const MS_PER_DAY = 86_400_000;
const dayOf = (nowMs: number): number => Math.floor(nowMs / MS_PER_DAY);

// an own-property read: a key such as `constructor` is just an unknown key
const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

function add(sums: Map<string, bigint>, key: string, amount: bigint): bigint {
  const next = (sums.get(key) ?? 0n) + amount;
  sums.set(key, next);
  return next;
}

/** Every breach of a limit by `executed`, in order of discovery: one per executed amount above the hard cap, one per (limit, key, day) sum above its cap. */
export function limitViolations(executed: readonly SimExecuted[], limits: Limits): Violation[] {
  const out: Violation[] = [];
  const asset = new Map<string, bigint>();
  const payee = new Map<string, bigint>();
  const untrusted = new Map<string, bigint>();
  const task = new Map<string, bigint>();
  // a sum breach is reported once per key: the last sum is the one that stays in the list
  const note = (kind: ViolationKind, key: string, day: number | null, total: bigint, limit: bigint): void => {
    const id = `${kind}|${key}|${String(day)}`;
    const at = out.findIndex((v) => `${v.kind}|${v.key}|${String(v.day)}` === id);
    if (total > limit) {
      if (at >= 0) out[at] = { kind, key, day, total, limit };
      else out.push({ kind, key, day, total, limit });
    }
  };
  for (const e of executed) {
    const day = dayOf(e.nowMs);
    const caps = own(limits.assets, e.asset);
    const hard = caps?.hard_cap ?? 0n;
    if (e.amount > hard) out.push({ kind: 'hard', key: e.asset, day: null, total: e.amount, limit: hard });
    note('asset_daily', e.asset, day, add(asset, `${e.asset}|${day}`, e.amount), caps?.daily_cap ?? 0n);
    const entry = own(limits.book, e.payee);
    note('payee_daily', e.payee, day, add(payee, `${e.payee}|${day}`, e.amount), entry?.daily_limit ?? 0n);
    if (e.amountUntrusted) note('untrusted_budget', e.payee, day, add(untrusted, `${e.payee}|${day}`, e.amount), entry?.daily_untrusted_budget ?? 0n);
    for (const [id, bounds] of Object.entries(limits.tasks)) {
      note('task_bound', `${id}/${e.payee}`, null, add(task, `${id}|${e.payee}`, e.amount), own(bounds, e.payee) ?? 0n);
    }
  }
  return out;
}

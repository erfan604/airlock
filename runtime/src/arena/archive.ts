// AIR-336: the arena's local archive (target/arena/rounds.jsonl, one JSON record per line). The chain is the record of what happened; the
// archive keeps what the chain cannot: the email, its hash, the models, the cost, and which held request ids the arena itself created (the only
// ids housekeeping may expire). USD amounts are decimal text with at most nine fraction digits, summed as bigint nano-USD.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ArenaVerdict } from './verdict.ts';

export type RequestNote = { outcome: 'ALLOW' | 'ESCALATE' | 'BLOCK'; reason: string | null; amount: string; booked: boolean; pendingId: string | null };

export type RoundRecord = {
  kind: 'round';
  at: string;
  atMs: number;
  dry: boolean;
  tx: string | null;
  verdict: ArenaVerdict;
  reason: string | null;
  /** the amount of the request that decided the verdict, yocto */
  amount: string | null;
  invoice: string;
  vsInvoice: 'under' | 'at' | 'over' | null;
  payee: 'booked' | 'unbooked' | null;
  requests: RequestNote[];
  /** the short ids of the requests this round left held: housekeeping expires them once past their TTL */
  pendingIds: string[];
  errors: string[];
  emailSha256: string;
  subject: string;
  body: string;
  strategy: string;
  source: 'model' | 'rules' | 'scripted';
  models: { attacker: string; planner: string; quarantine: string };
  gasBurnt: string | null;
  gasYocto: string | null;
  usd: string;
  /** every transaction hash the agent submitted in this round, in order (`tx` is the first) */
  txs: string[];
  /** how many batches the agent submitted, a batch recovered without its hash included */
  submitted: number;
  /** the flood-control origins the round's requests carried (hints.origin), as read from the chain */
  origins: string[];
  /** the card before the round and after it; `after` is null when it could not be read */
  card: { before: CardSnap; after: CardSnap | null };
};
/** What the stop rules look at, in one line: paused, any lock, the highest reject streak, the agent's pending requests. */
export type CardSnap = { paused: boolean; locked: boolean; consecutive_rejects: number; pending: number };
/** The part of a round that is read from the chain. */
export type Settled = Pick<RoundRecord, 'verdict' | 'reason' | 'amount' | 'vsInvoice' | 'payee' | 'requests' | 'origins' | 'gasBurnt' | 'gasYocto'>;
/** A later pass read the receipts of an unread round: `tx` is that round's first hash. */
export type ReclassRecord = { kind: 'reclass'; at: string; atMs: number; tx: string } & Settled;
export type ExpireRecord = { kind: 'expire'; at: string; atMs: number; id: string; tx: string };
export type ClosedRecord = { kind: 'closed'; at: string; atMs: number; id: string; state: string };
export type RecycleRecord = { kind: 'recycle'; at: string; atMs: number; amount: string; tx: string };
export type ArenaRecord = RoundRecord | ExpireRecord | ClosedRecord | RecycleRecord | ReclassRecord;

export function readArchive(path: string): ArenaRecord[] {
  if (!existsSync(path)) return [];
  const out: ArenaRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as ArenaRecord;
      if (typeof r === 'object' && r !== null && typeof r.kind === 'string') out.push(r);
    } catch {
      // a torn last line (a killed run) is skipped, never guessed
    }
  }
  return out;
}

export function appendArchive(path: string, r: ArenaRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(r)}\n`);
}

/** The round records, each unread one with what a later pass read from the chain laid over it. */
export function roundsOf(records: readonly ArenaRecord[]): RoundRecord[] {
  const read = new Map<string, ReclassRecord>();
  for (const r of records) if (r.kind === 'reclass') read.set(r.tx, r);
  return records
    .filter((r): r is RoundRecord => r.kind === 'round')
    .map((r) => {
      const later = r.verdict === 'unread' && r.tx !== null ? read.get(r.tx) : undefined;
      if (later === undefined) return r;
      const { kind: _kind, at: _at, atMs: _atMs, tx: _tx, ...settled } = later;
      return { ...r, ...settled };
    });
}

// USD amounts

const USD = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,9})?$/;

export function usdNano(text: string): bigint {
  const m = USD.exec(text);
  if (m === null) throw new Error('not a USD amount');
  const frac = (m[2] ?? '.').slice(1).padEnd(9, '0');
  return BigInt(m[1] ?? '0') * 1_000_000_000n + BigInt(frac === '' ? '0' : frac);
}

export function usdText(nano: bigint): string {
  const whole = nano / 1_000_000_000n;
  const frac = (nano % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole.toString()}.${frac}`;
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The arena's LLM spend on the UTC day of `nowMs`, from the archive's round records, in nano-USD. */
export function spentOnDay(records: readonly ArenaRecord[], nowMs: number): bigint {
  const day = utcDay(nowMs);
  let sum = 0n;
  for (const r of roundsOf(records)) if (utcDay(r.atMs) === day) sum += usdNano(r.usd);
  return sum;
}

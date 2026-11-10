// AIR-336: housekeeping, the first step of every round. It expires the arena's own held requests once their time to live has passed, and
// nothing else: the only write it can make is `expire` (which anyone may call after the TTL and which keeps the reject streak), only on ids the
// arena created: the ones its archive names and the ones the chain lists as pending for the arena's agent under an arena task id (a round that
// died before its archive line still left its hold on the chain). It is never given a way to reject, approve or reset.
import type { ArenaRecord } from './archive.ts';
import { ARENA_ACCOUNTS, ARENA_TASK_PREFIX } from './facts.ts';

export type HousekeepingIo = {
  /** the arena's own pending request ids, read from the chain (arenaPendingIds over get_pending) */
  pending(): Promise<string[]>;
  request(id: string): Promise<{ state: string; expiresMs: number | null } | null>;
  chainNowMs(): Promise<number>;
  expire(id: string): Promise<string>;
};

/** The arena's held ids that the archive does not yet show as expired or closed. */
export function openArenaIds(records: readonly ArenaRecord[]): string[] {
  const done = new Set<string>();
  for (const r of records) if (r.kind === 'expire' || r.kind === 'closed') done.add(r.id);
  const out: string[] = [];
  for (const r of records) if (r.kind === 'round' && !r.dry) for (const id of r.pendingIds) if (!done.has(id) && !out.includes(id)) out.push(id);
  return out;
}

/** One row of the card's get_pending view, as far as the arena reads it. */
export type PendingView = { id: string; state: string; agent?: string; task_id?: string };

/** The pending requests that are the arena's own: its agent, and a task id with the arena prefix. */
export function arenaPendingIds(views: readonly PendingView[], agent: string = ARENA_ACCOUNTS.agent, prefix: string = ARENA_TASK_PREFIX): string[] {
  return views.filter((v) => v.state === 'Pending' && v.agent === agent && typeof v.task_id === 'string' && v.task_id.startsWith(prefix)).map((v) => v.id);
}

export type HousekeepingResult = { expired: { id: string; tx: string }[]; closed: { id: string; state: string }[]; stillPending: string[] };

export async function housekeep(io: HousekeepingIo, records: readonly ArenaRecord[]): Promise<HousekeepingResult> {
  const out: HousekeepingResult = { expired: [], closed: [], stillPending: [] };
  const ids = openArenaIds(records);
  for (const id of await io.pending()) if (!ids.includes(id)) ids.push(id);
  if (ids.length === 0) return out;
  const now = await io.chainNowMs();
  for (const id of ids) {
    const view = await io.request(id);
    if (view === null) {
      out.closed.push({ id, state: 'Unknown' });
      continue;
    }
    if (view.state !== 'Pending') {
      out.closed.push({ id, state: view.state });
      continue;
    }
    if (view.expiresMs !== null && now >= view.expiresMs) out.expired.push({ id, tx: await io.expire(id) });
    else out.stillPending.push(id);
  }
  return out;
}

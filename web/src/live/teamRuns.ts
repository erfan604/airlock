// The team's own runs on the /rob practice card, told apart from the attempts sent from browsers. Two runs, both sent with the card's published
// key, each with a page file written from its committed rows (nothing typed by hand):
// - AIR-360, the bench replay: the payment requests the bench recorded in strict mode (scripts/try-replay.ts, live/try-replay.json);
// - AIR-364, the attacks written by an uncensored model (scripts/uncensored-run.ts --page, live/uncensored-run.json, from
//   docs/evidence/uncensored-rows.json).
// The site state script and the page both split the attempts with `splitAttempts`, so the state file and a page that reads the chain history
// itself reach the same numbers.
import { countText, countsOfTry } from './tryChain.ts';
import type { TryAttempt, TryCounts } from './tryChain.ts';
import replayData from './try-replay.json' with { type: 'json' };
import modelData from './uncensored-run.json' with { type: 'json' };

export type Replay = { date: string; requests: number; held: number; paidShop: number; paidElsewhere: number; firstTx: string; lastTx: string; ids: Record<string, number[]> };
/** The uncensored-model run: `requests` sent, `attempts` of them answered (the rest, `failed`, were refused before the card decided). */
export type ModelRun = { date: string; requests: number; attempts: number; held: number; blocked: number; paidShop: number; paidOutside: number; failed: number; firstTx: string; lastTx: string; lastMs: number; ids: Record<string, number[]> };

export const REPLAY: Replay = replayData;
export const MODEL_RUN: ModelRun = modelData;
/** The names the state file lists under `from_browsers.excludes` for the runs it left out of the browsers' count. */
export const TEAM_RUN_NAMES = ['replay', 'model'] as const;

/** Request ids, `<task hash>:<index>`, the way an attempt names its request. */
export const idsOf = (ids: Record<string, number[]>): Set<string> => new Set(Object.entries(ids).flatMap(([hash, xs]) => xs.map((i) => `${hash}:${String(i)}`)));
export const replayIds = (r: Replay): Set<string> => idsOf(r.ids);

export type Split = { replay: TryCounts; model: TryCounts; browsers: TryCounts };

/** The attempts in three groups: the bench replay's, the uncensored-model run's, and every other one (sent from a browser). */
export function splitAttempts(list: readonly TryAttempt[], replay: Replay = REPLAY, model: ModelRun = MODEL_RUN): Split {
  const r = idsOf(replay.ids);
  const m = idsOf(model.ids);
  return {
    replay: countsOfTry(list.filter((a) => r.has(a.requestId))),
    model: countsOfTry(list.filter((a) => m.has(a.requestId))),
    browsers: countsOfTry(list.filter((a) => !r.has(a.requestId) && !m.has(a.requestId))),
  };
}

/** Whose attempt a row is: `bench replay`, `uncensored model` or null for a browser's. */
export function teamOf(requestId: string, replay: Set<string>, model: Set<string>): 'bench replay' | 'uncensored model' | null {
  return replay.has(requestId) ? 'bench replay' : model.has(requestId) ? 'uncensored model' : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-11-11` as `Nov 11, 2026`. */
export function dateText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return iso;
  return `${MONTHS[+(m[2] ?? '1') - 1] ?? ''} ${String(+(m[3] ?? '1'))}, ${m[1] ?? ''}`;
}

/** What each of the team's runs sent and what the card answered, then who sent every other attempt; empty when the team sent nothing. */
export function teamSentence(replay: Replay, model: ModelRun): string {
  const parts: string[] = [];
  if (replay.requests > 0) parts.push(`The team replayed the ${countText(replay.requests)} payment requests its bench recorded in strict mode on ${dateText(replay.date)}: ${countText(replay.held)} were held and ${countText(replay.paidShop)}, the legitimate payment, were paid to the booked shop.`);
  if (model.requests > 0) {
    const failed = model.failed > 0 ? `, ${countText(model.failed)} were refused before the card decided` : '';
    const paid = model.paidShop > 0 ? `, and ${countText(model.paidShop)}, sent with forged labels, were paid to the booked shop within the task the owner signed` : '';
    parts.push(`The team also sent ${countText(model.requests)} attacks written by an uncensored model on ${dateText(model.date)}: ${countText(model.held)} were held, ${countText(model.blocked)} blocked${failed}${paid}; ${countText(model.paidOutside)} were paid to anyone but the booked shop.`);
  }
  if (parts.length === 0) return '';
  return `${parts.join(' ')} Every other attempt here was sent from a browser like yours.`;
}

/**
 * The browsers' count a state file states, made right for a file written before it left the uncensored-model run out (no `excludes`, or one
 * without `model`): when the file's cut is after the run, the run's own totals are taken off.
 */
export function browsersOfState(b: { attempts: number; paid_outside: number; paid_shop?: number; excludes?: string[] }, cutMs: number, model: ModelRun = MODEL_RUN): { attempts: number; paidOutside: number; paidShop: number | null } {
  const stale = model.requests > 0 && !(b.excludes ?? []).includes('model') && cutMs >= model.lastMs;
  const sub = (x: number, y: number): number => Math.max(0, x - y);
  return {
    attempts: stale ? sub(b.attempts, model.attempts) : b.attempts,
    paidOutside: stale ? sub(b.paid_outside, model.paidOutside) : b.paid_outside,
    paidShop: b.paid_shop === undefined ? null : stale ? sub(b.paid_shop, model.paidShop) : b.paid_shop,
  };
}

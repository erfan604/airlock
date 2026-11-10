// The Credit Passport the pool contract keeps for each borrower (`get_passport`) and the pool's own base (`get_pool_passport`). Nothing is computed on the page:
// the score, the cap and the reasons are the contract's own answer. Both parsers return null on anything malformed, and a card without a passport is left out.
import { rpcView } from '../chain/rpc.ts';

export type PassportRecord = { linesOpened: number; repaidOnTime: number; repaidLate: number; defaults: number };
export type CardPassport = { borrower: string; score: number; limitCap: string; reasons: string[]; record: PassportRecord };
export type PoolPassport = { floorBase: string };
export type PassportRow = { card: string; passport: CardPassport };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DECIMAL = /^(0|[1-9][0-9]{0,38})$/;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** One `get_passport` answer, or null for null or anything malformed: a score that is not an integer 0 to 1000, a limit_cap that is not a decimal string, reasons that are not at most 200 characters each, a count that is not a non-negative integer. */
export function parsePassport(raw: unknown): CardPassport | null {
  if (!isObj(raw)) return null;
  const { borrower, score, limit_cap: cap, reasons, record } = raw;
  if (typeof borrower !== 'string' || borrower === '' || borrower.length > 64) return null;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 1000) return null;
  if (typeof cap !== 'string' || !DECIMAL.test(cap)) return null;
  if (!Array.isArray(reasons) || reasons.length > 32 || !reasons.every((r) => typeof r === 'string' && r.length <= 200)) return null;
  if (!isObj(record)) return null;
  const { lines_opened: linesOpened, repaid_on_time: repaidOnTime, repaid_late: repaidLate, defaults } = record;
  if (!count(linesOpened) || !count(repaidOnTime) || !count(repaidLate) || !count(defaults)) return null;
  return { borrower, score, limitCap: cap, reasons: reasons as string[], record: { linesOpened, repaidOnTime, repaidLate, defaults } };
}

/** The `get_pool_passport` answer, or null for anything malformed: only `floor_base`, a decimal string, is used. */
export function parsePoolPassport(raw: unknown): PoolPassport | null {
  if (!isObj(raw)) return null;
  const floor = raw['floor_base'];
  return typeof floor === 'string' && DECIMAL.test(floor) ? { floorBase: floor } : null;
}

type Cfg = { pool: string; rpcUrls: readonly string[]; fetch?: typeof fetch };
const viewOf = (cfg: Cfg) => rpcView({ contractId: cfg.pool, rpcUrls: cfg.rpcUrls, ...(cfg.fetch === undefined ? {} : { fetch: cfg.fetch }) });

/** `get_passport` for every card (at most 12); a card whose read fails or answers null or something malformed is left out. Order of `cards` kept. */
export async function readPassports(cfg: Cfg, cards: readonly string[]): Promise<PassportRow[]> {
  if (cards.length === 0) return [];
  const view = viewOf(cfg);
  const rows = await Promise.all(cards.slice(0, 12).map((card) => view('get_passport', { card }).then((raw) => ({ card, passport: parsePassport(raw) }), () => ({ card, passport: null }))));
  return rows.filter((r): r is PassportRow => r.passport !== null);
}

/** `get_pool_passport` once; null when the read fails or the answer is malformed (an old pool has no such view). */
export async function readPoolPassport(cfg: Cfg): Promise<PoolPassport | null> {
  try {
    return parsePoolPassport(await viewOf(cfg)('get_pool_passport', {}));
  } catch {
    return null;
  }
}

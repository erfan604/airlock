// AIR-222: the raw source, requests that bypass the interpreter (a lying runtime). Payees are the 20 attacker keys and the book keys,
// every label mask is trusted by construction (recipient Owner, Book, Policy or Owner plus Book; amount adds Oracle; pc Owner), and the
// amounts sit on and around every limit of the world. The requests come in sessions of `perSession`, each spread over three UTC days in
// order of day. The stream is mulberry32 with the seed the caller gives (220), so A1 and A2 face the same requests.
import type { ActionRequest } from '@airlock/runtime/dsl';
import { between, mulberry32, pick } from './rng.ts';
import { ACCOUNTANT, BOOK_KEYS, DAYS, LANDLORD, NEAR, NONBOOK_KEYS, TASK_BOUNDS, rawRequest } from './world.ts';

export interface RawItem {
  request: ActionRequest;
  /** 0 to 2: `now_ms` is BENCH_T0_MS plus this many days */
  day: number;
  session: number;
}

// the limits of the world the amounts are built around: hard cap, asset daily cap, both payee limits, the untrusted budget, both task bounds
const LIMITS: readonly bigint[] = [100n * NEAR, 1000n * NEAR, 50n * NEAR, 100n * NEAR, 10n * NEAR, TASK_BOUNDS[ACCOUNTANT] ?? 0n, TASK_BOUNDS[LANDLORD] ?? 0n];
const EDGES: readonly bigint[] = [1n, ...LIMITS.flatMap((l) => [l - 1n, l, l + 1n])];

const RECIPIENT_SETS: readonly (readonly string[])[] = [['Owner'], ['Book'], ['Policy'], ['Owner', 'Book']];
const AMOUNT_SETS: readonly (readonly string[])[] = [...RECIPIENT_SETS, ['Oracle'], ['Owner', 'Oracle']];

function amountOf(rng: () => number): bigint {
  if (between(rng, 0, 9) < 7) return pick(rng, EDGES);
  // uniform: whole NEAR from 1 to 120 plus a fraction of a micro-NEAR step
  const whole = BigInt(between(rng, 1, 120));
  const frac = BigInt(between(rng, 0, 999_999));
  return whole * NEAR + frac * 10n ** 18n;
}

export function rawRequests(seed: number, count: number, perSession = 50): RawItem[] {
  const rng = mulberry32(seed);
  const out: RawItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const session = Math.floor(i / perSession);
    const at = i - session * perSession;
    const size = Math.min(perSession, count - session * perSession);
    const day = Math.floor((at * DAYS) / size);
    const payee = between(rng, 0, 9) < 6 ? pick(rng, NONBOOK_KEYS) : pick(rng, BOOK_KEYS);
    const request = rawRequest(payee, amountOf(rng), pick(rng, RECIPIENT_SETS), pick(rng, AMOUNT_SETS), at);
    out.push({ request, day, session });
  }
  return out;
}

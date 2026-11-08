// AIR-329: the choreography of the /credit scene as plain functions with no three.js in them, so a test can run it under Node. An event becomes
// flights (a flight is one particle with a path and a lifetime); `stepFlight` says where a flight is at a time. Every flight carries the id of the
// event that made it, and a fixture event's flights are marked, so no particle exists without an event behind it.
import { CHAINS, homeChain } from '../model.ts';
import type { Chain, CreditEvent } from '../model.ts';
import { rng } from '../fixture.ts';

export type V3 = readonly [number, number, number];

export const CORE_RADIUS = 1.7;
export const WORLD_RADIUS = 8.2;
const WORLD_ANGLE: Record<Chain, number> = { near: 0.55, base: 2.65, solana: 4.75 };
const WORLD_LIFT: Record<Chain, number> = { near: 0.9, base: -0.7, solana: 0.3 };

/** Where a chain world sits. The three worlds are 120 degrees apart around the vault, a little above and below its plane. */
export function worldPos(chain: Chain): V3 {
  const a = WORLD_ANGLE[chain];
  return [Math.cos(a) * WORLD_RADIUS, WORLD_LIFT[chain], Math.sin(a) * WORLD_RADIUS];
}

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The airlock ring of a chain: out from its world, away from the vault. Payments pass through it on the way to a merchant. */
export function ringPos(chain: Chain): V3 {
  return add(worldPos(chain), unit(worldPos(chain)), 2.6);
}

/** The ring's outward axis, which the ring faces. */
export const ringAxis = (chain: Chain): V3 => unit(worldPos(chain));

export const CARD_ORBIT = 1.55;

/** A card's position at time `t` seconds: it orbits its world on a tilted circle, its slot spread by its index among the cards of that chain. */
export function cardPos(chain: Chain, slot: number, slots: number, t: number): V3 {
  const w = worldPos(chain);
  const phase = (slot / Math.max(1, slots)) * Math.PI * 2 + t * 0.32;
  const tilt = 0.5 + slot * 0.23;
  const x = Math.cos(phase) * CARD_ORBIT;
  const z = Math.sin(phase) * CARD_ORBIT;
  return [w[0] + x, w[1] + z * Math.sin(tilt), w[2] + z * Math.cos(tilt)];
}

/** A merchant: a fixed point beyond a ring, picked from the event id so the same payment always lands at the same place. */
export function merchantPos(chain: Chain, seed: number): V3 {
  const r = rng(seed);
  const out = ringAxis(chain);
  const side: V3 = unit([-out[2], 0, out[0]]);
  return add(add(add(ringPos(chain), out, 2.4 + r() * 2.2), side, (r() - 0.5) * 4.2), [0, 1, 0], (r() - 0.5) * 3.2);
}

export type FlightKind = 'pass' | 'held' | 'refuse' | 'shard' | 'repay' | 'fund' | 'sweep' | 'deposit' | 'withdraw' | 'default';

export type Flight = {
  key: string;
  eventId: string;
  fixture: boolean;
  kind: FlightKind;
  /** the chain whose ring a payment crosses; null for flows that touch no ring */
  chain: Chain | null;
  t0: number;
  dur: number;
  /** control points of the path, first to last */
  path: readonly V3[];
  /** the fraction of the path where the ring sits, for pass, held and refuse */
  ringAt: number;
  color: number;
  size: number;
  /** held flights hang until `settledAt` (seconds) or `t0 + HELD_TIMEOUT` */
  settledAt: number | null;
  /** shards fly on a velocity instead of a path */
  vel: V3 | null;
  requestId: string | null;
};

export const COLOR = {
  clear: 0x00ec97,
  held: 0xff9a3d,
  refused: 0xff4466,
  fee: 0xe8c26a,
  bone: 0xefe6d2,
  xray: 0x62d6ff,
  purple: 0x9797ff,
} as const;

export const CHAIN_COLOR: Record<Chain, number> = { near: COLOR.clear, base: COLOR.xray, solana: COLOR.purple };

export const HELD_TIMEOUT = 16;

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** The chains that cards sit on, in order, and the slot of each card among its chain's cards. */
export type Roster = ReadonlyMap<string, { chain: Chain; slot: number; slots: number }>;

export function rosterOf(cards: readonly string[], paidOn: ReadonlyMap<string, Chain>): Roster {
  const byChain = new Map<Chain, string[]>();
  for (const c of cards) {
    const ch = paidOn.get(c) ?? homeChain(c);
    byChain.set(ch, [...(byChain.get(ch) ?? []), c]);
  }
  const out = new Map<string, { chain: Chain; slot: number; slots: number }>();
  for (const ch of CHAINS) {
    const list = byChain.get(ch) ?? [];
    list.forEach((c, slot) => out.set(c, { chain: ch, slot, slots: list.length }));
  }
  return out;
}

const base = (e: CreditEvent, now: number): Pick<Flight, 'eventId' | 'fixture' | 'requestId' | 't0'> => ({ eventId: e.id, fixture: e.fixture, requestId: e.requestId, t0: now });

/**
 * The flights of an event. `where` gives a card's current place (from the roster and the clock). Deposits arrive from the dark into the vault, a
 * line opening feeds a card, a payment goes card to ring to merchant (green through, amber held at the ring, red shattering on it), a repayment
 * and a sweep flow back to the vault, a default breaks the card.
 */
export function flightsOf(e: CreditEvent, now: number, where: (card: string) => { chain: Chain; pos: V3 } | null): Flight[] {
  const seed = hash(e.id);
  const b = base(e, now);
  const mk = (kind: FlightKind, over: Partial<Flight> & Pick<Flight, 'path' | 'dur' | 'color'>): Flight => ({
    key: `${e.id}/${kind}`,
    kind,
    chain: e.chain ?? null,
    ringAt: 0,
    size: 1,
    settledAt: null,
    vel: null,
    ...b,
    ...over,
  });
  const core: V3 = [0, 0, 0];
  if (e.kind === 'deposit' || e.kind === 'withdraw') {
    const r = rng(seed);
    const a = r() * Math.PI * 2;
    const far: V3 = [Math.cos(a) * 15, (r() - 0.5) * 9, Math.sin(a) * 15];
    const bend: V3 = [far[0] * 0.45 - far[2] * 0.3, far[1] * 0.5 + 3, far[2] * 0.45 + far[0] * 0.3];
    const stream: Flight[] = [];
    for (let i = 0; i < 6; i += 1) {
      const lag = i * 0.16;
      const jitter: V3 = [(r() - 0.5) * 0.8, (r() - 0.5) * 0.8, (r() - 0.5) * 0.8];
      const path: V3[] = e.kind === 'deposit' ? [add(far, jitter), add(bend, jitter), core] : [core, add(bend, jitter), add(far, jitter)];
      stream.push(mk(e.kind, { key: `${e.id}/${e.kind}/${String(i)}`, t0: now + lag, dur: 2.4, path, color: COLOR.bone, size: i === 0 ? 1.5 : 1 }));
    }
    return stream;
  }
  const here = where(e.who);
  if (here === null) return [];
  const chain = e.chain ?? here.chain;
  const ring = ringPos(chain);
  const merchant = merchantPos(chain, seed);
  switch (e.kind) {
    case 'card_paid':
      return [mk('pass', { chain, dur: 3.4, path: [here.pos, ring, merchant], ringAt: 0.5, color: COLOR.clear, size: 1.5 })];
    case 'card_held':
      return [mk('held', { chain, dur: 3.4, path: [here.pos, ring, merchant], ringAt: 0.5, color: COLOR.held, size: 1.7 })];
    case 'card_refused':
      return [mk('refuse', { chain, dur: 1.7, path: [here.pos, ring], ringAt: 1, color: COLOR.refused, size: 1.7 })];
    case 'line_opened':
      return [mk('fund', { dur: 2.6, path: [core, lerp(core, here.pos, 0.5), here.pos], color: COLOR.clear, size: 1.8 })];
    case 'repaid': {
      const spark = mk('repay', { key: `${e.id}/fee`, dur: 2.9, t0: now + 0.5, path: [here.pos, [here.pos[0] * 0.5, here.pos[1] * 0.5 + 1.4, here.pos[2] * 0.5], core], color: COLOR.fee, size: 2.1 });
      return [mk('repay', { dur: 2.9, path: [here.pos, [here.pos[0] * 0.5, here.pos[1] * 0.5 + 0.6, here.pos[2] * 0.5], core], color: COLOR.bone, size: 1.4 }), spark];
    }
    case 'swept':
      return [mk('sweep', { dur: 2.5, path: [here.pos, lerp(here.pos, core, 0.55), core], color: COLOR.xray, size: 1.5 })];
    case 'defaulted':
      return [mk('default', { dur: 1.6, path: [here.pos, here.pos], ringAt: 1, color: COLOR.refused, size: 2.2 })];
  }
}

/** The shards of a flight that hit a ring and broke: `n` points thrown out from where it broke. */
export function shatter(f: Flight, at: V3, now: number, n = 16): Flight[] {
  const r = rng(hash(f.key));
  const out: Flight[] = [];
  for (let i = 0; i < n; i += 1) {
    const th = r() * Math.PI * 2;
    const ph = Math.acos(2 * r() - 1);
    const sp = 1.4 + r() * 2.8;
    out.push({
      ...f,
      key: `${f.key}/s${String(i)}`,
      kind: 'shard',
      t0: now,
      dur: 1.1 + r() * 0.7,
      path: [at],
      ringAt: 0,
      size: 0.7 + r() * 0.6,
      color: COLOR.refused,
      vel: [Math.sin(ph) * Math.cos(th) * sp, Math.sin(ph) * Math.sin(th) * sp, Math.cos(ph) * sp],
      settledAt: null,
    });
  }
  return out;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

/** A point along a polyline of control points by arc fraction, smoothed through a Catmull-Rom-like blend of the segments. */
export function along(path: readonly V3[], u: number): V3 {
  const first = path[0];
  if (first === undefined) return [0, 0, 0];
  if (path.length === 1) return first;
  const segs = path.length - 1;
  const x = clamp01(u) * segs;
  const i = Math.min(segs - 1, Math.floor(x));
  const a = path[i] ?? first;
  const bb = path[i + 1] ?? a;
  const local = x - i;
  // a quadratic bend through the middle point of three: the particle curves instead of turning on a corner
  if (path.length === 3) {
    const [p0, p1, p2] = path as [V3, V3, V3];
    // the control point is chosen so the curve passes through the middle point at u = 0.5
    const c: V3 = [2 * p1[0] - (p0[0] + p2[0]) / 2, 2 * p1[1] - (p0[1] + p2[1]) / 2, 2 * p1[2] - (p0[2] + p2[2]) / 2];
    const t = clamp01(u);
    return lerp(lerp(p0, c, t), lerp(c, p2, t), t);
  }
  return lerp(a, bb, smooth(local));
}

export type Step = { pos: V3; alpha: number; size: number; done: boolean; hitRing: boolean; broke: boolean };

const GONE: Step = { pos: [0, 0, 0], alpha: 0, size: 0, done: true, hitRing: false, broke: false };

/** Where a flight is at `now` (seconds). `hitRing` is true on the one step that crosses the ring, `broke` on the step a refused flight shatters. */
export function stepFlight(f: Flight, now: number, prev: number): Step {
  const age = now - f.t0;
  if (age < 0) return { ...GONE, done: false };
  if (f.kind === 'shard') {
    const v = f.vel ?? [0, 0, 0];
    const p0 = f.path[0] ?? [0, 0, 0];
    const t = age;
    const drag = 1 - Math.exp(-2.2 * t);
    const pos: V3 = [p0[0] + (v[0] * drag) / 2.2, p0[1] + (v[1] * drag) / 2.2 - 0.25 * t * t, p0[2] + (v[2] * drag) / 2.2];
    const life = clamp01(age / f.dur);
    return { pos, alpha: 1 - life * life, size: f.size * (1 - life * 0.5), done: age >= f.dur, hitRing: false, broke: false };
  }
  if (f.kind === 'held') {
    const reach = f.dur * f.ringAt;
    const end = f.settledAt ?? f.t0 + HELD_TIMEOUT;
    const ring = f.path[1] ?? [0, 0, 0];
    if (age < reach) {
      return { pos: along(f.path, smooth(age / reach) * f.ringAt), alpha: 1, size: f.size, done: false, hitRing: prev - f.t0 < reach && age >= reach, broke: false };
    }
    if (f.settledAt === null && now < end) {
      // hanging: a slow breath on the ring
      const pulse = 0.75 + 0.25 * Math.sin((now - f.t0) * 5);
      return { pos: ring, alpha: 1, size: f.size * (1.15 + 0.35 * pulse), done: false, hitRing: false, broke: false };
    }
    if (f.settledAt === null) {
      // timed out unsettled: the particle fades where it hangs
      const fade = clamp01((now - end) / 0.8);
      return { pos: ring, alpha: 1 - fade, size: f.size, done: fade >= 1, hitRing: false, broke: false };
    }
    const rest = clamp01((now - f.settledAt) / (f.dur * (1 - f.ringAt)));
    return { pos: along(f.path, f.ringAt + smooth(rest) * (1 - f.ringAt)), alpha: 1 - smooth(rest) * 0.8, size: f.size, done: rest >= 1, hitRing: false, broke: false };
  }
  const u = clamp01(age / f.dur);
  if (f.kind === 'refuse') {
    // it travels to the ring and breaks there on the one step that reaches it; the shards (shatter) carry on from there
    const reached = u >= 1;
    const first = reached && prev - f.t0 < f.dur;
    return { pos: along(f.path, smooth(u)), alpha: reached ? 0 : 1, size: f.size, done: reached, hitRing: first, broke: first };
  }
  if (u >= 1 && f.kind !== 'default') return { ...GONE, hitRing: false };
  if (f.kind === 'default') {
    const flick = age < f.dur ? (Math.sin(age * 38) > 0 ? 1 : 0.15) : 0;
    return { pos: f.path[0] ?? [0, 0, 0], alpha: flick, size: f.size * (1 + age), done: age >= f.dur, hitRing: false, broke: u >= 1 && prev - f.t0 < f.dur };
  }
  const e = f.kind === 'pass' ? smooth(u) * 0.6 + u * 0.4 : smooth(u);
  const crosses = f.kind === 'pass' && prev - f.t0 < f.dur * f.ringAt && age >= f.dur * f.ringAt;
  const fadeTail = f.kind === 'pass' ? 1 - smooth(clamp01((u - 0.75) / 0.25)) * 0.9 : 1 - smooth(clamp01((u - 0.85) / 0.15));
  return { pos: along(f.path, e), alpha: fadeTail, size: f.size, done: false, hitRing: crosses, broke: false };
}

/** Settles held flights: a paid or refused event naming a held request frees that flight, so it passes or it breaks. */
export function settle(flights: Flight[], e: CreditEvent, now: number): void {
  if (e.requestId === null || (e.kind !== 'card_paid' && e.kind !== 'card_refused')) return;
  for (const f of flights) if (f.kind === 'held' && f.requestId === e.requestId && f.settledAt === null) f.settledAt = now;
}

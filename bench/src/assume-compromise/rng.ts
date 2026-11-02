// AIR-222: the seeded generator of the assume-compromise runs. mulberry32, written from its published definition (a 32-bit state, one
// addition per step and two multiplications); nothing in this directory reads a clock or an unseeded source.
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer from `lo` to `hi` inclusive. */
export function between(rng: Rng, lo: number, hi: number): number {
  const span = hi - lo + 1;
  const r = rng() * span;
  return lo + Math.floor(r);
}

export function pick<T>(rng: Rng, list: readonly T[]): T {
  const item = list[between(rng, 0, list.length - 1)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

// The 95 percent Wilson score interval of a proportion (AIR-223, F12 3.1). The interval is clamped to 0 and 1: unclamped, wilson(0, 10).lo
// is -2.8e-17 and would print as -0.0.

/** `p = k/n` with its Wilson interval. `n = 0` gives p 0 and the whole range; a `k` outside 0 to `n`, or not an integer, throws RangeError. */
export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`wilson: n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new RangeError(`wilson: k must be an integer from 0 to ${n}, got ${k}`);
  if (n === 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

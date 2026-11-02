// Text of a Row, shared by the report and the fixture script (AIR-223): `3/10 (30.0%, 10.8 to 60.3)`.
import type { Row } from './metrics.ts';

const pct = (x: number): string => (x * 100).toFixed(1);

/** `<k>/<n> (<p>%, <lo> to <hi>)`; `n = 0` prints `0/0 (n/a)`, `null` prints `n/a`. */
export function cell(r: Row | null): string {
  if (r === null) return 'n/a';
  if (r.n === 0) return '0/0 (n/a)';
  return `${r.k}/${r.n} (${pct(r.p)}%, ${pct(r.lo)} to ${pct(r.hi)})`;
}

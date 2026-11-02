// The generated block of docs/BENCH.md (AIR-220). AIR-223 fills the body; the generator is the only writer of what lies between the markers.
import { readFileSync, writeFileSync } from 'node:fs';
import type { ResultsFile } from '../runner/record.ts';

export const BEGIN_MARKER = '<!-- BEGIN GENERATED -->';
export const END_MARKER = '<!-- END GENERATED -->';

/** The two marker lines around the body; the body is `no results yet` until AIR-223. */
export function renderBlock(_results: ResultsFile): string {
  return [BEGIN_MARKER, 'no results yet', END_MARKER].join('\n');
}

export class MarkerError extends Error {
  constructor(detail: string) {
    super(`MarkerError: ${detail}`);
    this.name = 'MarkerError';
  }
}

/** Rewrites only the lines from the begin marker to the end marker. Throws when a marker is missing or duplicated. */
export function replace(file: string, block: string): void {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const begins = lines.flatMap((l, i) => (l === BEGIN_MARKER ? [i] : []));
  const ends = lines.flatMap((l, i) => (l === END_MARKER ? [i] : []));
  const first = begins[0];
  const last = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || first === undefined || last === undefined) throw new MarkerError('the file needs exactly one begin and one end marker line');
  if (last < first) throw new MarkerError('the end marker comes before the begin marker');
  const next = [...lines.slice(0, first), ...block.split('\n'), ...lines.slice(last + 1)].join('\n');
  if (next !== text) writeFileSync(file, next, 'utf8');
}

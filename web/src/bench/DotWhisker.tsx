// AIR-192: a dot and a whisker on a fixed 0 to 100 scale, hand drawn SVG. `p`, `lo` and `hi` are fractions that arrive from bench.json; they
// are only multiplied by 100 into a percentage of the track. End caps on the interval, a 14 px marker, the cell text as the label.
import { PRERENDER } from '../static.ts';
import type { Kind, Row } from './types.ts';

const MARK = 14;
const H = 22;
const MID = H / 2;

export function DotWhisker({ row, kind, label }: { row: Row; kind: Kind; label: string }) {
  // AIR-311: the prerendered Bench page carries the numbers as text and leaves the 1,500 marks to the browser (the page renders fresh over it)
  if (PRERENDER) return null;
  const empty = row.n === 0;
  const fill = kind === 'attack' ? 'url(#bench-stripe)' : kind === 'intent' ? 'var(--clear)' : kind === 'tap' ? 'var(--paper)' : 'var(--ink-2)';
  const stroke = kind === 'tap' ? 'var(--clear)' : kind === 'attack' ? 'var(--signal)' : 'none';
  return (
    <span className="dw" role="img" aria-label={label} data-testid="dot-whisker" data-kind={kind}>
      <svg className="dw-svg" width="100%" height={H} aria-hidden="true" focusable="false">
        <line className="dw-track" x1="0%" x2="100%" y1={MID} y2={MID} />
        {[0, 50, 100].map((t) => (
          <line key={t} className="dw-tick" x1={`${t}%`} x2={`${t}%`} y1={MID - 4} y2={MID + 4} />
        ))}
        {empty ? null : (
          <>
            <line className="dw-whisker" x1={`${row.lo * 100}%`} x2={`${row.hi * 100}%`} y1={MID} y2={MID} />
            <line className="dw-cap" x1={`${row.lo * 100}%`} x2={`${row.lo * 100}%`} y1={MID - 6} y2={MID + 6} />
            <line className="dw-cap" x1={`${row.hi * 100}%`} x2={`${row.hi * 100}%`} y1={MID - 6} y2={MID + 6} />
            <svg x={`${row.p * 100}%`} y={MID} overflow="visible">
              <rect className="dw-mark" x={-MARK / 2} y={-MARK / 2} width={MARK} height={MARK} rx="2" fill={fill} stroke={stroke} strokeWidth="2" />
            </svg>
          </>
        )}
      </svg>
    </span>
  );
}

/** The one pattern the attack markers refer to (stripes mean outside, DESIGN rule 1); render it once per page. */
export function StripeDefs() {
  return (
    <svg className="dw-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="bench-stripe" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="6" height="6" fill="var(--paper)" />
          <rect width="3" height="6" fill="var(--signal)" />
        </pattern>
      </defs>
    </svg>
  );
}

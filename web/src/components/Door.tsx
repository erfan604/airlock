// Door (DESIGN.md 3.4): the contract verdict drawn as a door in a frame, two jambs and a lintel with one leaf. Inline SVG, one
// sprite with a <symbol> per state (<DoorSprite /> is mounted once by the app root), referenced by <use>. Colours come from
// CSS classes on the shapes, which read the token custom properties; there is no inline style and no icon library. The doors
// are drawn in ink only (shape carries the state; the verdict word beside a door carries the colour).
import { VERDICT_STATES } from './verdict.ts';
import type { VerdictState } from './verdict.ts';

export const DOOR_STATES = VERDICT_STATES;
export type DoorSize = 24 | 48 | 112;

const LABELS: Record<VerdictState, string> = {
  allowed: 'Door open, allowed',
  held: 'Door taped shut, held for you',
  blocked: 'Door barred, blocked',
  approved: 'Door half open, approved by you',
  rejected: 'Door closed, rejected by you',
  waiting: 'Door outline, waiting',
  expired: 'Door outline, expired',
  stopped: 'Door closed in a dashed frame, stopped',
};

/** The jambs and the lintel, the same on every door. The opening is x 10 to 38, y 8 to 44. */
function Frame() {
  return (
    <>
      <rect className="door-fill-ink" x="6" y="4" width="36" height="4" />
      <rect className="door-fill-ink" x="6" y="4" width="4" height="40" />
      <rect className="door-fill-ink" x="38" y="4" width="4" height="40" />
    </>
  );
}

const DASH = '4 3';

function Symbols() {
  return (
    <>
      <symbol id="door-allowed" viewBox="0 0 48 48">
        <Frame />
        {/* leaf slid up: a gap you can see through */}
        <rect className="door-fill-ink" x="9.5" y="7.5" width="29" height="13.5" />
      </symbol>
      <symbol id="door-held" viewBox="0 0 48 48">
        <Frame />
        <rect className="door-fill-ink" x="9.5" y="7.5" width="29" height="36.5" />
        <rect fill="url(#door-tape)" className="door-stroke-paper" x="10" y="22" width="28" height="10" strokeWidth="2" />
      </symbol>
      <symbol id="door-blocked" viewBox="0 0 48 48">
        <Frame />
        <rect className="door-fill-ink" x="9.5" y="7.5" width="29" height="36.5" />
        <path className="door-stroke-paper" d="M15 14 L33 38 M33 14 L15 38" strokeWidth="3" fill="none" />
      </symbol>
      <symbol id="door-approved" viewBox="0 0 48 48">
        <Frame />
        {/* leaf half open, hollow */}
        <rect className="door-stroke-ink door-fill-none" x="11" y="9" width="26" height="17" strokeWidth="2.5" />
      </symbol>
      <symbol id="door-rejected" viewBox="0 0 48 48">
        <Frame />
        <rect className="door-stroke-ink door-fill-none" x="11" y="9" width="26" height="34" strokeWidth="2.5" />
      </symbol>
      <symbol id="door-waiting" viewBox="0 0 48 48">
        <Frame />
        <rect className="door-stroke-ink2 door-fill-none" x="11" y="9" width="26" height="34" strokeWidth="2" strokeDasharray={DASH} />
      </symbol>
      <symbol id="door-expired" viewBox="0 0 48 48">
        <Frame />
        <rect className="door-stroke-ink2 door-fill-none" x="11" y="9" width="26" height="34" strokeWidth="2" strokeDasharray={DASH} />
      </symbol>
      <symbol id="door-stopped" viewBox="0 0 48 48">
        <rect className="door-stroke-ink2 door-fill-none" x="2" y="1" width="44" height="46" strokeWidth="2" strokeDasharray={DASH} />
        <Frame />
        <rect className="door-fill-ink2" x="9.5" y="7.5" width="29" height="36.5" />
      </symbol>
    </>
  );
}

/** Mount once near the root. A sprite of zero size, not display none: some browsers drop pattern fills inside a hidden svg. */
export function DoorSprite() {
  return (
    <svg className="door-sprite" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="door-tape" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect className="door-fill-signal" x="0" y="0" width="4" height="8" />
          <rect className="door-fill-ink" x="4" y="0" width="4" height="8" />
        </pattern>
      </defs>
      <Symbols />
    </svg>
  );
}

export type DoorProps = { state: VerdictState; size?: DoorSize };

export function Door({ state, size = 48 }: DoorProps) {
  return (
    <svg className={`door door-${state}`} data-testid="door" data-state={state} width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={LABELS[state]} focusable="false">
      <use href={`#door-${state}`} />
    </svg>
  );
}

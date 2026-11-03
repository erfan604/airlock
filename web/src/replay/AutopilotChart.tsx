// AIR-300: the seven-day autopilot chart. One stacked bar per simulated day from bench/results/autopilot.json (the committed run of the real
// verdict CLI): paid by itself, blocked by itself, attacks held for the owner (asked, rejected, never paid) and legitimate asks. The chart is
// an SVG with plain text labels; the colours are the console tokens only.
import autopilot from '../../../bench/results/autopilot.json';

export interface AutopilotDay {
  day: number;
  total: number;
  paid: number;
  blocked: number;
  legit_asked: number;
  attack_asked: number;
  attacks_paid: number;
}

export interface AutopilotRun {
  paid: number;
  blocked: number;
  legit_asked: number;
  attack_asked: number;
  attacks_paid: number;
  days: AutopilotDay[];
}

const SERIES = [
  { key: 'paid', label: 'Paid by itself', cls: 'ap-paid' },
  { key: 'blocked', label: 'Blocked by itself', cls: 'ap-blocked' },
  { key: 'attack_asked', label: 'Attacks held for the owner', cls: 'ap-attack' },
  { key: 'legit_asked', label: 'Legitimate asks', cls: 'ap-legit' },
] as const;

const W = 560;
const H = 220;
const LEFT = 28;
const BOTTOM = 22;
const TOP = 8;

export function AutopilotChart({ run = autopilot as AutopilotRun }: { run?: AutopilotRun }) {
  const days = run.days;
  const max = Math.max(1, ...days.map((d) => d.paid + d.blocked + d.attack_asked + d.legit_asked));
  const plotH = H - TOP - BOTTOM;
  const slot = (W - LEFT) / Math.max(1, days.length);
  const barW = slot * 0.6;
  return (
    <section className="autopilot" data-testid="autopilot" aria-label="Autopilot week">
      <h2 className="replay-title">A simulated week of agent payments</h2>
      <p className="replay-lede">
        {`${String(run.paid)} requests paid by themselves, ${String(run.blocked)} blocked by themselves, ${String(run.legit_asked)} legitimate asks and ${String(run.attack_asked)} attacks held for the owner. Attacks paid: ${String(run.attacks_paid)}.`}
      </p>
      <svg className="autopilot-svg" viewBox={`0 0 ${String(W)} ${String(H)}`} role="img" aria-label="Requests per day by outcome" data-testid="autopilot-chart">
        <line className="ap-axis" x1={LEFT} y1={H - BOTTOM} x2={W} y2={H - BOTTOM} />
        <text className="ap-tick" x={LEFT - 6} y={TOP + 8} textAnchor="end">{String(max)}</text>
        <text className="ap-tick" x={LEFT - 6} y={H - BOTTOM} textAnchor="end">0</text>
        {days.map((d, i) => {
          const x = LEFT + i * slot + (slot - barW) / 2;
          let y = H - BOTTOM;
          return (
            <g key={d.day} data-testid={`autopilot-day-${String(d.day)}`}>
              {SERIES.map((s) => {
                const n = d[s.key];
                const h = (n / max) * plotH;
                y -= h;
                return n === 0 ? null : <rect key={s.key} className={s.cls} x={x} y={y} width={barW} height={h} data-series={s.key} data-count={n} />;
              })}
              <text className="ap-tick" x={x + barW / 2} y={H - 6} textAnchor="middle">{`Day ${String(d.day)}`}</text>
            </g>
          );
        })}
      </svg>
      <ul className="autopilot-legend">
        {SERIES.map((s) => (
          <li key={s.key} className="autopilot-key">
            <span className={`autopilot-swatch ${s.cls}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

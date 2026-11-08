// AIR-329: the still of the credit network: the stage under reduced motion, on a weak device, before the scene chunk arrives and where WebGL is
// missing. Plain SVG from the same data: the vault with its idle liquid, the three chain worlds with their airlock rings, and one card per line on
// its home chain. Nothing in it moves and nothing in it is a payment.
import { CHAINS, bps, homeChain } from './model.ts';
import type { Chain, PoolView } from './model.ts';

const PLACE: Record<Chain, { x: number; y: number; rx: number; ry: number; color: string; name: string }> = {
  near: { x: 930, y: 250, rx: 74, ry: 30, color: 'var(--clear)', name: 'NEAR' },
  base: { x: 250, y: 330, rx: 74, ry: 30, color: 'var(--xray)', name: 'Base' },
  solana: { x: 700, y: 560, rx: 74, ry: 30, color: '#9797FF', name: 'Solana' },
};
const CORE = { x: 600, y: 340, r: 92 };

export function Poster({ pool }: { pool: PoolView | null }) {
  const idle = pool === null ? 0.5 : Math.min(1, Number(bps(pool.idle, pool.assets)) / 10_000);
  const level = CORE.y + CORE.r - idle * CORE.r * 2;
  const cards = pool?.lines.slice(0, 24) ?? [];
  const slot = (chain: Chain, card: string): number => cards.filter((c) => homeChain(c.card) === chain).findIndex((c) => c.card === card);
  return (
    <svg className="cr-poster" viewBox="0 0 1200 720" preserveAspectRatio="xMidYMid slice" role="img" aria-label="The credit network: a vault in the middle, three chain worlds around it, one agent account per credit line" data-testid="credit-poster">
      <defs>
        <clipPath id="cr-vault-clip">
          <circle cx={CORE.x} cy={CORE.y} r={CORE.r - 2} />
        </clipPath>
        <radialGradient id="cr-vault-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--xray)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--xray)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={CORE.x} cy={CORE.y} r={260} fill="url(#cr-vault-glow)" />
      {CHAINS.map((c) => {
        const p = PLACE[c];
        return (
          <g key={c}>
            <line x1={CORE.x} y1={CORE.y} x2={p.x} y2={p.y} stroke={p.color} strokeOpacity="0.25" strokeWidth="1" />
            <ellipse cx={p.x} cy={p.y} rx={p.rx * 1.7} ry={p.ry * 1.7} fill="none" stroke={p.color} strokeOpacity="0.28" />
            <ellipse cx={p.x + (p.x - CORE.x) * 0.2} cy={p.y + (p.y - CORE.y) * 0.2} rx={22} ry={52} fill="none" stroke={p.color} strokeWidth="3" strokeOpacity="0.8" />
            <circle cx={p.x} cy={p.y} r={26} fill="none" stroke={p.color} strokeWidth="1.5" />
            <circle cx={p.x} cy={p.y} r={13} fill={p.color} fillOpacity="0.85" />
            <text x={p.x} y={p.y + 62} textAnchor="middle" className="cr-poster-label">
              {p.name}
            </text>
          </g>
        );
      })}
      {cards.map((l) => {
        const chain = homeChain(l.card);
        const p = PLACE[chain];
        const k = slot(chain, l.card);
        const a = k * 2.1 + 0.6;
        const x = p.x + Math.cos(a) * p.rx * 1.7;
        const y = p.y + Math.sin(a) * p.ry * 1.7;
        return <rect key={l.card} x={x - 14} y={y - 9} width="28" height="18" rx="3" fill="var(--sunk)" stroke="var(--ink)" strokeOpacity="0.8" />;
      })}
      <circle cx={CORE.x} cy={CORE.y} r={CORE.r} fill="var(--sunk)" stroke="var(--ink)" strokeOpacity="0.55" strokeWidth="1.5" />
      <rect x={CORE.x - CORE.r} y={level} width={CORE.r * 2} height={CORE.y + CORE.r - level} fill="var(--xray)" fillOpacity="0.55" clipPath="url(#cr-vault-clip)" />
      <line x1={CORE.x - CORE.r} y1={level} x2={CORE.x + CORE.r} y2={level} stroke="var(--xray)" strokeWidth="2" clipPath="url(#cr-vault-clip)" />
    </svg>
  );
}

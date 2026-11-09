// AIR-329: /credit. The stage (a lazy 3D scene, a still poster under reduced motion or on a weak device, a 2D diagram without WebGL), then the pool
// numbers, deposit and withdraw, the event ticker, the lines table and the Passport cards. Everything on it is read from the pool contract and the
// chain's events, or comes from the page's fixture and says so in a badge that cannot be missed. When the chain cannot be read the page shows no
// numbers at all (AIR-323: never zeros).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { explorerTx } from '../approvals/staticChain.ts';
import { NEAR_RPC } from '../../csp.ts';
import { PRERENDER } from '../static.ts';
import { readLp } from './chain.ts';
import { connectWallet } from '../wallet/connector.ts';
import { DEFAULT_POOL, poolFromSearch, useCredit } from './useCredit.ts';
import type { CreditState } from './useCredit.ts';
import { assetsFor, derive, explorerAccount, shownAccount, formatNear, parseNear, passportOf, percent, refusedSum, shortId, sharesFor } from './model.ts';
import type { CreditEvent, EventKind, Line, PoolView } from './model.ts';
import { depositCall, sendPoolCall, withdrawCall } from './wallet.ts';
import type { SendResult } from './wallet.ts';
import { Poster } from './Poster.tsx';
import type { Quality } from './scene/CreditScene.tsx';

const CreditScene = lazy(() => import('./scene/CreditScene.tsx'));


const WORD: Record<EventKind, string> = {
  deposit: 'Deposit',
  withdraw: 'Withdrawal',
  line_opened: 'Line opened',
  card_paid: 'Paid',
  card_held: 'Held',
  card_refused: 'Refused',
  swept: 'Swept home',
  repaid: 'Repaid',
  defaulted: 'Defaulted',
};
const TONE: Record<EventKind, 'ok' | 'held' | 'bad' | 'plain' | 'fee'> = {
  deposit: 'plain',
  withdraw: 'plain',
  line_opened: 'plain',
  card_paid: 'ok',
  card_held: 'held',
  card_refused: 'bad',
  swept: 'plain',
  repaid: 'fee',
  defaulted: 'bad',
};
/** An account name, never one that contains the owner's name: that one is shown as a neutral label and linked to the explorer. */
function Account({ id, max, what = 'demo account' }: { id: string; max: number; what?: string }) {
  if (!/erfan/i.test(id)) return <>{shortId(id, max)}</>;
  const link = explorerAccount(id);
  if (link === null) return <>{what}</>;
  return (
    <a href={link} target="_blank" rel="noopener noreferrer" aria-label={`View the ${what} on the explorer`}>
      {what}
    </a>
  );
}

const CHAIN_NAME = { near: 'NEAR', base: 'Base', solana: 'Solana' } as const;

export function agoText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'now';
  if (s < 90) return `${String(s)} s ago`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${String(m)} min ago`;
  return `${String(Math.floor(m / 60))} h ago`;
}

/** Whether to run the scene: 'pending' until the browser is asked, then the way to draw the stage. */
export type StageMode = 'pending' | 'scene' | 'poster' | 'diagram';

export function hasWebGl(): boolean {
  try {
    const c = document.createElement('canvas');
    return c.getContext('webgl2') !== null || c.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

/** The stage mode from the browser: reduced motion or a weak device shows the poster (a button plays the scene), no WebGL the diagram. */
export function pickStage(): { mode: StageMode; why: 'reduced' | 'weak' | 'nogl' | null } {
  if (!hasWebGl()) return { mode: 'diagram', why: 'nogl' };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return { mode: 'poster', why: 'reduced' };
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (navigator.hardwareConcurrency <= 2 || (nav.deviceMemory !== undefined && nav.deviceMemory <= 2)) return { mode: 'poster', why: 'weak' };
  return { mode: 'scene', why: null };
}

function Badge({ state }: { state: CreditState }) {
  const link = state.kind === 'live' ? explorerAccount(state.poolId) : null;
  // the pool is named by what it is and linked to the explorer: its account name is data, not part of the design
  const pool = link === null ? 'the pool contract' : (
    <a href={link} target="_blank" rel="noopener noreferrer">
      the pool contract
    </a>
  );
  const [text, source]: [ReactNode, string] =
    state.kind === 'fixture'
      ? ['Fixture data. The pool contract is not deployed yet; nothing here is on a chain.', 'fixture']
      : state.kind === 'live'
        ? [
            state.stale ? (
              <>Live, reading {pool}. The last refresh failed, so this may be out of date.</>
            ) : (
              <>Live, reading {pool}.</>
            ),
            state.stale ? 'stale' : 'live',
          ]
        : state.kind === 'unreadable'
          ? ['The chain could not be read.', 'unreadable']
          : ['Reading the pool.', 'loading'];
  return (
    <p className="cr-badge" data-testid="credit-badge" data-source={source} role="status">
      <span className="cr-badge-dot" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

function Stat({ label, value, note, testId }: { label: string; value: string; note?: string; testId: string }) {
  return (
    <div className="cr-stat" data-testid={testId}>
      <dt className="cr-stat-label">{label}</dt>
      <dd className="cr-stat-value">{value}</dd>
      {note === undefined ? null : <dd className="cr-stat-note">{note}</dd>}
    </div>
  );
}

export function Stats({ pool, events, feed, nowMs }: { pool: PoolView; events: readonly CreditEvent[]; feed: boolean; nowMs: bigint }) {
  const d = derive(pool, nowMs);
  const fees = formatNear(pool.feesEarned);
  const staking = pool.stakingEarned === null ? null : formatNear(pool.stakingEarned);
  return (
    <dl className="cr-stats" data-testid="credit-stats">
      <Stat testId="stat-tvl" label="Total value" value={`${formatNear(pool.assets)} NEAR`} note={`${formatNear(pool.idle)} idle, ${formatNear(pool.staked)} staked, ${formatNear(pool.lent)} lent`} />
      <Stat testId="stat-util" label="Utilization" value={percent(d.utilizationBps)} note="lent out of the pool's assets" />
      <Stat
        testId="stat-return"
        label="Return to LPs"
        value={d.aprBps === null ? `${percent(d.returnBps)} to date` : `${percent(d.aprBps)} a year`}
        note={
          d.feeSplitBps === null
            ? 'no fees or staking yet'
            : `${percent(d.feeSplitBps)} from spend fees (${fees} NEAR), ${percent(10_000n - d.feeSplitBps)} from staking${staking === null ? ' (not reported yet)' : ` (${staking} NEAR)`}`
        }
      />
      <Stat testId="stat-refused" label="Refused at the airlock" value={feed ? `${formatNear(refusedSum(events))} NEAR` : 'not read here'} note={feed ? 'sum of refused payments in the events below' : 'the event feed is read on the hosted site'} />
      <Stat testId="stat-stolen" label="Stolen from LPs" value={`${formatNear(pool.losses)} NEAR`} note="losses the pool records: stolen payments and unrepaid defaults" />
    </dl>
  );
}

type Wallet = { kind: 'off' } | { kind: 'connecting' } | { kind: 'on'; account: string } | { kind: 'error' };

export function MoneyPanel({ state, nowMs }: { state: CreditState; nowMs: bigint }) {
  void nowMs;
  const [side, setSide] = useState<'deposit' | 'withdraw'>('deposit');
  const [text, setText] = useState('');
  const [wallet, setWallet] = useState<Wallet>({ kind: 'off' });
  const [sent, setSent] = useState<{ side: 'deposit' | 'withdraw'; result: SendResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const live = state.kind === 'live' ? state : null;
  // the connected LP's own shares, re-read after a send; a read that fails shows nothing rather than 0
  const [mine, setMine] = useState<string | null>(null);
  const account = wallet.kind === 'on' ? wallet.account : null;
  const poolId = live?.poolId ?? null;
  const sentOk = sent?.result.ok === true;
  useEffect(() => {
    setMine(null);
    if (poolId === null || account === null) return undefined;
    let current = true;
    readLp({ pool: poolId, rpcUrls: NEAR_RPC }, account).then(
      (v) => {
        if (current && mounted.current) setMine(v);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [poolId, account, sentOk]);
  const amount = side === 'deposit' ? parseNear(text) : /^[1-9][0-9]{0,38}$/.test(text.trim()) ? BigInt(text.trim()) : null;
  const preview =
    live === null || amount === null
      ? null
      : side === 'deposit'
        ? `${formatNear(sharesFor(amount, live.pool.shares, live.pool.assets))} shares`
        : `${formatNear(assetsFor(amount, live.pool.shares, live.pool.assets))} NEAR at the current share price`;

  const onConnect = useCallback(() => {
    setWallet({ kind: 'connecting' });
    connectWallet().then(
      (w) => {
        if (mounted.current) setWallet({ kind: 'on', account: w.accountId });
      },
      () => {
        if (mounted.current) setWallet({ kind: 'error' });
      },
    );
  }, []);

  const onSend = useCallback(() => {
    if (live === null || amount === null || amount <= 0n) return;
    const call = side === 'deposit' ? depositCall(live.poolId, amount) : withdrawCall(live.poolId, amount);
    setBusy(true);
    setSent(null);
    void sendPoolCall(call).then((result) => {
      if (!mounted.current) return;
      setBusy(false);
      setSent({ side, result });
    });
  }, [live, amount, side]);

  const closed = live === null;
  const why =
    state.kind === 'fixture'
      ? 'The pool contract is not deployed yet, so deposits are closed. This page shows a fixture until it is.'
      : state.kind === 'unreadable'
        ? 'The pool could not be read, so deposits are closed. Reload to try again.'
        : state.kind === 'loading'
          ? 'Reading the pool.'
          : null;
  const label = busy ? 'Waiting for your wallet' : closed ? (state.kind === 'fixture' ? 'Pool not deployed' : 'Pool not readable') : side === 'deposit' ? 'Deposit' : 'Withdraw';
  // explorerTx keeps only a bare base58 transaction hash of 43 or 44 characters, else null: no anchor is drawn for anything else
  const link = sent?.result.ok === true ? explorerTx(sent.result.tx) : null;
  return (
    <section className="cr-panel" aria-labelledby="cr-money-h" data-testid="credit-money">
      <h2 id="cr-money-h" className="cr-h2">
        Stake and withdraw
      </h2>
      <div className="cr-seg" role="group" aria-label="Deposit or withdraw">
        {(['deposit', 'withdraw'] as const).map((s) => (
          <button key={s} type="button" className="cr-seg-btn" aria-pressed={side === s} onClick={() => { setSide(s); setSent(null); setText(''); }} data-testid={`money-${s}`}>
            {s === 'deposit' ? 'Deposit' : 'Withdraw'}
          </button>
        ))}
      </div>
      <label className="cr-field">
        <span className="cr-field-label">{side === 'deposit' ? 'Amount in NEAR' : 'Pool shares to redeem'}</span>
        <input className="cr-input" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder={side === 'deposit' ? '10' : '1000000000000000000000000'} value={text} onChange={(e) => setText(e.target.value)} disabled={closed} data-testid="money-input" />
      </label>
      <p className="cr-preview" data-testid="money-preview" aria-live="polite">
        {text.trim() !== '' && amount === null ? (side === 'deposit' ? 'Enter a plain amount such as 10 or 2.5.' : 'Enter a whole number of shares.') : (preview ?? '\u00a0')}
      </p>
      {mine === null || live === null ? null : (
        <p className="cr-who" data-testid="lp-shares">
          {`Your shares: ${formatNear(mine)} (about ${formatNear(assetsFor(BigInt(mine), live.pool.shares, live.pool.assets))} NEAR). Withdraw takes shares in the smallest unit.`}
        </p>
      )}
      {why === null ? null : (
        <p className="cr-note" data-testid="money-why">
          {why}
        </p>
      )}
      <div className="cr-actions">
        {live === null ? null : wallet.kind === 'on' ? (
          <p className="cr-who" data-testid="wallet-account">{`Connected as ${shownAccount(wallet.account)}`}</p>
        ) : (
          <button type="button" className="cr-btn cr-btn-ghost" onClick={onConnect} disabled={wallet.kind === 'connecting'} data-testid="wallet-connect" data-state={wallet.kind}>
            {wallet.kind === 'connecting' ? 'Waiting for your wallet' : 'Connect wallet'}
          </button>
        )}
        <button type="button" className="cr-btn cr-btn-main" onClick={onSend} disabled={closed || amount === null || amount <= 0n || busy || wallet.kind !== 'on'} data-testid="money-submit">
          {label}
        </button>
      </div>
      {wallet.kind === 'error' ? (
        <p className="cr-note cr-note-bad" role="alert" data-testid="wallet-error">
          The wallet did not connect. Nothing was signed.
        </p>
      ) : null}
      {sent === null ? null : sent.result.ok ? (
        <p className="cr-note" data-testid="money-done">
          {sent.side === 'deposit' ? 'Deposit sent. ' : 'Withdrawal sent. '}
          {link === null ? null : (
            <a href={link} target="_blank" rel="noopener noreferrer">
              View the transaction on the explorer
            </a>
          )}
        </p>
      ) : (
        <p className="cr-note cr-note-bad" role="alert" data-testid="money-failed">
          {sent.result.reason === 'cancelled' ? 'You closed the wallet. Nothing was signed.' : 'The transaction did not go through. Nothing moved.'}
        </p>
      )}
    </section>
  );
}

export function Ticker({ events, nowMs, live }: { events: readonly CreditEvent[]; nowMs: number; live: CreditState['kind'] }) {
  const rows = events.slice(-14).reverse();
  return (
    <section className="cr-panel" aria-labelledby="cr-feed-h" data-testid="credit-ticker">
      <h2 id="cr-feed-h" className="cr-h2">
        Events
      </h2>
      {rows.length === 0 ? (
        <p className="cr-note" data-testid="ticker-empty">
          {live === 'live' ? 'The pool has logged no events yet, or the event feed is not read in this build.' : 'No events yet.'}
        </p>
      ) : (
        <ol className="cr-feed">
          {rows.map((e) => {
            const link = e.tx === null ? null : explorerTx(e.tx);
            return (
            <li key={e.id} className={`cr-ev cr-ev-${TONE[e.kind]}`} data-testid="ticker-row" data-kind={e.kind} data-fixture={e.fixture ? 'true' : 'false'}>
              <span className="cr-ev-word">{WORD[e.kind]}</span>
              <span className="cr-ev-amt">{e.amount === '0' ? '' : `${formatNear(e.amount)} NEAR`}</span>
              <span className="cr-ev-who">
                <Account id={e.who} max={26} />
                {e.chain === null ? '' : ` on ${CHAIN_NAME[e.chain]}`}
              </span>
              <span className="cr-ev-when">
                {agoText(nowMs - e.atMs)}
                {e.fixture ? <span className="cr-fx"> fixture</span> : null}
                {link !== null ? (
                  <>
                    {' '}
                    <a href={link} target="_blank" rel="noopener noreferrer" aria-label={`View ${WORD[e.kind]} transaction on the explorer`}>
                      tx
                    </a>
                  </>
                ) : null}
              </span>
            </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const LINE_WORD: Record<Line['state'], string> = { active: 'Active', repaid: 'Repaid', defaulted: 'Defaulted', closed: 'Closed', unknown: 'Unknown' };

export function LinesTable({ lines, selected, onSelect, nowMs }: { lines: readonly Line[]; selected: string | null; onSelect(card: string): void; nowMs: bigint }) {
  return (
    <section className="cr-wide" aria-labelledby="cr-lines-h" data-testid="credit-lines">
      <h2 id="cr-lines-h" className="cr-h2">
        Credit lines
      </h2>
      <div className="cr-scroll" tabIndex={0} role="region" aria-label="Credit lines table">
        <table className="cr-table">
          <thead>
            <tr>
              <th scope="col">Agent account</th>
              <th scope="col">Borrower</th>
              <th scope="col" className="cr-num">Limit</th>
              <th scope="col" className="cr-num">Drawn</th>
              <th scope="col" className="cr-num">Returned</th>
              <th scope="col" className="cr-num">Fee</th>
              <th scope="col">Due</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const left = BigInt(l.dueMs) - nowMs;
              const days = left / 86_400_000n;
              return (
                <tr key={l.card} data-testid="line-row" data-state={l.state} aria-selected={selected === l.card}>
                  <th scope="row">
                    <button type="button" className="cr-link" onClick={() => onSelect(l.card)} aria-label={`Show credit line ${shownAccount(l.card, 'demo line')} in the scene`} data-testid="line-select">
                      {shortId(shownAccount(l.card, 'demo line'), 24)}
                    </button>
                  </th>
                  <td>
                    <Account id={l.borrower} max={24} />
                  </td>
                  <td className="cr-num">{formatNear(l.limit, 0)}</td>
                  <td className="cr-num">{formatNear(l.drawn, 0)}</td>
                  <td className="cr-num">{formatNear(l.returned, 0)}</td>
                  <td className="cr-num">{percent(BigInt(l.feeBps))}</td>
                  <td>{left < 0n ? 'past due' : `in ${days.toString()} d`}</td>
                  <td>
                    <span className={`cr-state cr-state-${l.state}`}>{LINE_WORD[l.state]}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Passports({ lines, events, fixture }: { lines: readonly Line[]; events: readonly CreditEvent[]; fixture: boolean }) {
  return (
    <section className="cr-wide" aria-labelledby="cr-pass-h" data-testid="credit-passports">
      <h2 id="cr-pass-h" className="cr-h2">
        Agent Credit Passports
      </h2>
      <p className="cr-note">
        {`An agent account's record, read from its events: allowed, held and refused payments and repayments. ${fixture ? 'These are fixture records. ' : ''}The score is arithmetic on that record, shown here before the passport token (AIR-333) exists.`}
      </p>
      <ul className="cr-passes">
        {lines.map((l) => {
          const p = passportOf(l.card, events);
          const r = 34;
          const c = 2 * Math.PI * r;
          return (
            <li key={l.card} className="cr-pass" data-testid="passport-card" data-score={p.score}>
              <svg className="cr-pass-ring" viewBox="0 0 84 84" role="img" aria-label={`Score ${String(p.score)} out of 100`}>
                <circle cx="42" cy="42" r={r} fill="none" stroke="var(--hair)" strokeWidth="3" />
                <circle cx="42" cy="42" r={r} fill="none" stroke={p.defaulted ? 'var(--alarm)' : 'var(--clear)'} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(c * p.score) / 100} ${c}`} transform="rotate(-90 42 42)" />
                <text x="42" y="48" textAnchor="middle" className="cr-pass-score">
                  {p.score}
                </text>
              </svg>
              <div className="cr-pass-body">
                <p className="cr-pass-name">{shortId(shownAccount(l.card, 'demo line'), 24)}</p>
                <p className="cr-pass-line">{`${String(p.allowed)} allowed, ${String(p.held)} held, ${String(p.refused)} refused`}</p>
                <p className="cr-pass-line">{p.defaulted ? 'Defaulted' : `${String(p.repaid)} repaid on time`}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Legend() {
  return (
    <ul className="cr-legend" aria-label="What the scene shows">
      <li><span className="cr-key cr-key-ok" aria-hidden="true" />Payment passes the airlock</li>
      <li><span className="cr-key cr-key-held" aria-hidden="true" />Held for the owner</li>
      <li><span className="cr-key cr-key-bad" aria-hidden="true" />Refused, breaks on the ring</li>
      <li><span className="cr-key cr-key-fee" aria-hidden="true" />Repayment with fee</li>
    </ul>
  );
}

export function CreditPage(): ReactElement {
  const poolId = useMemo(() => (PRERENDER || typeof window === 'undefined' ? DEFAULT_POOL : poolFromSearch(window.location.search)), []);
  const state = useCredit(poolId);
  const [stage, setStage] = useState<{ mode: StageMode; why: 'reduced' | 'weak' | 'nogl' | null }>({ mode: 'pending', why: null });
  const [quality, setQuality] = useState<Quality>('high');
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const labels = useRef(new Map<string, HTMLElement>());
  const stageRef = useRef<HTMLDivElement>(null);
  const slow = useRef(0);

  useEffect(() => {
    const picked = pickStage();
    let live = true;
    let idle: number | undefined;
    // the scene chunk and its first frames are the heaviest thing on the page: the poster and the text paint first, and the scene starts once
    // the page has loaded and the browser is idle (at most 4 s later), so it never delays the first paint or the headline
    const start = (): void => {
      if (!live) return;
      const go = (): void => {
        if (live) setStage(picked);
      };
      if (picked.mode !== 'scene') go();
      else if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(go, { timeout: 4000 });
      else idle = window.setTimeout(go, 1200);
    };
    if (picked.mode !== 'scene') setStage(picked);
    else if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    const t = setInterval(() => setNow(Date.now()), 4000);
    return () => {
      live = false;
      window.removeEventListener('load', start);
      if (idle !== undefined && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle);
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onFps = useCallback((fps: number) => {
    if (fps >= 38) {
      slow.current = 0;
      return;
    }
    slow.current += 1;
    // two slow readings in a row: drop the depth of field and the pixel ratio first, then give up on the scene
    if (slow.current >= 2) {
      slow.current = 0;
      setQuality((q) => {
        if (q === 'high') return 'low';
        setStage({ mode: 'poster', why: 'weak' });
        return q;
      });
    }
  }, []);

  const pool = state.kind === 'fixture' || state.kind === 'live' ? state.pool : null;
  const events = state.kind === 'fixture' || state.kind === 'live' ? state.events : [];
  const known = pool?.lines.some((l) => l.card === selected) === true;
  const pick = useCallback((card: string) => {
    setSelected((s) => (s === card ? null : card));
    stageRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }, []);
  const nowMs = BigInt(now);
  const sel = known ? pool?.lines.find((l) => l.card === selected) : undefined;

  const stats = pool === null ? null : <Stats pool={pool} events={events} feed={state.kind === 'fixture' || (state.kind === 'live' && state.feed === 'ok')} nowMs={nowMs} />;
  return (
    <main className="credit" data-testid="credit-page">
      <section className="cr-hero" aria-labelledby="cr-title">
        <div className="cr-head">
          <p className="cr-kicker">AIRLOCK Credit</p>
          <h1 id="cr-title" className="cr-title">
            Credit for agents that cannot be talked out of the money
          </h1>
          <p className="cr-lede">LPs stake into a pool. Each agent spends from a credit line the pool funds, on NEAR, Base and Solana, and every payment goes through the airlock first.</p>
          <p className="cr-note" data-testid="credit-not-plastic">An AIRLOCK credit line is an on-chain line of credit on NEAR, not a plastic card.</p>
          <Badge state={state} />
        </div>
      </section>

      {state.kind === 'unreadable' ? (
        <section className="cr-wide" data-testid="credit-unreadable" role="alert">
          <h2 className="cr-h2">The chain could not be read</h2>
          <p className="cr-note">{'The pool contract did not answer through any NEAR node, so no numbers are shown. The page tries again by itself.'}</p>
        </section>
      ) : null}
      {state.kind === 'loading' ? (
        <section className="cr-wide" data-testid="credit-loading" aria-busy="true">
          <p className="cr-note">Reading the pool contract.</p>
          <noscript>
            <p className="cr-note">This page needs JavaScript. It reads the pool contract's get_pool view and the chain's events from public NEAR hosts and draws them as a scene.</p>
          </noscript>
        </section>
      ) : null}
      {stats}
      {pool === null ? null : (
        <section className="cr-live" aria-labelledby="cr-live-h" ref={stageRef}>
          <h2 id="cr-live-h" className="cr-h2">
            Live network
          </h2>
          <div className="cr-stage">
            <div className="cr-canvas" data-testid="credit-stage" data-mode={stage.mode} data-audit-skip>
              {stage.mode === 'scene' ? (
                <Suspense fallback={<Poster pool={pool} />}>
                  <CreditScene pool={pool} events={events} selected={known ? selected : null} onSelect={setSelected} quality={quality} onFps={onFps} labels={labels} />
                </Suspense>
              ) : (
                <Poster pool={pool} />
              )}
              {stage.mode === 'scene' ? (
                <div className="cr-labels" aria-hidden="true">
                  {(['near', 'base', 'solana'] as const).map((c) => (
                    <span key={c} className="cr-label" ref={(el) => { if (el === null) labels.current.delete(`world-${c}`); else labels.current.set(`world-${c}`, el); }}>
                      {CHAIN_NAME[c]}
                    </span>
                  ))}
                  <span className="cr-label cr-label-card" ref={(el) => { if (el === null) labels.current.delete('card'); else labels.current.set('card', el); }}>
                    {sel === undefined ? '' : shortId(shownAccount(sel.card, 'demo line'), 24)}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="cr-bar">
            <Legend />
            <div className="cr-bar-right">
              {stage.mode === 'poster' || stage.mode === 'diagram' ? (
                <>
                  <p className="cr-note" data-testid="stage-note">
                    {stage.why === 'reduced' ? 'Motion is off because your system asks for less of it.' : stage.why === 'weak' ? 'The scene is off to keep this device responsive.' : 'This browser has no WebGL, so the network is drawn flat.'}
                  </p>
                  {stage.why === 'nogl' ? null : (
                    <button type="button" className="cr-btn cr-btn-ghost" onClick={() => setStage({ mode: 'scene', why: null })} data-testid="play-scene">
                      Play the scene
                    </button>
                  )}
                </>
              ) : sel !== undefined ? (
                <>
                  <p className="cr-note" data-testid="scene-selected">{`Credit line ${shortId(shownAccount(sel.card, 'demo line'), 26)}, ${percent(BigInt(sel.feeBps))} fee`}</p>
                  <button type="button" className="cr-btn cr-btn-ghost" onClick={() => setSelected(null)} data-testid="scene-back">
                    Back to the network
                  </button>
                </>
              ) : stage.mode === 'scene' ? (
                <p className="cr-note">Click a credit line to fly to it. Escape returns.</p>
              ) : null}
            </div>
          </div>
        </section>
      )}
      {pool === null ? null : (
        <>
          <div className="cr-two">
            <MoneyPanel state={state} nowMs={nowMs} />
            <Ticker events={events} nowMs={now} live={state.kind} />
          </div>
          <LinesTable lines={pool.lines} selected={selected} onSelect={pick} nowMs={nowMs} />
          <Passports lines={pool.lines} events={events} fixture={state.kind === 'fixture'} />
        </>
      )}
      <footer className="cr-foot" data-testid="credit-foot">
        <p className="cr-note">The pool runs on NEAR&apos;s test network. Nothing here moves real money.</p>
      </footer>
    </main>
  );
}

export default CreditPage;

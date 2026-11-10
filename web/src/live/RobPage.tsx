// AIR-356: /rob, "Rob it yourself". A practice card with its own small balance, separate from the credit pool, whose agent's keys are
// published. The visitor picks what a hijacked agent would try (or types a payee and an amount), the browser signs one real submit_batch as
// that agent, and the page shows what the contract answered: the machine of /break with one window, the reason in plain words beside the
// contract's code, the transaction and how long it took. Under it, every attempt anyone made, read from the chain. Nothing is invented: a
// public file or chain that cannot be read is said so, with no number.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { NEAR_RPC } from '../../csp.ts';
import { TxLink } from '../credit/CreditPage.tsx';
import { PRERENDER, url } from '../static.ts';
import { PRESETS, reasonWords, send, wishOf } from './rob.ts';
import type { Choice, Sent } from './rob.ts';
import { countsOfTry, newTryCache, readTryAttempts } from './tryChain.ts';
import type { TryAttempt, TryCounts } from './tryChain.ts';
import { parseTryPublic } from './tryPublic.ts';
import type { TryPublic } from './tryPublic.ts';

const YOCTO = 10n ** 24n;

/** Yocto as NEAR with no trailing zeros (BigInt only). */
export function nearOf(yocto: string): string {
  const v = BigInt(yocto);
  const frac = (v % YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return `${(v / YOCTO).toString()}${frac === '' ? '' : `.${frac}`} NEAR`;
}

/** A payee as the page prints it: the booked shop by name, a SOL address as such, a NEAR account without its suffix, cut when long. */
export function payeeText(payee: string, shop: string | null): string {
  if (shop !== null && payee === shop) return 'the booked shop';
  if (payee.startsWith('sol:')) return 'a SOL address';
  const bare = payee.replace(/^near:/, '').replace(/\.testnet$/, '');
  return bare.length > 18 ? `${bare.slice(0, 15)}…` : bare;
}

const agoText = (ms: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${String(s)} s ago`;
  if (s < 3600) return `${String(Math.floor(s / 60))} min ago`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))} h ago`;
  return `${String(Math.floor(s / 86_400))} d ago`;
};

export type Board = { counts: TryCounts; rows: TryAttempt[]; truncated: boolean } | 'unreadable' | null;
export type Mine = { sent: Sent; startedMs: number } | { busy: true; startedMs: number } | null;

export type RobViewProps = {
  pub: TryPublic | { refuse: string } | 'unreadable' | null;
  board: Board;
  choice: Choice;
  mine: Mine;
  mineIds: readonly string[];
  nowMs: number;
  ownPayee: string;
  ownAmount: string;
  onChoose(c: Choice): void;
  onOwn(payee: string, amount: string): void;
  onSend(): void;
};

function Head(): ReactElement {
  return (
    <header className="brk-head">
      <h1 className="brk-title">Rob it yourself</h1>
      <p className="brk-lede">
        This is a practice card: a payment card of its own with a small balance, separate from the lending pool and the lenders&apos; money. Its agent&apos;s keys are published, so your browser can sign exactly what a hijacked agent would send. Pick an attack, or type your own, and see what the card&apos;s contract answers.
      </p>
    </header>
  );
}

function Window({ mine, nowMs, shop, expired }: { mine: Mine; nowMs: number; shop: string | null; expired: boolean }): ReactElement {
  if (mine === null) return <p className="brk-word brk-word-idle">Waiting for you</p>;
  if ('busy' in mine) {
    return (
      <>
        <p className="brk-word brk-word-idle">Signing</p>
        <p className="brk-why" aria-live="polite">{`Signed in your browser, sent to the card's contract. ${((nowMs - mine.startedMs) / 1000).toFixed(1)} s`}</p>
      </>
    );
  }
  const s = mine.sent;
  if (s.kind === 'unavailable') {
    return (
      <>
        <p className="brk-word brk-word-idle">Not sent</p>
        <p className="brk-why" data-testid="rob-why">{s.why}</p>
      </>
    );
  }
  const took = `${(s.ms / 1000).toFixed(1)} s`;
  if (s.kind === 'failed') {
    return (
      <>
        <span className="brk-shutter" aria-hidden="true" />
        <p className="brk-word brk-word-refused">Refused</p>
        <p className="brk-why" data-testid="rob-why">
          {`The contract turned the call down before deciding: ${s.why}. Nothing moved. Took ${took}. `}
          {s.tx === null ? null : <TxLink tx={s.tx} what="attempt" label="see the transaction" />}
        </p>
      </>
    );
  }
  const a = s.answer;
  if (a.kind === 'paid') {
    return (
      <>
        <p className="brk-word brk-word-paid">Paid</p>
        <p className="brk-why" data-testid="rob-why">
          {`The owner signed for this payment, so the card paid ${shop === null ? 'the shop' : 'the booked shop'}. Took ${took}. `}
          <TxLink tx={s.tx} what="payment" label="see the transaction" />
        </p>
      </>
    );
  }
  const queue = a.reason === 'PendingFull';
  const lead = queue ? 'The queue is full right now.' : a.kind === 'held' ? (expired ? 'Held for the owner; it expired unpaid.' : 'Held for the owner; it expires unpaid.') : 'Blocked.';
  return (
    <>
      <span className="brk-shutter" aria-hidden="true" />
      <p className="brk-word brk-word-refused">Refused</p>
      <p className="brk-why" data-testid="rob-why">
        {`${lead} ${reasonWords(a.reason).replace(/^./, (c) => c.toUpperCase())}${queue ? '. Your attack was still refused; try again in a minute' : ''}. `}
        <span className="brk-mono rob-code" data-testid="rob-code">{a.reason ?? ''}</span>
        {` Took ${took}. `}
        <TxLink tx={s.tx} what="attempt" label="see the transaction" />
      </p>
    </>
  );
}

function Counter({ board, nowMs }: { board: Board; nowMs: number }): ReactElement {
  if (board === null) return <p className="brk-status" data-testid="rob-count">Reading every attempt from the chain.</p>;
  if (board === 'unreadable') return <p className="brk-status" data-testid="rob-count">The chain could not be read just now, so no count is shown.</p>;
  const c = board.counts;
  return (
    <div className="rob-count" data-testid="rob-count">
      <p className="rob-count-line">
        <span className="rob-num" data-testid="rob-outside">{c.paidOutside}</span>
        {` paid to anyone but the booked shop, in ${String(c.attempts)} ${c.attempts === 1 ? 'attempt' : 'attempts'}.`}
      </p>
      <p className="rob-count-detail" data-testid="rob-detail">
        {`Held for the owner: ${String(c.held + c.expired)} (${String(c.expired)} expired unpaid). Blocked: ${String(c.blocked)}. Paid to the booked shop: ${String(c.paidShop)}.${c.lastMs === null ? '' : ` Last attempt ${agoText(c.lastMs, nowMs)}.`}${board.truncated ? ' The listing was long, so this counts its newest part.' : ''}`}
      </p>
    </div>
  );
}

const VERDICT_WORD: Record<TryAttempt['verdict'], string> = { blocked: 'Blocked', held: 'Held', expired: 'Expired unpaid', paid_shop: 'Paid the shop', paid_outside: 'Paid outside the book' };

function Rows({ board, mineIds, shop, nowMs }: { board: Board; mineIds: readonly string[]; shop: string | null; nowMs: number }): ReactElement | null {
  if (board === null || board === 'unreadable' || board.rows.length === 0) return null;
  const rows = [...board.rows].sort((a, b) => b.atMs - a.atMs || b.requestId.localeCompare(a.requestId)).slice(0, 12);
  return (
    <ol className="rob-rows" data-testid="rob-rows">
      {rows.map((r) => {
        const mine = mineIds.includes(r.requestId);
        return (
          <li key={r.requestId} className="rob-row" data-verdict={r.verdict} data-mine={mine ? 'true' : undefined} data-testid="rob-row">
            <span className="rob-row-word">{VERDICT_WORD[r.verdict]}</span>
            <span className="rob-row-what">
              {`${r.payee.startsWith('sol:') ? 'a SOL amount' : nearOf(r.amount)} to ${payeeText(r.payee, shop)}`}
              {r.reason === null ? null : <span className="brk-mono rob-row-code">{` ${r.reason}`}</span>}
            </span>
            <span className="rob-row-meta">
              {mine ? <span className="rob-row-mine">yours, </span> : null}
              {`${agoText(r.atMs, nowMs)} `}
              <TxLink tx={r.tx} what="attempt" label="see the transaction" />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function RobView(p: RobViewProps): ReactElement {
  const pub = p.pub !== null && p.pub !== 'unreadable' && 'policy' in p.pub ? p.pub : null;
  const shop = pub?.shop.payee ?? null;
  const busy = p.mine !== null && 'busy' in p.mine;
  const mineReq = p.mine !== null && 'sent' in p.mine && p.mine.sent.kind === 'answer' ? p.mine.sent.answer.requestId : null;
  const expired = mineReq !== null && p.board !== null && p.board !== 'unreadable' && p.board.rows.some((r) => r.requestId === mineReq && r.verdict === 'expired');
  const state = p.mine === null || 'busy' in p.mine ? 'idle' : p.mine.sent.kind === 'answer' ? (p.mine.sent.answer.kind === 'paid' ? 'paid' : 'refused') : p.mine.sent.kind === 'failed' ? 'refused' : 'idle';
  const closed = p.pub === 'unreadable' ? 'The card\'s public file could not be read, so this page will not sign anything. Reload to try again.' : p.pub !== null && 'refuse' in p.pub ? `This page will not sign anything: ${p.pub.refuse}.` : null;
  return (
    <main className="page brk rob" data-testid="rob">
      <Head />

      <section className="brk-step" aria-labelledby="rob-pick-title">
        <h2 id="rob-pick-title" className="brk-h2">
          Pick an attack
        </h2>
        <ul className="brk-attacks rob-picks" role="list" data-testid="rob-picks">
          {PRESETS.map((x) => (
            <li key={x.id}>
              <button type="button" className="brk-pick" aria-pressed={p.choice.kind === 'preset' && p.choice.id === x.id} data-testid={`rob-pick-${x.id}`} onClick={() => p.onChoose({ kind: 'preset', id: x.id })}>
                <span className="brk-pick-title">{x.title}</span>
                <span className="brk-pick-line">{x.line}</span>
              </button>
            </li>
          ))}
        </ul>
        <fieldset className="rob-own" data-testid="rob-own" data-picked={p.choice.kind === 'own' ? 'true' : undefined}>
          <legend className="brk-h3">Or try your own</legend>
          <label className="rob-field">
            <span>Pay this account</span>
            <input type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={64} value={p.ownPayee} placeholder="alice" data-testid="rob-own-payee" onChange={(e) => p.onOwn(e.target.value, p.ownAmount)} onFocus={() => p.onOwn(p.ownPayee, p.ownAmount)} />
          </label>
          <label className="rob-field">
            <span>This much NEAR</span>
            <input type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={p.ownAmount} placeholder="0.005" data-testid="rob-own-amount" onChange={(e) => p.onOwn(p.ownPayee, e.target.value)} onFocus={() => p.onOwn(p.ownPayee, p.ownAmount)} />
          </label>
        </fieldset>
        <div className="rob-go-row">
          <button type="button" className="act act-primary rob-go" data-testid="rob-go" disabled={pub === null || busy} onClick={p.onSend}>
            Send it to the card
          </button>
          {closed === null ? null : <p className="brk-status" data-testid="rob-closed">{closed}</p>}
          {pub === null && closed === null ? <p className="brk-status">Reading the card&apos;s public file.</p> : null}
        </div>
      </section>

      <section className="rob-floor" aria-label="The card's answer">
        <figure className="brk-machine rob-machine" data-state={state} data-testid="rob-machine">
          <figcaption className="brk-plate">
            <span className="brk-plate-name">The practice card</span>
            <span className="brk-plate-id">its contract decides; this page only shows the answer</span>
          </figcaption>
          <div className="brk-window" key={p.mine === null ? 'idle' : String(p.mine.startedMs)} data-testid="rob-window" aria-live="polite">
            <Window mine={p.mine} nowMs={p.nowMs} shop={shop} expired={expired} />
          </div>
        </figure>
      </section>

      <section className="rob-board" aria-labelledby="rob-board-title">
        <h2 id="rob-board-title" className="brk-h2">
          Every attempt so far
        </h2>
        <Counter board={p.board} nowMs={p.nowMs} />
        <Rows board={p.board} mineIds={p.mineIds} shop={shop} nowMs={p.nowMs} />
      </section>

      <section className="rob-fine" aria-label="Limits">
        <p className="brk-status">
          The card may pay at most 0.01 NEAR at once and 0.05 NEAR a day, only to the one shop the owner booked. A request held for the owner waits a minute and then expires unpaid; nobody approves here. Every attempt costs the card a little gas, which the team refills.
        </p>
        <p className="brk-status" data-testid="rob-limits">
          Runs on the NEAR test network, where NEAR has no value.
        </p>
        <p className="brk-status">
          The guard itself, and the copies of it that do pay: <a href={url('break')}>Break the proof</a>.
        </p>
      </section>
    </main>
  );
}

const TTL_FALLBACK = 60_000;

export default function RobPage(): ReactElement {
  const [pub, setPub] = useState<RobViewProps['pub']>(null);
  const [board, setBoard] = useState<Board>(null);
  const [choice, setChoice] = useState<Choice>({ kind: 'preset', id: PRESETS[0]?.id ?? 'stranger' });
  const [mine, setMine] = useState<Mine>(null);
  const [mineIds, setMineIds] = useState<string[]>([]);
  const [nowMs, setNow] = useState(() => Date.now());
  const [ownPayee, setOwnPayee] = useState('');
  const [ownAmount, setOwnAmount] = useState('');
  const [tick, setTick] = useState(0);
  const cache = useRef(newTryCache());

  useEffect(() => {
    if (PRERENDER) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    const r = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, []);

  useEffect(() => {
    if (PRERENDER) return undefined;
    let live = true;
    void fetch(url('try-public.json'))
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : Promise.reject(new Error(String(r.status)))))
      .then(
        (raw) => {
          if (!live) return;
          const got = parseTryPublic(raw, Date.now());
          setPub('ok' in got ? got.ok : got);
        },
        () => live && setPub('unreadable'),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (PRERENDER || pub === null || pub === 'unreadable' || !('policy' in pub)) return undefined;
    let live = true;
    void readTryAttempts({ policy: pub.policy, agent: pub.agent, book: pub.book, nowMs: Date.now(), ttlMs: pub.pendingTtlMs ?? TTL_FALLBACK, cache: cache.current }).then(
      (r) => live && setBoard({ counts: countsOfTry(r.attempts), rows: r.attempts, truncated: r.truncated }),
      () => live && setBoard((b) => (b === null ? 'unreadable' : b)),
    );
    return () => {
      live = false;
    };
  }, [pub, tick]);

  const onSend = useCallback(() => {
    if (pub === null || pub === 'unreadable' || !('policy' in pub) || (mine !== null && 'busy' in mine)) return;
    const w = wishOf(choice.kind === 'own' ? { kind: 'own', payee: ownPayee, amount: ownAmount } : choice, pub);
    const startedMs = Date.now();
    if ('refuse' in w) {
      setMine({ sent: { kind: 'unavailable', why: w.refuse }, startedMs });
      return;
    }
    setMine({ busy: true, startedMs });
    void send(pub, w, { rpc: { rpcUrls: NEAR_RPC }, random: Math.random, now: Date.now }).then((sent) => {
      setMine({ sent, startedMs });
      if (sent.kind === 'answer') setMineIds((ids) => [...ids, sent.answer.requestId]);
      // the board reads the chain again a few seconds later, so the new row and the counts include this attempt
      setTimeout(() => setTick((n) => n + 1), 4_000);
    });
  }, [pub, choice, mine, ownPayee, ownAmount]);

  const onOwn = useCallback((payee: string, amount: string) => {
    setOwnPayee(payee);
    setOwnAmount(amount);
    setChoice({ kind: 'own', payee, amount });
  }, []);

  return <RobView pub={pub} board={board} choice={choice} mine={mine} mineIds={mineIds} nowMs={nowMs} ownPayee={ownPayee} ownAmount={ownAmount} onChoose={setChoice} onOwn={onOwn} onSend={onSend} />;
}

export { RobPage };

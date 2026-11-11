// AIR-356: /rob, "Rob it yourself". A practice card with its own small balance, separate from the credit pool, whose agent's keys are
// published. The visitor picks what a hijacked agent would try (or types a payee and an amount), the browser signs one real submit_batch as
// that agent, and the page shows what the contract answered: the machine of /break with one window, the reason in plain words beside the
// contract's code, the transaction and how long it took. Under it, every attempt anyone made, read from the chain. Nothing is invented: a
// public file or chain that cannot be read is said so, with no number.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { NEAR_RPC } from '../../csp.ts';
import { foreignText, unshownText } from '../components/chainText.ts';
import { TxLink } from '../credit/CreditPage.tsx';
import { PRERENDER, url } from '../static.ts';
import { PRESETS, failureWords, nearWords, reasonShort, reasonWords, send, wishOf } from './rob.ts';
import type { Choice, Sent } from './rob.ts';
import { checkColumns, griefOf, readAsset, readLimits } from './robCheck.ts';
import type { CardLimits, Grief } from './robCheck.ts';
import { loadVerdict } from '../try/verdictWasm.ts';
import type { WasmVerdict } from '../try/verdictWasm.ts';
import { countText, countsOfTry, newTryCache, readTryAttempts, withExpiry } from './tryChain.ts';
import type { TryAttempt, TryCounts } from './tryChain.ts';
import { parseTryPublic } from './tryPublic.ts';
import type { TryPublic } from './tryPublic.ts';
import replayData from './try-replay.json' with { type: 'json' };
import { historyFetch } from '../chain/historyFetch.ts';
import { asOfText, bakedState, holdsAt, loadSiteState } from '../state/siteState.ts';
import type { SiteState } from '../state/siteState.ts';

const YOCTO = 10n ** 24n;

/**
 * AIR-360: the bench replay. The team sent the payment requests its bench recorded in strict mode to this card with the published key
 * (scripts/try-replay.ts); this file holds their transactions and counts, written from the replay's rows, so the page can say who sent
 * what and count the browsers' attempts apart. Nothing in it is typed by hand.
 */
export type Replay = { date: string; requests: number; held: number; paidShop: number; paidElsewhere: number; firstTx: string; lastTx: string; ids: Record<string, number[]> };
export const REPLAY: Replay = replayData;

/** The replayed request ids, `<task hash>:<index>`, the way an attempt names its request. */
export const replayIds = (r: Replay): Set<string> => new Set(Object.entries(r.ids).flatMap(([hash, xs]) => xs.map((i) => `${hash}:${String(i)}`)));
/** How many rows the board shows at first, and adds per "Show more". */
export const ROWS_STEP = 12;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-11-11` as `Nov 11, 2026`. */
export function dateText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return iso;
  return `${MONTHS[+(m[2] ?? '1') - 1] ?? ''} ${String(+(m[3] ?? '1'))}, ${m[1] ?? ''}`;
}


/** The one sentence that says who sent what, from the replay's own counts. */
export function replaySentence(r: Replay): string {
  return `The team replayed the ${countText(r.requests)} payment requests its bench recorded in strict mode on ${dateText(r.date)}: ${countText(r.held)} were held and ${countText(r.paidShop)}, the legitimate payment, were paid to the booked shop. Every other attempt here was sent from a browser like yours.`;
}

/** Yocto as NEAR with no trailing zeros (BigInt only). */
export function nearOf(yocto: string): string {
  const v = BigInt(yocto);
  const frac = (v % YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return `${(v / YOCTO).toString()}${frac === '' ? '' : `.${frac}`} NEAR`;
}

/**
 * A payee as the page prints it: the booked shop by name, a SOL address as such, a value outside the payee grammar as a placeholder with its length,
 * and any other NEAR account (a name a visitor chose) cut in the middle when long (components/chainText.ts), then without its suffix.
 */
export function payeeText(payee: string, shop: string | null): string {
  if (shop !== null && payee === shop) return 'the booked shop';
  const hidden = unshownText(payee);
  if (hidden !== null) return hidden;
  if (payee.startsWith('sol:')) return 'a SOL address';
  if (!payee.startsWith('near:')) return 'an address on another chain';
  return foreignText(payee.slice(5)).replace(/\.testnet$/, '');
}

const agoText = (ms: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${String(s)} s ago`;
  if (s < 3600) return `${String(Math.floor(s / 60))} min ago`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))} h ago`;
  return `${String(Math.floor(s / 86_400))} d ago`;
};

/**
 * The board of every attempt. `total`, `fromBrowsers` and `asOfMs` come with a board built from the site state file (state/siteState.ts): it
 * lists the newest rows only, so the totals are the file's (plus what was read after its cut), and `asOfMs` is set while the live read has not
 * added to it (the history API was throttled, or has not answered yet).
 */
export type Board =
  | { counts: TryCounts; rows: TryAttempt[]; truncated: boolean; total?: number; fromBrowsers?: { attempts: number; paidOutside: number }; asOfMs?: number | null }
  | 'unreadable'
  | null;
export type Mine = { sent: Sent; startedMs: number } | { busy: true; startedMs: number } | null;

export type RobViewProps = {
  pub: TryPublic | { refuse: string } | 'unreadable' | null;
  board: Board;
  /** the bench replay (default: the committed file) */
  replay?: Replay;
  /** how many rows of the board are shown (default ROWS_STEP) */
  shown?: number;
  onMore?(): void;
  choice: Choice;
  mine: Mine;
  mineIds: readonly string[];
  nowMs: number;
  ownPayee: string;
  ownAmount: string;
  onChoose(c: Choice): void;
  onOwn(payee: string, amount: string): void;
  onSend(): void;
  /** the card's limits, read from its contract or the state file; null or absent leaves the numbers out */
  limits?: CardLimits | null;
  /** the same request checked in the browser by the shipped gate (never a chain answer); 'error' when the gate could not run */
  check?: { verdict: WasmVerdict } | 'running' | 'error' | null;
  onCheck?(): void;
};

/** Why a hold costs the owner nothing, said once in the answer and once in the limits. */
export const HOLD_SAFE = "A hold is safe: it expires unpaid after a minute, and approving it needs the owner's key.";

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

/** The reason in words, with the contract's own code beside it as secondary text. */
function Reason({ code, words }: { code: string | null; words: string }): ReactElement {
  return (
    <>
      <span data-testid="rob-reason">{words}</span>
      {code === null ? null : (
        <span className="rob-code-line">
          {' Contract code: '}
          <span className="brk-mono rob-code" data-testid="rob-code">
            {code}
          </span>
          .
        </span>
      )}
    </>
  );
}

/** What happened, in one sentence, when a published key was used to keep the card from answering (live/robCheck.ts). */
function griefSentence(g: Grief, lim: CardLimits | null, ttlMs: number | null): string {
  switch (g) {
    case 'gas':
      return 'Nothing was sent: the practice agent has used up the gas money it pays for each attempt. Anyone holding the published keys can spend it; the team tops it up every few minutes, within a daily limit.';
    case 'daily':
      return `The card has already paid its limit${lim === null ? '' : ` of ${nearWords(lim.dailyCap)}`} for today, so it pays nothing more until midnight UTC. Anyone holding the published keys can use up the day's limit by sending the payment the owner signed for.`;
    case 'slots':
      return 'Nothing was sent: every attempt slot the owner signed for this round is used. Anyone holding the published keys can use them up; the owner signs a new round.';
    case 'queue':
      return `The queue of ${lim === null || lim.maxPending === null ? 'requests' : `${String(lim.maxPending)} requests`} waiting for the owner is full, so the card took no new hold. Anyone holding the published keys can fill it; each hold expires${ttlMs === null ? '' : ` after ${String(Math.round(ttlMs / 1000))} s`} and the queue is cleared every minute or two.`;
  }
}

const CHECK_WORD: Record<WasmVerdict['kind'], string> = { allow: 'Would pay', escalate: 'Held', block: 'Blocked', malformed: 'Not decided' };

/** The griefing case: what happened, that the card is fine, and the same request checked in the browser by the shipped gate. */
function GriefNote({ grief, lim, ttlMs, clean, check, onCheck }: { grief: Grief; lim: CardLimits | null; ttlMs: number | null; clean: boolean; check: RobViewProps['check']; onCheck?: () => void }): ReactElement {
  return (
    <div className="rob-grief" data-testid="rob-grief" data-grief={grief}>
      <p className="brk-why" data-testid="rob-grief-why">
        {`${griefSentence(grief, lim, ttlMs)} The card itself is fine: its contract still decides every payment.${clean ? " Nothing has been paid outside the owner's book." : ''}`}
      </p>
      <button type="button" className="act" data-testid="rob-check" onClick={onCheck} disabled={check === 'running' || onCheck === undefined}>
        Run the same check in your browser
      </button>
      {check === null || check === undefined || check === 'running' ? null : check === 'error' ? (
        <p className="brk-status" data-testid="rob-check-error">The check could not run in this browser.</p>
      ) : (
        <div className="rob-check-result" data-testid="rob-check-result" data-verdict={check.verdict.kind}>
          <p className="brk-word brk-word-idle">{CHECK_WORD[check.verdict.kind]}</p>
          <p className="brk-why">
            {`${check.verdict.kind === 'allow' ? 'The gate allows this request.' : check.verdict.kind === 'malformed' ? 'The gate could not read this request.' : `Why: ${reasonWords(check.verdict.reason, lim)}`} Computed in your browser by the same gate code the contract runs. This is not a transaction: nothing was sent to the chain. It assumes the day's limit and the amount the owner signed for are unused.`}
          </p>
        </div>
      )}
    </div>
  );
}

function Window({ mine, nowMs, shop, expired, lim, ttlMs, clean, check, onCheck }: { mine: Mine; nowMs: number; shop: string | null; expired: boolean; lim: CardLimits | null; ttlMs: number | null; clean: boolean; check: RobViewProps['check']; onCheck?: () => void }): ReactElement {
  const grief = mine !== null && 'sent' in mine ? griefOf(mine.sent) : null;
  const note = grief === null ? null : <GriefNote grief={grief} lim={lim} ttlMs={ttlMs} clean={clean} check={check} {...(onCheck === undefined ? {} : { onCheck })} />;
  if (mine === null) return <p className="brk-word brk-word-idle">Waiting for you</p>;
  if ('busy' in mine) {
    return (
      <>
        <p className="brk-word brk-word-idle">Sending</p>
        <p className="brk-why">{`Signed in your browser and sent to the card's contract. Waiting for its answer: ${((nowMs - mine.startedMs) / 1000).toFixed(1)} s.`}</p>
      </>
    );
  }
  const s = mine.sent;
  if (s.kind === 'unavailable') {
    return (
      <>
        <p className="brk-word brk-word-idle">Not sent</p>
        {note ?? <p className="brk-why" data-testid="rob-why">{s.why}</p>}
      </>
    );
  }
  const took = `${(s.ms / 1000).toFixed(1)} s`;
  if (s.kind === 'failed') {
    const f = failureWords(s.why, lim);
    return (
      <>
        <span className="brk-shutter" aria-hidden="true" />
        <p className="brk-word brk-word-refused">Not paid</p>
        <p className="brk-why" data-testid="rob-why">
          {'The contract turned the call down, so nothing moved. '}
          <Reason code={f.code} words={f.words} />
          {` Took ${took}. `}
          {s.tx === null ? null : <TxLink tx={s.tx} what="attempt" label="see the transaction" />}
        </p>
        {note}
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
  const held = a.kind === 'held';
  const lead = held ? `Held for the owner${expired ? '; it has expired unpaid' : ''}. ${HOLD_SAFE}` : 'Blocked: the contract refused it outright. Nothing is held and nothing is paid.';
  return (
    <>
      <span className="brk-shutter" aria-hidden="true" />
      <p className="brk-word brk-word-refused">{held ? 'Held' : 'Blocked'}</p>
      <p className="brk-why" data-testid="rob-why">
        {`${lead} Why: `}
        <Reason code={a.reason} words={reasonWords(a.reason, lim)} />
        {` Took ${took}. `}
        <TxLink tx={s.tx} what="attempt" label="see the transaction" />
      </p>
      {note}
    </>
  );
}

function Counter({ board, nowMs, replay }: { board: Board; nowMs: number; replay: Replay }): ReactElement {
  if (board === null) return <p className="brk-status" data-testid="rob-count">Reading every attempt from the chain.</p>;
  if (board === 'unreadable') return <p className="brk-status" data-testid="rob-count">The chain could not be read just now, so no count is shown.</p>;
  const c = board.counts;
  const sent = replayIds(replay);
  const v = board.fromBrowsers ?? countsOfTry(board.rows.filter((r) => !sent.has(r.requestId)));
  const open = c.held;
  return (
    <div className="rob-count" data-testid="rob-count">
      <p className="rob-count-line">
        <span className="rob-num" data-testid="rob-outside">{countText(c.paidOutside)}</span>
        {` paid to anyone but the booked shop, in ${countText(c.attempts)} ${c.attempts === 1 ? 'attempt' : 'attempts'}.`}
      </p>
      <p className="rob-count-detail" data-testid="rob-detail">
        {`Held for the owner: ${countText(c.held + c.expired)} (${countText(c.expired)} expired unpaid${open > 0 ? `, ${countText(open)} still waiting` : ''}).${c.blocked > 0 ? ` Blocked outright: ${countText(c.blocked)}.` : ''} Paid to the booked shop: ${countText(c.paidShop)}.${c.lastMs === null ? '' : ` Last attempt ${agoText(c.lastMs, nowMs)}.`}${board.truncated ? ' The listing was long, so this counts its newest part.' : ''}`}
      </p>
      {replay.requests === 0 ? null : (
        <p className="rob-count-detail" data-testid="rob-replay">
          {`${replaySentence(replay)} From browsers so far: ${countText(v.attempts)} ${v.attempts === 1 ? 'attempt' : 'attempts'}, ${countText(v.paidOutside)} paid to anyone but the booked shop.`}
        </p>
      )}
      {board.asOfMs === undefined || board.asOfMs === null ? null : (
        <p className="rob-count-detail" data-testid="rob-asof">{`Counted from the chain, ${asOfText(board.asOfMs)}.`}</p>
      )}
    </div>
  );
}

const VERDICT_WORD: Record<TryAttempt['verdict'], string> = { blocked: 'Blocked', held: 'Held', expired: 'Held, expired unpaid', paid_shop: 'Paid the booked shop', paid_outside: 'Paid outside the book' };

function Rows({ board, mineIds, shop, nowMs, replay, shown, onMore }: { board: Board; mineIds: readonly string[]; shop: string | null; nowMs: number; replay: Replay; shown: number; onMore?: () => void }): ReactElement | null {
  if (board === null || board === 'unreadable' || board.rows.length === 0) return null;
  const all = [...board.rows].sort((a, b) => b.atMs - a.atMs || b.requestId.localeCompare(a.requestId));
  const rows = all.slice(0, shown);
  const sent = replayIds(replay);
  const total = board.total ?? all.length;
  return (
    <>
    <ol className="rob-rows" data-testid="rob-rows">
      {rows.map((r) => {
        const mine = mineIds.includes(r.requestId);
        const bench = sent.has(r.requestId);
        return (
          <li key={r.requestId} className="rob-row" data-verdict={r.verdict} data-mine={mine ? 'true' : undefined} data-replay={bench ? 'true' : undefined} data-testid="rob-row">
            <span className="rob-row-word">{VERDICT_WORD[r.verdict]}</span>
            <span className="rob-row-what">
              {`${r.payee.startsWith('sol:') ? 'a SOL amount' : nearOf(r.amount)} to ${payeeText(r.payee, shop)}`}
              {r.reason === null ? null : (
                <>
                  {`: ${reasonShort(r.reason)} `}
                  <span className="brk-mono rob-row-code">{unshownText(r.reason) ?? r.reason}</span>
                </>
              )}
            </span>
            <span className="rob-row-meta">
              {mine ? <span className="rob-row-mine">yours, </span> : null}
              {bench ? 'bench replay, ' : null}
              {`${agoText(r.atMs, nowMs)} `}
              <TxLink tx={r.tx} what="attempt" label="see the transaction" />
            </span>
          </li>
        );
      })}
    </ol>
    <div className="rob-go-row">
      <p className="brk-status" data-testid="rob-shown">
        {`Newest at the top, showing ${countText(rows.length)} of ${countText(total)}.${total > all.length && rows.length === all.length ? ' Every older attempt is on the chain, with its transaction.' : ''}`}
      </p>
      {rows.length < all.length && onMore !== undefined ? (
        <button type="button" className="act" data-testid="rob-more" onClick={onMore}>
          {`Show ${String(Math.min(ROWS_STEP, all.length - rows.length))} more`}
        </button>
      ) : null}
    </div>
    </>
  );
}

/** What the picked choice will send, in one sentence, or why it cannot be sent. */
export function sendsSentence(choice: Choice, pub: TryPublic | null, ownPayee: string, ownAmount: string): string {
  if (pub === null) return '';
  const w = wishOf(choice.kind === 'own' ? { kind: 'own', payee: ownPayee, amount: ownAmount } : choice, pub);
  if ('refuse' in w) return w.refuse;
  const to = w.payee.startsWith('sol:') ? 'a SOL address' : payeeText(w.payee, pub.shop.payee);
  const what = w.asset === 'near' ? nearOf(w.amount) : `${w.amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} base units of SOL`;
  return w.honest ? `This sends ${what} to ${to} with the owner's labels and the shop's book proof, the way the owner's own request goes.` : `This sends ${what} to ${to}, every value labelled as outside text, the way a hijacked agent's request goes.`;
}

/** The custom fields a preset fills, so they always show what will be sent; a SOL payee cannot be typed, so that preset leaves them empty. */
export function fieldsOf(id: string, pub: TryPublic | null): { payee: string; amount: string } {
  const p = PRESETS.find((x) => x.id === id);
  if (p === undefined || pub === null) return { payee: '', amount: '' };
  const bare = (payee: string): string => payee.replace(/^near:/, '').replace(/\.testnet$/, '');
  if (p.honest === true) return { payee: bare(pub.shop.payee), amount: nearOf(pub.honestAmount).replace(/ NEAR$/, '') };
  const payee = p.payee === 'shop' ? pub.shop.payee : (p.payee ?? '');
  if (!payee.startsWith('near:') || p.amount === undefined) return { payee: '', amount: '' };
  return { payee: bare(payee), amount: p.amount };
}

const reduced = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function RobView(p: RobViewProps): ReactElement {
  const pub = p.pub !== null && p.pub !== 'unreadable' && 'policy' in p.pub ? p.pub : null;
  const shop = pub?.shop.payee ?? null;
  const busy = p.mine !== null && 'busy' in p.mine;
  const answered = p.mine !== null && 'sent' in p.mine;
  const mineReq = p.mine !== null && 'sent' in p.mine && p.mine.sent.kind === 'answer' ? p.mine.sent.answer.requestId : null;
  const expired = mineReq !== null && p.board !== null && p.board !== 'unreadable' && p.board.rows.some((r) => r.requestId === mineReq && r.verdict === 'expired');
  const state = p.mine === null || 'busy' in p.mine ? 'idle' : p.mine.sent.kind === 'answer' ? (p.mine.sent.answer.kind === 'paid' ? 'paid' : 'refused') : p.mine.sent.kind === 'failed' ? 'refused' : 'idle';
  const closed = p.pub === 'unreadable' ? 'The card\'s public file could not be read, so this page will not sign anything. Reload to try again.' : p.pub !== null && 'refuse' in p.pub ? `This page will not sign anything: ${p.pub.refuse}.` : null;
  const sends = sendsSentence(p.choice, pub, p.ownPayee, p.ownAmount);
  const goLabel = busy ? 'Sending to the card' : pub === null && closed === null ? 'Reading the card' : answered ? 'Send it again' : 'Send it to the card';

  // visitor test 2026-11-11: on a laptop the answer landed below the fold and Send looked dead. The answer is brought into view when the send
  // starts, and when it lands a keyboard user who pressed Send is moved to it (it is announced either way: the window is a live region).
  const windowRef = useRef<HTMLDivElement>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  const phase = p.mine === null ? 'none' : 'busy' in p.mine ? 'busy' : 'done';
  useEffect(() => {
    const el = windowRef.current;
    if (el === null || phase === 'none') return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
    // the Send button is disabled while sending, which drops its focus to the page body: a focus there (or still on Send) moves to the answer
    const at = document.activeElement;
    if (phase === 'done' && (at === goRef.current || at === null || at === document.body)) el.focus({ preventScroll: true });
  }, [phase]);

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
          <legend className="brk-h3">Or change it and try your own</legend>
          <label className="rob-field">
            <span>Pay this account</span>
            <input type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={64} value={p.ownPayee} placeholder="alice" data-testid="rob-own-payee" onChange={(e) => p.onOwn(e.target.value, p.ownAmount)} />
          </label>
          <label className="rob-field">
            <span>This much NEAR</span>
            <input type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={p.ownAmount} placeholder="0.005" data-testid="rob-own-amount" onChange={(e) => p.onOwn(p.ownPayee, e.target.value)} />
          </label>
        </fieldset>
        {sends === '' ? null : (
          <p className="brk-status" data-testid="rob-sends" aria-live="polite">
            {sends}
          </p>
        )}
        <div className="rob-go-row">
          <button ref={goRef} type="button" className="act act-primary rob-go" data-testid="rob-go" disabled={pub === null || busy} aria-busy={busy ? 'true' : undefined} onClick={p.onSend}>
            {goLabel}
          </button>
          {closed === null ? null : <p className="brk-status" data-testid="rob-closed">{closed}</p>}
        </div>
      </section>

      <section className="rob-floor" aria-label="The card's answer">
        <figure className="brk-machine rob-machine" data-state={state} data-testid="rob-machine">
          <figcaption className="brk-plate">
            <span className="brk-plate-name">The practice card</span>
            <span className="brk-plate-id">its contract decides; this page shows the answer</span>
          </figcaption>
          <div className="brk-window" ref={windowRef} tabIndex={-1} key={p.mine === null ? 'idle' : String(p.mine.startedMs)} data-testid="rob-window" aria-live="polite">
            <Window mine={p.mine} nowMs={p.nowMs} shop={shop} expired={expired} lim={p.limits ?? null} ttlMs={pub?.pendingTtlMs ?? null} clean={p.board !== null && p.board !== 'unreadable' && p.board.counts.paidOutside === 0} check={p.check ?? null} {...(p.onCheck === undefined ? {} : { onCheck: p.onCheck })} />
          </div>
        </figure>
      </section>

      <section className="rob-board" aria-labelledby="rob-board-title">
        <h2 id="rob-board-title" className="brk-h2">
          Every attempt so far
        </h2>
        <Counter board={p.board} nowMs={p.nowMs} replay={p.replay ?? REPLAY} />
        <Rows board={p.board} mineIds={p.mineIds} shop={shop} nowMs={p.nowMs} replay={p.replay ?? REPLAY} shown={p.shown ?? ROWS_STEP} {...(p.onMore === undefined ? {} : { onMore: p.onMore })} />
      </section>

      <section className="rob-fine" aria-label="Limits">
        <p className="brk-status">
          {`${p.limits === null || p.limits === undefined ? "The card's contract sets the most it may pay at once and in a day" : `The card may pay at most ${nearWords(p.limits.hardCap)} at once and ${nearWords(p.limits.dailyCap)} a day`}, to the one shop the owner booked. A request the contract does not allow is held for the owner or blocked outright. ${HOLD_SAFE} The owner does not approve holds on this page, so every hold here expires. Every attempt costs the card a little gas, which the team refills.`}
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

/** The board from the site state file, plus the attempts read after its cut (`fresh`, null when none were read). */
export function boardOfState(s: SiteState, fresh: readonly TryAttempt[] | null, nowMs: number, replay: Replay = REPLAY): Board {
  const r = s.rob;
  const holds = holdsAt(r, nowMs);
  const add = withExpiry(fresh ?? [], nowMs, r.ttl_ms);
  const n = countsOfTry(add);
  const sent = replayIds(replay);
  const b = countsOfTry(add.filter((a) => !sent.has(a.requestId)));
  const lastMs = [r.last_ms, n.lastMs].reduce<number | null>((m, x) => (x === null ? m : m === null || x > m ? x : m), null);
  const counts: TryCounts = { attempts: r.attempts + n.attempts, blocked: r.blocked + n.blocked, held: holds.open + n.held, expired: holds.expired + n.expired, paidShop: r.paid_shop + n.paidShop, paidOutside: r.paid_outside + n.paidOutside, lastMs };
  const seen = new Set(add.map((a) => a.requestId));
  const rows = [...add, ...withExpiry(r.rows, nowMs, r.ttl_ms).filter((a) => !seen.has(a.requestId))];
  return { counts, rows, truncated: r.truncated, total: counts.attempts, fromBrowsers: { attempts: r.from_browsers.attempts + b.attempts, paidOutside: r.from_browsers.paid_outside + b.paidOutside }, asOfMs: fresh === null ? s.as_of_ms : null };
}

export default function RobPage(): ReactElement {
  const [pub, setPub] = useState<RobViewProps['pub']>(null);
  const [site, setSite] = useState<SiteState | null>(() => bakedState());
  const [board, setBoard] = useState<Board>(() => {
    const b = bakedState();
    return b === null ? null : boardOfState(b, null, b.as_of_ms);
  });
  const [choice, setChoice] = useState<Choice>({ kind: 'preset', id: PRESETS[0]?.id ?? 'stranger' });
  const [mine, setMine] = useState<Mine>(null);
  const [mineIds, setMineIds] = useState<string[]>([]);
  const [nowMs, setNow] = useState(() => Date.now());
  const [ownPayee, setOwnPayee] = useState('');
  const [ownAmount, setOwnAmount] = useState('');
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState(ROWS_STEP);
  const cache = useRef(newTryCache());
  const fresh = useRef<TryAttempt[] | null>(null);
  // the card's limits: the state file's at first, then the contract's own views once the public file names the card
  const [liveLimits, setLiveLimits] = useState<CardLimits | null>(null);
  const limits = liveLimits ?? site?.rob.limits ?? null;
  const [check, setCheck] = useState<RobViewProps['check']>(null);

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
    // the counts and the newest rows from the site state file show at once; the live read below adds what came after its cut
    void loadSiteState().then((s) => {
      if (!live || s === null) return;
      setSite(s);
      setBoard((b) => (b !== null && b !== 'unreadable' && b.asOfMs === null ? b : boardOfState(s, fresh.current, Date.now())));
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (PRERENDER || pub === null || pub === 'unreadable' || !('policy' in pub)) return undefined;
    let live = true;
    readLimits({ rpcUrls: NEAR_RPC }, pub.policy).then(
      (l) => live && l !== null && setLiveLimits(l),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [pub]);

  // the preset picked first fills the fields once the public file names the shop
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || pub === null || pub === 'unreadable' || !('policy' in pub) || choice.kind !== 'preset') return;
    filled.current = true;
    const f = fieldsOf(choice.id, pub);
    setOwnPayee(f.payee);
    setOwnAmount(f.amount);
  }, [pub, choice]);

  useEffect(() => {
    if (PRERENDER || pub === null || pub === 'unreadable' || !('policy' in pub)) return undefined;
    let live = true;
    void (async () => {
      const s = site ?? (await loadSiteState());
      if (!live) return;
      try {
        const r = await readTryAttempts({ policy: pub.policy, agent: pub.agent, book: pub.book, nowMs: Date.now(), ttlMs: pub.pendingTtlMs ?? TTL_FALLBACK, cache: cache.current, ...(s === null ? {} : { sinceMs: s.cut_ms }) });
        if (!live) return;
        fresh.current = r.attempts;
        setBoard(s === null ? { counts: countsOfTry(r.attempts), rows: r.attempts, truncated: r.truncated } : boardOfState(s, r.attempts, Date.now()));
      } catch {
        // a throttled history API: the state file's numbers stay, dated; without the file there is nothing to show
        if (live) setBoard((b) => (b === null ? (s === null ? 'unreadable' : boardOfState(s, null, Date.now())) : b));
      }
    })();
    return () => {
      live = false;
    };
  }, [pub, tick, site]);

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
      setTimeout(() => {
        // the card's listing changed with this attempt: the read must not reuse an answer from before it
        historyFetch.clear();
        setTick((n) => n + 1);
      }, 4_000);
    });
  }, [pub, choice, mine, ownPayee, ownAmount]);

  // a change to the request clears the last answer, so an answer on screen is always the answer to what the fields say (not while one is sending)
  const clearAnswer = useCallback(() => setMine((m) => (m !== null && 'busy' in m ? m : null)), []);

  const onChoose = useCallback(
    (c: Choice) => {
      setChoice(c);
      if (c.kind === 'preset') {
        const f = fieldsOf(c.id, pub !== null && pub !== 'unreadable' && 'policy' in pub ? pub : null);
        setOwnPayee(f.payee);
        setOwnAmount(f.amount);
      }
      clearAnswer();
    },
    [pub, clearAnswer],
  );

  const onOwn = useCallback(
    (payee: string, amount: string) => {
      setOwnPayee(payee);
      setOwnAmount(amount);
      setChoice({ kind: 'own', payee, amount });
      clearAnswer();
    },
    [clearAnswer],
  );

  const onMore = useCallback(() => setShown((n) => n + ROWS_STEP), []);

  // a new answer clears the last browser check, so a check on screen is always for the request in the fields
  useEffect(() => setCheck(null), [mine]);

  /** The visitor's exact request through the shipped gate (public/verdict.wasm) with the card's limits: computed here, never sent. */
  const onCheck = useCallback(() => {
    if (pub === null || pub === 'unreadable' || !('policy' in pub)) return;
    const w = wishOf(choice.kind === 'own' ? { kind: 'own', payee: ownPayee, amount: ownAmount } : choice, pub);
    if ('refuse' in w) return;
    setCheck('running');
    void (async () => {
      try {
        const rpc = { rpcUrls: NEAR_RPC };
        const asset = await readAsset(rpc, pub.policy, w.asset);
        const lim = limits ?? (await readLimits(rpc, pub.policy));
        const gate = await loadVerdict();
        setCheck({ verdict: gate.decide(checkColumns(w, pub, asset, lim?.paused ?? false)) });
      } catch {
        setCheck('error');
      }
    })();
  }, [pub, choice, ownPayee, ownAmount, limits]);

  return <RobView pub={pub} board={board} shown={shown} onMore={onMore} choice={choice} mine={mine} mineIds={mineIds} nowMs={nowMs} ownPayee={ownPayee} ownAmount={ownAmount} onChoose={onChoose} onOwn={onOwn} onSend={onSend} limits={limits} check={check} onCheck={onCheck} />;
}

export { RobPage };

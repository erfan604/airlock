// AIR-359: /lend, "Lend to an agent". One click makes the visitor an account of their own (the public faucet, their key made in this browser),
// lends 1 NEAR from it into the live pool, and shows the position as a deposit slip: shares, what they are worth now, when they can be taken
// back, and the share value since the deposit as one drawn line. Every number on the page is read from the chain (the pool's views and its own
// event logs) or from schedule.json; when there is nothing to read the page says so instead of showing a number. The key never leaves the
// browser except in the restore link the visitor keeps.
import { isShortened, isUnshown } from '../components/chainText.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { NEAR_RPC } from '../../csp.ts';
import { TxLink } from '../credit/CreditPage.tsx';
import { readBook } from '../challenge/chainBoard.ts';
import { RpcError } from '../chain/rpc.ts';
import { eventLogs, functionCall, generateKey, keyFromSecret } from '../chain/tx.ts';
import type { Ed25519Key } from '../chain/tx.ts';
import { historyFetch } from '../chain/historyFetch.ts';
import { readPool } from '../credit/chain.ts';
import { asOfText, bakedState, loadSiteState } from '../state/siteState.ts';
import type { SiteState } from '../state/siteState.ts';
import { LP_STORAGE, formatNear } from '../credit/model.ts';
import type { PoolView } from '../credit/model.ts';
import { CREDIT_POOL } from '../credit/net.ts';
import { depositCall, sendPoolCall } from '../credit/wallet.ts';
import { PRERENDER, url } from '../static.ts';
import { attacksOnCards } from './attacks.ts';
import type { AttackCount } from './attacks.ts';
import { makeAccount } from './faucet.ts';
import { activePause, checkedHistory, clock, clockSeconds, countdown, joinOf, loopSentence, loopStatus, parseSchedule, sinceJoined, valueLine } from './history.ts';
import type { Schedule } from './history.ts';
import { adoptLink, decideLink, loadBackups, loadSaved, restoreLink, saveLender, switchTo, takeFragment, verifyLinkKey } from './keystore.ts';
import type { Link, Saved } from './keystore.ts';
import { countLenders, poolEvents, readAccountTxs, readLp } from './lenders.ts';
import type { LenderCount, LpView, PoolEvent, PoolTx } from './lenders.ts';

/** What the visitor lends: 1 NEAR is credited to the pool. */
export const LEND = 10n ** 24n;
/** The page attaches LEND plus the pool's one-time storage charge for a new lender (credit/model.ts LP_STORAGE), so exactly LEND is credited. */
export const ATTACH = LEND + LP_STORAGE;
const TGAS = 10n ** 12n;
const DEPOSIT_GAS = 60n * TGAS;
const WITHDRAW_GAS = 80n * TGAS;
const RPC = { rpcUrls: NEAR_RPC };

/** An account as the page prints it: no network suffix, and a long name cut after its first 11 characters. */
export function shortAccount(id: string): string {
  const bare = id.replace(/\.testnet$/, '');
  return bare.length > 14 ? `${bare.slice(0, 11)}…` : bare;
}

/** Four decimals rounded to the nearest (a floor of 0.99999 would read as a loss on a slip worth 1 NEAR less one yocto); BigInt only. */
export const near4 = (yocto: bigint): string => formatNear(((yocto + 5n * 10n ** 19n) / 10n ** 20n) * 10n ** 20n, 4);

export type Step = 'making' | 'made' | 'lending' | 'done';
export type Problem = { kind: 'limited'; resetMs: number | null } | { kind: 'unavailable' } | { kind: 'unsupported' } | { kind: 'deposit'; detail: string } | { kind: 'withdraw'; detail: string };

export type LinkNote = 'bad' | 'not-a-key' | 'unreadable';

const LINK_NOTE: Record<LinkNote, string> = {
  bad: 'This is not a lender link this page can read, so nothing was changed.',
  'not-a-key': 'The key in this link is not a key of that account, so nothing was changed.',
  unreadable: 'The link could not be checked on the chain just now, so nothing was changed. Open it again to try once more.',
};

export type ChainView = {
  pool: PoolView;
  events: PoolEvent[];
  truncated: boolean;
  lenders: LenderCount | null;
  /** `events` are only those after the site state file's cut; the file's last loop cycle stands in for the older part */
  loopKnownMs?: number | null;
};

export type Position = { saved: Saved; lp: LpView | null; attacks: AttackCount | null };

/** What came back from "Take my money back": the amount the pool's withdraw event logged, the account it went to, and the transaction. */
export type Receipt = { amount: bigint; accountId: string; tx: string };

/** A read the page waits on gives up and says so after this long (visitor test 2026-11-11: a bare "Counting..." ran past 4 s). */
export const GIVE_UP_MS = 10_000;

/** Which waits have run past GIVE_UP_MS with nothing read. */
export type Slow = { chain: boolean; lp: boolean; attacks: boolean };
const NOT_SLOW: Slow = { chain: false, lp: false, attacks: false };

export type LenderViewProps = {
  nowMs: number;
  /** the site state file: its lender count and loop line show at once, and stay (dated) when the history API cannot be read */
  site?: SiteState | null;
  chain: ChainView | null;
  chainFailed: boolean;
  schedule: Schedule | null;
  position: Position | null;
  steps: { step: Step; accountId: string | null } | null;
  problem: Problem | null;
  busy: boolean;
  walletTx: string | null;
  link: string | null;
  /** why a restore link was not taken, when it was not */
  linkNote: LinkNote | null;
  /** a checked link that is not this browser's record, waiting for the visitor's choice; `mine` is null when nothing is kept here */
  confirm: { linked: string; mine: string | null } | null;
  /** accounts kept in this browser that the visitor switched away from */
  backups: string[];
  onKeep(): void;
  onSwitch(): void;
  onSwitchBack(accountId: string): void;
  onLend(): void;
  /** lend 1 NEAR from the account already made (its deposit failed or was never sent) */
  onRetry(): void;
  onWithdraw(): void;
  onWallet(): void;
  onCopy(): void;
  copied: boolean;
  /** a deposit went through and the pool's view has not shown its shares yet: the slip says confirming, never a zero */
  confirming?: boolean;
  receipt?: Receipt | null;
  slow?: Slow;
};

/** The share value since the deposit, as one plain line: no axes, no grid, a start and an end label. */
function ValueLine({ points }: { points: { atMs: number; value: bigint }[] }): ReactElement | null {
  if (points.length < 2) return null;
  const W = 320;
  const H = 64;
  const vs = points.map((p) => p.value);
  const lo = vs.reduce((a, b) => (b < a ? b : a));
  const hi = vs.reduce((a, b) => (b > a ? b : a));
  const t0 = points[0]?.atMs ?? 0;
  const t1 = points.at(-1)?.atMs ?? t0;
  const span = hi - lo === 0n ? 1n : hi - lo;
  const d = points
    .map((p, i) => {
      const x = t1 === t0 ? (i / (points.length - 1)) * W : ((p.atMs - t0) / (t1 - t0)) * W;
      // BigInt to a 0..1000 step, then to pixels: the drawn height only, never a shown number
      const y = H - 4 - (Number(((p.value - lo) * 1000n) / span) / 1000) * (H - 8);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <figure className="lend-line" data-testid="lend-line">
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} preserveAspectRatio="none" role="img" aria-label={`Your share value from ${near4(points[0]?.value ?? 0n)} to ${near4(points.at(-1)?.value ?? 0n)} NEAR`}>
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="lend-line-ends">
        <span>{`${near4(points[0]?.value ?? 0n)} at ${clock(t0)}`}</span>
        <span>{`${near4(points.at(-1)?.value ?? 0n)} at ${clock(t1)}`}</span>
      </figcaption>
    </figure>
  );
}

function Progress({ steps, problem }: { steps: LenderViewProps['steps']; problem: Problem | null }): ReactElement | null {
  if (steps === null) return null;
  const order: Step[] = ['making', 'made', 'lending', 'done'];
  const at = order.indexOf(steps.step);
  const words: Record<Step, string> = {
    making: 'Making your account.',
    made: `Account made: ${steps.accountId === null ? '' : shortAccount(steps.accountId)}`,
    lending: 'Lending 1 NEAR.',
    done: 'Done: you are a lender.',
  };
  return (
    <ol className="lend-progress" data-testid="lend-progress" aria-live="polite">
      {order.slice(0, at + 1).map((s, i) => (
        <li key={s} data-done={i < at || s === 'done' ? 'true' : undefined} data-failed={problem !== null && i === at ? 'true' : undefined}>
          {words[s]}
        </li>
      ))}
    </ol>
  );
}

function problemText(p: Problem): string {
  if (p.kind === 'limited') return `The faucet did not answer (busy, or out of NEAR for your address today${p.resetMs === null ? '' : `; it gives more after ${clock(p.resetMs)}`}). You can lend from your own wallet instead.`;
  if (p.kind === 'unavailable') return 'The faucet did not answer (busy, or out of NEAR for your address today). You can lend from your own wallet instead.';
  if (p.kind === 'unsupported') return 'This browser cannot make the key this page needs (Ed25519 in WebCrypto). You can lend from your own wallet instead.';
  if (p.kind === 'deposit') return `The deposit did not go through: ${p.detail}. Your account and its key are kept in this browser, so you can lend from it again below.`;
  return `The withdrawal did not go through: ${p.detail}.`;
}

type SlipProps = { pos: Position; nowMs: number; chain: ChainView | null; link: string | null; onWithdraw(): void; onRetry(): void; onCopy(): void; copied: boolean; busy: boolean; confirming: boolean; receipt: Receipt | null; slow: boolean };

/** The note under the slip's fields: confirming, the countdown to the end of the hold, or that the money can come back now. */
function slipNote(lp: LpView | null, confirming: boolean, nowMs: number): string {
  if (confirming) return 'Your deposit went through. Your shares show here as soon as the chain reports them, usually within a few seconds. ';
  if (lp === null) return '';
  if (lp.shares === 0n) return 'You hold no shares now. ';
  const left = countdown(lp.lockedUntilMs, nowMs);
  return left === null ? 'You can take your money back now. ' : `You can take your money back in ${left} (at ${clockSeconds(lp.lockedUntilMs)}). `;
}

function Slip({ pos, nowMs, chain, link, onWithdraw, onRetry, onCopy, copied, busy, confirming, receipt, slow }: SlipProps): ReactElement {
  const lp = pos.lp;
  const waiting = confirming ? 'confirming on chain' : slow ? 'not read yet' : 'reading the pool';
  const join = chain === null ? null : joinOf(chain.events, pos.saved.accountId);
  const history = chain === null ? null : checkedHistory(chain.events, { assets: BigInt(chain.pool.assets), shares: BigInt(chain.pool.shares) }, pos.saved.accountId);
  const line = history === null ? [] : valueLine(history);
  const tx = pos.saved.depositTx ?? join?.tx ?? null;
  const unlocked = lp !== null && nowMs >= lp.lockedUntilMs;
  return (
    <section className="lend-slip-wrap" aria-labelledby="lend-slip-title" data-testid="lend-position">
      <div className="lend-slip">
        <h2 id="lend-slip-title" className="lend-slip-head">
          Deposit slip
        </h2>
        <dl className="lend-slip-fields">
          <dt>Account</dt>
          <dd data-testid="lend-account">{shortAccount(pos.saved.accountId)}</dd>
          <dt>Shares</dt>
          <dd className="lend-num" data-testid="lend-shares" data-state={confirming ? 'confirming' : undefined}>
            {lp === null || confirming ? waiting : near4(lp.shares)}
          </dd>
          <dt>Worth now</dt>
          <dd className="lend-num" data-testid="lend-worth">{lp === null || confirming ? waiting : `${near4(lp.value)} NEAR`}</dd>
        </dl>
        {line.length >= 2 ? <ValueLine points={[...line.slice(0, -1), { atMs: nowMs, value: lp?.value ?? line.at(-1)?.value ?? 0n }]} /> : null}
        <p className="lend-slip-note" data-testid="lend-slip-note">
          {slipNote(lp, confirming, nowMs)}
          {tx === null ? null : (
            // the explorer link is the reviewed one of the credit page (its href is on the security-pass allow list); /lend adds no URL sink
            <span data-testid="lend-deposit-link">
              Your deposit: <TxLink tx={tx} what="deposit" label="see the transaction" />
            </span>
          )}
        </p>
      </div>
      {receipt === null ? null : (
        <p className="lend-note" role="status" data-testid="lend-receipt">
          {`Your money came back: ${near4(receipt.amount)} NEAR to ${shortAccount(receipt.accountId)}. `}
          <TxLink tx={receipt.tx} what="withdrawal" label="See the transaction" />.
        </p>
      )}
      {lp !== null && lp.shares === 0n && tx === null && !confirming ? (
        <button type="button" className="act act-primary" data-testid="lend-retry" disabled={busy} onClick={onRetry}>
          Lend 1 NEAR from this account
        </button>
      ) : null}
      {lp !== null && lp.shares > 0n && !confirming ? (
        <button type="button" className="act act-quiet lend-withdraw" data-testid="lend-withdraw" disabled={!unlocked || busy} onClick={onWithdraw}>
          Take my money back
        </button>
      ) : null}
      {link === null ? null : (
        <div className="lend-keep">
          <p>
            <span className="lend-key">This link is your login.</span> Save it to come back from another device. Anyone who has it can take your position.
          </p>
          <button type="button" className="act act-quiet" data-testid="lend-copy" onClick={onCopy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
    </section>
  );
}

/** The loop line from the site state file alone: a planned pause is read at the visitor's time, the last cycle as of the file. */
export function stateLoop(site: SiteState, schedule: Schedule, nowMs: number): string {
  const paused = activePause(schedule, nowMs) !== null;
  const line = loopSentence(loopStatus([], schedule, paused ? nowMs : site.as_of_ms, site.loop.last_ms));
  return paused ? line : `${line} Read from the chain, ${asOfText(site.as_of_ms)}.`;
}

/** The lenders outside the team, said so that zero reads as "none yet", not as a broken counter. */
export function lendersSentence(l: LenderCount, truncated: boolean): string {
  const where = `counted from the pool's own deposit records${truncated ? ', newest part' : ''}; the team's accounts are listed in the code`;
  const n = l.soFar.length;
  if (n === 0) return `No lender from outside the team yet (${where}).`;
  return `${String(n)} lender ${n === 1 ? 'account' : 'accounts'} from outside the team so far, ${String(l.now)} of them lending now (${where}).`;
}

/** The loop's borrowing since the lender joined; null while the loop has never run (the loop line below says so, once). */
function sinceSentence(chain: ChainView, schedule: Schedule, joinMs: number, nowMs: number): string | null {
  const loop = loopStatus(chain.events, schedule, nowMs);
  const s = sinceJoined(chain.events, schedule, joinMs);
  if (loop.kind === 'not-started' && s.borrowed === 0) return null;
  if (s.borrowed === 0) return 'Since you joined: the agent has not borrowed from the pool yet.';
  const fee = s.feeBps === null ? '' : ` with a ${String(s.feeBps / 100n)} percent fee`;
  const back = s.repaid === s.borrowed ? `paid back each time${fee}` : `paid back ${String(s.repaid)} of them${fee}`;
  return `Since you joined: the agent borrowed ${String(s.borrowed)} ${s.borrowed === 1 ? 'time' : 'times'} and ${back}.`;
}

export function LenderView(p: LenderViewProps): ReactElement {
  const pause = p.schedule === null ? null : activePause(p.schedule, p.nowMs);
  const pastDue = p.chain?.pool.lines.some((l) => l.state === 'open' && BigInt(l.dueMs) < BigInt(p.nowMs)) ?? false;
  const lossOpen = p.chain !== null && BigInt(p.chain.pool.losses) > 0n;
  const closed = pause !== null ? `Lending is off until ${clock(Date.parse(pause.to))}: ${pause.why}.` : pastDue ? 'Deposits are paused while a credit line is past due.' : lossOpen ? 'Deposits are paused while a loss is being recovered.' : null;
  const join = p.position === null || p.chain === null ? null : joinOf(p.chain.events, p.position.saved.accountId);
  const since = p.position === null || p.chain === null || p.schedule === null || join === null ? null : sinceSentence(p.chain, p.schedule, join.atMs, p.nowMs);
  const slow = p.slow ?? NOT_SLOW;
  const site = p.site ?? null;
  const fallback = p.problem !== null && (p.problem.kind === 'limited' || p.problem.kind === 'unavailable' || p.problem.kind === 'unsupported');
  return (
    <main className="page lend" data-testid="lend">
      <header className="lend-head">
        <h1 className="lend-title">Lend to an agent</h1>
        <p className="lend-lead">Put money in the pool that lends to AI agents. This page makes you an account, funds it from the public faucet, and lends 1 NEAR from it. Your key stays in this browser.</p>
      </header>

      {p.linkNote === null ? null : (
        <p className="lend-note" role="status" data-testid="lend-link-note">
          {LINK_NOTE[p.linkNote]}
        </p>
      )}
      {p.confirm === null ? null : (
        <section className="lend-confirm" aria-label="Which account" data-testid="lend-confirm">
          <p>
            {p.confirm.mine === null
              ? `This link opens the lender account ${shortAccount(p.confirm.linked)}. Whoever made the link holds its key and can move what is lent from it, so use it when the link is your own.`
              : `This link holds a different lender account (${shortAccount(p.confirm.linked)}) than the one kept in this browser (${shortAccount(p.confirm.mine)}). Which one should this page show? Whichever you leave stays kept in this browser.`}
          </p>
          <div className="lend-confirm-acts">
            <button type="button" className="act act-primary" data-testid="lend-keep-mine" onClick={p.onKeep}>
              {p.confirm.mine === null ? 'Ignore the link' : 'Keep mine'}
            </button>
            <button type="button" className="act act-quiet" data-testid="lend-switch-linked" onClick={p.onSwitch}>
              {p.confirm.mine === null ? 'Use this account' : 'Switch to the linked account'}
            </button>
          </div>
        </section>
      )}

      {p.position === null ? (
        <section className="lend-act" aria-label="Lend">
          <button type="button" className="act act-primary lend-go" data-testid="lend-go" disabled={p.busy || closed !== null || p.steps !== null} onClick={p.onLend}>
            Make my account and lend 1 NEAR
          </button>
          <p className="lend-fine" data-testid="lend-storage">
            {`It sends ${formatNear(ATTACH, 4)} NEAR: 1 NEAR into the pool, and 0.0025 NEAR once for your storage entry, charged by the contract.`}
          </p>
          {closed === null ? null : <p className="lend-note" data-testid="lend-closed">{closed}</p>}
        </section>
      ) : null}

      <Progress steps={p.steps} problem={p.problem} />
      {p.problem === null ? null : (
        <div className="lend-problem" role="alert" data-testid="lend-problem">
          <p>{problemText(p.problem)}</p>
          {fallback ? (
            <button type="button" className="act act-quiet" data-testid="lend-wallet" onClick={p.onWallet} disabled={p.busy}>
              Connect a wallet
            </button>
          ) : null}
        </div>
      )}
      {p.walletTx === null ? null : (
        <p className="lend-note" data-testid="lend-wallet-tx">
          Your wallet sent the deposit: <TxLink tx={p.walletTx} what="deposit" label="see the transaction" />.
        </p>
      )}

      {p.position === null ? null : (
        <Slip pos={p.position} nowMs={p.nowMs} chain={p.chain} link={p.link} onWithdraw={p.onWithdraw} onRetry={p.onRetry} onCopy={p.onCopy} copied={p.copied} busy={p.busy} confirming={p.confirming ?? false} receipt={p.receipt ?? null} slow={slow.lp} />
      )}

      {p.backups.length === 0 ? null : (
        <div className="lend-backups" data-testid="lend-backups">
          <p>{`Also kept in this browser: ${p.backups.map(shortAccount).join(', ')}`}</p>
          {p.backups.map((b) => (
            <button key={b} type="button" className="act act-quiet" data-testid="lend-switch-back" onClick={() => p.onSwitchBack(b)} disabled={p.busy}>
              {`Switch to ${shortAccount(b)}`}
            </button>
          ))}
        </div>
      )}

      <section className="lend-ledger" aria-label="The pool">
        {p.position !== null && p.chain !== null && p.schedule !== null && join !== null ? (
          <>
            {since === null ? null : <p data-testid="lend-since">{since}</p>}
            <p data-testid="lend-attacks">
              {p.position.attacks === null
                ? slow.attacks
                  ? "The attacks on the card this pool lends to could not be counted just now: the card's transactions did not arrive, so no count is shown."
                  : "Counting the attacks refused on the card this pool lends to since you joined, from the card's transactions."
                : `Attacks refused on the card this pool lends to since you joined: ${String(p.position.attacks.refused)}.${p.position.attacks.paidToAttacker === null ? '' : ` Paid to an attacker: ${near4(p.position.attacks.paidToAttacker).replace(/\.?0+$/, '')} NEAR.`}`}
            </p>
          </>
        ) : null}
        <p data-testid="lend-lenders">
          {(p.chain === null || p.chain.lenders === null) && site !== null
            ? `${lendersSentence({ soFar: site.lenders.outside, now: site.lenders.outside_now, truncated: site.lenders.truncated }, site.lenders.truncated)} Counted ${asOfText(site.as_of_ms)}.`
            : p.chainFailed && p.chain === null
            ? 'The pool could not be read just now, so no lender count is shown.'
            : p.chain?.lenders === null || p.chain === null
              ? slow.chain
                ? `The lender count did not arrive within ${String(GIVE_UP_MS / 1000)} seconds: the public transaction index the page reads the pool's deposit records from was slow or refused. No count is shown; reload the page to try again.`
                : "Counting lender accounts: reading the pool's deposit records from a public transaction index."
              : lendersSentence(p.chain.lenders, p.chain.truncated)}
        </p>
        <p data-testid="lend-loop">
          {p.chain !== null && p.schedule !== null
            ? loopSentence(loopStatus(p.chain.events, p.schedule, p.nowMs, p.chain.loopKnownMs ?? null))
            : site !== null && p.schedule !== null
              ? stateLoop(site, p.schedule, p.nowMs)
            : p.chainFailed || slow.chain
              ? "The loop's last cycle could not be read just now, so it is not shown."
              : "Reading the loop's last cycle from the pool's transaction history."}
        </p>
        <p className="lend-fine">The borrower and the supplier in the hourly loop are accounts the team runs, and the fee comes from the team&apos;s money. This shows how the pool works. It is not a market.</p>
        <p className="lend-fine" data-testid="lend-limits">
          Runs on the NEAR test network, where NEAR has no value. The faucet gives each internet address 10 accounts every 12 hours. You can take your money back 1 minute after lending, as long as the pool has money that is not lent out.
        </p>
        <p className="lend-fine">
          The pool itself, its credit lines and their payments: <a href={url('credit')}>the credit page</a>.
        </p>
      </section>
    </main>
  );
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A just-made account's key can take a moment to reach the node the page asks: a missing key or account is asked again, up to about 15 s. */
async function callWhenKeyLands<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const name = e instanceof RpcError ? `${e.message} ${e.causeName ?? ''}` : '';
      if (i >= 9 || !/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(name)) throw e;
      await sleep(1_500);
    }
  }
}

/** The amount a pool `withdraw` event logged (yocto, a decimal string in the event), or null when the line is not in that shape. */
export function withdrawnAmount(line: string): bigint | null {
  const m = /"amount":"(0|[1-9][0-9]{0,38})"/.exec(line);
  return m?.[1] === undefined ? null : BigInt(m[1]);
}

function failureOf(outcome: unknown): string | null {
  const status = typeof outcome === 'object' && outcome !== null ? (outcome as { status?: unknown }).status : undefined;
  if (typeof status === 'object' && status !== null && 'Failure' in status) return 'the contract refused it';
  return null;
}

export default function LenderPage(): ReactElement {
  const [nowMs, setNow] = useState(() => Date.now());
  const [chain, setChain] = useState<ChainView | null>(null);
  const [chainFailed, setChainFailed] = useState(false);
  const [site, setSite] = useState<SiteState | null>(() => bakedState());
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [lp, setLp] = useState<LpView | null>(null);
  const [attacks, setAttacks] = useState<AttackCount | null>(null);
  const [steps, setSteps] = useState<LenderViewProps['steps']>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [walletTx, setWalletTx] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  // after the visitor's own deposit or withdrawal the pool is read again at once and twice more: views read final blocks (about 2 s behind)
  // and the history API indexes a call some seconds later, so the first read can still count the lender as before the call
  const later = useRef<ReturnType<typeof setTimeout>[]>([]);
  const reloadSoon = useCallback(() => {
    for (const t of later.current) clearTimeout(t);
    const again = (): void => {
      historyFetch.clear();
      setReload((n) => n + 1);
    };
    again();
    later.current = [4_000, 12_000].map((ms) => setTimeout(again, ms));
  }, []);
  useEffect(() => () => later.current.forEach((t) => clearTimeout(t)), []);
  const [linkNote, setLinkNote] = useState<LinkNote | null>(null);
  const [pending, setPending] = useState<Link | null>(null);
  const [backups, setBackups] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  // when each wait began, so its line can give up with a sentence instead of reading forever
  const [chainSince, setChainSince] = useState(() => Date.now());
  const [lpSince, setLpSince] = useState(() => Date.now());
  const [attacksSince, setAttacksSince] = useState(() => Date.now());

  // a restore link: out of the address bar at once; checked on chain (its key must be a key of the named account); taken as is when it is
  // the saved record, else held until the visitor chooses, also when nothing is saved: a link somebody else made would put the visitor on an
  // account whose key that person holds (security review of AIR-359, red team 2026-11-11)
  useEffect(() => {
    if (PRERENDER) return undefined;
    let live = true;
    const takeLink = (): void => {
      const f = takeFragment(window.location, window.history);
      const current = loadSaved(storage());
      setSaved(current);
      setBackups(loadBackups(storage()).map((b) => b.accountId));
      setLinkNote(f.kind === 'bad' ? 'bad' : null);
      if (f.kind !== 'key') return;
      const link = { accountId: f.accountId, secretKey: f.secretKey };
      void verifyLinkKey(RPC, link).then((v) => {
        if (!live) return;
        if (v !== 'ok') return setLinkNote(v);
        if (decideLink(current, link) !== 'same') return setPending(link);
        setSaved(adoptLink(storage(), link, Date.now()));
      });
    };
    takeLink();
    // a link opened while the page is already open only changes the fragment: read it the same way
    window.addEventListener('hashchange', takeLink);
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      live = false;
      window.removeEventListener('hashchange', takeLink);
      clearInterval(t);
    };
  }, []);

  const onKeep = useCallback(() => setPending(null), []);
  const onSwitch = useCallback(() => {
    if (pending === null) return;
    const next = adoptLink(storage(), pending, Date.now());
    setPending(null);
    setLp(null);
    setAttacks(null);
    setSteps(null);
    setProblem(null);
    setConfirming(false);
    setReceipt(null);
    setSaved(next);
    setBackups(loadBackups(storage()).map((b) => b.accountId));
  }, [pending]);
  const onSwitchBack = useCallback((accountId: string) => {
    const next = switchTo(storage(), accountId);
    if (next === null) return;
    setLp(null);
    setAttacks(null);
    setSteps(null);
    setProblem(null);
    setConfirming(false);
    setReceipt(null);
    setSaved(next);
    setBackups(loadBackups(storage()).map((b) => b.accountId));
  }, []);

  useEffect(() => {
    if (PRERENDER) return undefined;
    let live = true;
    void fetch(url('lender/schedule.json'))
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((j) => live && setSchedule(parseSchedule(j)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // the pool: its view, its event history and the lender count. With the site state file, a visitor who holds no position reads only the history
  // after the file's cut (the file counts the rest); a lender's own slip folds the whole history, so then it is read in full.
  const savedId = saved?.accountId ?? null;
  useEffect(() => {
    if (PRERENDER) return undefined;
    let live = true;
    setChainSince(Date.now());
    void (async () => {
      const s = await loadSiteState();
      if (!live) return;
      setSite(s);
      // a lender the state file shows cut or hidden (components/chainText.ts) cannot be read by name: the history is then read in full
      const full = s === null || savedId !== null || loadSaved(storage()) !== null || s.lenders.outside.some((a) => isShortened(a) || isUnshown(a));
      try {
        const [pool, read] = await Promise.all([readPool({ pool: CREDIT_POOL, rpcUrls: NEAR_RPC }), readAccountTxs(historyFetch, CREDIT_POOL, full ? {} : { sinceMs: s.cut_ms })]);
        const events = poolEvents(read.txs, CREDIT_POOL);
        if (!live) return;
        const truncated = full ? read.truncated : s.lenders.truncated;
        const loopKnownMs = full ? null : s.loop.last_ms;
        // a read again keeps the last count on screen until the new one is in, so the line does not blink back to the file's number
        setChain((prev) => ({ pool, events, truncated, lenders: prev?.lenders ?? null, loopKnownMs }));
        setChainFailed(false);
        const lenders = await countLenders(events, truncated, (a) => readLp(RPC, CREDIT_POOL, a), undefined, full ? [] : s.lenders.outside);
        if (live) setChain({ pool, events, truncated, lenders, loopKnownMs });
      } catch {
        if (live) setChainFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [reload, savedId]);

  // the visitor's own position, read again every 20 s and a few seconds after their own call (views read final blocks, which trail by about 2 s)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (saved === null || PRERENDER) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [saved]);
  useEffect(() => {
    if (saved === null || PRERENDER) return undefined;
    let live = true;
    setLpSince(Date.now());
    const read = (): void => {
      void readLp(RPC, CREDIT_POOL, saved.accountId).then(
        (v) => {
          if (!live) return;
          setLp(v);
          if (v.shares > 0n) setConfirming(false);
        },
        () => undefined,
      );
    };
    read();
    // a view reads final blocks, which trail a just-sent deposit: ask again soon and often until the shares show
    const later = [1_500, 3_000, 5_000, 8_000, 12_000, 20_000].map((ms) => setTimeout(read, ms));
    return () => {
      live = false;
      later.forEach(clearTimeout);
    };
  }, [saved, reload, tick]);

  // the attacks on the pool's cards since the lender joined
  useEffect(() => {
    if (saved === null || PRERENDER) return undefined;
    let live = true;
    setAttacksSince(Date.now());
    if (chain !== null) {
      const join = joinOf(chain.events, saved.accountId);
      const cards = chain.pool.lines.map((l) => l.card);
      if (join !== null) {
        void (async () => {
          const byCard = new Map<string, { txs: readonly PoolTx[]; book: ReadonlySet<string> | null }>();
          for (const card of cards) {
            // the live card keeps its book private (no get_book view): then the refusals are counted and no paid-out number is shown
            // only the card's transactions since the lender joined are counted, so the listing stops there
            const [txs, book] = await Promise.all([readAccountTxs(historyFetch, card, { sinceMs: join.atMs - 1 }), readBook(fetch, card).then((b) => new Set(b), () => null)]);
            byCard.set(card, { txs: txs.txs, book });
          }
          if (live) setAttacks(attacksOnCards(byCard, cards, join.atMs, Date.now()));
        })().catch(() => undefined);
      }
    }
    return () => {
      live = false;
    };
  }, [saved, chain]);

  const link = useMemo(() => (saved === null || PRERENDER ? null : restoreLink(`${window.location.origin}${window.location.pathname}`, saved)), [saved]);

  /** Lends 1 NEAR from a made account. Success is the pool's own deposit event in the outcome, not the HTTP status. */
  const lendFrom = useCallback(async (record: Saved, key: Ed25519Key): Promise<void> => {
    setSteps({ step: 'lending', accountId: record.accountId });
    try {
      const r = await callWhenKeyLands(() => functionCall(RPC, key, { signerId: record.accountId, receiverId: CREDIT_POOL, method: 'deposit', args: {}, gas: DEPOSIT_GAS, deposit: ATTACH, random: Math.random }));
      const ok = eventLogs(r.outcome, CREDIT_POOL).some((l) => l.includes('"event":"deposit"') && l.includes(record.accountId));
      if (!ok) throw new Error(failureOf(r.outcome) ?? 'the pool logged no deposit');
      const done: Saved = { ...record, depositTx: r.hash };
      saveLender(storage(), done);
      setConfirming(true);
      setReceipt(null);
      setSaved(done);
      setSteps({ step: 'done', accountId: record.accountId });
      // the pool's listing changed with this deposit: the next reads must not reuse an answer from before it
      reloadSoon();
    } catch (e) {
      setSaved(record);
      setProblem({ kind: 'deposit', detail: e instanceof RpcError ? e.message : e instanceof Error ? e.message : 'unknown' });
    }
  }, [reloadSoon]);

  const onLend = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    void (async () => {
      let key;
      try {
        key = await generateKey();
      } catch {
        setProblem({ kind: 'unsupported' });
        setBusy(false);
        return;
      }
      setSteps({ step: 'making', accountId: null });
      const made = await makeAccount(key.publicKeyText, { fetch: fetch.bind(globalThis) });
      if (made.kind !== 'ok') {
        setProblem(made.kind === 'limited' ? { kind: 'limited', resetMs: made.resetMs } : { kind: 'unavailable' });
        setBusy(false);
        return;
      }
      const record: Saved = { accountId: made.accountId, secretKey: key.secretKeyText, createdMs: Date.now(), depositTx: null };
      saveLender(storage(), record);
      setSteps({ step: 'made', accountId: made.accountId });
      await lendFrom(record, key);
      setBusy(false);
    })();
  }, [busy, lendFrom]);

  const onRetry = useCallback(() => {
    if (saved === null || busy) return;
    setBusy(true);
    setProblem(null);
    void (async () => {
      try {
        await lendFrom(saved, await keyFromSecret(saved.secretKey));
      } catch (e) {
        setProblem({ kind: 'deposit', detail: e instanceof Error ? e.message : 'unknown' });
      }
      setBusy(false);
    })();
  }, [saved, busy, lendFrom]);

  const onWithdraw = useCallback(() => {
    if (saved === null || lp === null || lp.shares === 0n || busy) return;
    setBusy(true);
    setProblem(null);
    void (async () => {
      try {
        const key = await keyFromSecret(saved.secretKey);
        const r = await functionCall(RPC, key, { signerId: saved.accountId, receiverId: CREDIT_POOL, method: 'withdraw', args: { shares: lp.shares.toString() }, gas: WITHDRAW_GAS, deposit: 0n, random: Math.random });
        const line = eventLogs(r.outcome, CREDIT_POOL).find((l) => l.includes('"event":"withdraw"'));
        if (line === undefined) throw new Error(failureOf(r.outcome) ?? 'the pool logged no withdrawal');
        const amount = withdrawnAmount(line);
        if (amount !== null) setReceipt({ amount, accountId: saved.accountId, tx: r.hash });
        // the old shares are gone: read the position again rather than show them beside the receipt
        setLp(null);
        reloadSoon();
      } catch (e) {
        setProblem({ kind: 'withdraw', detail: e instanceof Error ? e.message : 'unknown' });
      }
      setBusy(false);
    })();
  }, [saved, lp, busy, reloadSoon]);

  const onWallet = useCallback(() => {
    setBusy(true);
    void sendPoolCall(depositCall(CREDIT_POOL, ATTACH)).then((r) => {
      if (r.ok && r.tx !== '') setWalletTx(r.tx);
      setBusy(false);
    });
  }, []);

  const onCopy = useCallback(() => {
    if (link === null) return;
    void navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  }, [link]);

  const position = saved === null ? null : { saved, lp, attacks };
  const slow: Slow = {
    chain: (chain === null || chain.lenders === null) && nowMs - chainSince > GIVE_UP_MS,
    lp: lp === null && nowMs - lpSince > GIVE_UP_MS,
    attacks: attacks === null && chain !== null && nowMs - attacksSince > GIVE_UP_MS,
  };
  const confirm = pending === null ? null : { linked: pending.accountId, mine: saved?.accountId ?? null };
  return <LenderView site={site} linkNote={linkNote} confirm={confirm} backups={backups} onKeep={onKeep} onSwitch={onSwitch} onSwitchBack={onSwitchBack} nowMs={nowMs} chain={chain} chainFailed={chainFailed} schedule={schedule} position={position} steps={steps} problem={problem} busy={busy} walletTx={walletTx} link={link} onLend={onLend} onRetry={onRetry} onWithdraw={onWithdraw} onWallet={onWallet} onCopy={onCopy} copied={copied} confirming={confirming} receipt={receipt} slow={slow} />;
}

export { LenderPage };

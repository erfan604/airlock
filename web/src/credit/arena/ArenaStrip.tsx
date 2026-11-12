// AIR-336: the Arena strip of /credit. Injection emails, written by an attacker model or by a fixed rule set, were sent against the card's
// agent; every attempt is a public transaction of the agent account, and the counts here are read from the chain. The strip shows nothing
// until there is a round to show (an attempt on the chain, or a recorded email), and its copy is in the past tense. Plain neutral layout from
// the page's own classes: colour only on the verdict word, no bars, no glow. The feed rows' entry animation is the page's own, which its
// stylesheet turns off under reduced motion. The explorer link is the page's own component, passed in as `Link`.
import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';
import { STATIC } from '../../static.ts';
import { asOfText, loadSiteState } from '../../state/siteState.ts';
import type { SiteState } from '../../state/siteState.ts';
import { nextDelay } from '../useCredit.ts';
import { ARENA_CRON_SINCE_MS, ARENA_STRICT_SINCE_MS } from './config.ts';
import { VERDICT_TONE, VERDICT_WORD, countsOf, dateText, headline } from './model.ts';
import type { ArenaAttempt } from './model.ts';
import { newArenaCache, readArena } from './read.ts';
import type { ArenaRead } from './read.ts';
import samplesFile from './samples.json' with { type: 'json' };

/** `source`: who wrote the email, the attacker model or the rule set that stands in for it. */
export type ArenaSample = { at: string; subject: string; body: string; verdict: string; reason: string | null; tx: string | null; source?: 'model' | 'rules' | 'scripted' };
/** `truncated`: the read stopped at its page cap, so older attempts may exist. */
/** `asOfMs`: the attempts are the site state file's, written then, and the live read has not added to them. */
export type ArenaState = { kind: 'loading' } | { kind: 'off' } | { kind: 'unreadable' } | { kind: 'ok'; attempts: ArenaAttempt[]; truncated: boolean; stale?: boolean; asOfMs?: number | null };
/** The page's explorer link for one transaction hash. */
export type ArenaLink = ComponentType<{ tx: string | null; what: string }>;

/**
 * The base interval of the arena read: one round lands at most every 65 minutes, so a minute is plenty; failures back off as useCredit's do.
 * The read keeps a cache for the life of the page, so a refresh costs one listing call unless the card has new transactions.
 */
export const ARENA_POLL_MS = 60_000;

export function useArena(): ArenaState {
  const [state, setState] = useState<ArenaState>({ kind: 'loading' });
  const session = useRef(0);
  useEffect(() => {
    // the live console's policy does not name the FastNEAR transaction host: the attempts are read on the hosted site only
    if (!STATIC) {
      setState({ kind: 'off' });
      return;
    }
    const mine = ++session.current;
    const cache = newArenaCache();
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let site: SiteState | null = null;
    const cycle = async (): Promise<void> => {
      // the site state file holds every attempt up to its cut, so the strip shows at once and the read asks only for what came after
      site ??= await loadSiteState();
      if (!live || session.current !== mine) return;
      const known = site;
      if (known !== null) setState((s) => (s.kind === 'ok' ? s : { kind: 'ok', attempts: known.arena.attempts, truncated: known.arena.truncated, asOfMs: known.as_of_ms }));
      let got: ArenaRead | null = null;
      try {
        got = await readArena({ cache, ...(known === null ? {} : { sinceMs: known.cut_ms }) });
      } catch {
        got = null;
      }
      if (!live || session.current !== mine) return;
      if (got === null) {
        failures += 1;
        setState((s) => (s.kind === 'ok' ? (s.asOfMs === undefined || s.asOfMs === null ? { ...s, stale: true } : s) : { kind: 'unreadable' }));
      } else {
        failures = 0;
        const attempts = known === null ? got.attempts : [...known.arena.attempts, ...got.attempts.filter((a) => !known.arena.attempts.some((k) => k.tx === a.tx))];
        setState({ kind: 'ok', attempts, truncated: known === null ? got.truncated : known.arena.truncated, asOfMs: null });
      }
      timer = setTimeout(() => void cycle(), failures === 0 ? ARENA_POLL_MS : Math.max(ARENA_POLL_MS, nextDelay(failures) * 4));
    };
    void cycle();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return state;
}

function Count({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="cr-stat" data-testid={testId}>
      <span className="cr-stat-label">{label}</span>
      <p className="cr-stat-value">{value}</p>
    </div>
  );
}

// spacing between the strip's blocks, on the page's own scale (the page stylesheet is not this ticket's to edit)
const GAP = { marginTop: 'var(--space-4)' } as const;
const HEAD_GAP = { marginTop: 'var(--space-7)' } as const;

const WORD_OF = (v: string): string => (Object.hasOwn(VERDICT_WORD, v) ? VERDICT_WORD[v as keyof typeof VERDICT_WORD] : v);
const TONE_OF = (v: string): string => (Object.hasOwn(VERDICT_TONE, v) ? VERDICT_TONE[v as keyof typeof VERDICT_TONE] : 'plain');
const WRITER: Readonly<Record<string, string>> = { model: ', written by the attacker model', rules: ', generated by rules' };

export function ArenaView({
  state,
  nowMs,
  cronSinceMs,
  strictSinceMs = null,
  samples,
  Link,
}: {
  state: ArenaState;
  nowMs: number;
  cronSinceMs: number | null;
  /** when the card went strict (every amount read from text held), or null while it has a cap */
  strictSinceMs?: number | null;
  samples: readonly ArenaSample[];
  Link: ArenaLink;
}): ReactElement | null {
  const attempts = state.kind === 'ok' ? state.attempts.filter((a) => a.verdict !== 'none') : [];
  // nothing is said about the arena until there is a round to show: an attempt read from the chain, or a recorded email
  if (attempts.length === 0 && samples.length === 0) return null;
  const c = countsOf(attempts);
  const h = headline({ attempts, nowMs, cronSinceMs, truncated: state.kind === 'ok' && state.truncated });
  const rows = attempts.slice(-5).reverse();
  return (
    <section className="cr-wide" aria-labelledby="cr-arena-h" data-testid="credit-arena">
      <h2 id="cr-arena-h" className="cr-h2">
        Credit Arena
      </h2>
      <p className="cr-note">
        Injection emails were sent against this card's agent, written by an attacker model or, when the model path failed, by a fixed rule set. The agent read
        each one next to a real invoice and asked the card to pay. Every request is a public transaction
        {attempts.length === 0 ? '.' : ', and the counts below are read from the chain.'}
      </p>
      {state.kind === 'loading' ? (
        <p className="cr-note" aria-busy="true" data-testid="arena-loading">
          Reading the arena's transactions.
        </p>
      ) : state.kind === 'off' ? (
        <p className="cr-note" data-testid="arena-off">
          The attempts are read on the hosted site.
        </p>
      ) : state.kind === 'unreadable' ? (
        <p className="cr-note cr-note-bad" role="alert" data-testid="arena-unreadable">
          The arena's transactions are unreadable right now, so no counts are shown. The page tries again by itself.
        </p>
      ) : attempts.length === 0 ? null : (
        <>
          <p className="cr-note" data-testid="arena-headline" style={GAP}>
            {h.count}
            {h.status === null ? null : (
              <>
                {` ${h.status} `}
                <Link tx={h.lastTx} what="last arena attempt" />
              </>
            )}
            {state.stale === true ? ' The last refresh failed; these are the counts of the read before.' : null}
            {state.asOfMs === undefined || state.asOfMs === null ? null : ` Counted from the chain, ${asOfText(state.asOfMs)}.`}
          </p>
          <div className="cr-stats" data-testid="arena-counts">
            <Count testId="arena-attempts" label="Attempts that reached the gate" value={c.attempts} />
            <Count testId="arena-held" label="Held for the owner" value={c.held} />
            <Count testId="arena-blocked" label="Blocked" value={c.blocked} />
          </div>
          <div className="cr-stats">
            <Count testId="arena-outside" label="Paid to an account outside the book" value={c.unbooked} />
            <Count testId="arena-over" label="Paid the merchant more than the invoice" value={c.over} />
            <Count testId="arena-under" label="Paid the merchant less than the invoice" value={c.under} />
          </div>
          {c.flood === 0 ? null : (
            <p className="cr-note" data-testid="arena-flood" style={GAP}>
              {c.flood === 1
                ? "1 attempt was turned away by the card's flood limits before the policy decided on it."
                : `${String(c.flood)} attempts were turned away by the card's flood limits before the policy decided on them.`}
            </p>
          )}
          <p className="cr-note" data-testid="arena-bound" style={GAP}>
            {strictSinceMs === null
              ? "Each round's owner task allows the booked merchant the invoice amount, 0.01 NEAR. A larger amount read from the email is held for the owner and never paid without approval."
              : `Since ${dateText(strictSinceMs)} the card runs strict mode. Every amount read from an email waits for the owner. The arena never approves, and each held request expires after one hour.`}
          </p>
          <ol className="cr-feed" aria-label="Latest arena attempts">
            {rows.map((a) => {
              const word = a.flood ? 'Flood limit' : WORD_OF(a.verdict);
              return (
                <li key={a.tx} className={`cr-ev cr-ev-${a.flood ? 'plain' : TONE_OF(a.verdict)}`} data-testid="arena-row" data-verdict={a.flood ? 'flood' : a.verdict}>
                  <span className="cr-ev-word">{word}</span>
                  <span className="cr-ev-amt">{a.amount === null ? '' : `${nearText(a.amount)} NEAR`}</span>
                  <span className="cr-ev-who">{a.reason ?? (a.verdict === 'paid_at' ? 'the booked invoice' : '')}</span>
                  <span className="cr-ev-when">
                    {`${dateText(a.atMs)} `}
                    <Link tx={a.tx} what={word} />
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {samples.length === 0 ? null : (
        <>
          <h3 className="cr-h2" data-testid="arena-samples-h" style={HEAD_GAP}>
            Recorded attack emails (latest snapshot)
          </h3>
          <ol className="cr-feed" aria-label="Recorded attack emails">
            {samples.map((s) => (
              <li key={`${s.at}-${s.tx ?? ''}`} className={`cr-ev cr-ev-${TONE_OF(s.verdict)}`} data-testid="arena-sample" data-source={s.source ?? 'unknown'}>
                <span className="cr-ev-who">
                  <strong>{s.subject}</strong>
                  {` ${s.body}`}
                </span>
                <span className="cr-ev-when">
                  <span className="cr-ev-word">{WORD_OF(s.verdict)}</span>
                  {` Recorded ${dateText(Date.parse(s.at))}${(s.source === undefined ? undefined : WRITER[s.source]) ?? ''} `}
                  <Link tx={s.tx} what="recorded attempt" />
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/** Yocto to NEAR text with up to 4 fraction digits, BigInt only. */
function nearText(yocto: string): string {
  const v = BigInt(yocto);
  const one = 10n ** 24n;
  const frac = ((v % one) / 10n ** 20n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac === '' ? (v / one).toString() : `${(v / one).toString()}.${frac}`;
}

export function ArenaStrip({ nowMs, Link }: { nowMs: number; Link: ArenaLink }): ReactElement | null {
  const state = useArena();
  return <ArenaView state={state} nowMs={nowMs} cronSinceMs={ARENA_CRON_SINCE_MS} samples={(samplesFile as { samples: ArenaSample[] }).samples} strictSinceMs={ARENA_STRICT_SINCE_MS} Link={Link} />;
}

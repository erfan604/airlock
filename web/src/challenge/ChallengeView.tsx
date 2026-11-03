// `/challenge` (AIR-301, D27): Steal this agent. The most public page of the project, built on the console's own parts: the Door and the
// VerdictStamp, the token colours, Courier Prime for outsider text through UntrustedInline. It shows what the contract answered and nothing
// the page decided: the counters come from the service's log, the rows stream in as they happen, and a visitor's own attempt comes back as the
// contract's verdict. In recorded mode (the board shows the replayed bench attacks) the text door is shut and the page says so.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Door } from '../components/Door.tsx';
import { UntrustedInline } from '../components/Specimen.tsx';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import { liveChallengeApi } from './api.ts';
import type { AttemptResult, ChallengeApi } from './api.ts';
import { EMPTY_BOARD, ago, explorerUrl, foldBoard, nearText, previewOf, reasonWords, refusalWords, sentenceOf, stateOf } from './model.ts';
import type { Attempt, ChallengeState } from './model.ts';

const FEED = 50;

const WORDS: Record<ReturnType<typeof stateOf>, string> = {
  allowed: 'ALLOWED',
  held: 'HELD',
  blocked: 'BLOCKED',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  waiting: 'WAITING',
  expired: 'EXPIRED',
  stopped: 'STOPPED',
};
const TERMS: Record<Attempt['verdict'], string> = { Allow: 'allow', Escalate: 'escalate', Block: 'block', NoAction: 'no submit' };
const DOOR_NAMES: Record<Attempt['door'], string> = { text: 'pasted text', key: 'published key', seed: 'bench case' };

const isStolen = (a: Attempt): boolean => a.stolenYocto !== '0';

function TxLink({ tx, label }: { tx: string | null; label: string }) {
  const url = explorerUrl(tx);
  if (url === null || tx === null) return <span className="ch-meta-item">{label}</span>;
  return (
    <a className="ch-tx" data-testid="tx-link" data-hash={tx} href={url} target="_blank" rel="noopener noreferrer">
      {tx.length > 16 ? `${tx.slice(0, 8)}...${tx.slice(-6)}` : tx}
    </a>
  );
}

export function AttemptRow({ a, nowMs, fresh }: { a: Attempt; nowMs: number; fresh: boolean }) {
  const state = isStolen(a) ? 'blocked' : stateOf(a);
  const word = isStolen(a) ? 'STOLEN' : WORDS[state];
  const preview = previewOf(a);
  const first = a.payments[0];
  return (
    <li className={`ch-row ch-row-${state}${fresh ? ' ch-row-fresh' : ''}`} data-testid="attempt-row" data-seq={a.seq} data-verdict={a.verdict}>
      <Door state={state} size={24} />
      <div className="ch-row-main">
        <p className="ch-row-head">
          <span className="ch-row-word" data-testid="row-word">{word}</span>
          <span className="ch-row-term">{TERMS[a.verdict]}</span>
          {first === undefined ? null : <span className="ch-row-amount">{nearText(first.amount)}</span>}
        </p>
        <p className="ch-row-why" data-testid="row-why">{reasonWords(a.reason) !== '' ? reasonWords(a.reason) : sentenceOf(a)}</p>
        {preview === null ? (a.label === null ? null : <p className="ch-row-input">{a.label}</p>) : (
          <p className="ch-row-input"><UntrustedInline text={preview} max={90} /></p>
        )}
      </div>
      <p className="ch-row-meta">
        <span className="ch-meta-item">{DOOR_NAMES[a.door]}</span>
        <span className="ch-meta-item">{a.source}</span>
        <span className="ch-meta-item" title={a.at}>{ago(Date.parse(a.at), nowMs)}</span>
        {a.mode === 'live' ? <TxLink tx={a.tx} label="no transaction" /> : <span className="ch-meta-item">replayed</span>}
      </p>
    </li>
  );
}

function KeyFacts({ state }: { state: ChallengeState | null }) {
  const k = state?.key ?? null;
  return (
    <section className="ch-door" data-testid="door-key" aria-labelledby="door-key-title">
      <h2 className="ch-door-title" id="door-key-title">Door two: use the agent's own key</h2>
      <p className="ch-help">The agent signs with a function-call key. It can call <code className="ch-code">submit_batch</code> on the policy contract and nothing else: it cannot transfer, add a key or change a rule. The contract decides every request it makes.</p>
      {k === null ? (
        <p className="ch-note" data-testid="key-pending">The key is published here when the challenge goes live.</p>
      ) : (
        <dl className="ch-facts" data-testid="key-facts">
          <dt>Account</dt>
          <dd>{k.account}</dd>
          <dt>Receiver</dt>
          <dd>{k.receiver}</dd>
          <dt>Methods</dt>
          <dd>{k.methods.join(', ')}</dd>
          {k.allowance === null ? null : (
            <>
              <dt>Allowance</dt>
              <dd>{k.allowance}</dd>
            </>
          )}
          <dt>Public key</dt>
          <dd><code className="ch-code" data-testid="key-public">{k.publicKey}</code></dd>
          <dt>Secret key</dt>
          <dd>{k.secretKey === null ? 'not published yet' : <code className="ch-code" data-testid="key-secret">{k.secretKey}</code>}</dd>
        </dl>
      )}
    </section>
  );
}

export type Own = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; attempt: Attempt } | { kind: 'refused'; code: string; retry: number | null };

export type ChallengeBodyProps = {
  state: ChallengeState | null;
  rows: Attempt[];
  fresh: number | null;
  streaming: boolean;
  failed: boolean;
  nowMs: number;
  draft: string;
  own: Own;
  onDraft(v: string): void;
  onSubmit(e: FormEvent): void;
};

export function ChallengeBody({ state, rows, fresh, streaming, failed, nowMs, draft, own, onDraft, onSubmit }: ChallengeBodyProps) {
  const board = state?.board ?? EMPTY_BOARD;
  const open = state?.doorTextOpen === true;
  const last = board.lastAt === null ? null : Date.parse(board.lastAt);
  const max = state?.limits.maxChars ?? 4000;
  const stolen = nearText(board.stolenYocto);

  return (
    <main className="page challenge" data-testid="challenge" data-mode={state?.mode ?? 'loading'}>
      <header className="ch-head">
        <h1 className="ch-title">Steal this agent</h1>
        <p className="ch-lede">
          An AI agent reads email and pays invoices from a wallet on NEAR testnet. The wallet is guarded by a contract, not by a server. Make it pay someone the owner never listed. Every attempt below is the contract's answer.
        </p>
      </header>

      {state?.mode === 'recorded' ? (
        <p className="ch-banner" data-testid="ch-banner">
          Recorded: the board shows the bench's attack cases replayed through the real verdict path. Live attempts open when the challenge goes live.
        </p>
      ) : null}
      {failed ? (
        <p className="ch-banner ch-banner-alarm" role="alert" data-testid="ch-failed">
          The challenge service did not answer. The numbers below may be old.
        </p>
      ) : null}

      <section className="ch-ledger" aria-label="Scoreboard">
        <p className="ch-count" aria-live="polite" data-testid="ch-count">
          <span className="ch-num" key={`a${String(board.attempts)}`} data-testid="count-attempts">{board.attempts}</span>
          {' attempts, '}
          <span className="ch-num" key={`h${String(board.escalate + board.block)}`} data-testid="count-held">{board.escalate + board.block}</span>
          {' held or blocked, '}
          <span className={`ch-num ch-num-stolen${board.stolenYocto === '0' ? '' : ' ch-num-alarm'}`} data-testid="count-stolen">{stolen}</span>
          {' stolen.'}
        </p>
        <p className="ch-pulse" data-testid="last-attempt">
          <span className={`ch-dot${streaming ? ' ch-dot-live' : ''}`} aria-hidden="true" />
          {last === null ? 'No attempts yet.' : `Last attempt ${ago(last, nowMs)}.`}
          {streaming ? ' Live.' : state?.mode === 'recorded' ? ' Replay.' : ' Reconnecting.'}
        </p>
        <p className="ch-fine" data-testid="ch-fine">
          Stolen is NEAR the contract let out to a payee outside the owner's address book. NEAR paid to the owner's own payees inside the owner's caps is counted apart: {nearText(board.paidToBookYocto)}. Held means the contract asked the owner and paid nothing.
        </p>
      </section>

      <div className="ch-doors">
        <section className="ch-door" data-testid="door-text" aria-labelledby="door-text-title">
          <h2 className="ch-door-title" id="door-text-title">Door one: give it text</h2>
          <p className="ch-help">Paste an email, an invoice or a web page. The agent reads it as outside text while it tries to pay the April invoice. The owner's request is fixed and the text never changes what the agent may do.</p>
          <form className="ch-form" onSubmit={onSubmit}>
            <label className="task-label" htmlFor="ch-input">Outside text</label>
            <textarea id="ch-input" className="task-input task-input-paste" data-testid="ch-input" rows={5} maxLength={max} value={draft} disabled={!open} onChange={(e) => onDraft(e.target.value)} />
            <p className="task-count">{`${String(Array.from(draft).length)} of ${String(max)} characters`}</p>
            {open ? null : <p className="ch-note" data-testid="door-shut">{refusalWords('live_off')}</p>}
            <button type="submit" className="card-btn card-btn-primary" data-testid="ch-submit" disabled={!open || draft.trim() === '' || own.kind === 'busy'}>
              {own.kind === 'busy' ? 'Waiting for the contract' : 'Try to steal'}
            </button>
          </form>
          {own.kind === 'done' ? (
            <div className="ch-own" data-testid="ch-own">
              <VerdictStamp state={isStolen(own.attempt) ? 'blocked' : stateOf(own.attempt)} sentence={sentenceOf(own.attempt)} />
              <p className="ch-own-tx"><TxLink tx={own.attempt.tx} label="No transaction: nothing was submitted." /></p>
            </div>
          ) : null}
          {own.kind === 'refused' ? (
            <p className="ch-note" role="alert" data-testid="ch-refused">{`${refusalWords(own.code)}${own.retry === null ? '' : ` Try again in ${String(own.retry)} s.`}`}</p>
          ) : null}
        </section>
        <KeyFacts state={state} />
      </div>

      <section className="ch-feed" aria-labelledby="ch-feed-title">
        <h2 className="ch-door-title" id="ch-feed-title">Latest attempts</h2>
        {rows.length === 0 ? (
          <p className="ch-note" data-testid="ch-empty">Nothing yet. The first attempt appears here as it happens.</p>
        ) : (
          <ol className="ch-rows" data-testid="ch-rows">
            {rows.map((a) => (
              <AttemptRow key={a.seq} a={a} nowMs={nowMs} fresh={a.seq === fresh} />
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

export type ChallengeViewProps = { api?: ChallengeApi; clock?: () => number; pollMs?: number };

export function ChallengeView({ api = liveChallengeApi, clock = Date.now, pollMs = 15_000 }: ChallengeViewProps) {
  const [state, setState] = useState<ChallengeState | null>(null);
  const [rows, setRows] = useState<Attempt[]>([]);
  const [fresh, setFresh] = useState<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nowMs, setNowMs] = useState(clock);
  const [draft, setDraft] = useState('');
  const [own, setOwn] = useState<Own>({ kind: 'idle' });
  const seen = useRef(new Set<number>());

  const take = useCallback((a: Attempt, isNew: boolean) => {
    if (seen.current.has(a.seq)) return;
    seen.current.add(a.seq);
    setRows((prev) => [a, ...prev].sort((x, y) => y.seq - x.seq).slice(0, FEED));
    setState((s) => (s === null ? s : { ...s, board: foldBoard(s.board, a) }));
    if (isNew) setFresh(a.seq);
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api.state(), api.attempts(FEED)]);
      seen.current = new Set(list.map((a) => a.seq));
      setState(s);
      setRows(list);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
    const close = api.stream((a) => take(a, true), setStreaming);
    const poll = setInterval(() => void load(), pollMs);
    const tick = setInterval(() => setNowMs(clock()), 1000);
    return () => {
      close();
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [api, load, take, clock, pollMs]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (draft.trim() === '' || own.kind === 'busy') return;
    setOwn({ kind: 'busy' });
    let result: AttemptResult;
    try {
      result = await api.attempt(draft);
    } catch {
      result = { ok: false, code: 'engine_failed', retryAfterSeconds: null };
    }
    if (result.ok) {
      take(result.attempt, true);
      setOwn({ kind: 'done', attempt: result.attempt });
    } else setOwn({ kind: 'refused', code: result.code, retry: result.retryAfterSeconds });
  }

  return <ChallengeBody state={state} rows={rows} fresh={fresh} streaming={streaming} failed={failed} nowMs={nowMs} draft={draft} own={own} onDraft={setDraft} onSubmit={(e) => void submit(e)} />;
}

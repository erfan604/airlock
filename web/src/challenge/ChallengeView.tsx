// `/challenge` (AIR-301, D27): Steal this agent. The most public page of the project, built on the console's own parts: the Door and the
// VerdictStamp, the token colours, Courier Prime for outsider text through UntrustedInline. It shows what the contract answered and nothing
// the page decided: the counters come from the service's log, the rows stream in as they happen, and a visitor's own attempt comes back as the
// contract's verdict. In recorded mode (the board shows the replayed bench attacks) the text door is shut and the page says so.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { explorerAccount } from '../components/account.ts';
import { Door } from '../components/Door.tsx';
import { UntrustedInline } from '../components/Specimen.tsx';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import { liveChallengeApi } from './api.ts';
import type { AttemptResult, ChallengeApi } from './api.ts';
import { EMPTY_BOARD, ago, explorerUrl, foldBoard, nearText, newestFirst, previewOf, reasonWords, refusalWords, sentenceOf, settleRead, shortSource, stateOf, trimDecimals } from './model.ts';
import type { Attempt, ChallengeState, PublishedTask, ReadView } from './model.ts';

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

/** An account as the page prints it: the owner's own names are a neutral label linked to the explorer (components/account.ts), other names as they are. */
function AccountName({ id, what }: { id: string; what: string }) {
  if (!/erfan/i.test(id)) return <>{id}</>;
  const url = explorerAccount(id.replace(/^near:/, ''));
  if (url === null) return <>{what}</>;
  return (
    <a className="ch-tx" href={url} target="_blank" rel="noopener noreferrer">
      {what}
    </a>
  );
}

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
        <span className="ch-meta-item" title={a.source}>{shortSource(a.source)}</span>
        <span className="ch-meta-item" title={a.at}>{ago(Date.parse(a.at), nowMs)}</span>
        {a.mode === 'live' ? <TxLink tx={a.tx} label="no transaction" /> : <span className="ch-meta-item">replayed</span>}
      </p>
    </li>
  );
}

function KeyFacts({ state, unreadable }: { state: ChallengeState | null; unreadable: boolean }) {
  const k = state?.key ?? null;
  return (
    <section className="ch-door" data-testid="door-key" aria-labelledby="door-key-title">
      <h2 className="ch-door-title" id="door-key-title">Use the agent's own key</h2>
      <p className="ch-help">The agent signs with a function-call key. It can call <code className="ch-code">submit_batch</code> on the policy contract and nothing else: it cannot transfer, add a key or change a rule. The contract decides every request it makes.</p>
      {k === null ? (
        unreadable ? null : <p className="ch-note" data-testid="key-pending">The key is published here when the challenge goes live.</p>
      ) : (
        <dl className="ch-facts" data-testid="key-facts">
          <dt>Account</dt>
          <dd><AccountName id={k.account} what="demo agent" /></dd>
          <dt>Receiver</dt>
          <dd><AccountName id={k.receiver} what="demo policy" /></dd>
          <dt>Methods</dt>
          <dd>{k.methods.join(', ')}</dd>
          {k.allowance === null ? null : (
            <>
              <dt>Allowance</dt>
              <dd>{trimDecimals(k.allowance)}</dd>
            </>
          )}
          <dt>Public key</dt>
          <dd><code className="ch-code" data-testid="key-public">{k.publicKey}</code></dd>
          <dt>Secret key</dt>
          <dd>{k.secretKey === null ? 'not published yet' : <code className="ch-code" data-testid="key-secret">{k.secretKey}</code>}</dd>
        </dl>
      )}
      {state?.taskExpired === true ? (
        <p className="ch-note" data-testid="task-expired">The tasks the owner signed for this page have expired, so a new call would be refused. The owner publishes fresh ones; the board below still shows every call the chain has seen.</p>
      ) : null}
      {state?.command === undefined || state.command === null ? null : <CommandFacts command={state.command} task={state.task ?? null} />}
      {(state?.command === undefined || state.command === null) && state?.task !== undefined && state.task !== null ? <TaskFacts task={state.task} /> : null}
    </section>
  );
}

/**
 * The command a challenger pastes, and the owner's signed task it carries. Both name the real accounts, so they sit in a fold the reader opens
 * (D11): the text is unchanged inside it, because a command that is shortened for display no longer runs.
 */
function CommandFacts({ command, task }: { command: string; task: PublishedTask | null }) {
  return (
    <div data-testid="command-facts">
      <h3 className="ch-door-title">Send one request now</h3>
      <p className="ch-help" data-testid="command-explain">
        With the near CLI (near-cli-rs 0.30 or later), one command sends one request to the policy contract with the published key. It asks to pay 1 NEAR to a payee that is not in the owner's book and claims the owner wrote both fields. To try another payee or amount, edit <code className="ch-code">payee</code> and <code className="ch-code">amount</code> (yocto NEAR). Each call uses one <code className="ch-code">action_index</code> of the task: if the contract answers that it is used, pick another number below the task's action limit.
      </p>
      <details className="ch-fold" data-testid="command-fold">
        <summary className="ch-fold-summary">Show the command to paste</summary>
        <pre className="ch-code ch-command" data-testid="command-text">{command}</pre>
        {task === null ? null : <TaskFacts task={task} />}
      </details>
    </div>
  );
}

function TaskFacts({ task }: { task: PublishedTask }) {
  const p = task.permits;
  return (
    <div data-testid="task-facts">
      <h3 className="ch-door-title">The owner's signed task</h3>
      <p className="ch-help" data-testid="task-explain">
        A call to <code className="ch-code">submit_batch</code> also needs a task signed by the owner. A compromised agent would hold one, so here is one. It lets the agent pay <AccountName id={p.payee} what="the demo payee" /> up to {p.maxTotal} {p.asset} in total, in at most {String(p.maxActions)} requests, until {task.expiresAt} (a fresh task is published before it expires). Anything else is outside what the owner signed: another payee, a larger amount, a replay or a call after expiry. Try it; the board shows what the contract answers.
      </p>
      <dl className="ch-facts">
        <dt>Task id</dt>
        <dd><code className="ch-code">{task.task.task_id}</code></dd>
        <dt>Expires</dt>
        <dd>{task.expiresAt}</dd>
      </dl>
      <p className="ch-help">Pass these as the <code className="ch-code">task</code> and <code className="ch-code">task_sig</code> arguments, with your requests as <code className="ch-code">reqs</code>:</p>
      <pre className="ch-code" data-testid="task-json">{JSON.stringify({ task: task.task, task_sig: task.task_sig }, null, 2)}</pre>
    </div>
  );
}

export type Own = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; attempt: Attempt } | { kind: 'refused'; code: string; retry: number | null };

export type ChallengeBodyProps = {
  state: ChallengeState | null;
  rows: Attempt[];
  fresh: number | null;
  streaming: boolean;
  failed: boolean;
  /** the hosted static copy: its reads are the chain, there is no challenge service to blame */
  hosted?: boolean;
  nowMs: number;
  draft: string;
  own: Own;
  onDraft(v: string): void;
  onSubmit(e: FormEvent): void;
};

type TextDoorProps = Pick<ChallengeBodyProps, 'state' | 'draft' | 'own' | 'onDraft' | 'onSubmit'> & { open: boolean; max: number; hosted?: boolean };

/** The text door: outside text for the agent to read. The hosted copy has no planner, so there it is one sentence and no dead form. */
function TextDoor({ state, open, max, draft, own, onDraft, onSubmit, hosted = false }: TextDoorProps) {
  return (
    <section className={`ch-door${hosted ? ' ch-door-shut' : ''}`} data-testid="door-text" aria-labelledby="door-text-title">
      <h2 className="ch-door-title" id="door-text-title">Give it text</h2>
      {hosted ? (
        <p className="ch-note" data-testid="door-shut">{refusalWords('hosted')}</p>
      ) : (
        <>
          <p className="ch-help">Paste an email, an invoice or a web page. The agent reads it as outside text while it tries to pay the April invoice. The owner's request is fixed and the text never changes what the agent may do.</p>
          <form className="ch-form" onSubmit={onSubmit}>
            <label className="task-label" htmlFor="ch-input">Outside text</label>
            <textarea id="ch-input" className="task-input task-input-paste" data-testid="ch-input" rows={5} maxLength={max} value={draft} disabled={!open} onChange={(e) => onDraft(e.target.value)} />
            <p className="task-count">{`${String(Array.from(draft).length)} of ${String(max)} characters`}</p>
            {open ? null : <p className="ch-note" data-testid="door-shut">{refusalWords(state?.hosted === true ? 'hosted' : 'live_off')}</p>}
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
        </>
      )}
    </section>
  );
}

export function ChallengeBody({ state, rows, fresh, streaming, failed, hosted, nowMs, draft, own, onDraft, onSubmit }: ChallengeBodyProps) {
  const board = state?.board ?? EMPTY_BOARD;
  const open = state?.doorTextOpen === true;
  const last = board.lastAt === null ? null : Date.parse(board.lastAt);
  const max = state?.limits.maxChars ?? 4000;
  const stolen = nearText(board.stolenYocto);
  const isHosted = hosted === true || state?.hosted === true;
  // a failed read with no data: no counts, no empty feed, only the cause
  const blind = failed && state === null;

  return (
    <main className="page challenge" data-testid="challenge" data-mode={state?.mode ?? 'loading'}>
      <header className="ch-head">
        <h1 className="ch-title">Steal this agent</h1>
        <p className="ch-lede">
          An AI agent reads email and pays invoices from a wallet on NEAR. The wallet is guarded by a contract, not by a server. Make it pay someone the owner never listed. Every attempt below is the contract's answer.
        </p>
      </header>

      {state?.mode === 'recorded' ? (
        <p className="ch-banner" data-testid="ch-banner">
          Recorded: the board shows the bench's attack cases replayed through the real verdict path. Live attempts open when the challenge goes live.
        </p>
      ) : null}
      {failed ? (
        <p className="ch-banner ch-banner-alarm" role="alert" data-testid="ch-failed">
          {!isHosted
            ? 'The challenge service did not answer. The numbers below may be old.'
            : blind
              ? 'The chain could not be read. No counts are shown until it can be. Reload to try again.'
              : 'The chain could not be read just now. The numbers below are from the last good read.'}
        </p>
      ) : null}

      {blind ? (
        <p className="ch-note" data-testid="ch-unreadable">The chain could not be read, so the scoreboard and the attempts are not shown.</p>
      ) : null}
      {blind ? null : (
      <section className="ch-ledger" aria-label="Scoreboard">
        <p className="ch-count ch-count-headline" aria-live="polite" data-testid="ch-count">
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
          {streaming ? ' Live.' : state?.hosted === true ? ' Read from the chain.' : state?.mode === 'recorded' ? ' Replay.' : ' Reconnecting.'}
        </p>
      </section>
      )}

      {/* the hosted copy has no planner, so its text door is shut: the key door, which works from any shell, comes first and the shut door goes below (D12) */}
      {isHosted ? (
        <div className="ch-doors ch-doors-one">
          <KeyFacts state={state} unreadable={blind} />
        </div>
      ) : (
        <div className="ch-doors">
          <TextDoor state={state} open={open} max={max} draft={draft} own={own} onDraft={onDraft} onSubmit={onSubmit} />
          <KeyFacts state={state} unreadable={blind} />
        </div>
      )}

      {blind ? null : (
      <section className="ch-rules" aria-label="How the board counts">
        <p className="ch-fine" data-testid="ch-fine">
          Stolen is NEAR the contract let out to a payee outside the owner's address book. NEAR paid to the owner's own payees inside the owner's caps is counted apart: {nearText(board.paidToBookYocto)}. Held means the contract asked the owner and paid nothing.
        </p>
        {state?.hosted === true ? (
          <p className="ch-fine" data-testid="ch-hosted">
            This hosted copy has no server. Your browser reads NEAR every 30 seconds and counts the calls to the policy contract that the published key signed, each with the verdict from the contract's own receipt. An attempt that never reaches the chain is not counted. Every call spends gas from the key's small allowance. Because every challenger is the same agent, sending many requests can use up its hourly budget of held requests or fill the queue waiting for the owner; later calls are then answered EscalationBudget or PendingFull until the hour turns or the owner clears the queue. That can slow the challenge down. It cannot pay anyone outside the owner's book.
            {state.truncated === true ? ' The listing was long, so the board shows the newest part of it.' : ''}
          </p>
        ) : null}
      </section>
      )}

      {blind ? null : (
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
      )}
      {isHosted ? <TextDoor state={state} open={open} max={max} draft={draft} own={own} onDraft={onDraft} onSubmit={onSubmit} hosted /> : null}
    </main>
  );
}

export type ChallengeViewProps = { api?: ChallengeApi; clock?: () => number; pollMs?: number; hosted?: boolean };

export function ChallengeView({ api = liveChallengeApi, clock = Date.now, pollMs = 15_000, hosted = false }: ChallengeViewProps) {
  const [view, setView] = useState<ReadView>({ read: null, unreadable: false });
  const [fresh, setFresh] = useState<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [nowMs, setNowMs] = useState(clock);
  const [draft, setDraft] = useState('');
  const [own, setOwn] = useState<Own>({ kind: 'idle' });
  const seen = useRef(new Set<number>());
  const state = view.read?.state ?? null;
  const rows = view.read?.rows ?? [];
  const failed = view.unreadable;

  const take = useCallback((a: Attempt, isNew: boolean) => {
    if (seen.current.has(a.seq)) return;
    seen.current.add(a.seq);
    setView((v) => (v.read === null ? v : { ...v, read: { state: { ...v.read.state, board: foldBoard(v.read.state.board, a) }, rows: newestFirst([a, ...v.read.rows]).slice(0, FEED) } }));
    if (isNew) setFresh(a.seq);
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api.state(), api.attempts(FEED)]);
      seen.current = new Set(list.map((a) => a.seq));
      setView((v) => settleRead(v.read, { state: s, rows: newestFirst(list) }));
    } catch {
      // the last good board stays on screen (or none), flagged: a failed read is never drawn as an empty board
      setView((v) => settleRead(v.read, null));
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

  return <ChallengeBody state={state} rows={rows} fresh={fresh} streaming={streaming} failed={failed} hosted={hosted} nowMs={nowMs} draft={draft} own={own} onDraft={setDraft} onSubmit={(e) => void submit(e)} />;
}

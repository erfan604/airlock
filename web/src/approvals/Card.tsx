// The approval card (AIR-181, DESIGN.md 4b): one card for one escalated request, readable at 375 px. Everything on it comes from the
// frozen `CardModel` (stored contract fields plus one typed evidence object); text an outsider wrote appears only inside `Specimen`
// and `UntrustedInline`, never in the title, a button or a sentence. Reject is the primary button and holds the focus; Approve is
// outlined and opens a two-step sheet; there is no countdown and no timer (F04). A failed approve is a security signal (R4-08).
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import type { AssetEntryViewJson, LedgersView, RequestState, RequestView } from '@airlock/runtime/chain-types';
import type { BookEntryJson } from '@airlock/runtime/dsl';
import { Manifest, ManifestRow } from '../components/Manifest.tsx';
import { Specimen, UntrustedInline } from '../components/Specimen.tsx';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import type { VerdictState } from '../components/verdict.ts';
import { BookDiff } from './BookDiff.tsx';
import { parseCanonicalDecimal } from '@airlock/runtime/money';
import { buildCardModel, CardError } from './cardModel.ts';
import type { ApproveArgs, CapLine, CardModel, CardRow, RememberArgs, SourceChip } from './cardModel.ts';
import { MAX_FAILURES, canApprove, cardReducer, initialState } from './cardReducer.ts';
import type { CardEvent, CardState } from './cardReducer.ts';
import type { CardEvidence } from './evidence.ts';
import { defaultScope, readFailures, writeFailures } from './failures.ts';
import type { CounterScope } from './failures.ts';
import { forcingSatisfied } from './forcing.ts';

export type { ApproveArgs } from './cardModel.ts';

/** What the wallet layer (AIR-182) reports back for an approve or a reject. */
export type ApproveResult = { ok: true; tx: string } | { ok: false; kind: 'wallet' | 'contract'; name?: string };

export type CardProps = {
  view: RequestView;
  evidence: CardEvidence;
  ledgers: LedgersView;
  asset: AssetEntryViewJson;
  book: BookEntryJson | null;
  /** The canonical keys of the `get_book` rows (AIR-190): the look-alike check and the diff read them. */
  bookKeys: readonly string[];
  /** Label per book key, for the diff sentence. A missing label leaves the sentence without one. */
  bookLabels?: Readonly<Record<string, string>>;
  onApprove(a: ApproveArgs): Promise<ApproveResult>;
  /** The second action of the sheet (AIR-299): approve and enter the payee into the book. Absent: the sheet offers the plain approve only. */
  onApproveAndRemember?(a: RememberArgs): Promise<ApproveResult>;
  onReject(id: string): Promise<ApproveResult>;
  /** Network and contract id of the R4-08 counter key. AIR-182 passes the real ones. */
  scope?: CounterScope;
  /** The clock of "2 min ago" as decimal milliseconds; the current time when absent. A fixture passes a fixed one. */
  nowMs?: string;
};

// ---- stamps and lines ----

const TX = /^[A-Za-z0-9]{1,64}$/;

function stampFor(readOnly: RequestState, s: CardState, remembered: boolean): { state: VerdictState; line: string | null } {
  if (s.kind === 'approved' && remembered) return { state: 'approved', line: 'Approved. Payee remembered.' };
  if (s.kind === 'approved') {
    return { state: 'approved', line: s.tx !== null && TX.test(s.tx) ? `Approved. Transaction ${s.tx}.` : 'Approved. Waiting for the chain.' };
  }
  if (s.kind === 'rejected') return { state: 'rejected', line: 'You rejected this request.' };
  switch (readOnly) {
    case 'Pending':
      return { state: 'held', line: null };
    case 'Rejected':
      return { state: 'rejected', line: 'You rejected this request.' };
    case 'Expired':
      return { state: 'expired', line: 'This request expired. Nothing was signed.' };
    case 'Blocked':
      return { state: 'blocked', line: 'The contract blocked this request. Nothing was signed.' };
    case 'Executing':
      return { state: 'approved', line: 'Approved. Signing.' };
    case 'Executed':
      return { state: 'approved', line: 'Approved. Executed on chain.' };
    case 'Retryable':
      return { state: 'approved', line: 'Approved. The first attempt failed and will be retried once.' };
    case 'Failed':
      return { state: 'approved', line: 'Approved. Execution failed.' };
  }
}

// ---- pieces ----

function Chip({ chip }: { chip: SourceChip }) {
  const parts: ReactNode[] = [];
  if (chip.from !== null) parts.push(`from ${chip.from}`);
  if (chip.sender !== null) parts.push(<UntrustedInline key="sender" text={chip.sender} />);
  if (chip.age !== null) parts.push(chip.age);
  return (
    <span className="source-chip" data-testid="source-chip">
      {parts.flatMap((p, i) => (i === 0 ? [p] : [', ', p]))}
    </span>
  );
}

/** The engineering dimension line (DESIGN 4b, item 5): a rule from 0 to the amount, a tall tick at the limit that binds. */
function CapLineView({ cap }: { cap: CapLine }) {
  return (
    <div className="cap-line" data-testid="cap-line" data-binds={cap.binds}>
      <svg className="cap-line-svg" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label={cap.description} focusable="false">
        <line className="cap-line-rule" x1="0" y1="10" x2={cap.amountAt} y2="10" />
        <line className="cap-line-end" x1="0" y1="6" x2="0" y2="14" />
        <line className="cap-line-end" x1={cap.amountAt} y1="6" x2={cap.amountAt} y2="14" />
        <line className="cap-line-tick" x1={cap.limitAt} y1="1" x2={cap.limitAt} y2="19" />
      </svg>
      <div className="cap-line-labels">
        <span>{cap.limitLabel}</span>
        <span>{cap.overLabel ?? 'within the limit'}</span>
      </div>
    </div>
  );
}

function sourceLineOf(row: CardRow, model: CardModel): ReactNode {
  const parts: ReactNode[] = [];
  if (model.chip !== null && model.chip.row === row.name) parts.push(<Chip key="chip" chip={model.chip} />);
  if (row.name === 'AMOUNT' && model.cap !== null) parts.push(<CapLineView key="cap" cap={model.cap} />);
  if (row.name === 'TO' && model.labelMismatch) {
    parts.push(
      <p key="mismatch" className="label-mismatch" data-testid="label-mismatch">
        label says book, payee is not in your book
      </p>,
    );
  }
  if (row.name === 'TO' && model.diff !== null) parts.push(<BookDiff key="diff" payee={row.value} result={model.diff.result} label={model.diff.label} />);
  return parts.length > 0 ? parts : undefined;
}

const ARG_NAMES = ['to', 'asset', 'amount', 'why', 'book'] as const;

// ---- the remember form (AIR-299) ----

export type RememberField = 'cap' | 'daily' | 'label';
export type RememberForm = { cap: string; daily: string; label: string; error: string | null };

const LABEL_CHARS = /[^A-Za-z0-9 ._-]/g;

/** The label the sheet starts with: the book label of the payee when it has one, else the account part of the stored payee key. */
function defaultLabel(model: CardModel, labels: Readonly<Record<string, string>> | undefined): string {
  const known = labels !== undefined && Object.hasOwn(labels, model.args.to) ? labels[model.args.to] : undefined;
  const raw = typeof known === 'string' ? known : (model.args.to.split(':').pop() ?? '');
  return raw.replace(LABEL_CHARS, '').slice(0, 40);
}

/** The arguments of the remember call from the form, or the sentence that says what is wrong. Amounts are BigInt end to end. */
function rememberArgsOf(model: CardModel, form: RememberForm, decimals: number): { ok: true; args: RememberArgs } | { ok: false; error: string } {
  let cap: bigint;
  let daily: bigint;
  let amount: bigint;
  try {
    amount = parseCanonicalDecimal(model.args.amount, decimals);
    cap = parseCanonicalDecimal(form.cap.trim(), decimals);
    daily = parseCanonicalDecimal(form.daily.trim(), decimals);
  } catch {
    return { ok: false, error: 'Enter the limits as plain numbers, for example 2.5.' };
  }
  if (cap < amount) return { ok: false, error: 'The per-payment cap cannot be below this payment.' };
  if (daily < cap) return { ok: false, error: 'The daily limit cannot be below the per-payment cap.' };
  if (form.label.length > 40 || /[^A-Za-z0-9 ._-]/.test(form.label)) return { ok: false, error: 'The label takes up to 40 letters, digits, spaces, dots, dashes and underscores.' };
  return { ok: true, args: { ...model.args, cap: cap.toString(), daily_limit: daily.toString(), label: form.label } };
}

// ---- the presentational card ----

export type CardViewProps = {
  model: CardModel;
  /** `RequestView.state`: anything but Pending is a read-only stamp with no buttons. */
  readOnly: RequestState;
  state: CardState;
  onOpen(): void;
  onCancel(): void;
  onConfirm(): void;
  onReject(): void;
  rejectRef?: Ref<HTMLButtonElement>;
  sheetRejectRef?: Ref<HTMLButtonElement>;
  /** What the owner has typed in the forcing step (AIR-190); empty when absent. */
  forcingInput?: string;
  onForcingInput?(value: string): void;
  /** The remember fields and action of the sheet (AIR-299); absent: the plain approve only. */
  remember?: RememberForm & { onField(field: RememberField, value: string): void; onRemember(): void; unit: string };
  /** The approve that just succeeded also remembered the payee. */
  remembered?: boolean;
};

export function CardView({ model, readOnly, state, onOpen, onCancel, onConfirm, onReject, rejectRef, sheetRejectRef, forcingInput = '', onForcingInput, remember, remembered = false }: CardViewProps) {
  const sheetTitleId = useId();
  const forcingId = useId();
  const stamp = stampFor(readOnly, state, remembered);
  const rememberIds = useId();
  const live = readOnly === 'Pending' && state.kind !== 'approved' && state.kind !== 'rejected';
  const approveOn = live && canApprove(state);
  const sheetOpen = approveOn && (state.kind === 'confirming' || state.kind === 'wallet_pending');
  const stopped = live && state.failures >= MAX_FAILURES;
  const waiting = state.kind === 'wallet_pending';
  const busy = waiting || state.kind === 'rejecting';
  const offender = model.offender ?? undefined;
  const forcingOpen = model.forcing !== null && model.forcing.required;
  const forcingMet = !forcingOpen || forcingSatisfied(forcingInput, model.args.to);

  return (
    <section className="card" data-testid="card" data-state={state.kind} data-request-state={readOnly}>
      <div className="card-body" inert={sheetOpen}>
        <VerdictStamp state={stamp.state} />
        <h2 className="card-title" data-testid="card-title">
          {model.title}
        </h2>
        <p className="card-reason" data-testid="reason">
          {model.sentence}
        </p>
        {stamp.line !== null ? (
          <p className="card-status" data-testid="card-status" role="status">
            {stamp.line}
          </p>
        ) : null}
        {live && state.kind === 'failed' && state.failures < MAX_FAILURES ? (
          <p className="card-notice" data-testid="card-notice" role="status">
            {`The previous approval attempt failed${state.last ? ` (${state.last.name})` : ''}. Nothing was signed. Read the values again before you try once more.`}
          </p>
        ) : null}
        {live && state.kind === 'declined' ? (
          <p className="card-notice" data-testid="card-notice" role="status">
            Your wallet declined. Nothing was signed.
          </p>
        ) : null}
        {stopped ? (
          <div className="card-alert" role="alert" data-testid="alert">
            <p className="card-alert-label">APPROVAL STOPPED</p>
            <p className="card-alert-line">{`approve rejected: ${state.last?.name ?? 'unknown'}`}</p>
            <p className="card-alert-text">Nothing was signed. Reject this request, or leave it to expire.</p>
          </div>
        ) : null}
        <Manifest order={offender ? 'offender-first' : 'canonical'} offender={offender}>
          {model.rows.map((row) => (
            <ManifestRow key={row.name} name={row.name} value={row.value} seals={row.seals} emphasized={row.name === model.offender} sourceLine={sourceLineOf(row, model)} />
          ))}
        </Manifest>
        {model.snippet !== null ? <Specimen text={model.snippet} channel={model.specimenChannel} source={model.ageText ?? undefined} testId="specimen" /> : null}
        {/* after the evidence, not inside the AMOUNT row: the pinned bar of AIR-181 must still clear the specimen after one scroll */}
        <p className="magnitude" data-testid="magnitude">
          <span>{model.magnitude.cap}</span>
          <span>{model.magnitude.day}</span>
        </p>
        <section className="card-args" aria-label="The values your wallet will show">
          <h3 className="card-label">Your wallet will show</h3>
          <dl className="card-arg-list">
            {ARG_NAMES.map((name) => (
              <div className="card-arg" key={name}>
                <dt>{name}</dt>
                <dd data-testid={`arg-${name}`}>{model.args[name]}</dd>
              </div>
            ))}
          </dl>
          <p className="card-ref" data-testid="card-ref">
            {model.ref}
          </p>
        </section>
        {live ? <p className="card-footnote">Doing nothing is also safe. Nothing is signed until you approve.</p> : null}
      </div>
      {live ? (
        <div className="card-bar" data-testid="card-bar" inert={sheetOpen}>
          <button ref={rejectRef} type="button" className="card-btn card-btn-primary" data-testid="reject" disabled={busy} onClick={onReject}>
            {state.kind === 'rejecting' ? 'Rejecting' : 'Reject'}
          </button>
          {approveOn ? (
            <button type="button" className="card-btn card-btn-outline" data-testid="open-approve" disabled={busy} onClick={onOpen}>
              {model.approveLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {sheetOpen ? (
        <>
          <div className="card-scrim" aria-hidden="true" />
          <div className="card-sheet" role="dialog" aria-modal="true" aria-labelledby={sheetTitleId} data-testid="sheet">
            <h3 className="card-sheet-title" id={sheetTitleId} data-testid="sheet-title">
              {model.sheetTitle}
            </h3>
            <p className="card-sheet-line" role="status">
              {waiting ? 'Waiting for your wallet.' : 'Your wallet will ask you to confirm the five values above.'}
            </p>
            {forcingOpen && model.forcing !== null ? (
              <div className="card-forcing">
                <label className="card-forcing-label" htmlFor={forcingId} data-testid="forcing-label">
                  {model.forcing.label}
                </label>
                <input
                  id={forcingId}
                  className="card-forcing-input"
                  data-testid="forcing-input"
                  type="text"
                  value={forcingInput}
                  onChange={(e) => onForcingInput?.(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={waiting}
                />
              </div>
            ) : null}
            {remember !== undefined ? (
              <div className="card-remember" data-testid="remember-fields">
                <label className="card-remember-label" htmlFor={`${rememberIds}-cap`}>
                  {`Per-payment cap (${remember.unit})`}
                </label>
                <input id={`${rememberIds}-cap`} className="card-remember-input" data-testid="remember-cap" type="text" inputMode="decimal" value={remember.cap} onChange={(e) => remember.onField('cap', e.target.value)} autoComplete="off" spellCheck={false} disabled={waiting} />
                <label className="card-remember-label" htmlFor={`${rememberIds}-daily`}>
                  {`Daily limit (${remember.unit})`}
                </label>
                <input id={`${rememberIds}-daily`} className="card-remember-input" data-testid="remember-daily" type="text" inputMode="decimal" value={remember.daily} onChange={(e) => remember.onField('daily', e.target.value)} autoComplete="off" spellCheck={false} disabled={waiting} />
                <label className="card-remember-label" htmlFor={`${rememberIds}-label`}>
                  Label
                </label>
                <input id={`${rememberIds}-label`} className="card-remember-input" data-testid="remember-label" type="text" value={remember.label} onChange={(e) => remember.onField('label', e.target.value)} autoComplete="off" spellCheck={false} maxLength={40} disabled={waiting} />
                {remember.error !== null ? (
                  <p className="card-remember-error" data-testid="remember-error" role="alert">
                    {remember.error}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="card-sheet-actions">
              <button ref={sheetRejectRef} type="button" className="card-btn card-btn-primary" data-testid="sheet-reject" disabled={waiting} onClick={onReject}>
                Reject
              </button>
              <button type="button" className="card-btn card-btn-outline" data-testid="confirm-approve" disabled={waiting || !forcingMet} onClick={onConfirm}>
                Approve
              </button>
              {remember !== undefined ? (
                <button type="button" className="card-btn card-btn-outline" data-testid="confirm-remember" disabled={waiting || !forcingMet} onClick={remember.onRemember}>
                  Approve and trust this payee
                </button>
              ) : null}
              <button type="button" className="card-btn card-btn-quiet" data-testid="sheet-cancel" disabled={waiting} onClick={onCancel}>
                Back
              </button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

// ---- the stateful card ----

type Snapshot = { ok: true; model: CardModel } | { ok: false; code: string };

const DECIMAL = /^[0-9]+$/;

/** Built once per mount from the rendered view: the arguments the wallet gets are the ones on screen, whatever the parent re-renders. */
function snapshot(p: CardProps): Snapshot {
  try {
    const now = p.nowMs !== undefined ? (DECIMAL.test(p.nowMs) ? BigInt(p.nowMs) : null) : BigInt(Date.now());
    if (now === null) return { ok: false, code: 'BadClock' };
    return { ok: true, model: buildCardModel(p.view, p.evidence, p.ledgers, p.asset, p.book, now, { bookKeys: p.bookKeys, bookLabels: p.bookLabels }) };
  } catch (e) {
    return { ok: false, code: e instanceof CardError ? e.code : 'BadView' };
  }
}

const errorName = (e: unknown): string | undefined => (e instanceof Error ? e.name : undefined);

type LiveProps = Pick<CardProps, 'onApprove' | 'onApproveAndRemember' | 'onReject'> & { model: CardModel; readOnly: RequestState; scope: CounterScope; decimals: number; bookLabels?: Readonly<Record<string, string>> };

function LiveCard({ model, readOnly, scope, onApprove, onApproveAndRemember, onReject, decimals, bookLabels }: LiveProps) {
  const [state, dispatch] = useReducer(cardReducer, undefined, () => initialState(readFailures(scope, model.no)));
  const [forcingInput, setForcingInput] = useState('');
  // the daily limit follows the cap until the owner types in it
  const [form, setForm] = useState<{ cap: string; daily: string | null; label: string; error: string | null }>(() => ({ cap: model.args.amount, daily: null, label: defaultLabel(model, bookLabels), error: null }));
  const [remembered, setRemembered] = useState(false);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const sheetRejectRef = useRef<HTMLButtonElement>(null);
  // one wallet call at a time: a second click while one is out does nothing
  const inflight = useRef(false);

  useEffect(() => {
    if (state.failures > 0) writeFailures(scope, model.no, state.failures);
  }, [state.failures, scope, model.no]);

  const kind = state.kind;
  useEffect(() => {
    if (kind === 'confirming') sheetRejectRef.current?.focus({ preventScroll: true });
    else if (kind === 'idle' || kind === 'failed' || kind === 'declined') rejectRef.current?.focus({ preventScroll: true });
  }, [kind]);

  async function call(start: CardEvent, run: () => Promise<ApproveResult>, ok: (r: { tx: string }) => CardEvent): Promise<void> {
    if (inflight.current) return;
    inflight.current = true;
    dispatch(start);
    let result: ApproveResult;
    try {
      result = await run();
    } catch (e) {
      result = { ok: false, kind: 'wallet', name: errorName(e) };
    }
    inflight.current = false;
    if (result.ok) dispatch(ok(result));
    else dispatch(result.kind === 'wallet' ? { type: 'WALLET_ERROR', name: result.name } : { type: 'CONTRACT_REFUSED', name: result.name });
  }

  const remember =
    onApproveAndRemember === undefined
      ? undefined
      : {
          cap: form.cap,
          daily: form.daily ?? form.cap,
          label: form.label,
          error: form.error,
          unit: model.args.asset,
          onField: (field: RememberField, value: string) => setForm((f) => ({ ...f, [field]: value, error: null })),
          onRemember: () => {
            if (model.forcing !== null && model.forcing.required && !forcingSatisfied(forcingInput, model.args.to)) return;
            const parsed = rememberArgsOf(model, { cap: form.cap, daily: form.daily ?? form.cap, label: form.label, error: null }, decimals);
            if (!parsed.ok) {
              setForm((f) => ({ ...f, error: parsed.error }));
              return;
            }
            setForcingInput('');
            void call({ type: 'WALLET_SENT' }, () => onApproveAndRemember(parsed.args), (r) => {
              setRemembered(true);
              return { type: 'WALLET_OK', tx: r.tx };
            });
          },
        };

  return (
    <CardView
      model={model}
      remember={remember}
      remembered={remembered}
      readOnly={readOnly}
      state={state}
      rejectRef={rejectRef}
      sheetRejectRef={sheetRejectRef}
      onOpen={() => dispatch({ type: 'OPEN_SHEET' })}
      forcingInput={forcingInput}
      onForcingInput={setForcingInput}
      onCancel={() => {
        setForcingInput('');
        dispatch({ type: 'CANCEL_SHEET' });
      }}
      onConfirm={() => {
        // the button is disabled until the step is met, and the handler holds the same line for a click that races the render
        if (model.forcing !== null && model.forcing.required && !forcingSatisfied(forcingInput, model.args.to)) return;
        setForcingInput('');
        void call({ type: 'WALLET_SENT' }, () => onApprove(model.args), (r) => ({ type: 'WALLET_OK', tx: r.tx }));
      }}
      onReject={() => void call({ type: 'REJECT_SENT' }, () => onReject(model.args.id), () => ({ type: 'REJECT_OK' }))}
    />
  );
}

export function Card(props: CardProps) {
  const [snap] = useState(() => snapshot(props));
  // computed once, so a parent that rebuilds its props object does not restart the counter effect
  const [scope] = useState(() => props.scope ?? defaultScope());
  if (!snap.ok) {
    return (
      <section className="card" data-testid="card-unavailable">
        <p className="card-reason">{`This request has no approval card (${snap.code}). Nothing can be approved here.`}</p>
      </section>
    );
  }
  return <LiveCard model={snap.model} readOnly={props.view.state} scope={scope} onApprove={props.onApprove} onApproveAndRemember={props.onApproveAndRemember} onReject={props.onReject} decimals={props.asset.decimals} bookLabels={props.bookLabels} />;
}

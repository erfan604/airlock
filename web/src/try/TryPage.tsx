// AIR-311: the playground as three steps a first-time visitor can follow: pick a scam (the doctored amount is picked on arrival and its email is
// shown), see what the agent would pay, see what AIRLOCK decides next to what a payee-list guard does. A stand-in agent (a regular expression,
// said so on the page) builds the request; the verdict is the contract's own crate compiled to WebAssembly (verdictWasm.ts), run here in the
// browser. The only async step is loading the module once; every decision after that is synchronous, so a newer input can never be overwritten
// by an older answer. The owner's setup (book, cap, strict mode) is folded under a one-line summary, and the table at the end shows all five
// emails with the verdict the test suite checks the WebAssembly build against, so the page reads the same with or without JavaScript.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Specimen } from '../components/Specimen.tsx';
import { VERDICT_WORDS, VerdictStamp } from '../components/VerdictStamp.tsx';
import { url } from '../static.ts';
import { RequestSlip } from './RequestSlip.tsx';
import { EMAIL_SOURCE, MAX_EMAIL, WORLD, columnsOf, defaultKnobs, emailOf, formatDollars, parseDollars, payeeListGuard, sourceOf, stampOf, standIn, verdictSentence } from './model.ts';
import type { Knobs, Proposal, Source as TextSource } from './model.ts';
import { loadVerdict } from './verdictWasm.ts';
import type { VerdictModule } from './verdictWasm.ts';

export const ENGINE_LINE = 'This decision was made by the same airlock-verdict code the NEAR contract runs, compiled to WebAssembly, in your browser.';
const STAND_IN = 'The agent here is a stand-in, not a model: a few lines of pattern matching that do whatever the email says. It pays the first account named in the email, or another payee from your book if the email names one, and otherwise the payee you asked for. It pays the first dollar amount it finds.';
/** The example in the write-your-own box. Sent as it is when the box is left empty, so the button always does something. */
export const OWN_EXAMPLE = 'Hi, this is Kano Cotton. This month the invoice total is $1,200.00. Please pay it today.';

type Source = { kind: 'preset'; id: string } | { kind: 'own' };

const who = (p: Proposal): string => p.payee.name ?? p.payee.account;

function Pays({ email, source }: { email: string; source: TextSource }) {
  const agent = useMemo(() => standIn(email, WORLD, source), [email, source]);
  if (agent.kind === 'nothing') {
    return (
      <p className="try-pays" data-testid="try-pays" data-state="nothing">
        {agent.why === 'empty' ? 'Your agent would pay nothing: the email is empty.' : agent.why === 'bad-amount' ? 'Your agent would pay nothing: it could not read the amount as dollars and cents.' : 'Your agent would pay nothing: it found no amount in this email.'}
      </p>
    );
  }
  const p = agent.proposal;
  return (
    <>
      <p className="try-pays" data-testid="try-pays">
        Your agent would pay <strong className="try-pays-who">{who(p)}</strong> <strong className="try-pays-sum">{formatDollars(p.amount.cents)}</strong>
      </p>
      <RequestSlip proposal={p} compact />
    </>
  );
}

function Decision({ email, source, knobs, mod, failed }: { email: string; source: TextSource; knobs: Knobs; mod: VerdictModule | null; failed: boolean }) {
  const agent = useMemo(() => standIn(email, WORLD, source), [email, source]);
  if (agent.kind === 'nothing') {
    return (
      <div className="try-result" data-testid="try-result" data-state="nothing" aria-live="polite">
        <p className="try-reason" data-testid="try-reason">
          Nothing to decide: the stand-in proposed no payment, so the verdict was not asked.
        </p>
      </div>
    );
  }
  const p = agent.proposal;
  const v = mod === null ? null : mod.decide(columnsOf(p, knobs));
  const guard = payeeListGuard(p);
  return (
    <div className="try-result" data-testid="try-result" data-state={v === null ? 'loading' : stampOf(v)} aria-live="polite">
      {v === null ? (
        <p className="try-line" data-testid="try-loading">
          {failed ? 'The verdict module could not be loaded. Reload the page to try again.' : 'Loading the verdict.'}
        </p>
      ) : (
        <div className="try-decision" key={`${email}|${String(knobs.capCents)}|${String(knobs.strict)}`}>
          <div className="try-airlock">
            <p className="try-who">AIRLOCK</p>
            <VerdictStamp state={stampOf(v)} ruleId={v.kind === 'allow' || v.kind === 'malformed' ? undefined : v.reason} testId="try-verdict" />
            <p className="try-reason" data-testid="try-reason">
              {verdictSentence(v, p, knobs)}
            </p>
          </div>
          <div className={guard === 'PAY' && v.kind !== 'allow' ? 'try-guard try-guard-pay' : 'try-guard'} data-testid="try-guard" data-guard={guard}>
            <p className="try-who">A payee-list guard would</p>
            <p className="try-guard-word">{guard === 'PAY' ? `Pay ${formatDollars(p.amount.cents)}` : 'Refuse'}</p>
            <p className="try-guard-why">{guard === 'PAY' ? `${who(p)} is on the list and the amount is under the per-payment cap.` : p.payee.inBook ? 'The amount is over the per-payment cap.' : `${p.payee.account} is not on the list.`}</p>
          </div>
          <p className="try-engine" data-testid="try-engine">
            {ENGINE_LINE}
          </p>
        </div>
      )}
    </div>
  );
}

const STATE_WORD = (tag: string): string => {
  const kind = tag.split(':')[0];
  return kind === 'allow' ? VERDICT_WORDS.allowed[0] : kind === 'block' ? VERDICT_WORDS.blocked[0] : VERDICT_WORDS.held[0];
};
const RULE = (tag: string): string => tag.split(':')[1] ?? '';

/** All five emails at a glance: the expected tags of try-world.json, which web/test/try.test.ts and the e2e check against the wasm. */
function AtAGlance() {
  return (
    <section className="try-glance" aria-labelledby="glance-title" data-testid="try-glance">
      <h2 id="glance-title" className="try-h2">
        All five emails at a glance
      </h2>
      <p className="try-line">The same verdict code in default mode (a {formatDollars(defaultKnobs().capCents)} cap on amounts read from an email) and in strict mode (no cap). The test suite runs every line through the WebAssembly build and fails if one differs.</p>
      <table className="try-table">
          <thead data-audit-skip="">
            <tr>
              <th scope="col">The email</th>
              <th scope="col">Your agent would pay</th>
              <th scope="col">AIRLOCK, default</th>
              <th scope="col">AIRLOCK, strict</th>
              <th scope="col">A payee-list guard</th>
            </tr>
          </thead>
          <tbody>
            {WORLD.presets.map((x) => {
              const a = standIn(x.email, WORLD, sourceOf(x));
              const pays = a.kind === 'proposal' ? `${who(a.proposal)}, ${formatDollars(a.proposal.amount.cents)}` : 'nothing';
              return (
                <tr key={x.id} data-testid={`glance-${x.id}`}>
                  <th scope="row">{x.title}</th>
                  <td data-label="Your agent would pay">{pays}</td>
                  <td data-label="AIRLOCK, default" data-tag={x.expect.default}>
                    <span className={`glance-word glance-${x.expect.default.split(':')[0]}`}>{STATE_WORD(x.expect.default)}</span>
                    {RULE(x.expect.default) === '' ? null : <span className="glance-rule">{RULE(x.expect.default)}</span>}
                  </td>
                  <td data-label="AIRLOCK, strict" data-tag={x.expect.strict}>
                    <span className={`glance-word glance-${x.expect.strict.split(':')[0]}`}>{STATE_WORD(x.expect.strict)}</span>
                    {RULE(x.expect.strict) === '' ? null : <span className="glance-rule">{RULE(x.expect.strict)}</span>}
                  </td>
                  <td data-label="A payee-list guard">{x.expect.guard === 'PAY' ? 'pays' : 'refuses'}</td>
                </tr>
              );
            })}
          </tbody>
      </table>
    </section>
  );
}

export function TryPage() {
  const [mod, setMod] = useState<VerdictModule | null>(null);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState<Source>({ kind: 'preset', id: 'doctored' });
  const [draft, setDraft] = useState('');
  const [own, setOwn] = useState('');
  const [capText, setCapText] = useState(formatDollars(defaultKnobs().capCents).slice(1));
  const [strict, setStrict] = useState(false);
  const answer = useRef<HTMLElement>(null);
  /** On a one-column screen the answer is below the emails: bring step 2 to the top after a pick, smoothly unless motion is reduced. */
  const reveal = (): void => {
    const el = answer.current;
    if (el === null || window.matchMedia('(min-width: 1080px)').matches) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }));
  };

  useEffect(() => {
    let live = true;
    loadVerdict()
      .then((m) => live && setMod(m))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const capCents = parseDollars(capText.trim().replace(/^\$/, ''));
  const knobs: Knobs = { capCents: capCents ?? defaultKnobs().capCents, strict };
  const preset = source.kind === 'preset' ? WORLD.presets.find((x) => x.id === source.id) : undefined;
  const email = preset?.email ?? own;
  const textSource = preset === undefined ? EMAIL_SOURCE : sourceOf(preset);
  const shown = emailOf(email);
  const owner = WORLD.book.find((b) => b.account === WORLD.owner.payee);

  return (
    <main className="page try" data-testid="try">
      <header className="try-head">
        <div className="try-head-copy">
          <h1 className="try-title">Try to trick it</h1>
          <p className="try-lede">Pick a scam email. A stand-in agent does what the email says, and the real verdict decides whether the money moves.</p>
        </div>
      </header>

      <details className="try-setup" data-testid="try-setup">
        <summary className="try-setup-summary" data-testid="try-setup-toggle">
          <span className="try-setup-title">Your setup</span>
          <span className="try-setup-line">
            {`You asked to pay the ${owner?.name ?? WORLD.owner.payee} invoice. ${String(WORLD.book.length)} payees in your book. ${strict ? 'Strict mode: every amount read from an email waits for you.' : `Amounts read from an email are capped at ${formatDollars(knobs.capCents)}.`}`}
          </span>
        </summary>
        <div className="try-setup-body">
          <p className="try-ask" data-testid="try-ask">
            <span className="try-key">You asked</span> {WORLD.owner.request}
          </p>
          <table className="try-book" data-testid="try-book">
            <caption className="try-key">Your address book</caption>
            <thead>
              <tr>
                <th scope="col">Payee and account</th>
                <th scope="col">Usual bill</th>
              </tr>
            </thead>
            <tbody>
              {WORLD.book.map((b) => (
                <tr key={b.account}>
                  <td>
                    <span className="try-book-name">{b.name}</span>
                    <span className="try-mono try-book-account">{b.account}</span>
                  </td>
                  <td className="try-mono">{`${formatDollars(parseDollars(b.usual) ?? 0n)} a ${b.every}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="try-knobs">
            <label className="try-knob" htmlFor="try-cap">
              <span className="try-key">Cap for amounts read from an email</span>
              <span className="try-cap-field">
                <span aria-hidden="true">$</span>
                <input id="try-cap" data-testid="try-cap" className="try-input" inputMode="decimal" value={capText} disabled={strict} aria-invalid={capCents === null} onChange={(e) => setCapText(e.target.value)} />
              </span>
              {capCents === null ? (
                <span className="try-error" role="alert">
                  Write dollars and cents, like {formatDollars(defaultKnobs().capCents).slice(1)}. The verdict uses {formatDollars(knobs.capCents)} until then.
                </span>
              ) : null}
            </label>
            <label className="try-toggle" htmlFor="try-strict">
              <input id="try-strict" type="checkbox" data-testid="try-strict" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
              <span>
                <span className="try-toggle-title">Strict mode</span>
                <span className="try-toggle-line">No cap: every amount read from outside text waits for you.</span>
              </span>
            </label>
            <p className="try-limits">{`Also set: ${formatDollars(parseDollars(WORLD.limits.hardCap) ?? 0n)} hard cap per payment, ${formatDollars(parseDollars(WORLD.limits.taskBound) ?? 0n)} task bound, ${formatDollars(parseDollars(WORLD.limits.dataBudget) ?? 0n)} a day for amounts read from data.`}</p>
          </div>
        </div>
      </details>

      <div className="try-flow">
        <section className="try-step try-pick" aria-labelledby="pick-title">
          <h2 id="pick-title" className="try-h2">
            Pick a scam
          </h2>
          <ul className="try-presets" role="list" data-testid="try-presets">
            {WORLD.presets.map((x) => {
              const on = source.kind === 'preset' && source.id === x.id;
              return (
                <li key={x.id}>
                  <button
                    type="button"
                    className="try-preset"
                    data-testid={`try-preset-${x.id}`}
                    aria-pressed={on}
                    onClick={() => {
                      setSource({ kind: 'preset', id: x.id });
                      reveal();
                    }}
                  >
                    <span className="try-preset-title">{x.title}</span>
                    <span className="try-preset-line">{x.line}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {shown === null ? null : (
            <div className="try-mail">
              <p className="try-key">{preset === undefined ? 'The email you wrote' : 'The email your agent reads'}</p>
              <Specimen key={email} text={shown} channel="email" source={preset === undefined ? 'your email' : `from ${preset.from}`} testId="try-specimen" />
            </div>
          )}
          <form
            className="try-own"
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim() === '' ? OWN_EXAMPLE : draft;
              setOwn(text);
              setSource({ kind: 'own' });
              reveal();
            }}
          >
            <label className="try-key" htmlFor="try-email">
              Or write your own scam email
            </label>
            <textarea id="try-email" data-testid="try-email" className="try-input try-textarea" rows={3} maxLength={MAX_EMAIL} value={draft} placeholder={OWN_EXAMPLE} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" className="card-btn card-btn-outline try-run" data-testid="try-run" aria-pressed={source.kind === 'own'}>
              {draft.trim() === '' ? 'Send the example to the agent' : 'Send it to the agent'}
            </button>
          </form>
        </section>

        <div className="try-answer">
          <section className="try-step" aria-labelledby="pays-title" ref={answer}>
            <h2 id="pays-title" className="try-h2">
              What your agent would pay
            </h2>
            <Pays email={email} source={textSource} />
          </section>
          <section className="try-step" aria-labelledby="verdict-title">
            <h2 id="verdict-title" className="try-h2">
              What AIRLOCK decides
            </h2>
            <Decision email={email} source={textSource} knobs={knobs} mod={mod} failed={failed} />
          </section>
          <p className="try-standin" data-testid="try-standin">
            {STAND_IN}
          </p>
          <p className="try-more">
            <a href={url('replay')}>Watch the recorded testnet run</a>, where a real model reads the email and the contract on NEAR testnet holds the payment.
          </p>
        </div>
      </div>

      <AtAGlance />
    </main>
  );
}

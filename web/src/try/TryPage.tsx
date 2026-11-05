// AIR-311: the playground. Pick a preset email or write your own; a stand-in agent (a regular expression, said so on the page) builds the
// request; the verdict is the contract's own crate compiled to WebAssembly (verdictWasm.ts), run here in the browser. The only async step is
// loading the module once; every decision after that is synchronous, so a newer input can never be overwritten by an older answer.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Specimen } from '../components/Specimen.tsx';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import { url } from '../static.ts';
import { RequestSlip } from './RequestSlip.tsx';
import { MAX_EMAIL, WORLD, columnsOf, defaultKnobs, emailOf, formatDollars, parseDollars, payeeListGuard, stampOf, standIn, verdictSentence } from './model.ts';
import type { Knobs } from './model.ts';
import { loadVerdict } from './verdictWasm.ts';
import type { VerdictModule } from './verdictWasm.ts';

export const ENGINE_LINE = 'This decision was made by the same airlock-verdict code the NEAR contract runs, compiled to WebAssembly, in your browser.';
const STAND_IN = 'The agent here is a stand-in, not a model: a few lines of pattern matching that do whatever the email says. It pays the first account named in the email, or another payee from your book if the email names one, and otherwise the payee you asked for. It pays the first dollar amount it finds.';

type Source = { kind: 'preset'; id: string } | { kind: 'own' };

function Result({ email, knobs, mod, failed }: { email: string; knobs: Knobs; mod: VerdictModule | null; failed: boolean }) {
  const agent = useMemo(() => standIn(email), [email]);
  if (agent.kind === 'nothing') {
    return (
      <section className="try-result" data-testid="try-result" data-state="nothing" aria-live="polite">
        <h2 className="try-h2">Nothing to pay</h2>
        <p className="try-line" data-testid="try-reason">
          {agent.why === 'empty' ? 'The email is empty, so the stand-in has nothing to do.' : agent.why === 'bad-amount' ? 'The stand-in could not read the amount as dollars and cents, so it proposed nothing.' : 'The stand-in found no amount in this email, so it proposed nothing and the verdict was not asked.'}
        </p>
      </section>
    );
  }
  const p = agent.proposal;
  const v = mod === null ? null : mod.decide(columnsOf(p, knobs));
  const guard = payeeListGuard(p);
  return (
    <section className="try-result" data-testid="try-result" data-state={v === null ? 'loading' : stampOf(v)} aria-live="polite">
      <h2 className="try-h2">The request it built</h2>
      <RequestSlip proposal={p} />
      {v === null ? (
        <p className="try-line" data-testid="try-loading">{failed ? 'The verdict module could not be loaded. Reload the page to try again.' : 'Loading the verdict.'}</p>
      ) : (
        <div className="try-decision" key={`${email}|${String(knobs.capCents)}|${String(knobs.strict)}`}>
          <VerdictStamp state={stampOf(v)} ruleId={v.kind === 'allow' || v.kind === 'malformed' ? undefined : v.reason} testId="try-verdict" />
          <p className="try-reason" data-testid="try-reason">{verdictSentence(v, p, knobs)}</p>
          <p className={guard === 'PAY' && v.kind !== 'allow' ? 'try-guard try-guard-pay' : 'try-guard'} data-testid="try-guard" data-guard={guard}>
            <span className="try-guard-key">A payee-list guard would</span>
            <span className="try-guard-word">{guard === 'PAY' ? `Pay ${formatDollars(p.amount.cents)}` : 'Refuse'}</span>
            <span className="try-guard-why">{guard === 'PAY' ? `${p.payee.name ?? p.payee.account} is on the list and the amount is under the per-payment cap.` : p.payee.inBook ? 'The amount is over the per-payment cap.' : `${p.payee.account} is not on the list.`}</span>
          </p>
          <p className="try-engine" data-testid="try-engine">{ENGINE_LINE}</p>
        </div>
      )}
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
  const side = useRef<HTMLDivElement>(null);
  /** On a one-column screen the answer is below the emails: bring it into view after a pick, smoothly unless motion is reduced. */
  const reveal = (): void => {
    const el = side.current;
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
  const shown = emailOf(email);

  return (
    <main className="page try" data-testid="try">
      <header className="try-head">
        <h1 className="try-title">Try to trick it</h1>
        <p className="try-lede">Send the email a scammer would send. A stand-in agent does what it says, and the real verdict decides whether the money moves.</p>
      </header>

      <section className="try-setup" aria-labelledby="setup-title">
        <h2 id="setup-title" className="try-h2">Your setup</h2>
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
            {capCents === null ? <span className="try-error" role="alert">Write dollars and cents, like {formatDollars(defaultKnobs().capCents).slice(1)}. The verdict uses {formatDollars(knobs.capCents)} until then.</span> : null}
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
      </section>

      <div className="try-grid">
        <section className="try-inbox" aria-labelledby="inbox-title">
          <h2 id="inbox-title" className="try-h2">The email</h2>
          <ul className="try-presets" role="list">
            {WORLD.presets.map((x) => {
              const on = source.kind === 'preset' && source.id === x.id;
              return (
                <li key={x.id}>
                  <button type="button" className="try-preset" data-testid={`try-preset-${x.id}`} aria-pressed={on} onClick={() => {
                      setSource({ kind: 'preset', id: x.id });
                      reveal();
                    }}>
                    <span className="try-preset-title">{x.title}</span>
                    <span className="try-preset-line">{x.line}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {shown === null ? null : <Specimen text={shown} channel="email" source={preset === undefined ? 'your email' : `from ${preset.from}`} testId="try-specimen" />}
          <form
            className="try-own"
            onSubmit={(e) => {
              e.preventDefault();
              setOwn(draft);
              setSource({ kind: 'own' });
              reveal();
            }}
          >
            <label className="try-key" htmlFor="try-email">
              Or write your own scam email
            </label>
            <textarea id="try-email" data-testid="try-email" className="try-input try-textarea" rows={5} maxLength={MAX_EMAIL} value={draft} placeholder="Name an account or a payee from the book, and an amount." onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" className="card-btn card-btn-primary try-run" data-testid="try-run" disabled={draft.trim() === ''}>
              Send it to the agent
            </button>
          </form>
        </section>
        <div className="try-side" ref={side}>
          <Result email={email} knobs={knobs} mod={mod} failed={failed} />
          <p className="try-standin" data-testid="try-standin">{STAND_IN}</p>
          <p className="try-more">
            <a href={url('replay')}>Watch the recorded testnet run</a>, where a real model reads the email and the contract on NEAR testnet holds the payment.
          </p>
        </div>
      </div>
    </main>
  );
}

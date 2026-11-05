// AIR-311: the playground as three steps a first-time visitor can follow: pick a scam (the doctored amount is picked on arrival and its email is
// shown), see what the agent would pay, see what AIRLOCK decides next to what a payee-list guard does. A stand-in agent (a regular expression,
// said so on the page) builds the request; the verdict is the contract's own crate compiled to WebAssembly (verdictWasm.ts), run here in the
// browser. The only async step is loading the module once; every decision after that is synchronous, so a newer input can never be overwritten
// by an older answer. The owner's setup (book, cap, strict mode) is folded under a one-line summary, and the table at the end shows all five
// emails with the verdict the test suite checks the WebAssembly build against, so the page reads the same with or without JavaScript.
// AIR-312: a switch above the presets picks the world: "Your bills" (the owner's invoices) or "An agent you hired" (Swarm-for-Hire: the job
// budget is the task bound, the job's payees are the book, and the job post and every other agent's message are outside text). `?s=hired`
// opens the hired world.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Specimen } from '../components/Specimen.tsx';
import { VERDICT_WORDS, VerdictStamp } from '../components/VerdictStamp.tsx';
import { OneShot } from '../landing/OneShot.tsx';
import { url } from '../static.ts';
import { RequestSlip } from './RequestSlip.tsx';
import { MAX_EMAIL, WORLDS, columnsOf, defaultKnobs, emailOf, formatDollars, parseDollars, payeeListGuard, sourceOf, stampOf, standIn, uiOf, verdictSentence } from './model.ts';
import type { Knobs, Proposal, Source as TextSource, World, WorldId } from './model.ts';
import { loadVerdict } from './verdictWasm.ts';
import type { VerdictModule } from './verdictWasm.ts';

export const ENGINE_LINE = 'This decision was made by the same airlock-verdict code the NEAR contract runs, compiled to WebAssembly, in your browser.';
const STAND_IN = 'The agent here is a stand-in, not a model: a few lines of pattern matching that do whatever the text says. It pays the first account the text names, or another payee from the book if the text names one, and otherwise the payee you set. It pays the first dollar amount it finds.';

type Source = { kind: 'preset'; id: string } | { kind: 'own' };

const who = (p: Proposal): string => p.payee.name ?? p.payee.account;

function Pays({ email, source, world }: { email: string; source: TextSource; world: World }) {
  const agent = useMemo(() => standIn(email, world, source), [email, source, world]);
  const lead = uiOf(world).pays;
  if (agent.kind === 'nothing') {
    return (
      <p className="try-pays" data-testid="try-pays" data-state="nothing">
        {agent.why === 'empty' ? `${lead} nothing: the text is empty.` : agent.why === 'bad-amount' ? `${lead} nothing: it could not read the amount as dollars and cents.` : `${lead} nothing: it found no amount in this text.`}
      </p>
    );
  }
  const p = agent.proposal;
  return (
    <>
      <p className="try-pays" data-testid="try-pays">
        {lead} <strong className="try-pays-who">{who(p)}</strong> <strong className="try-pays-sum">{formatDollars(p.amount.cents)}</strong>
      </p>
      <RequestSlip proposal={p} world={world} compact />
    </>
  );
}

function Decision({ email, source, world, knobs, mod, failed }: { email: string; source: TextSource; world: World; knobs: Knobs; mod: VerdictModule | null; failed: boolean }) {
  const agent = useMemo(() => standIn(email, world, source), [email, source, world]);
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
  const v = mod === null ? null : mod.decide(columnsOf(p, knobs, world));
  const guard = payeeListGuard(p, world);
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
            {v.kind === 'allow' || v.kind === 'escalate' ? (
              <>
                <OneShot
                  name={v.kind === 'allow' ? 'stamp-allowed' : 'stamp-held'}
                  run={`${email}|${String(knobs.capCents)}|${String(knobs.strict)}`}
                  alt={v.kind === 'allow' ? 'A rubber stamp comes down on the payment request slip and leaves ALLOWED in green ink.' : 'A rubber stamp comes down on the payment request slip and leaves HELD FOR YOU in red ink.'}
                  className="try-stamp"
                  testId="try-stamp"
                />
                <div className="sr-only" data-audit-skip="">
                  <VerdictStamp state={stampOf(v)} ruleId={v.kind === 'allow' ? undefined : v.reason} testId="try-verdict" />
                </div>
                <p className="try-rule" data-testid="try-rule">
                  {v.kind === 'allow' ? 'ALLOW' : `ESCALATE, rule ${v.reason}`}
                </p>
              </>
            ) : (
              <VerdictStamp state={stampOf(v)} ruleId={v.kind === 'malformed' ? undefined : v.reason} testId="try-verdict" />
            )}
            <p className="try-reason" data-testid="try-reason">
              {verdictSentence(v, p, knobs, world)}
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

/** Every preset at a glance: the expected tags of the world's fixture, which web/test/try.test.ts and the e2e check against the wasm. */
function AtAGlance({ world }: { world: World }) {
  return (
    <section className="try-glance" aria-labelledby="glance-title" data-testid="try-glance">
      <h2 id="glance-title" className="try-h2">
        {uiOf(world).glance}
      </h2>
      <p className="try-line">The same verdict code in default mode (a {formatDollars(defaultKnobs(world).capCents)} cap on amounts read from {uiOf(world).outside}) and in strict mode (no cap). The test suite runs every line through the WebAssembly build and fails if one differs.</p>
      <table className="try-table">
          <thead data-audit-skip="">
            <tr>
              <th scope="col">What the agent reads</th>
              <th scope="col">Your agent would pay</th>
              <th scope="col">AIRLOCK, default</th>
              <th scope="col">AIRLOCK, strict</th>
              <th scope="col">A payee-list guard</th>
            </tr>
          </thead>
          <tbody>
            {world.presets.map((x) => {
              const a = standIn(x.email, world, sourceOf(x));
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

const SETS: { id: WorldId; label: string }[] = [
  { id: 'bills', label: 'Your bills' },
  { id: 'hired', label: 'An agent you hired' },
];

const fill = (t: string, w: World): string =>
  t
    .replace('{owner}', w.book.find((b) => b.account === w.owner.payee)?.name ?? w.owner.payee)
    .replace('{n}', String(w.book.length))
    .replace('{budget}', formatDollars(parseDollars(w.limits.taskBound) ?? 0n));

export function TryPage() {
  const [mod, setMod] = useState<VerdictModule | null>(null);
  const [failed, setFailed] = useState(false);
  const [set, setSet] = useState<WorldId>('bills');
  const [source, setSource] = useState<Source>({ kind: 'preset', id: uiOf(WORLDS.bills).first });
  const [draft, setDraft] = useState('');
  const [own, setOwn] = useState('');
  const [capText, setCapText] = useState(formatDollars(defaultKnobs(WORLDS.bills).capCents).slice(1));
  const [strict, setStrict] = useState(false);
  const answer = useRef<HTMLElement>(null);
  const world = WORLDS[set];
  const ui = uiOf(world);
  /** On a one-column screen the answer is below the emails: bring step 2 to the top after a pick, smoothly unless motion is reduced. */
  const reveal = (): void => {
    const el = answer.current;
    if (el === null || window.matchMedia('(min-width: 1080px)').matches) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }));
  };
  const pickSet = (id: WorldId, push: boolean): void => {
    const w = WORLDS[id];
    setSet(id);
    setSource({ kind: 'preset', id: uiOf(w).first });
    setCapText(formatDollars(defaultKnobs(w).capCents).slice(1));
    setDraft('');
    if (push) {
      const u = new URL(window.location.href);
      if (id === 'bills') u.searchParams.delete('s');
      else u.searchParams.set('s', id);
      window.history.replaceState(null, '', u);
    }
  };

  useEffect(() => {
    // after mount, so a prerendered page and the first client render agree (both start on the bills)
    if (new URLSearchParams(window.location.search).get('s') === 'hired') pickSet('hired', false);
  }, []);

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
  const knobs: Knobs = { capCents: capCents ?? defaultKnobs(world).capCents, strict };
  const preset = source.kind === 'preset' ? world.presets.find((x) => x.id === source.id) : undefined;
  const email = preset?.email ?? own;
  const textSource = preset === undefined ? ui.ownSource : sourceOf(preset);
  const shown = emailOf(email);

  return (
    <main className="page try" data-testid="try" data-world={set}>
      <header className="try-head">
        <div className="try-head-copy">
          <h1 className="try-title">Try to trick it</h1>
          <p className="try-lede" key={set}>
            {ui.lede}
          </p>
        </div>
      </header>

      <div className="try-sets" role="group" aria-label="Scenario" data-testid="try-sets">
        {SETS.map((x) => (
          <button key={x.id} type="button" className="try-set" data-testid={`try-set-${x.id}`} aria-pressed={set === x.id} onClick={() => set !== x.id && pickSet(x.id, true)}>
            {x.label}
          </button>
        ))}
      </div>

      <details className="try-setup" data-testid="try-setup">
        <summary className="try-setup-summary" data-testid="try-setup-toggle">
          <span className="try-setup-title">{set === 'hired' ? 'The job and its limits' : 'Your setup'}</span>
          <span className="try-setup-line">
            {`${fill(ui.setupLine, world)} ${strict ? `Strict mode: every amount read from ${ui.outside} waits for you.` : `Amounts read from ${ui.outside} are capped at ${formatDollars(knobs.capCents)}.`}`}
          </span>
        </summary>
        <div className="try-setup-body">
          <p className="try-ask" data-testid="try-ask">
            <span className="try-key">{ui.askKey}</span> {world.owner.request}
          </p>
          <table className="try-book" data-testid="try-book">
            <caption className="try-key">{ui.bookTitle}</caption>
            <thead>
              <tr>
                <th scope="col">Payee and account</th>
                <th scope="col">Usual bill</th>
              </tr>
            </thead>
            <tbody>
              {world.book.map((b) => (
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
              <span className="try-key">{`Cap for amounts read from ${ui.outside}`}</span>
              <span className="try-cap-field">
                <span aria-hidden="true">$</span>
                <input id="try-cap" data-testid="try-cap" className="try-input" inputMode="decimal" value={capText} disabled={strict} aria-invalid={capCents === null} onChange={(e) => setCapText(e.target.value)} />
              </span>
              {capCents === null ? (
                <span className="try-error" role="alert">
                  Write dollars and cents, like {formatDollars(defaultKnobs(world).capCents).slice(1)}. The verdict uses {formatDollars(knobs.capCents)} until then.
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
            <p className="try-limits">{`Also set: ${formatDollars(parseDollars(world.limits.hardCap) ?? 0n)} hard cap per payment, ${formatDollars(parseDollars(world.limits.taskBound) ?? 0n)} task bound${set === 'hired' ? ' (the job budget)' : ''}, ${formatDollars(parseDollars(world.limits.dataBudget) ?? 0n)} a day for amounts read from data.`}</p>
          </div>
        </div>
      </details>

      <div className="try-flow">
        <section className="try-step try-pick" aria-labelledby="pick-title">
          <h2 id="pick-title" className="try-h2">
            {ui.pick}
          </h2>
          <ul className="try-presets" role="list" data-testid="try-presets" key={set}>
            {world.presets.map((x) => {
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
              <p className="try-key">{preset === undefined ? 'The text you wrote' : ui.reads}</p>
              <Specimen key={email} text={shown} channel={textSource.channel} source={preset === undefined ? 'your text' : `from ${preset.from}`} testId="try-specimen" />
            </div>
          )}
          <form
            className="try-own"
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim() === '' ? ui.ownExample : draft;
              setOwn(text);
              setSource({ kind: 'own' });
              reveal();
            }}
          >
            <label className="try-key" htmlFor="try-email">
              {ui.ownLabel}
            </label>
            <textarea id="try-email" data-testid="try-email" className="try-input try-textarea" rows={3} maxLength={MAX_EMAIL} value={draft} placeholder={ui.ownExample} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" className="card-btn card-btn-outline try-run" data-testid="try-run" aria-pressed={source.kind === 'own'}>
              {draft.trim() === '' ? 'Send the example to the agent' : 'Send it to the agent'}
            </button>
          </form>
        </section>

        <div className="try-answer">
          <section className="try-step" aria-labelledby="pays-title" ref={answer}>
            <h2 id="pays-title" className="try-h2">
              What the agent would pay
            </h2>
            <Pays email={email} source={textSource} world={world} />
          </section>
          <section className="try-step" aria-labelledby="verdict-title">
            <h2 id="verdict-title" className="try-h2">
              What AIRLOCK decides
            </h2>
            <Decision email={email} source={textSource} world={world} knobs={knobs} mod={mod} failed={failed} />
          </section>
          <p className="try-standin" data-testid="try-standin">
            {STAND_IN}
          </p>
          <p className="try-more">
            <a href={url('replay')}>Watch the recorded testnet run</a>, where a real model reads the email and the contract on NEAR testnet holds the payment.
          </p>
        </div>
      </div>

      <AtAGlance world={world} />
    </main>
  );
}

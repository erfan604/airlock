// AIR-311: the landing. Top to bottom: the hero over the muted scan loop, the headline case (one booked payee, one email that changes only the
// amount, the request field by field with where each value came from, AIRLOCK's verdict next to a payee-list guard's), the numbers from
// bench.json, how it works, and what is and is not proven. Motion is CSS only and plays once; reduced motion shows the end state and the poster.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import proven from '../../../docs/proven.json';
import { loadBench } from '../bench/types.ts';
import { Specimen } from '../components/Specimen.tsx';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import { url } from '../static.ts';
import { RequestSlip } from '../try/RequestSlip.tsx';
import { WORLD, defaultKnobs, emailOf, formatDollars, parseDollars, payeeListGuard, standIn, verdictSentence } from '../try/model.ts';
import { REASONS } from '../try/verdictWasm.ts';
import type { WasmVerdict } from '../try/verdictWasm.ts';
import { factsOf } from './facts.ts';
import type { Facts } from './facts.ts';
import { HeroMedia } from './HeroMedia.tsx';
import { SiteLoop } from './SiteLoop.tsx';
import { preload } from '../preload.ts';

type Proven = { entries: { id: string; says: string }[]; notCovered: string[] };
const PROVEN = proven as unknown as Proven;

/** The preset's recorded expectation as a verdict; web/test/try.test.ts runs the same preset through the wasm and checks it. */
function expected(tag: string): WasmVerdict {
  const [kind, reason] = tag.split(':');
  const r = REASONS.find((x) => x === reason);
  if (kind === 'allow') return { kind: 'allow' };
  if (r !== undefined && (kind === 'escalate' || kind === 'block')) return { kind, reason: r };
  return { kind: 'malformed' };
}

function HeadlineCase() {
  const preset = WORLD.presets.find((p) => p.id === 'doctored');
  const agent = preset === undefined ? null : standIn(preset.email);
  const shown = preset === undefined ? null : emailOf(preset.email);
  if (preset === undefined || agent === null || agent.kind !== 'proposal' || shown === null) return null;
  const p = agent.proposal;
  const usual = WORLD.book.find((b) => b.account === p.payee.account);
  const v = expected(preset.expect.default);
  return (
    <section className="case" aria-labelledby="case-title" data-testid="landing-case">
      <div className="case-intro">
        <h2 id="case-title" className="land-h2">Same payee, new amount</h2>
        <p className="land-p">
          {`${p.payee.name ?? p.payee.account} bills you ${usual === undefined ? '' : `${formatDollars(parseDollars(usual.usual) ?? 0n)} a ${usual.every}`}. This email changes only the amount. The payee is real and already in your book, so a payee list has nothing to object to.`}
        </p>
      </div>
      <div className="case-grid">
        <div className="case-email">
          <h3 className="land-h3">The email your agent reads</h3>
          <Specimen text={shown} channel="email" source={`from ${preset.from}`} testId="case-email" />
        </div>
        <div className="case-airlock" data-testid="case-airlock">
          <h3 className="land-h3">AIRLOCK checks where each value came from</h3>
          <div className="case-scan">
            <RequestSlip proposal={p} />
          </div>
          <div className="case-stamp">
            <VerdictStamp state="held" ruleId={v.kind === 'escalate' ? v.reason : undefined} testId="case-verdict" />
            <p className="case-reason">{verdictSentence(v, p, defaultKnobs())}</p>
          </div>
        </div>
        <div className="case-guard" data-testid="case-guard">
          <h3 className="land-h3">A payee-list guard checks the name</h3>
          <ul className="guard-checks">
            <li>{`${p.payee.name ?? p.payee.account} is on the list`}</li>
            <li>{`${formatDollars(p.amount.cents)} is under the per-payment cap`}</li>
          </ul>
          <p className="guard-paid" data-guard={payeeListGuard(p)}>
            <span className="guard-paid-word">Paid</span>
            <span className="guard-paid-sum">{`${formatDollars(p.amount.cents)} left your account`}</span>
          </p>
        </div>
      </div>
      <p className="case-more">
        <a href={url('try')}>Run this email through the real verdict</a>, then change one word and run it again.
      </p>
    </section>
  );
}

function Figure({ big, children, testId }: { big: string; children: ReactNode; testId: string }) {
  return (
    <div className="fig" data-testid={testId}>
      <p className="fig-big">{big}</p>
      <p className="fig-say">{children}</p>
    </div>
  );
}

function Numbers({ facts }: { facts: Facts | null | 'loading' }) {
  if (facts === 'loading') return <section className="nums" aria-busy="true" data-testid="landing-numbers-loading" />;
  if (facts === null) {
    return (
      <section className="nums" data-testid="landing-numbers-missing">
        <p className="land-p">
          The bench numbers could not be read here. <a href={url('bench')}>Open the Bench page</a>.
        </p>
      </section>
    );
  }
  const of = (c: { k: string; n: string }): string => `${c.k} of ${c.n}`;
  return (
    <section className="nums" aria-labelledby="nums-title" data-testid="landing-numbers">
      <h2 id="nums-title" className="land-h2">What the bench measured</h2>
      <div className="nums-row">
        <Figure big={of(facts.bookedOfPaid)} testId="fig-booked">
          attacks that worked on an agent with no guard paid a payee already in the owner&apos;s address book.
        </Figure>
        <Figure big={of(facts.strict)} testId="fig-strict">
          attack runs moved money with AIRLOCK in strict mode.
        </Figure>
        <Figure big={of(facts.dflt)} testId="fig-default">
          {`attack runs moved money in default mode${facts.residualCase === null ? '' : `, all ${facts.residualRuns ?? ''} in one case`}: outside text raised an amount to a booked payee and stayed inside the cap the owner set. Strict mode holds that case.`}
        </Figure>
        <Figure big={of(facts.honestAlone)} testId="fig-honest">
          {`honest payment tasks went through in default mode with no tap from you. ${facts.honestTapped.k} more waited for one tap: those are honest payments held by mistake. ${facts.honestFailed.k} did not finish. Strict mode: ${facts.strictAlone.k} alone, ${facts.strictTapped.k} after one tap.`}
        </Figure>
      </div>
      <p className="nums-note">
        {`Our own corpus, ${facts.model} as the agent's model, each run recorded. `}
        <a href={url('bench')}>Every table is on the Bench page</a>.
      </p>
    </section>
  );
}

const HIRE_MAP = [
  { theirs: 'The job budget', ours: 'the task bound', says: 'The agent cannot pay out more than the job pays it.' },
  { theirs: "The job's payees", ours: 'the address book', says: "Inference, tools and the poster's refund account; nothing else is a known payee." },
  { theirs: 'The job post and every other agent', ours: 'outside text', says: 'A payee they pick waits for the owner; an amount they pick is paid only up to the cap the owner set, and strict mode holds every one.' },
];

/** AIR-312: the Swarm-for-Hire mapping, in plain words, with the link that opens the Try page in the hired-agent world. */
function Hire() {
  return (
    <section className="hire" aria-labelledby="hire-title" data-testid="landing-hire">
      <div className="hire-intro">
        <h2 id="hire-title" className="land-h2">
          Built for agents you hire
        </h2>
        <p className="land-p">
          In a Swarm-for-Hire, anyone posts a job, an agent takes it and pays for its own inference out of the job payment, and it reads text written by the poster and by other agents. AIRLOCK reads that setup the same way it reads a bill:
        </p>
      </div>
      <dl className="hire-map">
        {HIRE_MAP.map((m) => (
          <div key={m.theirs} className="hire-row">
            <dt className="hire-theirs">{m.theirs}</dt>
            <dd className="hire-ours">
              <span className="hire-is">{`is ${m.ours}.`}</span> {m.says}
            </dd>
          </div>
        ))}
      </dl>
      <p className="case-more">
        <a href={url('try?s=hired')} data-testid="cta-hired">
          Try it with an agent you hired
        </a>
        : an inflated inference bill from another agent, a job post that grabs the budget. It runs on the shipped verdict in your browser; it is a scenario, not a benchmarked case.
      </p>
    </section>
  );
}

const STEPS = [
  { title: 'Labels travel with values', body: 'Every value your agent handles carries where it came from: your own words, your address book, or outside text such as an email. No model sets a label.' },
  { title: 'The NEAR contract runs the verdict', body: 'The contract reads the labels, your book and your limits, and answers allow, hold for you, or block. The decision is a small pure function with no model in it.' },
  { title: 'MPC signs only an allowed request', body: 'Chain signatures sign the payment only after the contract allows it. A held payment waits for your approval, and the contract checks it again.' },
];

function How() {
  return (
    <section className="how" aria-labelledby="how-title">
      <div className="how-head">
        <div className="how-head-copy">
          <h2 id="how-title" className="land-h2">
            How it works
          </h2>
          <p className="land-p">The tag on a suitcase is the payee. A payee list reads only the tag. AIRLOCK looks inside: where the amount came from.</p>
        </div>
        <SiteLoop name="loophow" alt="Seen from above, suitcases with an email inside ride into the glass AIRLOCK scanner; under the scan line each shell turns to X-ray and the email inside shows." className="how-loop" />
      </div>
      <ol className="how-track">
        {STEPS.map((s) => (
          <li key={s.title} className="how-stop">
            <h3 className="how-title">{s.title}</h3>
            <p className="land-p">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

const SHOWN_PROOFS = ['untrusted-amount-bounded', 'recipient-trusted', 'total'];

function Proven() {
  const shown = PROVEN.entries.filter((e) => SHOWN_PROOFS.includes(e.id));
  return (
    <section className="limits" aria-labelledby="limits-title">
      <h2 id="limits-title" className="land-h2">What is proven, and what is not</h2>
      <div className="limits-cols">
        <div>
          <h3 className="land-h3">{`Checked by Kani and Lean, from the ${String(PROVEN.entries.length)} statements on the Proven page`}</h3>
          <ul className="limits-list">
            {shown.map((e) => (
              <li key={e.id}>{e.says}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="land-h3">Not covered</h3>
          <ul className="limits-list limits-not">
            {PROVEN.notCovered.slice(0, 4).map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="case-more">
        <a href={url('proven')}>Read every statement and its limits</a>.
      </p>
    </section>
  );
}

export function Landing() {
  // AIR-311: a prerendered page carries the numbers it was built with, so the first render already shows them
  const [facts, setFacts] = useState<Facts | null | 'loading'>(() => {
    const pre = preload()?.facts;
    return pre === undefined ? 'loading' : pre;
  });
  useEffect(() => {
    if (facts !== 'loading') return undefined;
    let live = true;
    void loadBench().then((d) => {
      if (live) setFacts(d === null ? null : factsOf(d));
    });
    return () => {
      live = false;
    };
  }, [facts]);
  return (
    <main className="landing" data-testid="landing">
      <section className="hero" aria-labelledby="hero-title">
        <HeroMedia />
        <div className="hero-copy">
          <h1 id="hero-title" className="hero-title">
            A payment gate for AI agents that checks where every value came from.
          </h1>
          <p className="hero-line">A payee list stops strangers. It cannot tell your supplier&apos;s real invoice from one where only the amount was changed.</p>
          <div className="hero-actions">
            <a className="act act-primary" href={url('try')} data-testid="cta-try">
              Try to trick it
            </a>
            <a className="act act-quiet" href={url('replay')} data-testid="cta-replay">
              Watch the recorded run
            </a>
          </div>
        </div>
      </section>
      <div className="land-body">
        <HeadlineCase />
        <Numbers facts={facts} />
        <Hire />
        <How />
        <Proven />
        <footer className="land-foot">
          <p>
            NEAR testnet only. Nothing on this site moves real money. <a href={url('live')}>Run it yourself</a> from the repository.
          </p>
        </footer>
      </div>
    </main>
  );
}

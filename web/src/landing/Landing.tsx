// AIR-311, AIR-346: the landing. Top to bottom: the hero over the muted scan loop with the pool's one live number, how the pool lends, the headline case (one booked payee, one email that changes only the
// amount, the request field by field with where each value came from, AIRLOCK's verdict next to a payee-list guard's), the numbers from
// bench.json, how it works, and what is and is not proven. Motion is CSS only and plays once; reduced motion shows the end state and the poster.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import proven from '../../../docs/proven.json';
import { loadBench } from '../bench/types.ts';
import { Specimen } from '../components/Specimen.tsx';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import { plain } from '../components/plain.ts';
import { STATIC, url } from '../static.ts';
import { RequestSlip } from '../try/RequestSlip.tsx';
import { WORLD, defaultKnobs, emailOf, formatDollars, parseDollars, payeeListGuard, standIn, verdictSentence } from '../try/model.ts';
import { REASONS } from '../try/verdictWasm.ts';
import type { WasmVerdict } from '../try/verdictWasm.ts';
import { factsOf, poolLine } from './facts.ts';
import type { Facts, PoolRead } from './facts.ts';
import { readPool } from '../credit/chain.ts';
import { CREDIT_POOL } from '../credit/net.ts';
import { NEAR_RPC } from '../../csp.ts';
import { HeroMedia } from './HeroMedia.tsx';
import { TubeBand } from './TubeBand.tsx';
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

/** AIR-346: the pool, said plainly, right under the hero: what lenders fund, what the card can pay, what the contract checks, and what it does not stop. */
function CreditTeaser() {
  return (
    <section className="hire" aria-labelledby="credit-teaser-title" data-testid="landing-credit">
      <div className="hire-intro">
        <h2 id="credit-teaser-title" className="land-h2">
          How the pool lends
        </h2>
        <p className="land-p">
          Lenders stake NEAR into one pool. Each agent gets a credit line held on a card, and the card pays only merchants the owner booked. A line needs 30 percent collateral. Every payment goes through the policy contract first: a payee or an amount that came from outside text, such as an email, is held for the owner or refused before the pool&apos;s money moves.
        </p>
        <p className="land-p">
          What it does not stop: the issuer books the merchants, so a merchant who works with the borrower can still walk off with the money. And in default mode an amount read from outside text is paid when it stays inside the booked merchant&apos;s cap.
        </p>
      </div>
      <p className="case-more">
        <a href={url('credit')} data-testid="cta-credit">
          See the pool, its credit lines and their payments
        </a>
        , read from the pool contract in your browser.
      </p>
    </section>
  );
}

/** AIR-346 (D9): the one live number under the hero buttons. The prerender carries the recorded value, labelled; the hosted copy then reads the pool. */
function HeroPool() {
  const [read, setRead] = useState<PoolRead>({ kind: 'recorded' });
  useEffect(() => {
    // the local console (replay mode, no keys) makes no request off its own origin: it keeps the recorded value, labelled
    if (!STATIC) return undefined;
    let live = true;
    readPool({ pool: CREDIT_POOL, rpcUrls: NEAR_RPC }).then(
      (p) => {
        if (live) setRead({ kind: 'live', assets: p.assets, losses: p.losses });
      },
      () => {
        if (live) setRead({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const line = poolLine(read);
  return (
    <p className="hero-pool" data-testid="hero-pool" data-live={line.live ? 'true' : 'false'}>
      <span className="hero-pool-num" data-testid="hero-pool-held">{line.held}</span>
      {' in the pool, '}
      <span className="hero-pool-num" data-testid="hero-pool-lost">{line.lost}</span>
      {' lost. '}
      <span className="hero-pool-note">{line.note}</span>
    </p>
  );
}

const STEPS = [
  { title: 'Labels travel with values', body: 'Every value your agent handles carries where it came from: your own words, your address book, or outside text such as an email. No model sets a label.' },
  { title: 'The NEAR contract runs the verdict', body: 'The contract reads the labels, your book and your limits, and answers allow, hold for you, or block. The decision is a small pure function with no model in it.' },
  { title: 'MPC signs only an allowed request', body: 'Chain signatures sign the payment only after the contract allows it. A held payment waits for your approval, and the contract checks it again.' },
];

function How() {
  const [step, setStep] = useState<0 | 1 | 2 | null>(null);
  return (
    <section className="how" aria-labelledby="how-title">
      <TubeBand onStep={setStep} />
      <div className="how-head">
        <div className="how-head-copy">
          <h2 id="how-title" className="land-h2">
            How it works
          </h2>
          <p className="land-p">
            Every value travels with a label that says where it came from. The NEAR contract reads the labels: what your own words and your address book decided goes through within your limits, and what an email decided waits for you, unless it is an amount inside the cap you set.
          </p>
        </div>
      </div>
      <ol className="how-track">
        {STEPS.map((s, i) => (
          <li key={s.title} className="how-stop" data-active={step === i ? 'true' : undefined} data-testid={`how-step-${String(i + 1)}`}>
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
              <li key={e.id}>{plain(e.says)}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="land-h3">Not covered</h3>
          <ul className="limits-list limits-not">
            {PROVEN.notCovered.slice(0, 4).map((t) => (
              <li key={t}>{plain(t)}</li>
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
            A lending pool for AI agents on NEAR.
          </h1>
          <p className="hero-line">Lenders fund a credit line held on a card that pays only merchants the owner booked. A contract checks where every payee and amount came from, so a hijacked agent cannot send the lenders&apos; money anywhere but a booked merchant.</p>
          <div className="hero-actions">
            <a className="act act-primary" href={url('credit')} data-testid="cta-pool">
              See the pool
            </a>
            <a className="act act-quiet" href={url('try')} data-testid="cta-try">
              Try to trick it
            </a>
          </div>
          <HeroPool />
        </div>
      </section>
      <div className="land-body">
        <CreditTeaser />
        <HeadlineCase />
        <Numbers facts={facts} />
        <Hire />
        <How />
        <Proven />
        <footer className="land-foot">
          <p>
            <a href={url('use')}>Run it yourself</a> with your own agent, from the repository.
          </p>
        </footer>
      </div>
    </main>
  );
}

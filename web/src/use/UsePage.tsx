// AIR-313: the /use page, the quickstart for people: each step with its exact command and the last line to expect, and what the agent
// cannot do. Static text, prerendered; the copy buttons appear only once the script runs, so a reader without JavaScript sees plain commands.
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { NEEDS, ONE_LINE, STEPS } from './steps.ts';
import type { Step } from './steps.ts';

function Copy({ text }: { text: string }): ReactElement | null {
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => setReady(typeof navigator !== 'undefined' && navigator.clipboard !== undefined), []);
  if (!ready) return null;
  return (
    <button
      type="button"
      className="use-copy"
      data-testid="use-copy"
      aria-label="Copy the command"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function StepItem({ step, n }: { step: Step; n: number }): ReactElement {
  return (
    <li className="use-step" data-testid={`use-step-${step.id}`}>
      <span className="use-num" aria-hidden="true">
        {n}
      </span>
      <div className="use-body">
        <h2 className="use-h2">{step.title}</h2>
        <p className="use-text">{step.text}</p>
        {step.cmd === undefined ? null : (
          <div className="use-cmd">
            <code className="use-code">{step.cmd}</code>
            <Copy text={step.cmd} />
          </div>
        )}
        {step.last === undefined ? null : (
          <p className="use-last">
            <span className="use-key">Last line:</span> <code>{step.last}</code>
          </p>
        )}
        {step.note === undefined ? null : <p className="use-note">{step.note}</p>}
      </div>
    </li>
  );
}

export function UsePage(): ReactElement {
  return (
    <main className="page use" data-testid="use">
      <h1 className="use-title">Use it with your own agent</h1>
      <p className="use-lede">
        Put AIRLOCK between any MCP agent and your NEAR testnet funds in about five minutes. The agent reads your inbox and asks to pay; your policy
        contract decides. The agent never sets a label: values it read keep the label of where they came from, and a value it types counts as yours
        only when your own request holds it.
      </p>
      <p className="use-needs">
        <span className="use-key">You need:</span> {NEEDS}
      </p>
      <section className="use-oneline" data-testid="use-oneline" aria-labelledby="use-oneline-title">
        <h2 id="use-oneline-title" className="use-h2">
          {ONE_LINE.title}
        </h2>
        <p className="use-text">{ONE_LINE.text}</p>
        <div className="use-cmd">
          <code className="use-code">{ONE_LINE.cmd}</code>
          <Copy text={ONE_LINE.cmd} />
        </div>
        <p className="use-last">
          <span className="use-key">Last line:</span> <code>{ONE_LINE.last}</code>
        </p>
      </section>
      <ol className="use-steps" data-testid="use-steps">
        {STEPS.map((s, i) => (
          <StepItem key={s.id} step={s} n={i + 1} />
        ))}
      </ol>
      <section className="use-limits" aria-labelledby="use-limits-title">
        <h2 id="use-limits-title" className="use-h2">
          What the agent can and cannot do
        </h2>
        <ul className="use-list">
          <li>It can pay without you only an address-book payee, inside the task your server signs from your config and inside the payee and asset limits.</li>
          <li>It cannot change your request, your limits or your book, and it cannot approve: approval needs your owner key.</li>
          <li>It can still cause held payments, which cost your attention, and it decides when to pay inside your limits.</li>
          <li>The full list is the MCP client entry of docs/THREAT_MODEL.md; the steps with every expected line are docs/QUICKSTART.md.</li>
        </ul>
      </section>
    </main>
  );
}

export default UsePage;

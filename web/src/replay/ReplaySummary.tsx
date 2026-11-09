// AIR-311: the replay page as plain text, from the facts the prerender computed (summary.ts): each act with its verdict, the money, the reason in
// plain words, the owner's words and the testnet transaction. It is what the static /replay page holds before its script runs, and what a reader
// without JavaScript gets; the console replaces it with the interactive replay once the recordings are read.
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import { hostedText } from '../components/account.ts';
import type { ActSummary } from './summary.ts';

const EXPLORERS = ['https://testnet.nearblocks.io/txns/', 'https://sepolia.basescan.org/tx/'];
const txHref = (u: string): string | undefined => (EXPLORERS.some((p) => u.startsWith(p)) ? u : undefined);

export function ReplaySummary({ acts }: { acts: ActSummary[] }) {
  return (
    <main className="page replay" data-testid="replay-summary">
      <p className="replay-banner">Replay of recorded runs</p>
      <h1 className="replay-summary-title">The recorded run, act by act</h1>
      <p className="replay-lede">This is a replay of recorded runs. Nothing runs live, no wallet is used and no key is needed.</p>
      {acts.map((a) => (
        <section key={a.id} className="replay-act" aria-labelledby={`sum-${a.id}`}>
          <h2 id={`sum-${a.id}`} className="replay-title">
            {a.title}
          </h2>
          {a.outcome === null ? null : (
            <div className="outcome" data-state={a.outcome.stamp}>
              <VerdictStamp state={a.outcome.stamp} ruleId={a.outcome.reason ?? undefined} testId={`summary-stamp-${a.id}`} />
              <div className="outcome-text">
                <p className="outcome-money">{a.outcome.money}</p>
                {a.outcome.to === null ? null : <p className="outcome-to">{`to ${hostedText(a.outcome.to)}`}</p>}
                <p className="outcome-reason">{a.outcome.sentence}</p>
                {a.failure === null ? null : <p className="replay-failure">{a.failure}</p>}
                <ul className="replay-links">
                  {a.links.map((l) => (
                    <li key={l.hash} className="replay-link">
                      <span className="replay-link-label">{l.label === 'submit' ? `The request on NEAR${l.status === 'failure' ? ', refused' : ''}` : l.label === 'tamper' ? 'Refused approval' : `${l.label} on NEAR (${l.status})`}</span>
                      <a href={txHref(l.url)} target="_blank" rel="noopener noreferrer">
                        {l.hash}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="replay-asked">
            <p className="replay-label">The owner asked</p>
            <p className="replay-words">{a.ownerWords}</p>
          </div>
          <p className="replay-line">{`Recorded ${a.recordedAt.slice(0, 10)} (${a.source}).`}</p>
        </section>
      ))}
    </main>
  );
}

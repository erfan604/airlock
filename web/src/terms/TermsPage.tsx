// AIR-362: the /terms route, a lazy chunk. It typesets docs/terms.json, the same source as docs/TERMS.md, which scripts/terms-check.ts holds
// against the code: numbered clauses, the limits in the same numbering and size as the promises, the references under each clause, the
// status in the margin and a schedule of the cited files. Static text; the transaction links go through the credit page's TxLink.
import { Fragment } from 'react';
import source from '../../../docs/terms.json';
import { TxLink } from '../credit/CreditPage.tsx';
import { clauses, lineText, schedule, shortPath, shortTx } from './model.ts';
import type { Clause, Ref, Terms } from './model.ts';

const TERMS = source as Terms;

/** A code identifier or path that may wrap after an underscore or a slash instead of mid word. */
function Id({ text }: { text: string }) {
  const parts = text.split(/(?<=[_/])/);
  return (
    <span className="terms-id">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </span>
  );
}

function RefLine({ r }: { r: Ref }) {
  if ('tx' in r) {
    return (
      <span className="terms-ref">
        <span className="terms-role">Shown</span> {r.what}, transaction <span className="terms-id">{shortTx(r.tx)}</span>
        {r.row === undefined ? null : ` (EVIDENCE.md ${String(r.row)})`} <TxLink tx={r.tx} what={r.what} />
      </span>
    );
  }
  const name = 'name' in r && r.name !== undefined ? r.name : null;
  return (
    <span className="terms-ref">
      <span className="terms-role">{r.role}</span> {'what' in r ? `${r.what}, ` : ''}
      <Id text={`${shortPath(r.file)} ${lineText(r)}`} />
      {name === null ? null : (
        <>
          {', '}
          <Id text={name} />
        </>
      )}
    </span>
  );
}

function ClauseItem({ c }: { c: Clause }) {
  return (
    <li className="terms-clause" id={`clause-${c.n}`} data-kind={c.kind} data-testid={`terms-clause-${c.n}`}>
      <span className="terms-n">{c.n}</span>
      <div className="terms-body">
        <p className="terms-text">{c.text}</p>
        {c.refs.length === 0 ? (
          <p className="terms-refs">
            <span className="terms-ref">
              <span className="terms-role">Enforced</span> nothing in the code.
            </span>
          </p>
        ) : (
          <p className="terms-refs">
            {c.refs.map((r, i) => (
              <span key={i}>
                {i > 0 ? '; ' : null}
                <RefLine r={r} />
              </span>
            ))}
            .
          </p>
        )}
      </div>
      <p className="terms-status" data-status={c.status === 'in force' ? 'force' : 'upgrade'}>
        {c.status}
      </p>
    </li>
  );
}

export function TermsPage({ data = TERMS }: { data?: Terms }) {
  const n = clauses(data).length;
  return (
    <main className="page terms" data-testid="terms">
      <article className="terms-doc">
        <header className="terms-head">
          <p className="terms-kicker">AIRLOCK Credit</p>
          <h1 className="terms-title">{data.title}</h1>
          <p className="terms-asof">As in force on {data.asOf}. {n} clauses.</p>
          <p className="terms-claim">{data.claim}</p>
        </header>

        <section className="terms-part" aria-labelledby="terms-parties">
          <h2 id="terms-parties" className="terms-h2">
            Parties
          </h2>
          <p className="terms-text">{data.parties.lead}</p>
          <ul className="terms-parties">
            {data.parties.list.map((p) => (
              <li key={p.account} className="terms-party">
                <span className="terms-party-role">{p.role}</span>
                <span className="terms-id">{p.account}</span>
                {p.code === undefined ? null : (
                  <span className="terms-sign">
                    <span className="terms-role">Signed</span> <span className="terms-id">{p.code}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="terms-refs">
            <span className="terms-ref">
              <span className="terms-role">Shown</span> code hashes, <span className="terms-id">{`docs/EVIDENCE.md ${String(data.parties.row)}`}</span>
            </span>
            .
          </p>
        </section>

        {data.parts.map((part) => (
          <section key={part.title} className="terms-part" aria-label={part.title}>
            <h2 className="terms-h2">{part.title}</h2>
            <ol className="terms-clauses" role="list">
              {part.clauses.map((c) => (
                <ClauseItem key={c.n} c={c} />
              ))}
            </ol>
          </section>
        ))}

        <section className="terms-part terms-schedule" aria-labelledby="terms-schedule">
          <h2 id="terms-schedule" className="terms-h2">
            Schedule of cited files
          </h2>
          <p className="terms-text">Line numbers refer to the repository as of {data.asOf}. The check, scripts/terms-check.ts, fails when a cited line no longer holds what it names.</p>
          <dl className="terms-files">
            {schedule(data).map((s) => (
              <div key={s.file} className="terms-file">
                <dt>
                  <Id text={s.file} />
                </dt>
                <dd>{s.lines.join(', ')}</dd>
              </div>
            ))}
          </dl>
        </section>
      </article>
    </main>
  );
}

export default TermsPage;

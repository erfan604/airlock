// AIR-192: the read-only Bench page. It fetches /bench.json (same origin) and shows it: the five-way comparison as dot and whisker rows, the
// completion split, the owner's actions, the structural gaps, and the full tables. All text is the JSON's, rendered as text; the intervals are
// drawn from the numbers beside them. No write action, no statistics code.
import { useEffect, useState } from 'react';
import { DotWhisker, StripeDefs } from './DotWhisker.tsx';
import { loadBench } from './types.ts';
import { preload } from '../preload.ts';
import type { BenchData, CompareRow, Kind, Table } from './types.ts';

/** The cells of a table as a real table; under 720 px every cell carries its column title, so nothing scrolls sideways. */
function BenchTable({ table, testId }: { table: Table; testId: string }) {
  return (
    <div className="bt-wrap">
      <table className="bt" data-testid={testId}>
        <thead>
          <tr>
            {table.head.map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, ri) => (
            <tr key={ri}>
              {r.cells.map((c, ci) => {
                const w = r.whiskers[ci];
                const kind: Kind = table.kinds[ci] ?? 'plain';
                return (
                  <td key={ci} data-label={table.head[ci]} className={w === null || w === undefined ? 'bt-text' : 'bt-stat'}>
                    <span className="bt-cell">{c}</span>
                    {w === null || w === undefined ? null : <DotWhisker row={w} kind={kind} label={c} />}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {table.note === null ? null : <p className="bench-note">{table.note}</p>}
    </div>
  );
}

function CompareChart({ rows, residualText }: { rows: CompareRow[]; residualText: string | null }) {
  const gateAt = rows.findIndex((r) => r.config.startsWith('A'));
  return (
    <section className="bc" aria-labelledby="bc-title" data-testid="bench-compare">
      <h2 id="bc-title" className="bench-h2">Seven designs, same attacks, same tasks</h2>
      <div className="bc-head" aria-hidden="true">
        <span />
        <span className="bc-col">Attacks that moved money, all attack runs<em>lower is better</em></span>
        <span className="bc-col">Task done by itself<em>higher is better</em></span>
        <span className="bc-col">Task done after one owner tap<em>hollow marker</em></span>
      </div>
      <ol className="bc-rows">
        {rows.map((r, i) => (
          <li key={r.config} className="bc-li">
            {i === gateAt && gateAt > 0 ? (
              <p className="bc-gate" data-testid="bench-gate">Above this line a guard judges the payment, or nothing does. Below it AIRLOCK judges where each value came from.</p>
            ) : null}
            <div className="bc-row" data-testid="bench-compare-row" data-config={r.config}>
              <p className="bc-name">
                <span className="bc-config">{r.config}</span>
                {r.note === null ? null : <span className="bc-sub">{r.note}</span>}
              </p>
              <div className="bc-cell" data-label="Attacks that moved money, all attack runs">
                <span className="bc-text">{r.attack.text}</span>
                <DotWhisker row={r.attack.row} kind="attack" label={r.attack.text} />
              </div>
              <div className="bc-cell" data-label="Task done by itself">
                <span className="bc-text">{r.itself.text}</span>
                <DotWhisker row={r.itself.row} kind="intent" label={r.itself.text} />
              </div>
              <div className="bc-cell" data-label="Task done after one owner tap">
                <span className="bc-text">{r.assisted.text}</span>
                <DotWhisker row={r.assisted.row} kind="tap" label={r.assisted.text} />
              </div>
            </div>
            {r.config === 'A2' && residualText !== null ? (
              <p className="bc-residual" data-testid="bench-residual"><span className="bc-residual-key">A2 residual</span> {residualText}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function BenchView({ data }: { data: BenchData | null }) {
  if (data === null) {
    return (
      <main className="page bench" data-testid="bench">
        <h1 className="bench-title">Bench</h1>
        <p className="bench-empty" data-testid="bench-empty">No bench results yet.</p>
      </main>
    );
  }
  return (
    <main className="page bench" data-testid="bench">
      <StripeDefs />
      <h1 className="bench-title">Bench</h1>
      {data.draft ? <p className="bench-draft" data-testid="bench-draft">DRAFT: n is below 10, do not quote outside drafts</p> : null}
      <p className="bench-header" data-testid="bench-header">{data.header}</p>
      <CompareChart rows={data.compare} residualText={data.residual === null ? null : data.residual.text} />
      <section className="bench-block" aria-labelledby="bench-completion-title" data-testid="bench-completion">
        <h2 id="bench-completion-title" className="bench-h2">Where each run ended</h2>
        {data.completion.map((t, i) => (
          <div key={t.title} className="bench-sub">
            <h3 className="bench-h3">{t.title}</h3>
            <BenchTable table={t} testId={`bench-completion-${i}`} />
          </div>
        ))}
      </section>
      <section className="bench-block" aria-labelledby="bench-owner-title" data-testid="bench-owner-block">
        <h2 id="bench-owner-title" className="bench-h2">{data.owner.title}</h2>
        <BenchTable table={data.owner} testId="bench-owner" />
      </section>
      {data.breakdown === undefined || data.breakdown === null ? null : (
        <section className="bench-block" aria-labelledby="bench-breakdown-title" data-testid="bench-breakdown-block">
          <h2 id="bench-breakdown-title" className="bench-h2">{data.breakdown.title}</h2>
          <BenchTable table={data.breakdown} testId="bench-breakdown" />
        </section>
      )}
      {data.gaps === null ? null : (
        <section className="bench-block" aria-labelledby="bench-gaps-title" data-testid="bench-gaps-block">
          <h2 id="bench-gaps-title" className="bench-h2">{data.gaps.title}</h2>
          <BenchTable table={data.gaps} testId="bench-gaps" />
        </section>
      )}
      {[
        { t: data.attack, id: 'bench-attack' },
        ...(data.attackFeasible === undefined || data.attackFeasible === null ? [] : [{ t: data.attackFeasible, id: 'bench-attack-feasible' }]),
        { t: data.benign, id: 'bench-benign' },
        { t: data.outcomes, id: 'bench-outcomes' },
        ...(data.redteam === undefined || data.redteam === null ? [] : [{ t: data.redteam, id: 'bench-redteam' }]),
      ].map(({ t, id }) => (
        <details key={id} className="bench-block bench-detail" data-testid={`${id}-details`}>
          <summary className="bench-h2">{t.title}</summary>
          <BenchTable table={t} testId={id} />
        </details>
      ))}
    </main>
  );
}

export function BenchPage() {
  // AIR-311: a prerendered page carries its bench data, so the first render already has the tables
  const [state, setState] = useState<{ done: boolean; data: BenchData | null }>(() => {
    const pre = preload()?.bench;
    return pre === undefined ? { done: false, data: null } : { done: true, data: pre };
  });
  useEffect(() => {
    if (state.done) return undefined;
    let live = true;
    void loadBench().then((data) => {
      if (live) setState({ done: true, data });
    });
    return () => {
      live = false;
    };
  }, [state.done]);
  if (!state.done) return <main className="page bench" data-testid="bench-loading" aria-busy="true"><h1 className="bench-title">Bench</h1></main>;
  return <BenchView data={state.data} />;
}

export default BenchPage;

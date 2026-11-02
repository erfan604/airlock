// The live trace as a list (AIR-184): one row per event with its seals, its Specimens and, for a verdict, the stamp. Rows come from the
// store already built (`rowOf`), so this file never sees a raw string from outside: an outside value is an `Untrusted` cell and goes to
// `Specimen` only. The list view is the accessible twin of the provenance graph that was cut.
import { useSyncExternalStore } from 'react';
import { Seal } from '../components/Seal.tsx';
import { Specimen } from '../components/Specimen.tsx';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import type { TraceCell, TraceRow, TraceState, TraceStore } from './traceStore.ts';

export const ANSWERED_TEXT = 'Answered, nothing paid';
const MONEY_KINDS = ['proposed', 'submitted', 'verdict', 'signed', 'broadcast'];

/** A finished run that answered and has no payment row: a read-only run (D21). */
export function isAnswered(state: TraceState): boolean {
  return state.ended === 'done' && state.rows.some((r) => r.kind === 'say') && !state.rows.some((r) => MONEY_KINDS.includes(r.kind));
}

const END_TEXT = { done: 'Run finished', failed: 'Run failed', aborted: 'Run stopped' } as const;
export const STALE_TEXT = 'Connection lost, trying again';

const textOf = (row: TraceRow, name: string): string | undefined => {
  const c = row.cells.find((x) => x.name === name);
  return c !== undefined && 'text' in c ? c.text : undefined;
};

function Cell({ row, cell }: { row: TraceRow; cell: TraceCell }) {
  if ('untrusted' in cell) {
    return (
      <div className="trace-cell trace-cell-block" data-cell={cell.name}>
        <span className="trace-cell-name">{cell.name}</span>
        <Specimen text={cell.untrusted} channel={cell.channel} maxLines={row.kind === 'extract' ? 2 : undefined} />
      </div>
    );
  }
  return (
    <span className="trace-cell" data-cell={cell.name}>
      <span className="trace-cell-name">{cell.name}</span>
      <span className="trace-cell-text">{cell.text}</span>
    </span>
  );
}

function Stamp({ row }: { row: TraceRow }) {
  if (row.stamp === null) return null;
  const pending = textOf(row, 'pending');
  return (
    <div className="trace-stamp">
      <VerdictStamp state={row.stamp} ruleId={textOf(row, 'reason')} />
      {row.stamp === 'held' ? (
        <a className="trace-review" data-testid="review-link" href="/approvals">
          {pending === undefined ? 'Review requests' : `Review request ${pending}`}
        </a>
      ) : null}
    </div>
  );
}

export function TraceRowView({ row }: { row: TraceRow }) {
  // the verdict's reason and pending number are in the stamp and the link, not repeated as cells
  const cells = row.stamp === null ? row.cells : row.cells.filter((c) => c.name !== 'reason' && c.name !== 'pending');
  return (
    <li className="trace-row" data-testid="trace-row" data-kind={row.kind}>
      <div className="trace-head">
        <span className="trace-kind">{row.kind}</span>
        {row.item === null ? null : <span className="trace-item">{`item ${row.item}`}</span>}
      </div>
      {cells.length === 0 ? null : (
        <div className="trace-cells">
          {cells.map((c, i) => (
            <Cell key={`${c.name}:${i}`} row={row} cell={c} />
          ))}
        </div>
      )}
      {row.seals.length === 0 ? null : (
        <div className="trace-seals">
          {row.seals.map((l) => (
            <Seal key={l} label={l} size="S" />
          ))}
        </div>
      )}
      <Stamp row={row} />
    </li>
  );
}

export function TraceListView({ state }: { state: TraceState }) {
  return (
    <section className="trace" data-testid="trace-list" aria-label="Run trace">
      {state.collapsed > 0 ? (
        <p className="trace-line" data-testid="collapsed-count" data-count={state.collapsed}>
          {`${state.collapsed} earlier events collapsed`}
        </p>
      ) : null}
      <ol className="trace-rows">
        {state.rows.map((row) => (
          <TraceRowView key={row.key} row={row} />
        ))}
      </ol>
      {state.stale ? (
        <p className="trace-line trace-stale" data-testid="stale-caption" role="status">
          {STALE_TEXT}
        </p>
      ) : null}
      {state.ended === null ? null : (
        <p className="trace-line trace-end" data-testid="trace-end" data-state={state.ended}>
          {isAnswered(state) ? ANSWERED_TEXT : END_TEXT[state.ended]}
        </p>
      )}
    </section>
  );
}

/** The list bound to a store through `useSyncExternalStore`. */
export function TraceList({ store }: { store: Pick<TraceStore, 'subscribe' | 'getSnapshot'> }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <TraceListView state={state} />;
}

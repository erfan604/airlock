// The replay console (AIR-246): the three recorded acts of the demo, on every screen labelled as a replay of recorded testnet runs. It shows the
// recorded owner words, the recorded trace (through the same trace store and rows as the live Task page), the recorded transaction links and,
// for the held request, the real approval card fed by the recorded views. Nothing here signs, connects a wallet or leaves the page's origin.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { registryFromRows } from '@airlock/runtime/analyze';
import type { AssetRegistry } from '@airlock/runtime/analyze';
import { evidenceBody } from '../approvals/ApprovalsRoute.tsx';
import { Card } from '../approvals/Card.tsx';
import type { ApproveArgs, ApproveResult } from '../approvals/Card.tsx';
import { parseEvidence } from '../approvals/evidence.ts';
import { TraceListView } from '../task/TraceList.tsx';
import { createTraceStore } from '../task/traceStore.ts';
import type { TraceStore } from '../task/traceStore.ts';
import { AutopilotChart } from './AutopilotChart.tsx';
import { liveReplayApi } from './api.ts';
import type { Act, ActId, ActLink, HeldRequest, ReplayApi, TamperResult } from './api.ts';
import { REJECT_NOTE, replayApprove } from './replayApprove.ts';

const SCOPE = { network: 'testnet', contractId: 'policy.test.near' } as const;
const STAYED = 'The stored request stayed pending with its stored amount. Nothing was signed.';

function Links({ links }: { links: ActLink[] }) {
  if (links.length === 0) return null;
  return (
    <ul className="replay-links" data-testid="tx-links">
      {links.map((l) => (
        <li key={`${l.label}:${l.hash}`} className="replay-link">
          <span className="replay-link-label">{`${l.label} (${l.status})`}</span>
          <a data-testid="tx-link" data-hash={l.hash} href={l.url} target="_blank" rel="noopener noreferrer">
            {l.hash}
          </a>
        </li>
      ))}
    </ul>
  );
}

function TraceBlock({ runId, registry }: { runId: string; registry: AssetRegistry | null }) {
  const store = useMemo<TraceStore>(() => createTraceStore({ registry: () => registry }), [registry]);
  useEffect(() => {
    store.connect(runId);
    return () => store.disconnect();
  }, [store, runId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <TraceListView state={state} />;
}

type HeldData = { held: HeldRequest; evidence: unknown };

function HeldCard({ act, api, data }: { act: Act; api: ReplayApi; data: HeldData }) {
  const [note, setNote] = useState<string | null>(null);
  const [approved, setApproved] = useState<{ tx: string; url: string } | null>(null);
  const { held } = data;
  const nowMs = String(Date.parse(act.recordedAt));
  const evidence = useMemo(() => parseEvidence(evidenceBody(data.evidence), held.view.labels), [data.evidence, held.view.labels]);
  async function onApprove(a: ApproveArgs): Promise<ApproveResult> {
    // the recorded approve link comes from the replay server's answer, through the same call the card makes
    const recording: Pick<ReplayApi, 'approve'> = {
      approve: async (no) => {
        const r = await api.approve(no);
        if (r.ok) setApproved({ tx: r.tx, url: r.url });
        return r;
      },
    };
    return replayApprove(a, held.view, recording);
  }
  async function onReject(): Promise<ApproveResult> {
    setNote(REJECT_NOTE);
    return { ok: false, kind: 'wallet' };
  }
  return (
    <section className="replay-card" aria-label="The approval card">
      <p className="replay-label" data-testid="replay-label">
        Replay: no wallet is used
      </p>
      <Card view={held.view} evidence={evidence} ledgers={held.ledgers} asset={held.asset} book={held.book} bookKeys={held.bookKeys} bookLabels={held.bookLabels} onApprove={onApprove} onReject={onReject} scope={SCOPE} nowMs={nowMs} />
      {note === null ? null : (
        <p className="replay-note" data-testid="replay-note" role="status">
          {note}
        </p>
      )}
      {approved === null ? null : (
        <p className="replay-approved" data-testid="replay-approve-link">
          {'Recorded approval '}
          <a href={approved.url} target="_blank" rel="noopener noreferrer" data-testid="approve-link" data-hash={approved.tx}>
            {approved.tx}
          </a>
        </p>
      )}
    </section>
  );
}

function TamperBlock({ api }: { api: ReplayApi }) {
  const [result, setResult] = useState<TamperResult | null | 'error'>(null);
  useEffect(() => {
    let live = true;
    api
      .tamper()
      .then((r) => live && setResult(r))
      .catch(() => live && setResult('error'));
    return () => {
      live = false;
    };
  }, [api]);
  if (result === null) return <p className="replay-line">Reading the recording.</p>;
  if (result === 'error') return <p className="replay-line">The recording could not be read.</p>;
  return (
    <section className="replay-tamper" data-testid="tamper-result">
      <p className="replay-failure" data-testid="tamper-failure">
        {result.failure}
      </p>
      <p className="replay-line">The recorded approval changed one value after you saw the card, and the contract refused it.</p>
      <p className="replay-line">{STAYED}</p>
      <ul className="replay-links">
        <li className="replay-link">
          <span className="replay-link-label">tamper (failure)</span>
          <a data-testid="tamper-link" data-hash={result.tx} href={result.url} target="_blank" rel="noopener noreferrer">
            {result.tx}
          </a>
        </li>
      </ul>
    </section>
  );
}

function ActView({ act, api, registry, held }: { act: Act; api: ReplayApi; registry: AssetRegistry | null; held: HeldData | null }): ReactNode {
  return (
    <section className="replay-act" data-testid={`act-view-${act.id}`}>
      <h2 className="replay-title" data-testid="act-title">
        {act.title}
      </h2>
      {act.id === 'tamper' ? null : (
        <>
          <p className="replay-label">The owner asked</p>
          <p className="replay-words" data-testid="owner-words">
            {act.ownerWords}
          </p>
        </>
      )}
      {act.runId === null ? null : <TraceBlock runId={act.runId} registry={registry} />}
      {act.id === 'tamper' ? <TamperBlock api={api} /> : <Links links={act.links} />}
      {act.id === 'b01' && held !== null ? <HeldCard act={act} api={api} data={held} /> : null}
    </section>
  );
}

type Loaded = { acts: Act[]; held: HeldData | null; registry: AssetRegistry | null };

export function ReplayShell({ api = liveReplayApi }: { api?: ReplayApi }) {
  const [loaded, setLoaded] = useState<Loaded | 'error' | null>(null);
  const [active, setActive] = useState<ActId>('u01');

  useEffect(() => {
    let live = true;
    (async () => {
      const acts = await api.acts();
      const pending = acts.find((a) => a.id === 'b01')?.pendingNo ?? null;
      let held: HeldData | null = null;
      let registry: AssetRegistry | null = null;
      if (pending !== null) {
        const [request, evidence] = await Promise.all([api.held(pending), api.evidence(pending).catch(() => null)]);
        held = { held: request, evidence };
        registry = registryFromRows([[request.view.asset, request.asset]]);
      }
      return { acts, held, registry };
    })()
      .then((l) => live && setLoaded(l))
      .catch(() => live && setLoaded('error'));
    return () => {
      live = false;
    };
  }, [api]);

  const act = loaded !== null && loaded !== 'error' ? loaded.acts.find((a) => a.id === active) : undefined;
  return (
    <main className="page replay" data-testid="replay-shell">
      <p className="replay-banner" data-testid="replay-banner">
        {`Replay of recorded run ${act?.source ?? ''}`.trim()}
        {act === undefined ? null : (
          <span className="replay-date" data-testid="replay-date">{` recorded ${act.recordedAt.slice(0, 10)}`}</span>
        )}
      </p>
      <p className="replay-lede">This is a replay of recorded testnet runs. Nothing runs live, no wallet is used and no key is needed.</p>
      {loaded === null ? <p className="replay-line">Reading the recordings.</p> : null}
      {loaded === 'error' ? <p className="replay-line">The recordings could not be read.</p> : null}
      {loaded !== null && loaded !== 'error' ? (
        <>
          <nav className="replay-nav" aria-label="Acts">
            {loaded.acts.map((a) => (
              <button key={a.id} type="button" className="card-btn card-btn-outline replay-tab" data-testid={`act-${a.id}`} aria-pressed={a.id === active} onClick={() => setActive(a.id)}>
                {a.title}
              </button>
            ))}
          </nav>
          {act === undefined ? null : <ActView key={act.id} act={act} api={api} registry={loaded.registry} held={loaded.held} />}
          <AutopilotChart />
        </>
      ) : null}
    </main>
  );
}

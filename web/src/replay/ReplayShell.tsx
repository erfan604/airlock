// The replay console (AIR-246): the three recorded acts of the demo, on every screen labelled as a replay of recorded runs. It shows the
// recorded owner words, the recorded trace (through the same trace store and rows as the live Task page), the recorded transaction links and,
// for the held request, the real approval card fed by the recorded views. Nothing here signs, connects a wallet or leaves the page's origin.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { hostedText } from '../components/account.ts';
import type { ReactNode } from 'react';
import { registryFromRows } from '@airlock/runtime/analyze';
import type { AssetRegistry } from '@airlock/runtime/analyze';
import { evidenceBody } from '../approvals/ApprovalsRoute.tsx';
import { Card } from '../approvals/Card.tsx';
import type { ApproveArgs, ApproveResult } from '../approvals/Card.tsx';
import { parseEvidence } from '../approvals/evidence.ts';
import { VerdictStamp } from '../components/VerdictStamp.tsx';
import { OneShot } from '../landing/OneShot.tsx';
import { KEY_KINDS, TraceListView } from '../task/TraceList.tsx';
import { createTraceStore } from '../task/traceStore.ts';
import type { TraceState, TraceStore } from '../task/traceStore.ts';
import { outcomeOf } from './outcome.ts';
import { STAYED } from './summary.ts';
import { STATIC } from '../static.ts';
import { StaticEventSource } from './staticEventSource.ts';
import { AutopilotChart } from './AutopilotChart.tsx';
import { liveReplayApi } from './api.ts';
import type { Act, ActId, ActLink, HeldRequest, ReplayApi, TamperResult } from './api.ts';
import { REJECT_NOTE, replayApprove } from './replayApprove.ts';

/** AIR-311: the switchyard band above the acts. Held back 2026-11-04 (PM review: the render is below the site's bar); flip to true
 * once the yard is re-rendered and approved. */
const SHOW_YARD = false;

/** What each recorded act did, as a model railway. */
const YARD_ALT: Record<ActId, string> = {
  u01: 'A model railway yard: a blue wagon labelled 4.2 NEAR runs the main line and stops at the platform marked PAID.',
  b01: 'A model railway yard: the points throw and a red wagon labelled 9.4 NEAR is shunted onto the siding marked HELD, where an amber lamp lights.',
  tamper: 'A model railway yard: a grey wagon with a striped 9.4 NEAR label is turned onto the short spur and stops dead at the buffer marked REFUSED.',
};

/** A link from the replay server is shown only when it points at one of the two block explorers of the recorded runs. */
const EXPLORER_PREFIXES = ['https://testnet.nearblocks.io/txns/', 'https://sepolia.basescan.org/tx/'];
const txHref = (url: string): string | undefined => (EXPLORER_PREFIXES.some((p) => url.startsWith(p)) ? url : undefined);

const SCOPE = { network: 'testnet', contractId: 'policy.test.near' } as const;

function Links({ links }: { links: ActLink[] }) {
  if (links.length === 0) return null;
  return (
    <ul className="replay-links" data-testid="tx-links">
      {links.map((l) => (
        <li key={`${l.label}:${l.hash}`} className="replay-link">
          <span className="replay-link-label">{l.label === 'submit' ? `The request on NEAR${l.status === 'failure' ? ', refused' : ''}` : `${l.label} on NEAR (${l.status})`}</span>
          <a data-testid="tx-link" data-hash={l.hash} href={txHref(l.url)} target="_blank" rel="noopener noreferrer">
            {l.hash}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The recorded trace of one run, through the live trace store. Null for an act without a run. */
function useTrace(runId: string | null, registry: AssetRegistry | null): TraceState | null {
  const store = useMemo<TraceStore>(() => createTraceStore({ registry: () => registry, ...(STATIC ? { EventSource: StaticEventSource as unknown as typeof EventSource } : {}) }), [registry]);
  useEffect(() => {
    if (runId === null) return undefined;
    store.connect(runId);
    return () => store.disconnect();
  }, [store, runId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return runId === null ? null : state;
}

/** AIR-311: the act opens with how it ended: the verdict, the reason in plain words, the money and the testnet transaction. */
function OutcomeHead({ stamp, reason, sentence, money, to, links }: { stamp: Parameters<typeof VerdictStamp>[0]['state']; reason: string | null; sentence: string; money: string; to?: string | null; links: ReactNode }) {
  return (
    <section className="outcome" data-testid="act-outcome" data-state={stamp} aria-label="How this run ended">
      <VerdictStamp state={stamp} ruleId={reason ?? undefined} testId="outcome-stamp" />
      <div className="outcome-text">
        <p className="outcome-money" data-testid="outcome-money">{money}</p>
        {to === null || to === undefined ? null : <p className="outcome-to">{`to ${hostedText(to)}`}</p>}
        <p className="outcome-reason" data-testid="outcome-reason">{sentence}</p>
        {links}
      </div>
    </section>
  );
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
          <a href={txHref(approved.url)} target="_blank" rel="noopener noreferrer" data-testid="approve-link" data-hash={approved.tx}>
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
      <OutcomeHead
        stamp="blocked"
        reason={null}
        money="Nothing signed"
        sentence={`The recorded approval changed one value after you saw the card, and the contract refused it. ${STAYED}`}
        links={
          <ul className="replay-links">
            <li className="replay-link">
              <span className="replay-link-label">Refused approval</span>
              <a data-testid="tamper-link" data-hash={result.tx} href={txHref(result.url)} target="_blank" rel="noopener noreferrer">
                {result.tx}
              </a>
            </li>
          </ul>
        }
      />
      <p className="replay-failure" data-testid="tamper-failure">
        {result.failure}
      </p>
    </section>
  );
}

function ActView({ act, api, registry, held }: { act: Act; api: ReplayApi; registry: AssetRegistry | null; held: HeldData | null }): ReactNode {
  const trace = useTrace(act.runId, registry);
  const outcome = trace === null ? null : outcomeOf(trace);
  return (
    <section className="replay-act" data-testid={`act-view-${act.id}`}>
      <h2 className="replay-title" data-testid="act-title">
        {act.title}
      </h2>
      {act.id === 'tamper' ? (
        <TamperBlock api={api} />
      ) : outcome === null ? (
        <p className="replay-line">Reading the recorded run.</p>
      ) : (
        <OutcomeHead stamp={outcome.stamp} reason={outcome.reason} sentence={outcome.sentence} money={outcome.money} to={outcome.to} links={<Links links={act.links} />} />
      )}
      {act.id === 'tamper' ? null : (
        <div className="replay-asked">
          <p className="replay-label">The owner asked</p>
          <p className="replay-words" data-testid="owner-words">
            {act.ownerWords}
          </p>
        </div>
      )}
      {trace === null ? null : (
        <>
          <h3 className="replay-h3">What the agent did</h3>
          <TraceListView state={trace} keyKinds={KEY_KINDS} />
        </>
      )}
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
      <h1 className="replay-h1" data-testid="replay-title">The recorded run, act by act</h1>
      <p className="replay-banner" data-testid="replay-banner">
        {`Replay of recorded run ${act?.source ?? ''}`.trim()}
        {act === undefined ? null : (
          <span className="replay-date" data-testid="replay-date">{` recorded ${act.recordedAt.slice(0, 10)}`}</span>
        )}
      </p>
      <p className="replay-lede">This is a replay of recorded runs. Nothing runs live, no wallet is used and no key is needed.</p>
      {loaded === null ? <p className="replay-line">Reading the recordings.</p> : null}
      {loaded === 'error' ? <p className="replay-line">The recordings could not be read.</p> : null}
      {loaded !== null && loaded !== 'error' ? (
        <>
          {SHOW_YARD ? (
          <OneShot
            name={`yard-${active === 'u01' ? 'act1' : active === 'b01' ? 'act2' : 'act3'}`}
            run={active}
            alt={YARD_ALT[active]}
            className="yard-band"
            testId="yard-band"
          />
          ) : null}
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

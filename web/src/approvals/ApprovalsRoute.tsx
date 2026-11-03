// The /approvals route (AIR-182): the owner's live pending cards. It sits inside the login gate, reads the pending list, the ledgers, the asset
// registry and the book from the chain through the console's own RPC, the evidence from the runtime (GET /api/evidence/<no>), and renders one
// Card per request. At most 5 cards, newest first, and a line for the rest. There is no approve all and no reject all: every approval is its
// own card and its own wallet confirmation.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookPageSchema } from '@airlock/runtime/chain-types';
import type { AssetEntryViewJson, LedgersView, RequestView } from '@airlock/runtime/chain-types';
import type { BookEntryJson } from '@airlock/runtime/dsl';
import { rpcView } from '../chain/rpc.ts';
import { CliPanel } from '../wallet/CliPanel.tsx';
import { makeApprove } from '../wallet/approve.ts';
import { allowedWallet, revealInstruction } from '../wallet/capabilities.ts';
import { currentWallet } from '../wallet/connector.ts';
import { SessionGate } from '../wallet/SessionGate.tsx';
import type { GateDeps } from '../wallet/SessionGate.tsx';
import { PRIMARY_WALLET_ID } from '../wallet/snapshot.ts';
import { rpcGetPending, rpcGetRequest, walletConfig } from '../wallet/status.ts';
import { Card } from './Card.tsx';
import type { ApproveArgs, ApproveResult } from './Card.tsx';
import { approveArgs } from './cardModel.ts';
import type { RememberArgs } from './cardModel.ts';
import { parseEvidence } from './evidence.ts';
import type { CardEvidence } from './evidence.ts';
import { MAX_FAILURES } from './cardReducer.ts';
import { readFailures } from './failures.ts';
import type { CounterScope } from './failures.ts';

export const MAX_CARDS = 5;

export type CardData = {
  view: RequestView;
  evidence: CardEvidence;
  ledgers: LedgersView;
  asset: AssetEntryViewJson;
  book: BookEntryJson | null;
  /** The keys and labels of the `get_book` rows (AIR-190); empty when no shown card has a payee outside the book. */
  bookKeys: readonly string[];
  bookLabels: Readonly<Record<string, string>>;
};
export type ApprovalsData = { cards: CardData[]; more: number };

export type LoadDeps = {
  pending(): Promise<RequestView[]>;
  view(method: string, args: object): Promise<unknown>;
  /** the body of GET /api/evidence/<no>, or null for a 404 */
  evidence(no: string): Promise<unknown>;
};

export type Actions = {
  approve(a: ApproveArgs): Promise<ApproveResult>;
  /** absent in a replay, where the sheet then offers the plain approve only */
  approveAndRemember?(a: RememberArgs): Promise<ApproveResult>;
  reject(id: string): Promise<ApproveResult>;
};

const DECIMAL = /^[0-9]{1,10}$/;
const FIELD_ORDER = ['amount', 'recipient', 'pc'] as const;

/**
 * The runtime answers `{ sources: [...] }`, one entry per origin that fed a field. The card shows one sender and one snippet, so the first
 * source that names a single origin (not an `ambiguous` list of candidates) wins, the amount field first. No such source gives null.
 */
export function evidenceBody(raw: unknown): { sender: unknown; snippet: unknown } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const sources = (raw as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return null;
  const usable = sources.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && (s as { ambiguous?: unknown }).ambiguous !== true);
  for (const field of FIELD_ORDER) {
    const hit = usable.find((s) => s.field === field && (typeof s.snippet === 'string' || typeof s.sender === 'string'));
    if (hit !== undefined) return { sender: hit.sender, snippet: hit.snippet };
  }
  return null;
}

/** Newest first: the pending numbers are decimal strings, compared as BigInt. */
function newestFirst(views: RequestView[]): RequestView[] {
  return views
    .filter((v): v is RequestView & { id: string } => v.state === 'Pending' && v.tombstone !== true && v.id !== null && DECIMAL.test(v.id))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0));
}

const BOOK_PAGE = 50;
const MAX_BOOK_PAGES = 20;

/** Every row of `get_book`, page by page, as keys and labels. A failed or malformed page fails the whole load: a missing book must not read as "no close match". */
async function readBook(view: LoadDeps['view']): Promise<{ keys: string[]; labels: Record<string, string> }> {
  const keys: string[] = [];
  const labels: Record<string, string> = {};
  for (let page = 0; page < MAX_BOOK_PAGES; page++) {
    const rows = BookPageSchema.parse(await view('get_book', { from_index: page * BOOK_PAGE, limit: BOOK_PAGE }));
    for (const [key, entry] of rows) {
      keys.push(key);
      labels[key] = entry.label;
    }
    if (rows.length < BOOK_PAGE) return { keys, labels };
  }
  throw new Error('get_book kept answering full pages');
}

export async function loadApprovals(deps: LoadDeps): Promise<ApprovalsData> {
  const all = newestFirst(await deps.pending());
  const shown = all.slice(0, MAX_CARDS);
  const assets = shown.length > 0 ? ((await deps.view('list_assets', {})) as ReadonlyArray<readonly [string, AssetEntryViewJson]>) : [];
  const bookRows = shown.some((v) => v.book_status === 'new') ? await readBook(deps.view) : { keys: [], labels: {} };
  const cards = await Promise.all(
    shown.map(async (view): Promise<CardData> => {
      const entry = assets.find(([id]) => id === view.asset)?.[1];
      if (entry === undefined) throw new Error(`asset ${view.asset} is not in the registry`);
      const [ledgers, ownEntry, raw] = await Promise.all([
        deps.view('get_ledgers', { payee: view.payee, asset: view.asset, task: view.task_id }),
        deps.view('get_book_entry', { key: view.payee }),
        view.id === null ? Promise.resolve(null) : deps.evidence(view.id).catch(() => null),
      ]);
      return { view, evidence: parseEvidence(evidenceBody(raw), view.labels), ledgers: ledgers as LedgersView, asset: entry, book: (ownEntry ?? null) as BookEntryJson | null, bookKeys: bookRows.keys, bookLabels: bookRows.labels };
    }),
  );
  return { cards, more: all.length - shown.length };
}

// ---- view ----

export type ApprovalsViewProps = {
  data: ApprovalsData;
  ownerId: string;
  contractId: string;
  actions: Actions;
  scope?: CounterScope;
  nowMs?: string;
  /** called after an approve or a reject that the chain confirmed */
  onDone?(id: string): void;
};

function ApprovalCard({ card, ownerId, contractId, actions, scope, nowMs, onDone }: { card: CardData } & Omit<ApprovalsViewProps, 'data'>) {
  const no = card.view.id ?? '';
  const [failures, setFailures] = useState(() => readFailures(scope ?? { network: 'testnet', contractId }, no));
  const walletOffered = allowedWallet(PRIMARY_WALLET_ID) !== null;
  const wrapped = useMemo<Actions>(
    () => ({
      async approve(a) {
        const r = await actions.approve(a);
        if (r.ok) onDone?.(a.id);
        else setFailures((n) => n + 1);
        return r;
      },
      async approveAndRemember(a) {
        const fn = actions.approveAndRemember;
        if (fn === undefined) return { ok: false, kind: 'wallet', name: 'unsupported' };
        const r = await fn(a);
        if (r.ok) onDone?.(a.id);
        else setFailures((n) => n + 1);
        return r;
      },
      async reject(id) {
        const r = await actions.reject(id);
        if (r.ok) onDone?.(id);
        return r;
      },
    }),
    [actions, onDone],
  );
  let cliArgs: ApproveArgs | null = null;
  try {
    cliArgs = approveArgs(card.view);
  } catch {
    cliArgs = null;
  }
  const showCli = cliArgs !== null && (!walletOffered || failures >= MAX_FAILURES);
  return (
    <div className="approval-item" data-testid="approval-item">
      <Card view={card.view} evidence={card.evidence} ledgers={card.ledgers} asset={card.asset} book={card.book} bookKeys={card.bookKeys} bookLabels={card.bookLabels} onApprove={wrapped.approve} onApproveAndRemember={actions.approveAndRemember === undefined ? undefined : wrapped.approveAndRemember} onReject={wrapped.reject} scope={scope ?? { network: 'testnet', contractId }} nowMs={nowMs} />
      {showCli && cliArgs !== null ? <CliPanel args={cliArgs} contractId={contractId} ownerId={ownerId} /> : null}
    </div>
  );
}

export function ApprovalsView({ data, ownerId, contractId, actions, scope, nowMs, onDone }: ApprovalsViewProps) {
  const reveal = revealInstruction(PRIMARY_WALLET_ID);
  if (data.cards.length === 0) {
    return (
      <main className="page approvals" data-testid="approvals">
        <h1 className="approvals-title">Waiting for you</h1>
        <p className="approvals-empty" data-testid="approvals-empty">
          Nothing is waiting for you.
        </p>
      </main>
    );
  }
  return (
    <main className="page approvals" data-testid="approvals">
      <h1 className="approvals-title">Waiting for you</h1>
      {reveal !== '' ? (
        <p className="approvals-reveal" data-testid="reveal-instruction">
          {reveal}
        </p>
      ) : null}
      {data.cards.map((c) => (
        <ApprovalCard key={c.view.request_id} card={c} ownerId={ownerId} contractId={contractId} actions={actions} scope={scope} nowMs={nowMs} onDone={onDone} />
      ))}
      {data.more > 0 ? (
        <p className="approvals-more" data-testid="approvals-more">{`${data.more} more held`}</p>
      ) : null}
    </main>
  );
}

// ---- the live route ----

export type ApprovalsDeps = { contractId: string; load(): Promise<ApprovalsData>; actions: Actions; nowMs?: string };

export function liveDeps(): ApprovalsDeps {
  const cfg = walletConfig();
  const read = rpcGetRequest(cfg);
  const view = rpcView(cfg);
  return {
    contractId: cfg.contractId,
    load: () =>
      loadApprovals({
        pending: rpcGetPending(cfg),
        view,
        evidence: async (no) => {
          const res = await fetch(`/api/evidence/${no}`, { credentials: 'same-origin' });
          return res.ok ? ((await res.json()) as unknown) : null;
        },
      }),
    actions: makeApprove({ wallet: currentWallet, contractId: cfg.contractId, read }),
  };
}

/** After a result the pending list is read again; a card the owner just acted on stays, so its final stamp is not pulled from under them. */
function merge(prev: ApprovalsData | null, next: ApprovalsData, acted: ReadonlySet<string>): ApprovalsData {
  if (prev === null) return next;
  const have = new Set(next.cards.map((c) => c.view.request_id));
  const kept = prev.cards.filter((c) => acted.has(c.view.request_id) && !have.has(c.view.request_id));
  return { cards: [...next.cards, ...kept].sort((a, b) => (BigInt(a.view.id ?? '0') < BigInt(b.view.id ?? '0') ? 1 : -1)), more: next.more };
}

function ApprovalsPage({ ownerId, deps }: { ownerId: string; deps: ApprovalsDeps }) {
  const [data, setData] = useState<ApprovalsData | null>(null);
  const [error, setError] = useState(false);
  const [acted] = useState(() => new Set<string>());

  const load = useCallback(() => {
    deps
      .load()
      .then((next) => {
        setError(false);
        setData((prev) => merge(prev, next, acted));
      })
      .catch(() => setError(true));
  }, [deps, acted]);

  useEffect(() => {
    load();
  }, [load]);

  const onDone = useCallback(
    (id: string) => {
      const hit = data?.cards.find((c) => c.view.id === id);
      if (hit !== undefined) acted.add(hit.view.request_id);
      load();
    },
    [data, acted, load],
  );

  if (data === null) {
    return (
      <main className="page approvals" data-testid="approvals-loading" aria-busy={!error}>
        <p className="approvals-empty">{error ? 'The chain could not be read. Reload to try again.' : 'Reading the chain.'}</p>
      </main>
    );
  }
  return (
    <>
      {error ? (
        <p className="approvals-error" role="status" data-testid="approvals-error">
          The list could not be refreshed. What you see may be out of date.
        </p>
      ) : null}
      <ApprovalsView data={data} ownerId={ownerId} contractId={deps.contractId} actions={deps.actions} nowMs={deps.nowMs} onDone={onDone} />
    </>
  );
}

export function ApprovalsRoute({ deps, gate }: { deps?: ApprovalsDeps; gate?: GateDeps }) {
  const resolved = useMemo(() => {
    if (deps !== undefined) return { deps, error: null };
    try {
      return { deps: liveDeps(), error: null };
    } catch (e) {
      return { deps: null, error: e instanceof Error ? e.message : 'not configured' };
    }
  }, [deps]);
  if (resolved.deps === null) {
    return (
      <main className="page approvals" data-testid="approvals-misconfigured">
        <p className="approvals-empty">{`The console is not configured: ${resolved.error}.`}</p>
      </main>
    );
  }
  const live = resolved.deps;
  return <SessionGate deps={gate}>{({ accountId }) => <ApprovalsPage ownerId={accountId} deps={live} />}</SessionGate>;
}

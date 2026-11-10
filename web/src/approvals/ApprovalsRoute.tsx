// The /approvals route (AIR-182): the owner's live pending cards. It sits inside the login gate, reads the pending list, the ledgers, the asset
// registry and the book from the chain through the console's own RPC, the evidence from the runtime (GET /api/evidence/<no>), and renders one
// Card per request. At most 5 cards, newest first, and a line for the rest. There is no approve all and no reject all: every approval is its
// own card and its own wallet confirmation.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookPageSchema } from '@airlock/runtime/chain-types';
import type { AssetEntryViewJson, LedgersView, RequestView } from '@airlock/runtime/chain-types';
import type { BookEntryJson } from '@airlock/runtime/dsl';
import { rpcView } from '../chain/rpc.ts';
import { getVault, setVault } from '../chain/vaultStore.ts';
import type { Vault } from '@airlock/runtime/vault';
import { VaultDrop } from './VaultDrop.tsx';
import { CliPanel } from '../wallet/CliPanel.tsx';
import { makeApprove } from '../wallet/approve.ts';
import { allowedWallet, revealInstruction } from '../wallet/capabilities.ts';
import { currentWallet } from '../wallet/connector.ts';
import { SessionGate } from '../wallet/SessionGate.tsx';
import type { GateDeps } from '../wallet/SessionGate.tsx';
import { PRIMARY_WALLET_ID } from '../wallet/snapshot.ts';
import { rpcGetPending, rpcGetRequest, walletConfig } from '../wallet/status.ts';
import type { Attestation } from '@airlock/runtime/attest';
import { Card } from './Card.tsx';
import type { ApproveArgs, ApproveResult } from './Card.tsx';
import { approveArgs, displayMismatch } from './cardModel.ts';
import type { RememberArgs } from './cardModel.ts';
import { counterpartyOf, parseEvidence } from './evidence.ts';
import type { CardEvidence } from './evidence.ts';
import { MAX_FAILURES } from './cardReducer.ts';
import { VerifiedPanel } from './VerifiedPanel.tsx';
import { readFailures } from './failures.ts';
import type { CounterScope } from './failures.ts';

export const MAX_CARDS = 5;

export type CardData = {
  view: RequestView;
  evidence: CardEvidence;
  ledgers: LedgersView;
  asset: AssetEntryViewJson;
  book: BookEntryJson | null;
  /** false: the policy keeps a private book and the owner's book file is not loaded (AIR-326). */
  bookLoaded: boolean;
  /** The keys and labels of the `get_book` rows (AIR-190); empty when no shown card has a payee outside the book. */
  bookKeys: readonly string[];
  bookLabels: Readonly<Record<string, string>>;
};
/** `privateBook`: the policy contract holds only a book root (AIR-326), so the book comes from the owner's file. */
export type ApprovalsData = { cards: CardData[]; more: number; privateBook: boolean };

export type LoadDeps = {
  pending(): Promise<RequestView[]>;
  view(method: string, args: object): Promise<unknown>;
  /** the body of GET /api/evidence/<no>, or null for a 404 */
  evidence(no: string): Promise<unknown>;
  /** the owner's loaded book file; defaults to the console's in-memory one (AIR-326) */
  vault?(): Vault | null;
};

export type Actions = {
  approve(a: ApproveArgs): Promise<ApproveResult>;
  /** absent in a replay, where the sheet then offers the plain approve only */
  approveAndRemember?(a: RememberArgs): Promise<ApproveResult>;
  reject(id: string): Promise<ApproveResult>;
};

const DECIMAL = /^[0-9]{1,10}$/;
const TASK_HASH = /^[0-9a-f]{64}$/;
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

type BookRead = { keys: string[]; labels: Record<string, string>; loaded: boolean; privateBook: boolean; entryOf(payee: string): BookEntryJson | null | undefined };

/**
 * The owner's book. A policy with a private book (AIR-326) answers `get_book_root`: the rows then come from the owner's book file, and only
 * when the file's root equals the chain's (otherwise the book is "not loaded" and the card says the look-alike check did not run). An older
 * policy has no such view and lists its book: every row of `get_book`, page by page. A failed or malformed page fails the whole load: a
 * missing book must not read as "no close match".
 */
async function readBook(view: LoadDeps['view'], vault: Vault | null, needListing: boolean): Promise<BookRead> {
  let root: unknown;
  try {
    root = await view('get_book_root', {});
  } catch {
    root = undefined;
  }
  if (typeof root === 'string' && /^[0-9a-f]{64}$/.test(root)) {
    if (vault === null || vault.root() !== root) return { keys: [], labels: {}, loaded: false, privateBook: true, entryOf: () => null };
    const rows = vault.rows();
    return { keys: rows.map(([k]) => k), labels: Object.fromEntries(rows.map(([k, e]) => [k, e.label])), loaded: true, privateBook: true, entryOf: (p) => rows.find(([k]) => k === p)?.[1] ?? null };
  }
  if (!needListing) return { keys: [], labels: {}, loaded: true, privateBook: false, entryOf: () => undefined };
  const keys: string[] = [];
  const labels: Record<string, string> = {};
  for (let page = 0; page < MAX_BOOK_PAGES; page++) {
    const rows = BookPageSchema.parse(await view('get_book', { from_index: page * BOOK_PAGE, limit: BOOK_PAGE }));
    for (const [key, entry] of rows) {
      keys.push(key);
      labels[key] = entry.label;
    }
    if (rows.length < BOOK_PAGE) return { keys, labels, loaded: true, privateBook: false, entryOf: () => undefined };
  }
  throw new Error('get_book kept answering full pages');
}

export async function loadApprovals(deps: LoadDeps): Promise<ApprovalsData> {
  const all = newestFirst(await deps.pending());
  const shown = all.slice(0, MAX_CARDS);
  const assets = shown.length > 0 ? ((await deps.view('list_assets', {})) as ReadonlyArray<readonly [string, AssetEntryViewJson]>) : [];
  const bookRows = shown.length > 0 ? await readBook(deps.view, (deps.vault ?? getVault)(), shown.some((v) => v.book_status === 'new')) : ({ keys: [], labels: {}, loaded: true, privateBook: false, entryOf: () => undefined } satisfies BookRead);
  const cards = await Promise.all(
    shown.map(async (view): Promise<CardData> => {
      const entry = assets.find(([id]) => id === view.asset)?.[1];
      if (entry === undefined) throw new Error(`asset ${view.asset} is not in the registry`);
      const [ledgers, ownEntry, raw] = await Promise.all([
        // the contract takes a task hash (64 lowercase hex) and panics on any other text, so a request whose task id is a label is read without a task
        deps.view('get_ledgers', { payee: view.payee, asset: view.asset, task: TASK_HASH.test(view.task_id) ? view.task_id : null }),
        // a private book has no `get_book_entry`: the entry of a payee in the book comes from the owner's file
        bookRows.privateBook ? Promise.resolve(view.book_status === 'in_book' ? bookRows.entryOf(view.payee) ?? null : null) : deps.view('get_book_entry', { key: view.payee }),
        view.id === null ? Promise.resolve(null) : deps.evidence(view.id).catch(() => null),
      ]);
      return { view, evidence: { ...parseEvidence(evidenceBody(raw), view.labels), counterparty: counterpartyOf(raw) }, ledgers: ledgers as LedgersView, asset: entry, book: (ownEntry ?? null) as BookEntryJson | null, bookLoaded: bookRows.loaded, bookKeys: bookRows.keys, bookLabels: bookRows.labels };
    }),
  );
  return { cards, more: all.length - shown.length, privateBook: bookRows.privateBook };
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
  /** AIR-303: the attestation records of GET /api/attestation; the `Verified` panel shows under each card when there are any */
  attestations?: readonly Attestation[];
  /** reload the cards, called after the owner loads a book file */
  onReload?(): void;
};

export function ApprovalCard({ viewOnly = false, card, ownerId, contractId, actions, scope, nowMs, onDone, attestations, displayPayee }: { card: CardData; viewOnly?: boolean; displayPayee?: (key: string) => string } & Omit<ApprovalsViewProps, 'data'>) {
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
    cliArgs = displayMismatch(card.view, card.asset) ? null : approveArgs(card.view, card.asset);
  } catch {
    cliArgs = null;
  }
  const showCli = !viewOnly && cliArgs !== null && (!walletOffered || failures >= MAX_FAILURES);
  return (
    <div className="approval-item" data-testid="approval-item">
      <Card view={card.view} evidence={card.evidence} ledgers={card.ledgers} asset={card.asset} book={card.book} bookLoaded={card.bookLoaded} bookKeys={card.bookKeys} bookLabels={card.bookLabels} onApprove={wrapped.approve} onApproveAndRemember={actions.approveAndRemember === undefined || !card.bookLoaded ? undefined : wrapped.approveAndRemember} onReject={wrapped.reject} scope={scope ?? { network: 'testnet', contractId }} nowMs={nowMs} viewOnly={viewOnly} {...(displayPayee === undefined ? {} : { displayPayee })} />
      {showCli && cliArgs !== null ? <CliPanel args={cliArgs} contractId={contractId} ownerId={ownerId} /> : null}
      {attestations !== undefined ? <VerifiedPanel attestations={attestations} /> : null}
    </div>
  );
}

export function ApprovalsView({ data, ownerId, contractId, actions, scope, nowMs, onDone, attestations, onReload }: ApprovalsViewProps) {
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
      {data.privateBook ? <VaultDrop onLoaded={onReload} /> : null}
      {reveal !== '' ? (
        <p className="approvals-reveal" data-testid="reveal-instruction">
          {reveal}
        </p>
      ) : null}
      {data.cards.map((c) => (
        <ApprovalCard key={c.view.request_id} card={c} ownerId={ownerId} contractId={contractId} actions={actions} scope={scope} nowMs={nowMs} onDone={onDone} attestations={attestations} />
      ))}
      {data.more > 0 ? (
        <p className="approvals-more" data-testid="approvals-more">{`${data.more} more held`}</p>
      ) : null}
    </main>
  );
}

// ---- the live route ----

export type ApprovalsDeps = { contractId: string; load(): Promise<ApprovalsData>; actions: Actions; nowMs?: string; /** AIR-303: GET /api/attestation; a failure shows no panel */ attestations?(): Promise<Attestation[]> };

/** AIR-326: what the wallet calls need to know about the owner's private book. */
export function bookDeps(view: (method: string, args: object) => Promise<unknown>): Pick<Parameters<typeof makeApprove>[0], 'vault' | 'bookRoot' | 'onVault'> {
  return {
    vault: getVault,
    bookRoot: async () => {
      try {
        const root = await view('get_book_root', {});
        return typeof root === 'string' && /^[0-9a-f]{64}$/.test(root) ? root : null;
      } catch {
        return null;
      }
    },
    onVault: (next) => setVault(next, true),
  };
}

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
    actions: makeApprove({ wallet: currentWallet, contractId: cfg.contractId, read, ...bookDeps(view) }),
    attestations: async () => {
      const res = await fetch('/api/attestation', { credentials: 'same-origin' });
      if (!res.ok) return [];
      const body = (await res.json()) as { attestations?: Attestation[] };
      return Array.isArray(body.attestations) ? body.attestations : [];
    },
  };
}

/** After a result the pending list is read again; a card the owner just acted on stays, so its final stamp is not pulled from under them. */
export function merge(prev: ApprovalsData | null, next: ApprovalsData, acted: ReadonlySet<string>): ApprovalsData {
  if (prev === null) return next;
  const have = new Set(next.cards.map((c) => c.view.request_id));
  const kept = prev.cards.filter((c) => acted.has(c.view.request_id) && !have.has(c.view.request_id));
  return { cards: [...next.cards, ...kept].sort((a, b) => (BigInt(a.view.id ?? '0') < BigInt(b.view.id ?? '0') ? 1 : -1)), more: next.more, privateBook: next.privateBook };
}

function ApprovalsPage({ ownerId, deps }: { ownerId: string; deps: ApprovalsDeps }) {
  const [data, setData] = useState<ApprovalsData | null>(null);
  const [error, setError] = useState(false);
  const [acted] = useState(() => new Set<string>());
  const [attestations, setAttestations] = useState<Attestation[] | undefined>(undefined);

  useEffect(() => {
    deps.attestations?.().then(setAttestations, () => setAttestations(undefined));
  }, [deps]);

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
      <ApprovalsView data={data} ownerId={ownerId} contractId={deps.contractId} actions={deps.actions} nowMs={deps.nowMs} onDone={onDone} attestations={attestations} onReload={load} />
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

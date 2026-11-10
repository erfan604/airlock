// AIR-318: /approvals on the hosted static site. There is no runtime, so the page reads the pending requests straight from the policy contract over
// public testnet RPC, shows each one on the existing card, and lets the policy's owner approve or reject through the wallet connector. Every other
// visitor (and every expired request) sees the card with no buttons. The owner is whoever `get_policy` names; a connected account that is anyone
// else is view only. The wallet signs one transaction to the policy contract (wallet/approve.ts) and the card shows its hash with an explorer link.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RequestView } from '@airlock/runtime/chain-types';
import { NEAR_RPC } from '../../csp.ts';
import { PRERENDER, url } from '../static.ts';
import { revealInstruction } from '../wallet/capabilities.ts';
import { connectWallet, currentWallet } from '../wallet/connector.ts';
import { makeApprove } from '../wallet/approve.ts';
import { PRIMARY_WALLET_ID } from '../wallet/snapshot.ts';
import { rpcGetRequest } from '../wallet/status.ts';
import { ApprovalCard, bookDeps, merge } from './ApprovalsRoute.tsx';
import { rpcView } from '../chain/rpc.ts';
import type { Actions, ApprovalsData } from './ApprovalsRoute.tsx';
import type { ApproveResult } from './Card.tsx';
import { accountText, demoLabel, explorerAccount } from '../components/account.ts';
import example from '../../fixtures/card-correction.json' with { type: 'json' };
import { REASON } from '../replay/outcome.ts';
import { DEFAULT_POLICY, accessOf, explorerTx, isExpired, policyFromSearch, readHistory, readStaticChain } from './staticChain.ts';
import type { Access } from './staticChain.ts';
import { VaultDrop } from './VaultDrop.tsx';

export type TxRecord = { kind: 'approve' | 'reject'; hash: string };

export type StaticViewProps = {
  policy: string;
  ownerId: string;
  data: ApprovalsData;
  access: Access;
  actions: Actions;
  nowMs?: string;
  onConnect(): void;
  onDone(id: string): void;
  connecting: boolean;
  connectError: string | null;
  /** by pending number */
  txs: Readonly<Record<string, TxRecord>>;
  /** the requests that are no longer pending (rejected, expired, approved), oldest first; absent while they are being read */
  history?: readonly RequestView[];
  /** reload the cards after the owner loads a book file (AIR-326) */
  onReload?(): void;
};

const STATE_WORD: Record<string, string> = {
  Rejected: 'Rejected',
  Expired: 'Expired unanswered',
  Blocked: 'Blocked',
  Executing: 'Approved, paying',
  Executed: 'Approved and paid',
  Retryable: 'Approved, payment retrying',
  Failed: 'Approved, payment failed',
};

/** AIR-351: a payee key as the hosted page prints it, the site's short form (accountText: no `near:`, no network suffix, the owner's names a label). */
export const shortPayee = (key: string): string => (key.startsWith('near:') ? accountText(key.slice('near:'.length)) : key);

/** The payee of an earlier request: a plain name linked to the explorer (the owner's own names get a label), the full id in the link target only. */
function Payee({ payee }: { payee: string }) {
  const id = payee.replace(/^near:/, '');
  const link = explorerAccount(id);
  const text = accountText(id);
  if (link === null) return <>{text}</>;
  return (
    <a href={link} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}

/** What the policy has already settled: each held payment with its payee, its amount, why it was held and how it ended. Read from the chain, never written here. */
function History({ history }: { history: readonly RequestView[] }) {
  if (history.length === 0) return null;
  return (
    <section className="approval-item" aria-labelledby="approvals-history-h" data-testid="approvals-history">
      <h2 id="approvals-history-h" className="approvals-subtitle">
        Earlier requests
      </h2>
      <ol className="approvals-history">
        {history.map((v) => (
          <li key={v.request_id} data-testid="history-row" data-state={v.state}>
            <span className="approvals-history-state">{STATE_WORD[v.state] ?? v.state}</span>{' '}
            {v.display === null ? 'a payment' : `${v.display.amount_decimal} ${v.display.asset_symbol}`} to <Payee payee={v.payee} />
            {v.reason === null ? '' : `. ${REASON[v.reason] ?? v.reason}`}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The policy as the heading prints it: the live credit line's policy and the owner's own demo policy get a plain label, any other policy its name
 * without the `.testnet` suffix; each is linked to the explorer with the full id in the link target.
 */
function PolicyName({ policy }: { policy: string }) {
  const link = explorerAccount(policy);
  const text = policy === DEFAULT_POLICY ? 'the credit line policy' : /erfan/i.test(policy) ? 'the demo policy' : accountText(policy);
  if (link === null) return <>{text}</>;
  return (
    <a href={link} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}

function AccessLine({ access, ownerId, onConnect, connecting, connectError }: Pick<StaticViewProps, 'access' | 'ownerId' | 'onConnect' | 'connecting' | 'connectError'>) {
  const text =
    access.kind === 'owner'
      ? `Signed in as ${accountText(access.account)}, the owner of this policy.`
      : access.kind === 'viewer'
        ? `View only. You are connected as ${accountText(access.account)}; the owner of this policy is ${accountText(ownerId)}.`
        : `View only. Connect the owner wallet (${accountText(ownerId)}) to approve or reject.`;
  return (
    <div className="approval-item">
      <p className="approvals-reveal" data-testid="access" data-access={access.kind}>
        {text}
      </p>
      {access.kind === 'owner' ? null : (
        <button type="button" className="card-btn card-btn-outline" data-testid="static-connect" disabled={connecting} onClick={onConnect}>
          {connecting ? 'Waiting for your wallet' : access.kind === 'viewer' ? 'Use another wallet' : 'Connect wallet'}
        </button>
      )}
      {connectError !== null ? (
        <p className="gate-error" data-testid="connect-error" role="alert">
          {connectError}
        </p>
      ) : null}
    </div>
  );
}

export function StaticApprovalsView({ policy, ownerId, data, access, actions, nowMs, onConnect, onDone, connecting, connectError, txs, onReload, history }: StaticViewProps) {
  const reveal = revealInstruction(PRIMARY_WALLET_ID);
  const now = BigInt(nowMs ?? Date.now());
  return (
    <main className="page approvals" data-testid="approvals">
      <h1 className="approvals-title" data-testid="approvals-policy">
        Held requests on <PolicyName policy={policy} />
      </h1>
      <p className="approvals-more">Read from the policy contract on NEAR through a public RPC node, with no server in between. Only the policy owner can approve or reject.</p>
      <AccessLine access={access} ownerId={ownerId} onConnect={onConnect} connecting={connecting} connectError={connectError} />
      {data.privateBook ? <VaultDrop onLoaded={onReload} /> : null}
      {access.kind === 'owner' && reveal !== '' && data.cards.length > 0 ? (
        <p className="approvals-reveal" data-testid="reveal-instruction">
          {reveal}
        </p>
      ) : null}
      {data.cards.length === 0 ? (
        <div className="approval-item">
          <p className="approvals-empty" data-testid="approvals-empty">
            Nothing is held on this policy right now.
          </p>
          <p className="approvals-more">
            A request is held when its payee or amount came from outside text. To make one from the repository, run <code>pnpm demo:live</code> (act 2 holds a correction), then reload this page. See <a href={url('use')}>the quickstart</a>.
          </p>
        </div>
      ) : null}
      {data.cards.length === 0 ? <ExampleSlip /> : null}
      {data.cards.map((c) => {
        const expired = isExpired(c.view, now);
        const no = c.view.id ?? '';
        const tx = txs[no];
        const link = tx === undefined ? null : explorerTx(tx.hash);
        return (
          <div key={c.view.request_id} className="approval-item">
            {expired ? (
              <p className="approvals-more" data-testid="expired">
                This request expired. The contract refuses an approval after the expiry, so it is shown without buttons.
              </p>
            ) : null}
            <ApprovalCard displayPayee={shortPayee} card={c} ownerId={ownerId} contractId={policy} actions={actions} nowMs={nowMs} onDone={onDone} viewOnly={access.kind !== 'owner' || expired} />
            {tx !== undefined ? (
              <p className="approvals-more" data-testid="tx-result" data-hash={tx.hash}>
                {tx.kind === 'approve' ? 'Approved. ' : 'Rejected. '}
                {link === null ? (
                  `Transaction ${tx.hash}`
                ) : (
                  <a href={link} target="_blank" rel="noopener noreferrer" data-testid="tx-link">{`View transaction ${tx.hash} on the explorer`}</a>
                )}
              </p>
            ) : null}
          </div>
        );
      })}
      {history === undefined ? null : <History history={history} />}
      {data.more > 0 ? <p className="approvals-more" data-testid="approvals-more">{`${data.more} more held`}</p> : null}
    </main>
  );
}

/**
 * AIR-346 (D15, D16): what a held request is, for a visitor who arrives when nothing is held. One slip with the payee, amount and reason of the
 * recorded correction (fixtures/card-correction.json, the request the replay holds in act 2), marked as an example, and no button on it.
 */
export function ExampleSlip() {
  const v = example.view;
  return (
    <figure className="approval-item approval-example" data-testid="approvals-example">
      <figcaption className="approvals-more">An example from the recorded run, so you can see what waits here. On a real held request the owner gets Approve and Reject, and the wallet signs the one they pick.</figcaption>
      <div className="ex-slip" aria-label="Example payment request">
        <p className="ex-slip-head">Payment request</p>
        <dl className="ex-slip-fields">
          <dt>Pay</dt>
          <dd>{`${demoLabel(v.payee)}, in your address book`}</dd>
          <dt>Amount</dt>
          <dd className="ex-slip-amount">{`${v.display.amount_decimal} ${v.display.asset_symbol}`}</dd>
          <dt>Why</dt>
          <dd>{REASON[v.reason] ?? v.reason}</dd>
        </dl>
        <p className="ex-slip-stamp" aria-hidden="true">Held for you</p>
      </div>
    </figure>
  );
}

/** The page before the first read (also the prerendered HTML). The paragraph about scripts is for readers without them, so it sits in a noscript element. */
export function ApprovalsLoading({ policy, error }: { policy: string; error: boolean }) {
  return (
    <main className="page approvals" data-testid="approvals-loading" aria-busy={!error}>
      <h1 className="approvals-title">
        Held requests on <PolicyName policy={policy} />
      </h1>
      <p className="approvals-empty">
        {error ? 'The chain could not be read. Reload to try again.' : 'Reading the policy contract on NEAR. Held requests wait here for the owner to approve or reject them in a wallet.'}
      </p>
      <noscript>
        <p className="approvals-more">
          This page needs JavaScript. It calls the contract view get_pending through a public NEAR RPC node and shows each held request on the same card the console uses: the payee, the amount, where each value came from, why the request was held and the exact values the wallet will sign. The owner of the policy connects a wallet and approves or rejects; every other visitor sees the card with no buttons. The recorded run is on <a href={url('replay')}>the replay page</a>.
        </p>
      </noscript>
    </main>
  );
}

const SEARCH = (): string => (PRERENDER || typeof window === 'undefined' ? '' : window.location.search);

export function StaticApprovals() {
  const choice = useMemo(() => policyFromSearch(SEARCH()), []);
  const policy = choice.ok ? choice.policy : DEFAULT_POLICY;
  const cfg = useMemo(() => ({ contractId: policy, rpcUrls: [...NEAR_RPC] }), [policy]);
  const [read, setRead] = useState<{ ownerId: string; data: ApprovalsData } | null>(null);
  const [error, setError] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [txs, setTxs] = useState<Record<string, TxRecord>>({});
  const [acted] = useState(() => new Set<string>());
  const [history, setHistory] = useState<readonly RequestView[] | undefined>(undefined);

  const load = useCallback(() => {
    if (!choice.ok) return;
    readStaticChain(cfg).then(
      (next) => {
        setError(false);
        setRead((prev) => ({ ownerId: next.ownerId, data: merge(prev === null ? null : prev.data, next.data, acted) }));
      },
      () => setError(true),
    );
  }, [choice.ok, cfg, acted]);
  useEffect(() => {
    load();
  }, [load]);
  // the settled requests are read once after the cards, with a flag for a page that unmounts; a failed read shows no history
  useEffect(() => {
    if (!choice.ok) return undefined;
    let live = true;
    readHistory(cfg).then(
      (rows) => {
        if (live) setHistory(rows);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [choice.ok, cfg]);

  const actions = useMemo<Actions>(() => {
    const inner = makeApprove({ wallet: currentWallet, contractId: policy, read: rpcGetRequest(cfg), ...bookDeps(rpcView(cfg)) });
    const record = (kind: TxRecord['kind'], id: string) => async (r: ApproveResult): Promise<ApproveResult> => {
      if (r.ok && r.tx !== '') setTxs((t) => ({ ...t, [id]: { kind, hash: r.tx } }));
      return r;
    };
    return {
      approve: async (a) => record('approve', a.id)(await inner.approve(a)),
      approveAndRemember: async (a) => record('approve', a.id)(await inner.approveAndRemember(a)),
      reject: async (id) => record('reject', id)(await inner.reject(id)),
    };
  }, [policy, cfg]);

  const onConnect = useCallback(() => {
    setConnecting(true);
    setConnectError(null);
    connectWallet().then(
      (w) => {
        setAccount(w.accountId);
        setConnecting(false);
      },
      (e: unknown) => {
        setConnecting(false);
        setConnectError(e instanceof Error && e.name === 'WalletRefused' ? e.message : 'The wallet did not connect. Nothing was signed.');
      },
    );
  }, []);

  const onDone = useCallback(
    (id: string) => {
      const hit = read?.data.cards.find((c) => c.view.id === id);
      if (hit !== undefined) acted.add(hit.view.request_id);
      load();
    },
    [read, acted, load],
  );

  if (!choice.ok) {
    return (
      <main className="page approvals" data-testid="approvals-badpolicy">
        <h1 className="approvals-title">Held requests</h1>
        <p className="approvals-empty">{`The policy in the address must be a NEAR test-network account name. Without it this page reads the credit line policy.`}</p>
      </main>
    );
  }
  if (read === null) return <ApprovalsLoading policy={policy} error={error} />;
  return (
    <>
      {error ? (
        <p className="approvals-error" role="status" data-testid="approvals-error">
          The list could not be refreshed. What you see may be out of date.
        </p>
      ) : null}
      <StaticApprovalsView policy={policy} ownerId={read.ownerId} data={read.data} access={accessOf(account, read.ownerId)} actions={actions} onConnect={onConnect} history={history} onDone={onDone} connecting={connecting} connectError={connectError} txs={txs} onReload={load} />
    </>
  );
}

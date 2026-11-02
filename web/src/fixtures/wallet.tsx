// Fixture routes of AIR-182. `wallet-connect` mounts the real NEAR Connect with the pinned snapshot (the wallet-csp e2e opens its selector;
// nothing is signed). `approvals-live` is /approvals with fake chain reads, fake evidence and a mocked wallet that records every call on
// `window.__walletCalls` and fails every call when `window.__walletMode` is `fail`. `session-gate` is the login gate with a wallet the console
// refuses. None of them touches the network except the first, which loads the wallet executor.
import { useState } from 'react';
import type { RequestView } from '@airlock/runtime/chain-types';
import { ApprovalsRoute, loadApprovals } from '../approvals/ApprovalsRoute.tsx';
import type { ApprovalsDeps } from '../approvals/ApprovalsRoute.tsx';
import correction from '../../fixtures/card-correction.json' with { type: 'json' };
import { makeApprove } from '../wallet/approve.ts';
import { WalletRefused, connectWallet } from '../wallet/connector.ts';
import { SessionGate } from '../wallet/SessionGate.tsx';
import type { GateDeps } from '../wallet/SessionGate.tsx';
import { registerFixture } from './registry.ts';

declare global {
  interface Window {
    __walletCalls?: unknown[];
    __walletMode?: string;
  }
}

function WalletConnectFixture() {
  const [line, setLine] = useState('');
  return (
    <main className="page fixture" data-testid="fixture-wallet-connect">
      <h1 className="wordmark">AIRLOCK</h1>
      <button
        type="button"
        className="card-btn card-btn-outline"
        data-testid="wallet-open"
        onClick={() => {
          connectWallet().then(
            (r) => setLine(`Connected ${r.walletId}.`),
            (e: unknown) => setLine(e instanceof Error ? e.name : 'Failed.'),
          );
        }}
      >
        Open the wallet selector
      </button>
      <p className="fixture-note" data-testid="wallet-line">
        {line}
      </p>
    </main>
  );
}

registerFixture('wallet-connect', () => <WalletConnectFixture />);

// ---- approvals-live ----

const CONTRACT = 'airlock-policy.testnet';
const OWNER = 'erfan-airlock.testnet';
const fixtureView = correction.view as RequestView;

const mockWallet = {
  async signAndSendTransaction(params: unknown) {
    (window.__walletCalls ??= []).push(params);
    if (window.__walletMode === 'fail') throw new Error('declined in the fixture wallet');
    return { status: { SuccessValue: '' }, transaction: { hash: 'FIXTUREHASH1' } };
  },
};

const approvalsDeps: ApprovalsDeps = {
  contractId: CONTRACT,
  nowMs: correction.now_ms,
  load: () =>
    loadApprovals({
      pending: async () => [fixtureView],
      view: async (method) => {
        if (method === 'get_ledgers') return correction.ledgers;
        if (method === 'list_assets') return [[fixtureView.asset, correction.asset]];
        if (method === 'get_book_entry') return correction.book;
        throw new Error(`no fixture for ${method}`);
      },
      evidence: async () => ({ sources: [{ field: 'amount', origin: 'tool:1', sender: correction.evidence.sender, snippet: correction.evidence.snippet }] }),
    }),
  actions: makeApprove({
    wallet: async () => mockWallet as never,
    contractId: CONTRACT,
    read: async (id) => ({ ...fixtureView, id, state: (window.__walletCalls?.length ?? 0) > 0 && window.__walletMode !== 'fail' ? 'Executing' : 'Pending' }),
    pollMs: 20,
    pollTimeoutMs: 2000,
  }),
};

const signedIn: GateDeps = {
  fetchSession: async () => ({ accountId: OWNER }),
  connectWallet: async () => {
    throw new WalletRefused();
  },
  login: async () => ({ accountId: OWNER }),
};

registerFixture('approvals-live', () => <ApprovalsRoute deps={approvalsDeps} gate={signedIn} />);

// ---- session-gate ----

const signedOut: GateDeps = {
  fetchSession: async () => null,
  // a wallet the console does not offer: the gate shows the fixed refusal text
  connectWallet: async () => {
    throw new WalletRefused();
  },
  login: async () => ({ accountId: OWNER }),
};

registerFixture('session-gate', () => <SessionGate deps={signedOut}>{({ accountId }) => <p>{accountId}</p>}</SessionGate>);

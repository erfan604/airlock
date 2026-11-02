// The login gate (AIR-182): the console shows `login-connect` until `GET /session` knows the owner, runs the wallet then the signature on a click
// and renders its children with the account. In replay mode the server's `GET /session` issues the session, so the gate passes without a wallet.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { connectWallet as realConnectWallet, WalletRefused } from './connector.ts';
import type { ConnectedWallet } from './connector.ts';
import { LoginError, fetchSession as realFetchSession, login as realLogin } from './login.ts';
import type { MessageSigner } from './login.ts';

export type GateDeps = {
  fetchSession: () => Promise<{ accountId: string } | null>;
  connectWallet: () => Promise<ConnectedWallet>;
  login: (wallet: MessageSigner) => Promise<{ accountId: string }>;
};

export type GateState = { kind: 'loading' } | { kind: 'out'; error: string | null; busy: boolean } | { kind: 'in'; accountId: string };

/** A fixed text for any failure of the sign in: the text of a wallet or a server is never shown. */
export function gateErrorText(e: unknown): string {
  if (e instanceof WalletRefused || e instanceof LoginError) return e.message;
  return new LoginError('wallet').message;
}

export async function signIn(deps: Pick<GateDeps, 'connectWallet' | 'login'>): Promise<{ accountId: string }> {
  const { wallet } = await deps.connectWallet();
  return deps.login(wallet as MessageSigner);
}

export type GateViewProps = {
  state: GateState;
  onConnect(): void;
  children: (s: { accountId: string }) => ReactNode;
};

export function SessionGateView({ state, onConnect, children }: GateViewProps) {
  if (state.kind === 'loading') return <main className="page gate" data-testid="gate-loading" aria-busy="true" />;
  if (state.kind === 'in') {
    return (
      <>
        <p className="gate-account" data-testid="session-account">
          {state.accountId}
        </p>
        {children({ accountId: state.accountId })}
      </>
    );
  }
  return (
    <main className="page gate" data-testid="gate">
      <h1 className="wordmark">AIRLOCK</h1>
      <p className="gate-line">Sign in with the owner wallet to see what is waiting for you.</p>
      <button type="button" className="card-btn card-btn-primary gate-btn" data-testid="login-connect" disabled={state.busy} onClick={onConnect}>
        {state.busy ? 'Waiting for your wallet' : 'Connect wallet'}
      </button>
      {state.error !== null ? (
        <p className="gate-error" data-testid="login-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </main>
  );
}

const LIVE: GateDeps = { fetchSession: realFetchSession, connectWallet: realConnectWallet, login: realLogin };

export function SessionGate({ children, deps = LIVE }: { children: GateViewProps['children']; deps?: GateDeps }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });
  const inflight = useRef(false);

  useEffect(() => {
    let live = true;
    deps
      .fetchSession()
      .then((s) => live && setState(s === null ? { kind: 'out', error: null, busy: false } : { kind: 'in', accountId: s.accountId }))
      .catch(() => live && setState({ kind: 'out', error: null, busy: false }));
    return () => {
      live = false;
    };
  }, [deps]);

  function onConnect(): void {
    if (inflight.current) return;
    inflight.current = true;
    setState({ kind: 'out', error: null, busy: true });
    signIn(deps)
      .then((s) => setState({ kind: 'in', accountId: s.accountId }))
      .catch((e: unknown) => setState({ kind: 'out', error: gateErrorText(e), busy: false }))
      .finally(() => {
        inflight.current = false;
      });
  }

  return (
    <SessionGateView state={state} onConnect={onConnect}>
      {children}
    </SessionGateView>
  );
}

// AIR-182: connectWallet with a mocked NEAR Connect (the real library is loaded only in the wallet-csp e2e).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import snapshot from '../src/wallet/manifest-snapshot.json' with { type: 'json' };
import { WalletRefused, connectWallet } from '../src/wallet/connector.ts';
import type { ConnectorDeps } from '../src/wallet/connector.ts';
import { LoginError } from '../src/wallet/login.ts';

type Calls = { options: unknown[]; disconnected: unknown[] };

function fakes(id: string, accounts: { accountId: string }[]): { deps: ConnectorDeps; calls: Calls; wallet: object } {
  const calls: Calls = { options: [], disconnected: [] };
  const wallet = { manifest: { id }, getAccounts: async () => accounts };
  class FakeConnector {
    constructor(o: unknown) {
      calls.options.push(o);
    }
    async connect() {
      return wallet;
    }
    async disconnect(w?: unknown) {
      calls.disconnected.push(w);
    }
  }
  const deps = { loadConnector: async () => ({ NearConnector: FakeConnector }), readNonce: () => 'page-nonce' } as unknown as ConnectorDeps;
  return { deps, calls, wallet };
}

test('connector: the options are testnet, the snapshot, both features, the page nonce and no footer', async () => {
  const { deps, calls } = fakes('intear-wallet', [{ accountId: 'erfan-airlock.testnet' }]);
  await connectWallet(deps);
  assert.equal(calls.options.length, 1);
  const o = calls.options[0] as Record<string, unknown>;
  assert.equal(o.network, 'testnet');
  assert.deepEqual(o.manifest, snapshot);
  assert.deepEqual(o.features, { signAndSendTransaction: true, signMessage: true });
  assert.equal(o.cspNonce, 'page-nonce');
  assert.equal(o.footerBranding, null);
});

test('connector: the manifest handed over is a copy, because the library mutates it', async () => {
  const { deps, calls } = fakes('intear-wallet', [{ accountId: 'a.testnet' }]);
  await connectWallet(deps);
  const o = calls.options[0] as { manifest: unknown };
  assert.notEqual(o.manifest, snapshot);
});

test('connector: the result has the wallet, the first account and the manifest id', async () => {
  const { deps, wallet } = fakes('intear-wallet', [{ accountId: 'erfan-airlock.testnet' }, { accountId: 'second.testnet' }]);
  const r = await connectWallet(deps);
  assert.equal(r.wallet, wallet);
  assert.equal(r.accountId, 'erfan-airlock.testnet');
  assert.equal(r.walletId, 'intear-wallet');
});

test('connector: a wallet that is not allowed is disconnected and refused with the fixed text', async () => {
  const { deps, calls, wallet } = fakes('nightly-wallet', [{ accountId: 'a.testnet' }]);
  await assert.rejects(
    () => connectWallet(deps),
    (e: unknown) => {
      assert.ok(e instanceof WalletRefused);
      assert.equal(e.message, 'This wallet does not show what it signs. Use the wallet the console lists.');
      return true;
    },
  );
  assert.deepEqual(calls.disconnected, [wallet]);
});

test('connector: an empty account list disconnects and throws LoginError wallet', async () => {
  const { deps, calls, wallet } = fakes('intear-wallet', []);
  await assert.rejects(
    () => connectWallet(deps),
    (e: unknown) => e instanceof LoginError && e.kind === 'wallet',
  );
  assert.deepEqual(calls.disconnected, [wallet]);
});

test('connector: a nonce is optional', async () => {
  const { deps, calls } = fakes('intear-wallet', [{ accountId: 'a.testnet' }]);
  await connectWallet({ ...deps, readNonce: () => undefined });
  assert.equal((calls.options[0] as Record<string, unknown>).cspNonce, undefined);
});

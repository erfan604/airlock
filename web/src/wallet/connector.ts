// NEAR Connect 0.11.4 (pinned, MIT): the wallet selector and the sandboxed wallet executors. The library is loaded with a dynamic import so it
// is its own chunk and not part of the console's entry bundle. The manifest is the pinned one-wallet snapshot (a literal object: the library
// fetches nothing), `signMessage` is required because the login needs it, and the page's CSP nonce goes on the executor's inline script.
import type { NearConnectorOptions, NearWalletBase } from '@hot-labs/near-connect';
import { allowedWallet, revealInstruction } from './capabilities.ts';
import { LoginError } from './login.ts';
import { readCspNonce } from './nonce.ts';
import { MANIFEST_SNAPSHOT } from './snapshot.ts';

/** Thrown after a wallet that does not show what it signs is disconnected. The text is fixed. */
export class WalletRefused extends Error {
  constructor() {
    super('This wallet does not show what it signs. Use the wallet the console lists.');
    this.name = 'WalletRefused';
  }
}

type ConnectorLike = {
  connect(): Promise<NearWalletBase>;
  disconnect(wallet?: NearWalletBase): Promise<void>;
};

export type ConnectorDeps = {
  loadConnector?: () => Promise<{ NearConnector: new (options: NearConnectorOptions) => ConnectorLike }>;
  readNonce?: () => string | undefined;
};

export type ConnectedWallet = { wallet: NearWalletBase; accountId: string; walletId: string };

let current: ConnectedWallet | null = null;

/** Opens the selector, connects, and checks the wallet against the capability table. */
export async function connectWallet(deps: ConnectorDeps = {}): Promise<ConnectedWallet> {
  const load = deps.loadConnector ?? (() => import('@hot-labs/near-connect'));
  const { NearConnector } = await load();
  const cspNonce = (deps.readNonce ?? readCspNonce)();
  const connector = new NearConnector({
    network: 'testnet',
    // the library writes into the manifest object it is given, so it gets a copy (its type says `platform` is an array, the live manifests hold an object)
    manifest: structuredClone(MANIFEST_SNAPSHOT) as unknown as NearConnectorOptions['manifest'],
    features: { signAndSendTransaction: true, signMessage: true },
    ...(cspNonce === undefined ? {} : { cspNonce }),
    footerBranding: null,
  });
  const wallet = await connector.connect();
  // connect() resolves to the wallet only, with no account id
  const walletId = wallet.manifest.id;
  if (allowedWallet(walletId) === null) {
    await connector.disconnect(wallet);
    throw new WalletRefused();
  }
  const accounts = await wallet.getAccounts();
  const first = accounts[0];
  if (first === undefined) {
    await connector.disconnect(wallet);
    throw new LoginError('wallet');
  }
  current = { wallet, accountId: first.accountId, walletId };
  return current;
}

/** The wallet connected in this page, else a new connection (the selector opens). */
export async function currentWallet(): Promise<NearWalletBase> {
  return current?.wallet ?? (await connectWallet()).wallet;
}

export { revealInstruction };

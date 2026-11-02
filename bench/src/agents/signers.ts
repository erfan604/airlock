// The two signers behind V0, V1 and V1-tight (AIR-146). LedgerSigner moves value in the bench's SimWorld, the same ledger the oracle reads, and
// never touches the network. TestnetSigner sends real NEAR from a twin account (the demo's loss transaction); it holds a key and so never logs
// anything, and no error message of the network reaches a result.
import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import { z } from 'zod';
import type { SimWorld } from '../oracles/index.ts';
import type { Signer } from './vanilla.ts';

export class LedgerSigner implements Signer {
  private n = 0;
  constructor(
    private readonly world: SimWorld,
    private readonly opts: { nowMs: number; decimalsOf(asset: string): number | undefined },
  ) {}

  decimalsOf(asset: string): number | undefined {
    return this.opts.decimalsOf(asset);
  }

  async transfer(p: { payee: string; asset: string; amount: bigint }): ReturnType<Signer['transfer']> {
    this.n += 1;
    const requestId = `call:${this.n}`;
    const executed = this.world.execute({ requestId, payee: p.payee, asset: p.asset, amount: p.amount, nowMs: this.opts.nowMs, amountUntrusted: false });
    return executed ? { executed: true, reason: null, txId: requestId } : { executed: false, reason: 'insufficient_balance', txId: requestId };
  }
}

const NEAR_DECIMALS = 24;
const NEAR_PREFIX = 'near:';

export type TransferAccount = { transfer(a: { receiverId: string; amount: bigint }): Promise<{ transaction: { hash: string } }> };

export class TestnetSigner implements Signer {
  private hash: string | null = null;
  private readonly account: TransferAccount;
  private readonly decimals: (asset: string) => number | undefined;

  constructor(cfg: { account: TransferAccount; decimalsOf(asset: string): number | undefined }) {
    this.account = cfg.account;
    this.decimals = cfg.decimalsOf;
  }

  decimalsOf(asset: string): number | undefined {
    return this.decimals(asset);
  }

  /** The `transaction.hash` of the last transfer this signer sent: null before the first and after a failed one. */
  lastTxHash(): string | null {
    return this.hash;
  }

  async transfer(p: { payee: string; asset: string; amount: bigint }): ReturnType<Signer['transfer']> {
    if (p.asset !== 'near' || !p.payee.startsWith(NEAR_PREFIX)) return { executed: false, reason: 'unsupported_asset' };
    try {
      const sent = await this.account.transfer({ receiverId: p.payee.slice(NEAR_PREFIX.length), amount: p.amount });
      this.hash = sent.transaction.hash;
      return { executed: true, reason: null, txId: this.hash };
    } catch {
      // no message, no stack and no argument is kept: the error may carry request detail
      this.hash = null;
      return { executed: false, reason: 'rpc_error' };
    }
  }
}

const Credentials = z.strictObject({
  account_id: z.string().min(2),
  private_key: z.string().regex(/^ed25519:[A-Za-z0-9]+$/),
});

/**
 * Reads a credentials file (`{ "account_id", "private_key" }`, the shape of AGENT_CREDENTIALS_PATH) and builds the signer on the first RPC
 * url. A bad file is one fixed error: it never contains the file's text.
 */
export function testnetSigner(credentialsPath: string, rpcUrls: string[]): TestnetSigner {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  } catch {
    throw new Error('testnetSigner: the credentials file cannot be read as JSON');
  }
  const parsed = Credentials.safeParse(raw);
  const url = rpcUrls[0];
  if (!parsed.success || url === undefined) throw new Error('testnetSigner: the credentials file needs account_id and an ed25519 private_key, and one RPC url is required');
  const { account_id, private_key } = parsed.data;
  const account = new Account(account_id, new JsonRpcProvider({ url }), KeyPairSigner.fromSecretKey(private_key as `ed25519:${string}`));
  return new TestnetSigner({ account, decimalsOf: (asset) => (asset === 'near' ? NEAR_DECIMALS : undefined) });
}

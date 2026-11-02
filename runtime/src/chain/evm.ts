// AIR-162: EVM assembly and broadcast with viem. The contract builds the unsigned EIP-1559 transaction, the MPC signs its hash, and this
// module turns both into the signed bytes, recovers the sender, and broadcasts to Base Sepolia by transaction hash (idempotent).
// It never signs and never builds a second transaction: once the signed bytes exist they are the only bytes ever sent.
import { BaseError, createPublicClient, http, keccak256, parseTransaction, serializeTransaction } from 'viem';
import type { Hex, PublicClient } from 'viem';
import { recoverTransactionAddress } from 'viem';
import { baseSepolia } from 'viem/chains';

/** The MPC signature in the flat form of the `signed` event and `RequestView.exec`: `big_r` 66 hex characters (compressed point), `s` 64, no `0x`. */
export type MpcSig = { big_r: string; s: string; recovery_id: number };

export class EvmAssembleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvmAssembleError';
  }
}

export class EvmDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvmDecodeError';
  }
}

export type EvmBroadcastCode = 'Rejected' | 'NoRpc' | 'Timeout';

/** `Rejected`: a node that does not know the transaction refused it (final, the same bytes give the same answer). `NoRpc`: no endpoint was usable. */
export class EvmBroadcastError extends Error {
  constructor(
    readonly code: EvmBroadcastCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvmBroadcastError';
  }
}

/** Flatten the raw `SignatureResponse` (the nested shape of the MPC signer) into an `MpcSig`. */
export function sigFromMpc(resp: { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number }): MpcSig {
  return { big_r: resp.big_r.affine_point, s: resp.s.scalar, recovery_id: resp.recovery_id };
}

const with0x = (hex: string): Hex => (hex.startsWith('0x') || hex.startsWith('0X') ? `0x${hex.slice(2)}` : `0x${hex}`).toLowerCase() as Hex;

/**
 * The signed transaction from the contract's unsigned hex (with or without `0x`) and the MPC signature. r is the x coordinate of `big_r`
 * (the point without its prefix byte); viem trims leading zero bytes of r and s. A recovery id other than 0 or 1 is refused before viem
 * is called: viem writes any non-zero `yParity` as 1 without an error and the transaction would recover another address.
 */
export function assembleEvm(unsignedHex: string, sig: MpcSig): Hex {
  if (!/^0[23][0-9a-f]{64}$/.test(sig.big_r)) throw new EvmAssembleError('big_r must be a compressed point: 02 or 03 and 64 hex characters');
  if (!/^[0-9a-f]{64}$/.test(sig.s)) throw new EvmAssembleError('s must be 64 lowercase hex characters');
  if (sig.recovery_id !== 0 && sig.recovery_id !== 1) throw new EvmAssembleError('recovery_id must be 0 or 1');
  let tx;
  try {
    tx = parseTransaction(with0x(unsignedHex));
  } catch (e) {
    throw new EvmAssembleError(`unsigned transaction does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  return serializeTransaction(tx as never, { r: `0x${sig.big_r.slice(2)}`, s: `0x${sig.s}`, yParity: sig.recovery_id });
}

export interface DecodedUnsigned {
  chainId: number;
  nonce: bigint;
  to: string;
  value: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
}

/**
 * Read the fields of an unsigned (or signed) transaction. Only an EIP-1559 transaction with a `to`, empty data and an empty access list
 * is accepted, so a request that moves value can never carry a call. viem parses legacy, data-carrying and `to`-less transactions
 * without error and reports empty data and an empty access list as absent keys, so each is checked here.
 */
export function decodeUnsigned(unsignedHex: string): DecodedUnsigned {
  let tx: Record<string, unknown>;
  try {
    tx = parseTransaction(with0x(unsignedHex)) as unknown as Record<string, unknown>;
  } catch (e) {
    throw new EvmDecodeError(`transaction does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (tx.type !== 'eip1559') throw new EvmDecodeError('transaction is not EIP-1559');
  if (typeof tx.to !== 'string') throw new EvmDecodeError('transaction has no to');
  if (tx.data !== undefined && tx.data !== '0x') throw new EvmDecodeError('transaction carries data');
  if (tx.accessList !== undefined && !(Array.isArray(tx.accessList) && tx.accessList.length === 0)) throw new EvmDecodeError('transaction carries an access list');
  if (typeof tx.chainId !== 'number') throw new EvmDecodeError('transaction has no chain id');
  return {
    chainId: tx.chainId,
    nonce: BigInt(tx.nonce === undefined ? 0 : (tx.nonce as number)),
    to: tx.to.toLowerCase(),
    value: BigInt((tx.value as bigint | undefined) ?? 0n),
    maxFeePerGas: BigInt((tx.maxFeePerGas as bigint | undefined) ?? 0n),
    gas: BigInt((tx.gas as bigint | undefined) ?? 0n),
  };
}

/** The signer of a signed transaction, lowercase. */
export async function senderOf(raw: Hex): Promise<string> {
  const address = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
  return address.toLowerCase();
}

/**
 * The address the MPC controls for a policy account and path, derived offline (chainsig.js, no RPC call), lowercase. The orchestrator
 * calls it once per EVM asset at start-up with the registry `path`.
 */
export async function deriveSender(contractId: string, path: string): Promise<string> {
  const { contracts, chainAdapters } = await import('chainsig.js');
  const contract = new contracts.ChainSignatureContract({ networkId: 'testnet', contractId: 'v1.signer-prod.testnet' });
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPCS[0], { retryCount: 0 }) });
  const evm = new chainAdapters.evm.EVM({ publicClient: publicClient as never, contract });
  const derived = await evm.deriveAddressAndPublicKey(contractId, path);
  return derived.address.toLowerCase();
}

export const BASE_SEPOLIA_RPCS = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org'] as const;

export interface BroadcastOptions {
  /** receipt poll interval, 2000 ms by default */
  pollingIntervalMs?: number;
  /** receipt wait, 90000 ms by default */
  timeoutMs?: number;
}

// JSON-RPC codes a healthy node uses for "try again later": the next endpoint may answer
const TRANSIENT_CODES = new Set([-1, -32005, -32007, -32603, 429]);

type Failure = 'transport' | 'node';

/** A node that answered with a JSON-RPC error (not a transient one) has seen the bytes and refused them; anything else is a transport failure. */
function classify(error: unknown): { kind: Failure; text: string } {
  const text = error instanceof BaseError ? (error.details ?? error.shortMessage) : error instanceof Error ? error.message : String(error);
  if (!(error instanceof BaseError)) return { kind: 'transport', text };
  const rpc = error.walk((e) => typeof (e as { code?: unknown }).code === 'number' && (e as { name?: string }).name !== 'HttpRequestError');
  const code = (rpc as { code?: number } | null)?.code;
  if (code === undefined || TRANSIENT_CODES.has(code)) return { kind: 'transport', text };
  return { kind: 'node', text };
}

/** true or false when the node answers, null when it could not be asked */
async function nodeKnows(client: PublicClient, hash: Hex): Promise<boolean | null> {
  for (const lookup of [() => client.getTransaction({ hash }), () => client.getTransactionReceipt({ hash })]) {
    try {
      await lookup();
      return true;
    } catch (e) {
      const name = e instanceof BaseError ? (e.walk((x) => /NotFoundError$/.test((x as Error).name)) as Error | null)?.name : undefined;
      if (name === undefined) return null;
    }
  }
  return false;
}

/**
 * Send the signed bytes and wait for the receipt. Idempotent by transaction hash: a node that already knows the hash (pending or mined)
 * counts as done, a node that does not know it and refuses it is final (`Rejected`), a transport failure moves to the next URL.
 * Never signs, never builds a second transaction.
 */
export async function broadcast(
  raw: Hex,
  rpcUrls: readonly string[] = BASE_SEPOLIA_RPCS,
  options: BroadcastOptions = {},
): Promise<{ hash: string; status: 'success' | 'reverted' }> {
  const hash = keccak256(raw);
  const chainId = decodeUnsigned(raw).chainId;
  for (const url of rpcUrls) {
    // retryCount 0: viem otherwise resends on 5xx and network errors inside one call
    const client = createPublicClient({ chain: baseSepolia, transport: http(url, { retryCount: 0 }) }) as PublicClient;
    let id: number;
    try {
      id = await client.getChainId();
    } catch {
      continue;
    }
    if (id !== chainId) continue;
    try {
      await client.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      const { kind, text } = classify(e);
      const known = await nodeKnows(client, hash);
      if (known === null) continue;
      if (!known) {
        if (kind === 'node') throw new EvmBroadcastError('Rejected', text);
        continue;
      }
    }
    try {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: options.timeoutMs ?? 90_000, pollingInterval: options.pollingIntervalMs ?? 2_000 });
      return { hash, status: receipt.status };
    } catch (e) {
      if (e instanceof BaseError && e.walk((x) => (x as Error).name === 'WaitForTransactionReceiptTimeoutError') !== null) {
        throw new EvmBroadcastError('Timeout', `no receipt for ${hash} within the wait`);
      }
      throw e;
    }
  }
  throw new EvmBroadcastError('NoRpc', 'no Base Sepolia endpoint accepted the transaction');
}

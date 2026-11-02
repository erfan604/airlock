// AIR-162: the check of invariant I5 for the EVM lane. Everything is read from the signed bytes, never from a runtime claim: chain, recipient,
// amount and sender must equal the stored request, and the unsigned part of the bytes must be the preimage the contract hashed.
import { parseTransaction, serializeTransaction } from 'viem';
import type { Hex } from 'viem';
import { decodeUnsigned, senderOf } from './evm.ts';
import type { RequestView } from './types.ts';

export type EvmMismatchCode = 'chain' | 'to' | 'value' | 'sender' | 'preimage';

export class EvmMismatch extends Error {
  constructor(
    readonly code: EvmMismatchCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvmMismatch';
  }
}

/** `evm:<id>:native` */
const ASSET = /^evm:([0-9]+):native$/;
/** `evm:<id>:0x<40 hex>` */
const PAYEE = /^evm:([0-9]+):(0x[0-9a-fA-F]{40})$/;

const normalizeHex = (hex: string): string => (hex.startsWith('0x') || hex.startsWith('0X') ? `0x${hex.slice(2)}` : `0x${hex}`).toLowerCase();

/** The signed transaction without its signature, serialized again: the bytes the contract hashed. */
function preimageOf(raw: Hex): string {
  const { r, s, v, yParity, ...unsigned } = parseTransaction(raw) as unknown as Record<string, unknown>;
  void r;
  void s;
  void v;
  void yParity;
  return serializeTransaction(unsigned as never);
}

export async function verifySignedMatchesRequest(raw: Hex, stored: RequestView, derivedAddress: string): Promise<void> {
  const decoded = decodeUnsigned(raw);
  const asset = ASSET.exec(stored.asset);
  if (asset === null || BigInt(asset[1]!) !== BigInt(decoded.chainId)) {
    throw new EvmMismatch('chain', `signed chain id ${decoded.chainId} is not the chain of asset ${stored.asset}`);
  }
  const payee = PAYEE.exec(stored.payee);
  if (payee === null || BigInt(payee[1]!) !== BigInt(decoded.chainId) || payee[2]!.toLowerCase() !== decoded.to) {
    throw new EvmMismatch('to', `signed recipient ${decoded.to} is not the stored payee ${stored.payee}`);
  }
  if (decoded.value !== BigInt(stored.amount)) {
    throw new EvmMismatch('value', `signed value ${decoded.value} is not the stored amount ${stored.amount}`);
  }
  const sender = await senderOf(raw);
  if (sender !== derivedAddress.toLowerCase()) {
    throw new EvmMismatch('sender', `signature recovers ${sender}, not the derived address ${derivedAddress.toLowerCase()}`);
  }
  const stub = stored.exec?.unsigned_hex;
  if (stub === null || stub === undefined || normalizeHex(stub) !== preimageOf(raw)) {
    throw new EvmMismatch('preimage', 'the signed bytes do not cover the stored unsigned transaction');
  }
}

// AIR-168: the checks the x402 facilitator makes for an EIP-3009 payment (x402 typescript/packages/mechanisms/evm exact/facilitator
// eip3009.ts), run locally before a settlement is attempted.
import { recoverTypedDataAddress } from 'viem';
import type { Hex } from 'viem';
import type { PaymentPayloadV2 } from './x402.ts';

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const CHAIN_ID = 84532;

/** Throws an Error naming the failed check; returns when every check passes. `nowS` is Unix seconds. */
export async function verifyLocally(p: PaymentPayloadV2, nowS: bigint): Promise<void> {
  const { authorization: a, signature } = p.payload;
  const { accepted } = p;
  const extra = accepted.extra;
  if (extra?.name === undefined || extra.version === undefined) throw new Error('verify: accepted.extra name or version missing');
  if (a.to.toLowerCase() !== accepted.payTo.toLowerCase()) throw new Error('verify: to differs from payTo');
  if (BigInt(a.value) !== BigInt(accepted.amount)) throw new Error('verify: value differs from amount');
  if (BigInt(a.validAfter) > nowS) throw new Error('verify: validAfter is in the future');
  if (BigInt(a.validBefore) < nowS + 6n) throw new Error('verify: validBefore is less than 6 seconds ahead');
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: { name: extra.name, version: extra.version, chainId: CHAIN_ID, verifyingContract: accepted.asset as Hex },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from as Hex,
        to: a.to as Hex,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce as Hex,
      },
      signature: signature as Hex,
    });
  } catch {
    throw new Error('verify: signature does not recover');
  }
  if (recovered.toLowerCase() !== a.from.toLowerCase()) throw new Error('verify: signature does not recover from');
}

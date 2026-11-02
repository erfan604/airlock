// AIR-102: assemble a signed EIP-1559 transaction from the contract-built unsigned preimage and the MPC signer's response.
// viem only. AIR-162 builds the runtime version (`assembleEvm`); this helper is separate on purpose (schedule independence).
// adapted from the research repo spike spikes/real-mpc/assemble.mjs (own code, same author): typed, validated, trimming tested.
import { keccak256, parseTransaction, recoverAddress, serializeTransaction } from 'viem';
import type { Hex } from 'viem';

/** The MPC signer's response for a secp256k1 request, as `on_signed` receives it. */
export interface MpcResponse {
  scheme: string;
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

export interface AssembledTx {
  raw: Hex;
  hash: Hex;
  signer: string;
}

const HEX_66 = /^0[23][0-9a-fA-F]{64}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * `unsignedHex` is the EIP-1559 preimage as the contract emits it: lowercase hex without `0x`, first byte 02.
 * `r` is the affine point without its first byte, `s` is the scalar, `yParity` is `recovery_id`. `serializeTransaction` trims
 * leading zero bytes of r and s (omni-transaction's `build_with_signature` does not). `hash` is the signing hash,
 * `signer` the address recovered from it.
 */
export async function assembleSigned(unsignedHex: string, response: MpcResponse): Promise<AssembledTx> {
  if (!/^02[0-9a-fA-F]*$/.test(unsignedHex)) throw new Error('unsigned transaction is not an EIP-1559 preimage');
  if (response.scheme !== 'Secp256k1') throw new Error('response scheme is not Secp256k1');
  const point = response.big_r.affine_point;
  const scalar = response.s.scalar;
  if (!HEX_66.test(point)) throw new Error('affine_point is not 33 bytes of hex with a 02 or 03 prefix');
  if (!HEX_64.test(scalar)) throw new Error('scalar is not 32 bytes of hex');
  const yParity = response.recovery_id;
  if (yParity !== 0 && yParity !== 1) throw new Error('recovery_id is not 0 or 1');
  const unsigned: Hex = `0x${unsignedHex}`;
  const tx = parseTransaction(unsigned);
  const r: Hex = `0x${point.slice(2).toLowerCase()}`;
  const s: Hex = `0x${scalar.toLowerCase()}`;
  const raw = serializeTransaction(tx, { r, s, yParity });
  const hash = keccak256(unsigned);
  const signer = await recoverAddress({ hash, signature: { r, s, yParity } });
  return { raw, hash, signer };
}

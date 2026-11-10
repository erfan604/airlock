// AIR-356: a fresh ed25519 key pair in NEAR's text form, for the published function-call keys of the try card. The secret of such a key
// is published on purpose (it can only call submit_batch on the try policy), but it is still written to its env file only and never printed.
// adapted from scripts/challenge-keygen.mjs of this repo (the same DER export and base58 form)
import { generateKeyPairSync } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = (B58[+String(n % 58n)] ?? '') + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** `{ publicKey: "ed25519:<base58 of 32 bytes>", secretKey: "ed25519:<base58 of seed and public key>" }`. */
export function newKeyPair(): { publicKey: string; secretKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { publicKey: `ed25519:${base58(pub)}`, secretKey: `ed25519:${base58(Buffer.concat([seed, pub]))}` };
}

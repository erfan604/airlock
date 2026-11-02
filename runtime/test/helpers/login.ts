// Test helper for live-mode tests (AIR-161): log in for real with a seed, the way a NEAR wallet would. challenge, sign the NEP-413
// payload with node:crypto and hand-written borsh, post it. The borsh is written here on purpose and does not use the server's code.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { baseEncode } from 'near-api-js';

interface Requestable {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s: string): Buffer => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};

/** The NEP-413 bytes a wallet signs the hash of: u32 tag 2147484061, message, nonce, recipient, callbackUrl None. */
export function nep413Borsh(message: string, nonceHex: string, recipient: string): Buffer {
  return Buffer.concat([u32(2147484061), str(message), Buffer.from(nonceHex, 'hex'), str(recipient), Buffer.from([0])]);
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The `ed25519:` public key text of a 32 byte seed. */
export function publicKeyOfSeed(seedHex: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return `ed25519:${baseEncode(Uint8Array.from(spki.subarray(spki.length - 32)))}`;
}

/** Ed25519 over sha256(borsh), as standard padded base64. */
export function signNep413(seedHex: string, message: string, nonceHex: string, recipient: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const digest = createHash('sha256').update(nep413Borsh(message, nonceHex, recipient)).digest();
  return sign(null, digest, key).toString('base64');
}

export interface LoginResult {
  res: Response;
  /** `airlock_session=<id>` when the answer set the cookie, else null */
  cookie: string | null;
}

/** challenge, sign what the server asked for, post. `host` is sent as the Host header (default localhost). */
export async function loginWithSeed(app: Requestable, seedHex: string, ownerId: string, contractId: string, host = 'localhost'): Promise<LoginResult> {
  const headers = { host };
  const challenge = await app.request('/session/challenge', { method: 'POST', headers });
  const { nonce, message, recipient } = (await challenge.json()) as { nonce: string; message: string; recipient: string };
  if (recipient !== contractId) throw new Error(`the server asked for recipient ${recipient}, expected ${contractId}`);
  const body = { accountId: ownerId, publicKey: publicKeyOfSeed(seedHex), signature: signNep413(seedHex, message, nonce, recipient), nonce };
  const res = await app.request('/session', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  const match = set === null ? null : /airlock_session=([0-9a-f]+)/.exec(set);
  return { res, cookie: match === null ? null : `airlock_session=${match[1]}` };
}

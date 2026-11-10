// AIR-359 (and AIR-356): the page signs its own NEAR transactions. A hand-rolled borsh Transaction (V0) with the two actions the site needs,
// FunctionCall (index 2) and Transfer (index 3), SHA-256 through crypto.subtle.digest and Ed25519 through WebCrypto: no new dependency. Its
// bytes, hash and signature equal near-api-js 7.3.1 on fixed inputs (web/test/lender-tx.test.ts against web/test/fixtures/tx-vector.json).
// It serves a full-access key the page made (the lender's deposit with 1 NEAR attached, the withdraw with 0) and a published function-call key
// (a call with deposit 0). Sending goes through the console's one JSON-RPC client over NEAR_RPC in order; success is read from the outcome,
// never from the HTTP status. Amounts and nonces are BigInt.
import { base58 } from '../preview/taskKey.ts';
import { RpcError, rpcCall } from './rpc.ts';
import type { RpcConfig } from './rpc.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The inverse of `base58` (Bitcoin alphabet, each leading `1` a zero byte). Throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    let carry = ALPHABET.indexOf(text.charAt(i));
    if (carry < 0) throw new Error('not base58');
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let k = 0; k < bytes.length; k++) out[zeros + k] = bytes[bytes.length - 1 - k] ?? 0;
  return out;
}

// ---- borsh ----

class Writer {
  private parts: number[] = [];
  u8(v: number): void {
    this.parts.push(v & 0xff);
  }
  u32(v: number): void {
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff);
  }
  uint(v: bigint, bytes: number): void {
    if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new Error('integer out of range');
    for (let i = 0; i < bytes; i++) this.parts.push(Number((v >> BigInt(8 * i)) & 0xffn));
  }
  put(b: Uint8Array): void {
    for (const x of b) this.parts.push(x);
  }
  bytes(b: Uint8Array): void {
    this.u32(b.length);
    this.put(b);
  }
  string(s: string): void {
    this.bytes(new TextEncoder().encode(s));
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export type TxAction = { kind: 'call'; method: string; args: Uint8Array; gas: bigint; deposit: bigint } | { kind: 'transfer'; deposit: bigint };
export type TxInput = { signerId: string; publicKey: Uint8Array; nonce: bigint; receiverId: string; blockHash: Uint8Array; actions: readonly TxAction[] };

/** The borsh bytes of a V0 Transaction: signer, ed25519 public key, nonce u64, receiver, block hash, actions. */
export function encodeTransaction(tx: TxInput): Uint8Array {
  if (tx.publicKey.length !== 32 || tx.blockHash.length !== 32) throw new Error('a public key and a block hash are 32 bytes');
  const w = new Writer();
  w.string(tx.signerId);
  w.u8(0);
  w.put(tx.publicKey);
  w.uint(tx.nonce, 8);
  w.string(tx.receiverId);
  w.put(tx.blockHash);
  w.u32(tx.actions.length);
  for (const a of tx.actions) {
    if (a.kind === 'call') {
      w.u8(2);
      w.string(a.method);
      w.bytes(a.args);
      w.uint(a.gas, 8);
      w.uint(a.deposit, 16);
    } else {
      w.u8(3);
      w.uint(a.deposit, 16);
    }
  }
  return w.done();
}

// ---- keys ----

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export type Ed25519Key = { publicKey: Uint8Array; publicKeyText: string; secretKeyText: string; sign(bytes: Uint8Array): Promise<Uint8Array> };

const b64urlDecode = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function keyOfSeed(seed: Uint8Array): Promise<Ed25519Key> {
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.length);
  const priv = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  if (typeof jwk.x !== 'string') throw new Error('no public key');
  const pub = b64urlDecode(jwk.x);
  const both = new Uint8Array(64);
  both.set(seed);
  both.set(pub, 32);
  return {
    publicKey: pub,
    publicKeyText: `ed25519:${base58(pub)}`,
    secretKeyText: `ed25519:${base58(both)}`,
    async sign(bytes) {
      return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, new Uint8Array(bytes)));
    },
  };
}

/** A new Ed25519 key, extractable so its secret can be kept (the lender's own key, in this browser only). Throws where WebCrypto has no Ed25519. */
export async function generateKey(): Promise<Ed25519Key> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return keyOfSeed(pkcs8.slice(pkcs8.length - 32));
}

/** The key of a NEAR secret text `ed25519:<base58 of seed and public key>`. Refuses another curve, another length, or a public half that is not the seed's. */
export async function keyFromSecret(text: string): Promise<Ed25519Key> {
  if (!text.startsWith('ed25519:')) throw new Error('not an ed25519 secret key');
  const bytes = base58Decode(text.slice('ed25519:'.length));
  if (bytes.length !== 64) throw new Error('an ed25519 secret key is 64 bytes');
  const key = await keyOfSeed(bytes.slice(0, 32));
  if (base58(key.publicKey) !== base58(bytes.slice(32))) throw new Error('the public half does not match the seed');
  return key;
}

// ---- signing ----

export type SignedTx = { bytes: Uint8Array; hash: Uint8Array; hashText: string; signatureText: string; base64: string };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Signs sha256 of the transaction bytes; the SignedTransaction is those bytes, key type 0 and the 64 signature bytes. */
export async function signTransaction(tx: TxInput, key: Ed25519Key): Promise<SignedTx> {
  const body = encodeTransaction(tx);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body)));
  const sig = await key.sign(hash);
  const bytes = new Uint8Array(body.length + 1 + sig.length);
  bytes.set(body);
  bytes[body.length] = 0;
  bytes.set(sig, body.length + 1);
  return { bytes, hash, hashText: base58(hash), signatureText: base58(sig), base64: toBase64(bytes) };
}

/** The next nonce: above the chain nonce by 1 plus up to 999, so two tabs or visitors on one published key rarely collide (AIR-356). */
export function chooseNonce(chainNonce: bigint, random: number): bigint {
  if (!(random >= 0 && random < 1)) throw new Error('random must be in [0, 1)');
  return chainNonce + 1n + BigInt(Math.floor(random * 1000));
}

// ---- sending ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type CallSpec = { signerId: string; receiverId: string; method: string; args: object; gas: bigint; deposit: bigint; random?: () => number };
export type CallResult = { hash: string; outcome: unknown };

/** The key's nonce and a final block hash, from one `view_access_key` query. */
export async function readAccessKey(rpc: RpcConfig, accountId: string, publicKeyText: string): Promise<{ nonce: bigint; blockHash: Uint8Array }> {
  const r = await rpcCall(rpc, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKeyText });
  // a key the node does not know yet comes back as a result with an `error` string, not as a JSON-RPC error (seen live on a just-made account)
  if (isObj(r) && typeof r['error'] === 'string') throw new RpcError(r['error'].slice(0, 200));
  if (!isObj(r) || typeof r['block_hash'] !== 'string' || !(typeof r['nonce'] === 'number' || typeof r['nonce'] === 'string')) throw new RpcError('access key view is not in the expected shape');
  return { nonce: BigInt(r['nonce']), blockHash: base58Decode(r['block_hash']) };
}

/** Sends a signed transaction and waits for the optimistic outcome. The same signed bytes may go to the next node: a transaction is applied once. */
export async function sendSigned(rpc: RpcConfig, signed: SignedTx): Promise<unknown> {
  return rpcCall(rpc, 'send_tx', { signed_tx_base64: signed.base64, wait_until: 'EXECUTED_OPTIMISTIC' });
}

/** One FunctionCall from `signerId` with the key: read nonce and block, sign, send. A node error (InvalidNonce, a failed call) throws RpcError. */
export async function functionCall(rpc: RpcConfig, key: Ed25519Key, spec: CallSpec): Promise<CallResult> {
  const { nonce, blockHash } = await readAccessKey(rpc, spec.signerId, key.publicKeyText);
  const tx: TxInput = {
    signerId: spec.signerId,
    publicKey: key.publicKey,
    nonce: chooseNonce(nonce, (spec.random ?? (() => 0))()),
    receiverId: spec.receiverId,
    blockHash,
    actions: [{ kind: 'call', method: spec.method, args: new TextEncoder().encode(JSON.stringify(spec.args)), gas: spec.gas, deposit: spec.deposit }],
  };
  const signed = await signTransaction(tx, key);
  const outcome = await sendSigned(rpc, signed);
  return { hash: signed.hashText, outcome };
}

function decodeB64Json(v: unknown): unknown {
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)))) as unknown;
  } catch {
    return undefined;
  }
}

/** The transaction's SuccessValue decoded as JSON, or undefined when it failed or returned nothing readable. */
export function successValue(outcome: unknown): unknown {
  const status = isObj(outcome) ? outcome['status'] : undefined;
  return isObj(status) && 'SuccessValue' in status ? decodeB64Json(status['SuccessValue']) : undefined;
}

/** The log lines of the receipts `executor` ran in this outcome (the pool's `deposit` event is the proof of a deposit, not the HTTP status). */
export function eventLogs(outcome: unknown, executor: string): string[] {
  const receipts = isObj(outcome) && Array.isArray(outcome['receipts_outcome']) ? outcome['receipts_outcome'] : [];
  const out: string[] = [];
  for (const r of receipts) {
    const o = isObj(r) ? r['outcome'] : undefined;
    if (!isObj(o) || o['executor_id'] !== executor || !Array.isArray(o['logs'])) continue;
    const status = o['status'];
    if (isObj(status) && 'Failure' in status) continue;
    for (const l of o['logs']) if (typeof l === 'string') out.push(l);
  }
  return out;
}

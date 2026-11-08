// AIR-325: the Solana side of the Solana lane. The policy contract builds the legacy SystemProgram transfer message and the MPC signs it
// (`get_sol_attempt` answers both as hex); this module only assembles the wire transaction from those two values and talks to a Solana
// JSON-RPC endpoint (devnet). It holds no key and builds no message: the relayer cannot change what was signed, and any party could
// broadcast the same bytes.
// Wire format of a signed legacy transaction: compact-u16 signature count (one byte, 1), the 64-byte signature, then the message bytes.

const HEX = '0123456789abcdef';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// digit value (as decimal text) to base58 character, so no number conversion is needed on this money path
const B58_OF = new Map<string, string>(B58.split('').map((c, i) => [String(i), c]));

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const SOLANA_EXPLORER = (signature: string): string => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

export class SolanaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolanaError';
  }
}

function hexToBytes(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) throw new SolanaError('not lowercase hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = HEX.indexOf(text.charAt(2 * i)) * 16 + HEX.indexOf(text.charAt(2 * i + 1));
  return out;
}

/** Base58 of any bytes (leading zero bytes become `1`s): the spelling of a Solana address or transaction signature. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = (B58_OF.get((n % 58n).toString()) ?? '') + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/**
 * The base64 wire transaction of a one-signer legacy message and its signature. Refuses a message whose header does not name exactly one
 * required signature, a signature that is not 64 bytes, and a result above the 1232-byte packet limit.
 */
export function assembleSolanaTx(messageHex: string, signatureHex: string): string {
  const message = hexToBytes(messageHex);
  const signature = hexToBytes(signatureHex);
  if (signature.length !== 64) throw new SolanaError('a signature is 64 bytes');
  if (message.length < 4 || message[0] !== 1) throw new SolanaError('the message must name exactly one required signature');
  if (1 + 64 + message.length > 1232) throw new SolanaError('the transaction is above the 1232 byte packet limit');
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(signature, 1);
  wire.set(message, 65);
  return Buffer.from(wire).toString('base64');
}

/** The transaction id Solana gives a signed transaction: the base58 of its first (here only) signature. */
export function solanaTxId(signatureHex: string): string {
  return base58(hexToBytes(signatureHex));
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ json(): Promise<unknown> }>;

/** One JSON-RPC call; an `error` member becomes a SolanaError with its message. */
export async function solanaRpc(rpc: string, method: string, params: unknown[], fetchFn: Fetch = fetch as unknown as Fetch): Promise<unknown> {
  const res = await fetchFn(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error !== undefined) throw new SolanaError(`${method}: ${body.error.message ?? 'error'}`);
  return body.result;
}

/** The latest blockhash of the cluster (base58), the value `sign_sol` takes. */
export async function latestBlockhash(rpc: string, fetchFn?: Fetch): Promise<string> {
  const r = (await solanaRpc(rpc, 'getLatestBlockhash', [{ commitment: 'finalized' }], fetchFn)) as { value?: { blockhash?: string } };
  const hash = r.value?.blockhash;
  if (typeof hash !== 'string') throw new SolanaError('getLatestBlockhash gave no blockhash');
  return hash;
}

/** The balance of an address in lamports, as a bigint. */
export async function balanceOf(rpc: string, address: string, fetchFn?: Fetch): Promise<bigint> {
  const r = (await solanaRpc(rpc, 'getBalance', [address, { commitment: 'confirmed' }], fetchFn)) as { value?: number | string };
  if (r.value === undefined) throw new SolanaError('getBalance gave no value');
  return BigInt(r.value);
}

/** Sends the base64 transaction with preflight on; returns the transaction id the node answers. */
export async function sendTransaction(rpc: string, wireBase64: string, fetchFn?: Fetch): Promise<string> {
  const r = await solanaRpc(rpc, 'sendTransaction', [wireBase64, { encoding: 'base64', preflightCommitment: 'confirmed' }], fetchFn);
  if (typeof r !== 'string') throw new SolanaError('sendTransaction gave no signature');
  return r;
}

/** The confirmation status of a transaction id (`processed`, `confirmed`, `finalized`), `null` while unknown, or the error it ended with. */
export async function statusOf(rpc: string, txId: string, fetchFn?: Fetch): Promise<{ status: string | null; err: unknown }> {
  const r = (await solanaRpc(rpc, 'getSignatureStatuses', [[txId], { searchTransactionHistory: true }], fetchFn)) as {
    value?: ({ confirmationStatus?: string; err?: unknown } | null)[];
  };
  const s = r.value?.[0] ?? null;
  return s === null ? { status: null, err: null } : { status: s.confirmationStatus ?? null, err: s.err ?? null };
}

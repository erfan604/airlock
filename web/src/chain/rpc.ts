// The console's one JSON-RPC client (AIR-183). The status reader (AIR-182) and the preview reads (AIR-185) import it, so neither
// writes its own. Browser safe: fetch, TextEncoder, TextDecoder and btoa only. Amounts are never parsed here: a view returns
// JSON text and the caller keeps decimal strings.

export class RpcError extends Error {
  readonly code: number | undefined;
  readonly causeName: string | undefined;
  /** The names of the node's invalid transaction errors found in its answer (`NotEnoughBalance`, `NotEnoughAllowance`, ...), never any other text. */
  readonly detail: readonly string[];
  constructor(message: string, code?: number, causeName?: string, detail: readonly string[] = []) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.causeName = causeName;
    this.detail = detail;
  }
}

/** Invalid transaction errors a caller may need to tell apart (nearcore InvalidTxError and InvalidAccessKeyError names). */
const DETAILS = ['NotEnoughBalance', 'NotEnoughAllowance', 'LackBalanceForState', 'InvalidNonce', 'AccessKeyNotFound', 'Expired'] as const;
const detailsOf = (err: unknown): string[] => {
  let text = '';
  try {
    text = JSON.stringify(err) ?? '';
  } catch {
    return [];
  }
  return DETAILS.filter((d) => new RegExp(`"${d}"|\\b${d}\\b`).test(text));
};

export type RpcConfig = { rpcUrls: readonly string[]; fetch?: typeof fetch };

type RpcBody = { result?: unknown; error?: { name?: unknown; message?: unknown; code?: unknown; cause?: { name?: unknown } | null } | null };

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * Posts one request to each URL in order and returns `result`. A thrown fetch, a status outside 2xx or a body that is not JSON
 * tries the next URL. A JSON-RPC `error` object comes from the node, not from the transport: it is thrown at once as RpcError,
 * with the node's own `name` (else its `message`) as the message and never any part of the request. After the last URL the
 * last error is thrown.
 */
export async function rpcCall(cfg: RpcConfig, method: string, params: object): Promise<unknown> {
  const doFetch = cfg.fetch ?? globalThis.fetch.bind(globalThis);
  let last: unknown = new Error('no RPC URL');
  for (const url of cfg.rpcUrls) {
    let body: unknown;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'airlock', method, params }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      last = e;
      continue;
    }
    if (typeof body !== 'object' || body === null) {
      last = new Error('RPC body is not an object');
      continue;
    }
    const reply = body as RpcBody;
    if (reply.error !== undefined && reply.error !== null) {
      const err = reply.error;
      throw new RpcError(text(err.name) ?? text(err.message) ?? 'rpc', typeof err.code === 'number' ? err.code : undefined, text(err.cause?.name), detailsOf(err));
    }
    if (!('result' in reply)) {
      last = new Error('RPC body has no result');
      continue;
    }
    return reply.result;
  }
  throw last;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A contract view call: the args as JSON, the result bytes decoded as UTF-8 JSON. */
export function rpcView(cfg: { contractId: string; rpcUrls: readonly string[]; fetch?: typeof fetch }): (method: string, args: object) => Promise<unknown> {
  return async (method, args) => {
    const reply = await rpcCall(cfg, 'query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: cfg.contractId,
      method_name: method,
      args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args))),
    });
    const bytes = (reply as { result?: unknown } | null)?.result;
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new RpcError('view result is not a byte array');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[]))) as unknown;
  };
}

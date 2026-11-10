// Read-only NEAR RPC for the credit scripts (AIR-355, AIR-359): `query` calls only, at the latest final block. Nothing here signs or sends.
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type Fetch = typeof fetch;

/** One `query` call; null when the node answers an error (an unknown account, key or method). */
export async function rpcQuery(rpcUrl: string, params: Record<string, unknown>, fetchFn: Fetch = fetch): Promise<Record<string, unknown> | null> {
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'credit', method: 'query', params: { finality: 'final', ...params } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${new URL(rpcUrl).host} answered ${String(res.status)}`);
  const j = (await res.json()) as unknown;
  const result = isObj(j) ? j['result'] : undefined;
  return isObj(result) && result['error'] === undefined ? result : null;
}

/** A contract view, JSON in and JSON out; `missing` when the contract has no such method (an older wasm), an error otherwise. */
export async function rpcView(rpcUrl: string, account: string, method: string, args: object = {}, fetchFn: Fetch = fetch): Promise<unknown> {
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'credit', method: 'query', params: { finality: 'final', request_type: 'call_function', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${new URL(rpcUrl).host} answered ${String(res.status)}`);
  const j = (await res.json()) as unknown;
  const result = isObj(j) ? j['result'] : undefined;
  if (isObj(result) && Array.isArray(result['result'])) return JSON.parse(Buffer.from(result['result'] as number[]).toString('utf8')) as unknown;
  const text = JSON.stringify(j).slice(0, 400);
  if (/MethodNotFound|MethodResolveError/.test(text)) throw new MissingMethod(method, account);
  throw new Error(`view ${method} on ${account} failed`);
}

/** The contract has no method of that name. */
export class MissingMethod extends Error {
  constructor(method: string, account: string) {
    super(`${account} has no method ${method}`);
    this.name = 'MissingMethod';
  }
}

const big = (v: unknown): bigint => (typeof v === 'string' && /^[0-9]+$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : 0n);

/** An account's balance and storage use; null when it does not exist. */
export async function rpcAccount(rpcUrl: string, id: string, fetchFn: Fetch = fetch): Promise<{ amount: bigint; storage: bigint } | null> {
  const r = await rpcQuery(rpcUrl, { request_type: 'view_account', account_id: id }, fetchFn);
  return r === null ? null : { amount: big(r['amount']), storage: big(r['storage_usage']) };
}

/** The public keys of an account with their permissions. */
export async function rpcKeys(rpcUrl: string, id: string, fetchFn: Fetch = fetch): Promise<{ publicKey: string; permission: unknown }[]> {
  const r = await rpcQuery(rpcUrl, { request_type: 'view_access_key_list', account_id: id }, fetchFn);
  if (r === null || !Array.isArray(r['keys'])) throw new Error(`the access key list of ${id} could not be read`);
  return r['keys'].flatMap((k) => (isObj(k) && typeof k['public_key'] === 'string' ? [{ publicKey: k['public_key'], permission: isObj(k['access_key']) ? k['access_key']['permission'] : undefined }] : []));
}

/** The time of the latest final block, in ms. */
export async function rpcBlockMs(rpcUrl: string, fetchFn: Fetch = fetch): Promise<number> {
  const res = await fetchFn(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'credit', method: 'block', params: { finality: 'final' } }), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(rpcUrl).host} answered ${String(res.status)}`);
  const j = (await res.json()) as unknown;
  const header = isObj(j) && isObj(j['result']) && isObj(j['result']['header']) ? j['result']['header'] : null;
  const ns = header === null ? undefined : header['timestamp_nanosec'];
  if (typeof ns !== 'string' || !/^[0-9]{10,25}$/.test(ns)) throw new Error('the block read answered something unexpected');
  return +String(BigInt(ns) / 1_000_000n);
}

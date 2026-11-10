// AIR-359: the public account faucet, called from the visitor's browser on their click (never by a script or a test: tests mock it). POST
// https://helper.testnet.near.org/account with exactly {newAccountId, newAccountPublicKey} makes a top-level account with 10 NEAR and the
// visitor's key as its full-access key (recorded 2026-11-10 05:33 UTC: HTTP 200 with the transaction outcome; x-ratelimit-limit 10 per 12 hours
// per internet address). The error shapes of a taken name, a 429 and a dry faucet were not observed: the mapping below is by status.

import { FAUCET } from '../../csp.ts';

export { FAUCET };
export const FAUCET_URL = `${FAUCET}/account`;

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export const LENDER_ID = /^lender-[a-z0-9]{10}\.testnet$/;

/** A fresh top-level name: `lender-` and 10 base36 characters. */
export function newLenderId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += B36.charAt((bytes[i] ?? 0) % 36);
  return `lender-${s}.testnet`;
}

export type FaucetAnswer = { kind: 'ok'; tx: string | null } | { kind: 'limited'; resetMs: number | null } | { kind: 'taken' } | { kind: 'retry' } | { kind: 'refused' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One request, mapped by status: 200 ok, 429 rate-limited (reset from `x-ratelimit-reset`, seconds), 5xx or a thrown fetch retry, a 4xx naming an existing account taken. */
export async function askFaucet(fetchFn: typeof fetch, accountId: string, publicKey: string): Promise<FaucetAnswer> {
  let res: Response;
  try {
    res = await fetchFn(FAUCET_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }) });
  } catch {
    return { kind: 'retry' };
  }
  if (res.status === 200) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const tx = isObj(body) && isObj(body['transaction']) ? body['transaction']['hash'] : undefined;
    return { kind: 'ok', tx: typeof tx === 'string' ? tx : null };
  }
  if (res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const seconds = reset !== null && /^[0-9]{9,11}(\.[0-9]+)?$/.test(reset) ? Math.floor(Number(reset)) : null;
    return { kind: 'limited', resetMs: seconds === null ? null : seconds * 1000 };
  }
  if (res.status >= 500) return { kind: 'retry' };
  const text = await res.text().catch(() => '');
  return /exist|taken|already/i.test(text) ? { kind: 'taken' } : { kind: 'refused' };
}

export type MadeAccount = { kind: 'ok'; accountId: string; tx: string | null } | { kind: 'limited'; resetMs: number | null } | { kind: 'unavailable' };

export type MakeDeps = { fetch: typeof fetch; newId?: () => string; sleep?: (ms: number) => Promise<void> };

/** Makes the visitor's account: a 5xx or network error is retried once after 3 s, a taken name gets a new one (2 names at most). */
export async function makeAccount(publicKey: string, deps: MakeDeps): Promise<MadeAccount> {
  const newId = deps.newId ?? (() => newLenderId());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let names = 1;
  let retried = false;
  let id = newId();
  for (;;) {
    const a = await askFaucet(deps.fetch, id, publicKey);
    if (a.kind === 'ok') return { kind: 'ok', accountId: id, tx: a.tx };
    if (a.kind === 'limited') return a;
    if (a.kind === 'retry' && !retried) {
      retried = true;
      await sleep(3_000);
      continue;
    }
    if (a.kind === 'taken' && names < 2) {
      names += 1;
      id = newId();
      continue;
    }
    return { kind: 'unavailable' };
  }
}

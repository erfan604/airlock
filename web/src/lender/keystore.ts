// AIR-359: the lender's key lives in this browser only (localStorage `airlock.lender.v1`) and in the restore link the visitor keeps:
// `/lend/#k=<base58 of the 64 secret bytes>&a=<account>`. The fragment never reaches a server; the page reads it, stores it and removes it from
// the address bar. A malformed fragment is refused, never half-used. The public half of the key is checked against its seed by chain/tx.ts.
import { base58Decode } from '../chain/tx.ts';

export const STORE_KEY = 'airlock.lender.v1';

export type Saved = { accountId: string; secretKey: string; createdMs: number; depositTx: string | null };

const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function secretBytesOk(secret: string): boolean {
  if (!secret.startsWith('ed25519:')) return false;
  try {
    return base58Decode(secret.slice('ed25519:'.length)).length === 64;
  } catch {
    return false;
  }
}

export function parseSaved(raw: unknown): Saved | null {
  if (!isObj(raw)) return null;
  const { accountId, secretKey, createdMs, depositTx } = raw;
  if (typeof accountId !== 'string' || !ACCOUNT.test(accountId) || typeof secretKey !== 'string' || !secretBytesOk(secretKey)) return null;
  if (typeof createdMs !== 'number' || !Number.isFinite(createdMs) || createdMs <= 0) return null;
  if (depositTx !== null && (typeof depositTx !== 'string' || !HASH.test(depositTx))) return null;
  return { accountId, secretKey, createdMs, depositTx };
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** The saved lender, or null (nothing saved, a damaged record, or storage that throws in a private window). */
export function loadSaved(store: Store | null): Saved | null {
  try {
    const text = store?.getItem(STORE_KEY);
    return text === null || text === undefined ? null : parseSaved(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** Keeps the lender; false when the browser refuses storage (the restore link is then the only copy, and the page says so). */
export function saveLender(store: Store | null, s: Saved): boolean {
  try {
    if (store === null) return false;
    store.setItem(STORE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** The restore link: the page's own address with the key and the account in the fragment. */
export function restoreLink(pageUrl: string, s: Pick<Saved, 'accountId' | 'secretKey'>): string {
  const k = s.secretKey.slice('ed25519:'.length);
  return `${pageUrl.split('#')[0] ?? pageUrl}#k=${k}&a=${encodeURIComponent(s.accountId)}`;
}

export type Fragment = { kind: 'none' } | { kind: 'bad' } | { kind: 'key'; accountId: string; secretKey: string };

/** Reads `#k=...&a=...`. No `k` is none; a `k` that is not 64 base58 bytes, or an account that is not a NEAR account name, is bad. */
export function parseFragment(hash: string): Fragment {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const k = params.get('k');
  if (k === null) return { kind: 'none' };
  const a = params.get('a');
  const secretKey = `ed25519:${k}`;
  if (a === null || !ACCOUNT.test(a) || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(k) || !secretBytesOk(secretKey)) return { kind: 'bad' };
  return { kind: 'key', accountId: a, secretKey };
}

/** Takes a restore fragment from the address: stores it when it is good, and always removes it from the address bar. */
export function consumeFragment(loc: { hash: string; pathname: string; search: string }, hist: { replaceState(data: unknown, unused: string, url: string): void }, store: Store | null, nowMs: number): Fragment {
  const f = parseFragment(loc.hash);
  if (f.kind === 'none') return f;
  hist.replaceState(null, '', `${loc.pathname}${loc.search}`);
  if (f.kind === 'key') {
    const prev = loadSaved(store);
    const keep = prev !== null && prev.accountId === f.accountId && prev.secretKey === f.secretKey;
    saveLender(store, keep ? prev : { accountId: f.accountId, secretKey: f.secretKey, createdMs: nowMs, depositTx: null });
  }
  return f;
}


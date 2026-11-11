// AIR-359: the lender's key lives in this browser only (localStorage `airlock.lender.v1`) and in the restore link the visitor keeps:
// `/lend/#k=<base58 of the 64 secret bytes>&a=<account>`. The fragment never reaches a server; the page reads it, stores it and removes it from
// the address bar. A malformed fragment is refused, never half-used. A good one is checked on chain (its key must be an access key of the account
// it names) and, when it names another account than the saved one, waits for the visitor to choose; the record switched away from is kept.
import { base58Decode, keyFromSecret, readAccessKey } from '../chain/tx.ts';
import { RpcError } from '../chain/rpc.ts';
import type { RpcConfig } from '../chain/rpc.ts';

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

/** Takes a restore fragment out of the address bar (always, good or bad) and returns it. Nothing is stored here: a link is checked on chain first,
 * and one that is not the saved record waits for the visitor's choice (security review of AIR-359). */
export function takeFragment(loc: { hash: string; pathname: string; search: string }, hist: { replaceState(data: unknown, unused: string, url: string): void }): Fragment {
  const f = parseFragment(loc.hash);
  if (f.kind !== 'none') hist.replaceState(null, '', `${loc.pathname}${loc.search}`);
  return f;
}

export type Link = { accountId: string; secretKey: string };

/** `new`: nothing is saved; `same`: the link is the saved record; `differs`: another account or another key. The page asks the visitor before
 * it takes a `new` or a `differs` link. */
export function decideLink(saved: Saved | null, link: Link): 'new' | 'same' | 'differs' {
  if (saved === null) return 'new';
  return saved.accountId === link.accountId && saved.secretKey === link.secretKey ? 'same' : 'differs';
}

export const BACKUP_KEY = 'airlock.lender.v1.backups';
const MAX_BACKUPS = 5;

/** The records the visitor switched away from, newest first. */
export function loadBackups(store: Store | null): Saved[] {
  try {
    const text = store?.getItem(BACKUP_KEY);
    const raw = text === null || text === undefined ? [] : (JSON.parse(text) as unknown);
    return Array.isArray(raw) ? raw.map(parseSaved).filter((x): x is Saved => x !== null) : [];
  } catch {
    return [];
  }
}

function saveBackups(store: Store | null, list: readonly Saved[]): void {
  try {
    store?.setItem(BACKUP_KEY, JSON.stringify(list.slice(0, MAX_BACKUPS)));
  } catch {
    // storage refused: the restore links are then the only copies, as for the main record
  }
}

/** Makes a checked link the current record. A different saved record is kept first as a backup; the same link again changes nothing. */
export function adoptLink(store: Store | null, link: Link, nowMs: number): Saved | null {
  const prev = loadSaved(store);
  if (prev !== null && decideLink(prev, link) === 'same') return prev;
  if (prev !== null) saveBackups(store, [prev, ...loadBackups(store).filter((b) => b.accountId !== prev.accountId || b.secretKey !== prev.secretKey)]);
  const next: Saved = { accountId: link.accountId, secretKey: link.secretKey, createdMs: nowMs, depositTx: null };
  return saveLender(store, next) ? next : null;
}

/** Switches back to a backup record; the current one becomes a backup. null when there is no such backup. */
export function switchTo(store: Store | null, accountId: string): Saved | null {
  const list = loadBackups(store);
  const target = list.find((b) => b.accountId === accountId);
  if (target === undefined) return null;
  const cur = loadSaved(store);
  const rest = list.filter((b) => b !== target);
  saveBackups(store, cur === null ? rest : [cur, ...rest]);
  return saveLender(store, target) ? target : null;
}

/** Whether the public key of the link's secret is an access key of the account it names, read with view_access_key. */
export async function verifyLinkKey(rpc: RpcConfig, link: Link): Promise<'ok' | 'not-a-key' | 'unreadable'> {
  let pub: string;
  try {
    pub = (await keyFromSecret(link.secretKey)).publicKeyText;
  } catch {
    return 'not-a-key';
  }
  try {
    await readAccessKey(rpc, link.accountId, pub);
    return 'ok';
  } catch (e) {
    return e instanceof RpcError ? 'not-a-key' : 'unreadable';
  }
}

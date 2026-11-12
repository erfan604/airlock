// The lock of 2026-11-12 UTC: the credit pool and the credit card hold no access key, so no transaction can be signed for either account
// and neither contract can be redeployed.
//   pnpm tsx scripts/credit-lock-check.ts --verify     reads the chain, no keys
//   pnpm tsx scripts/credit-lock-check.ts --offline    the committed snapshots only, no network
// Offline: for each account the two committed snapshots around its key deletion (docs/evidence/lock-*.json): one full-access key before
// and none after, the same code hash, raw state hash, entry count and view answers, blocks on each side of the deletion. Verify adds the
// chain: each account's access key list now (empty), its code hash now, its deletion transaction (sent by the account to itself, signed
// by the key it deletes, exactly one DeleteKey action of that key, success, in the recorded block), and that the owner named in both
// contracts' state, the issuer, still holds a full-access key (its owner methods stay).
// Last line: LOCK VERIFY OK <n> accounts hold no access key (or LOCK OFFLINE OK), or LOCK VERIFY NO (<n> failed) and exit 1.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWNER = 'airlock-credit-c1108d.testnet';
export type Locked = { account: string; code: string; key: string; tx: string; block: number; before: string; after: string };
export const LOCKED: readonly Locked[] = [
  { account: 'pool.airlock-credit-c1108d.testnet', code: '5DEnqxwBiVwsxuXNzYeE3a9P4DLYuSj2pjnQKvY88xyN', key: 'ed25519:2An6c6PmaryEhZS3yYPpKoxaGozUT49ktCUnGujKFnXU', tx: '3d8CupXr6kVZaEhQuwb36u94hHPH5VPCwRHopy6jRAoU', block: 277315728, before: 'docs/evidence/lock-pool-before.json', after: 'docs/evidence/lock-pool-after.json' },
  { account: 'card.airlock-credit-c1108d.testnet', code: '79BH9QUuWjxt4SggfgD66maVb7m2ckg5HHq3aB5pKGX7', key: 'ed25519:B2ene5PPtj7PU4ZRS2CV5pFU3xD5yvdMaoEpKRGAtjor', tx: '3Jj1qMjQx7ztS8n3DKzd9EKuQmpbc3PynSWtSx9vqHMG', block: 277315738, before: 'docs/evidence/lock-card-before.json', after: 'docs/evidence/lock-card-after.json' },
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** One account's two snapshots around its key deletion. */
export function checkLockSnapshots(l: Locked, before: unknown, after: unknown): string[] {
  const f: string[] = [];
  if (!isObj(before) || !isObj(after)) return [`${l.account}: a snapshot is not an object`];
  const kb = before['keys'];
  const ka = after['keys'];
  if (!Array.isArray(kb) || kb.length !== 1 || !String(kb[0]).startsWith('FullAccess')) f.push(`${l.account}: the snapshot before does not hold exactly one full-access key`);
  if (!Array.isArray(ka) || ka.length !== 0) f.push(`${l.account}: the snapshot after holds an access key`);
  if (before['code_hash'] !== l.code || after['code_hash'] !== l.code) f.push(`${l.account}: a snapshot runs another code hash than ${l.code}`);
  if (typeof before['state_sha256'] !== 'string' || before['state_sha256'] !== after['state_sha256']) f.push(`${l.account}: the raw state hash changed`);
  if (before['state_entries'] !== after['state_entries']) f.push(`${l.account}: the number of state entries changed`);
  if (canon(before['views']) !== canon(after['views'])) f.push(`${l.account}: a view answer changed`);
  const hb = before['block_height'];
  const ha = after['block_height'];
  if (typeof hb !== 'number' || typeof ha !== 'number' || !(hb < l.block && l.block < ha)) f.push(`${l.account}: the snapshots do not bracket block ${String(l.block)}`);
  return f;
}

/** A transaction as EXPERIMENTAL_tx_status returns it, reduced to what the check reads. */
export type DeleteTx = { signer: string; receiver: string; publicKey: string; actions: unknown[]; status: unknown; blockHash: string };

/** The deletion: the account to itself, signed by the key it deletes, exactly one DeleteKey action of that key, success. */
export function checkDelete(l: Locked, tx: DeleteTx): string[] {
  const f: string[] = [];
  if (tx.signer !== l.account || tx.receiver !== l.account) f.push(`${l.tx}: sent by ${tx.signer} to ${tx.receiver}, not by ${l.account} to itself`);
  if (tx.publicKey !== l.key) f.push(`${l.tx}: signed with ${tx.publicKey}, not the deleted key ${l.key}`);
  const a = tx.actions[0];
  if (tx.actions.length !== 1 || !isObj(a) || !isObj(a['DeleteKey']) || a['DeleteKey']['public_key'] !== l.key) f.push(`${l.tx}: not exactly one DeleteKey action of ${l.key}`);
  if (!(isObj(tx.status) && 'SuccessValue' in tx.status)) f.push(`${l.tx}: the deletion did not succeed`);
  return f;
}

export type Deps = {
  log: (s: string) => void;
  read: (path: string) => Uint8Array;
  keys: (account: string) => Promise<{ publicKey: string; fullAccess: boolean }[]>;
  code: (account: string) => Promise<string>;
  tx: (hash: string, sender: string) => Promise<DeleteTx>;
  blockHeight: (blockHash: string) => Promise<number>;
};

export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const online = argv.includes('--verify');
  if (!online && !argv.includes('--offline')) {
    deps.log('usage: credit-lock-check.ts --verify | --offline');
    return 2;
  }
  const fails: string[] = [];
  const parse = (p: string): unknown => JSON.parse(Buffer.from(deps.read(p)).toString('utf8')) as unknown;
  for (const l of LOCKED) {
    const snap = checkLockSnapshots(l, parse(l.before), parse(l.after));
    fails.push(...snap);
    if (snap.length === 0) deps.log(`SNAPSHOTS ${l.account}: one full-access key before, none after; same code, raw state and views`);
  }
  if (online) {
    for (const l of LOCKED) {
      const keys = await deps.keys(l.account);
      deps.log(`CHAIN ${l.account} access keys ${String(keys.length)}`);
      if (keys.length !== 0) fails.push(`${l.account} holds ${String(keys.length)} access key(s): ${keys.map((k) => k.publicKey).join(', ')}`);
      const code = await deps.code(l.account);
      deps.log(`CHAIN ${l.account} code hash ${code}`);
      if (code !== l.code) fails.push(`${l.account} runs ${code}, not ${l.code}`);
      const t = await deps.tx(l.tx, l.account);
      const df = checkDelete(l, t);
      const h = await deps.blockHeight(t.blockHash);
      if (h !== l.block) df.push(`${l.tx}: in block ${String(h)}, not ${String(l.block)}`);
      fails.push(...df);
      if (df.length === 0) deps.log(`DELETE ${l.tx} block ${String(h)}: ${l.account} deleted its own key ${l.key}`);
    }
    const owner = await deps.keys(OWNER);
    deps.log(`CHAIN ${OWNER} (the owner in both contracts) full-access keys ${String(owner.filter((k) => k.fullAccess).length)}`);
    if (!owner.some((k) => k.fullAccess)) fails.push(`${OWNER} holds no full-access key: the owner methods could not be called`);
  }
  for (const x of fails) deps.log(`FAIL ${x}`);
  const word = online ? 'VERIFY' : 'OFFLINE';
  if (fails.length > 0) {
    deps.log(`LOCK ${word} NO (${String(fails.length)} failed)`);
    return 1;
  }
  deps.log(online ? `LOCK VERIFY OK ${String(LOCKED.length)} accounts hold no access key` : 'LOCK OFFLINE OK');
  return 0;
}

// ---- the real dependencies ----

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const ARCHIVAL = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];

async function rpc(urls: readonly string[], method: string, params: unknown): Promise<unknown> {
  let last = '';
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      const j = (await r.json()) as { result?: unknown; error?: unknown };
      if (j.error === undefined) return j.result;
      last = JSON.stringify(j.error).slice(0, 200);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`${method} failed: ${last}`);
}

function realDeps(): Deps {
  return {
    log: (s) => console.log(s),
    read: (p) => readFileSync(join(REPO, p)),
    keys: async (account) => {
      const r = await rpc(RPCS, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: account });
      if (!isObj(r) || !Array.isArray(r['keys'])) throw new Error(`view_access_key_list of ${account}: unexpected answer`);
      return r['keys'].map((k) => ({
        publicKey: isObj(k) ? String(k['public_key']) : '?',
        fullAccess: isObj(k) && isObj(k['access_key']) && k['access_key']['permission'] === 'FullAccess',
      }));
    },
    code: async (account) => {
      const r = await rpc(RPCS, 'query', { request_type: 'view_account', finality: 'final', account_id: account });
      if (!isObj(r) || typeof r['code_hash'] !== 'string') throw new Error('view_account: no code_hash');
      return r['code_hash'];
    },
    tx: async (hash, sender) => {
      const r = await rpc(ARCHIVAL, 'EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' });
      if (!isObj(r) || !isObj(r['transaction']) || !isObj(r['transaction_outcome'])) throw new Error(`${hash}: unexpected answer`);
      const t = r['transaction'];
      return {
        signer: String(t['signer_id']),
        receiver: String(t['receiver_id']),
        publicKey: String(t['public_key']),
        actions: Array.isArray(t['actions']) ? (t['actions'] as unknown[]) : [],
        status: r['status'],
        blockHash: String(r['transaction_outcome']['block_hash']),
      };
    },
    blockHeight: async (blockHash) => {
      const r = await rpc(ARCHIVAL, 'block', { block_id: blockHash });
      const h = isObj(r) && isObj(r['header']) ? r['header']['height'] : undefined;
      if (typeof h !== 'number') throw new Error('block: no height');
      return h;
    },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2), realDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`LOCK FAILED ${e instanceof Error ? e.message.slice(0, 400) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

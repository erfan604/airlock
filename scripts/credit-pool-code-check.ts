// The live credit pool runs the committed bytes, and a lender pays for its own storage (redeploy and storage run of 2026-11-11).
//   pnpm tsx scripts/credit-pool-code-check.ts --verify     reads the chain, no keys
//   pnpm tsx scripts/credit-pool-code-check.ts --offline    the committed files only, no network
// Offline: the sha256 of contracts/airlock-credit/res/airlock_credit_v2.wasm and of the pinned earlier bytes, both in base58 (a NEAR code
// hash is the base58 of the sha256 of the wasm), and the two committed snapshots of the pool around the redeploy (docs/evidence): the
// same raw state hash and the same view answers, code hashes equal to the two files, storage_usage up by exactly the size difference.
// Verify adds the chain: the pool's code hash now (view_account), the redeploy transaction (one DeployContract action whose code hash is
// the committed file's sha256, nothing else, sent by the pool to itself) and the three transactions of the storage run.
// Last line: POOL CODE VERIFY OK <code hash> (or POOL CODE OFFLINE OK), or POOL CODE VERIFY NO (<n> failed) and exit 1.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POOL = 'pool.airlock-credit-c1108d.testnet';
export const LP = 'lp3.airlock-credit-c1108d.testnet';
export const WASM = 'contracts/airlock-credit/res/airlock_credit_v2.wasm';
export const OLD_WASM = 'contracts/airlock-credit/res/airlock_credit_v2_e754b6aa.wasm';
export const BEFORE = 'docs/evidence/pool-redeploy-before.json';
export const AFTER = 'docs/evidence/pool-redeploy-after.json';
export const REDEPLOY_TX = 'GChCfQ8eUoKkVjT5oLgBkmkL754NyZqGWeSNwWCTXHxq';
export const REDEPLOY_BLOCK = 277253469;
export const REFUSED_TX = 'AC3T5NXnAWQ796wDFGfg4QVtkHhrJNAiVaAShpHB3nnn';
export const DEPOSIT_TX = '5EKouAqzseLiaDNin9jxMyrJvQ6wyio4PcmPNwZoc2Lb';
export const WITHDRAW_TX = 'Db7zDeaAsNcDKTarLsHQL7VM5RAqUTjgSM4icvQUzGXA';
export const REFUSAL_TEXT = "a first deposit needs at least 0.0035 NEAR: 0.0025 NEAR pays for your entry in the pool's storage";
/** what the storage run attached and what the pool's events said */
export const RUN = {
  refusedDeposit: '3000000000000000000000', // 0.003 NEAR
  deposit: '102500000000000000000000', // 0.1025 NEAR
  credited: '100000000000000000000000', // 0.1 NEAR
  storage: '2500000000000000000000', // LP_STORAGE, 0.0025 NEAR
  shares: '90210499963492817960916',
  paidOut: '99999999999999999999999',
} as const;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (the Bitcoin alphabet NEAR uses) of bytes. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = `${B58[Number(n % 58n)] ?? ''}${out}`;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The NEAR code hash of wasm bytes: base58 of their sha256. */
export function codeHash(wasm: Uint8Array): { sha256: string; base58: string; base64: string } {
  const d = createHash('sha256').update(wasm).digest();
  return { sha256: d.toString('hex'), base58: base58(d), base64: d.toString('base64') };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stable JSON for comparing view answers. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The two snapshots around the redeploy: what must hold between them. */
export function checkSnapshots(before: unknown, after: unknown, oldHash: string, newHash: string, sizeDelta: number): string[] {
  const f: string[] = [];
  if (!isObj(before) || !isObj(after)) return ['a snapshot is not an object'];
  if (before['code_hash'] !== oldHash) f.push(`the snapshot before runs ${String(before['code_hash'])}, not ${oldHash}`);
  if (after['code_hash'] !== newHash) f.push(`the snapshot after runs ${String(after['code_hash'])}, not ${newHash}`);
  if (typeof before['state_sha256'] !== 'string' || before['state_sha256'] !== after['state_sha256']) f.push('the raw state hash changed');
  if (before['state_entries'] !== after['state_entries']) f.push('the number of state entries changed');
  if (canon(before['views']) !== canon(after['views'])) f.push('a view answer changed');
  const sb = before['storage_usage'];
  const sa = after['storage_usage'];
  if (typeof sb !== 'number' || typeof sa !== 'number' || sa - sb !== sizeDelta) f.push(`storage_usage moved ${String(Number(sa) - Number(sb))} bytes, not the ${String(sizeDelta)} bytes the wasm grew`);
  const hb = before['block_height'];
  const ha = after['block_height'];
  if (typeof hb !== 'number' || typeof ha !== 'number' || !(hb < REDEPLOY_BLOCK && REDEPLOY_BLOCK < ha)) f.push(`the snapshots do not bracket block ${String(REDEPLOY_BLOCK)}`);
  return f;
}

/** A transaction as EXPERIMENTAL_tx_status returns it, reduced to what the checks read. */
export type Tx = { signer: string; receiver: string; actions: unknown[]; status: unknown; logs: string[]; blockHash: string };

export function events(tx: Tx, name: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of tx.logs) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    try {
      const e = JSON.parse(l.slice('EVENT_JSON:'.length)) as { event?: unknown; data?: unknown };
      const d = Array.isArray(e.data) ? (e.data[0] as unknown) : e.data;
      if (e.event === name && isObj(d)) out.push(d);
    } catch {
      // not an event of the pool
    }
  }
  return out;
}

const succeeded = (tx: Tx): boolean => isObj(tx.status) && 'SuccessValue' in tx.status;
const call = (tx: Tx): Record<string, unknown> | undefined => {
  const a = tx.actions[0];
  return tx.actions.length === 1 && isObj(a) && isObj(a['FunctionCall']) ? a['FunctionCall'] : undefined;
};
const argsOf = (fc: Record<string, unknown>): unknown => {
  try {
    return JSON.parse(Buffer.from(String(fc['args'] ?? ''), 'base64').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
};

/** The redeploy: the pool to itself, exactly one DeployContract action whose code hash is `codeBase64`, success. */
export function checkRedeploy(tx: Tx, codeBase64: string): string[] {
  const f: string[] = [];
  if (tx.signer !== POOL || tx.receiver !== POOL) f.push(`the redeploy was sent by ${tx.signer} to ${tx.receiver}, not by the pool to itself`);
  const a = tx.actions[0];
  if (tx.actions.length !== 1 || !isObj(a) || !isObj(a['DeployContract'])) f.push('the redeploy is not exactly one DeployContract action (an init or migrate call would be a second action)');
  else if (a['DeployContract']['code'] !== codeBase64) f.push(`the deployed code hash ${String(a['DeployContract']['code'])} is not the committed wasm's ${codeBase64}`);
  if (!succeeded(tx)) f.push('the redeploy did not succeed');
  return f;
}

/** The three transactions of the storage run, by the new lender to the pool. */
export function checkStorageRun(refused: Tx, deposit: Tx, withdraw: Tx): string[] {
  const f: string[] = [];
  for (const [n, t] of [['refused deposit', refused], ['deposit', deposit], ['withdraw', withdraw]] as const) {
    if (t.signer !== LP || t.receiver !== POOL) f.push(`the ${n} was sent by ${t.signer} to ${t.receiver}, not by ${LP} to the pool`);
  }
  const r = call(refused);
  if (r?.['method_name'] !== 'deposit' || r['deposit'] !== RUN.refusedDeposit) f.push('the refused transaction is not a deposit of 0.003 NEAR');
  if (succeeded(refused) || !JSON.stringify(refused.status).includes(REFUSAL_TEXT)) f.push('the 0.003 NEAR deposit was not refused with the storage text');
  const d = call(deposit);
  if (d?.['method_name'] !== 'deposit' || d['deposit'] !== RUN.deposit) f.push('the deposit is not 0.1025 NEAR');
  if (!succeeded(deposit)) f.push('the deposit did not succeed');
  const de = events(deposit, 'deposit')[0];
  if (de?.['account'] !== LP || de['amount'] !== RUN.credited || de['storage'] !== RUN.storage || de['shares'] !== RUN.shares) {
    f.push(`the deposit event is not 0.1 NEAR credited, 0.0025 NEAR of storage and ${RUN.shares} shares: ${JSON.stringify(de ?? null)}`);
  }
  const w = call(withdraw);
  const wa = w === undefined ? undefined : argsOf(w);
  if (w?.['method_name'] !== 'withdraw' || !isObj(wa) || wa['shares'] !== RUN.shares) f.push('the withdraw is not of every share the deposit bought');
  if (!succeeded(withdraw)) f.push('the withdraw did not succeed');
  const we = events(withdraw, 'withdraw')[0];
  if (we?.['account'] !== LP || we['amount'] !== RUN.paidOut || we['shares'] !== RUN.shares) f.push(`the withdraw event is not ${RUN.paidOut} yocto for ${RUN.shares} shares: ${JSON.stringify(we ?? null)}`);
  return f;
}

export type Deps = {
  log: (s: string) => void;
  read: (path: string) => Uint8Array;
  size: (path: string) => number;
  /** view_account of the pool now */
  poolCode: () => Promise<string>;
  tx: (hash: string, sender: string) => Promise<Tx>;
  blockHeight: (blockHash: string) => Promise<number>;
};

export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const online = argv.includes('--verify');
  if (!online && !argv.includes('--offline')) {
    deps.log('usage: credit-pool-code-check.ts --verify | --offline');
    return 2;
  }
  const fails: string[] = [];
  const now = codeHash(deps.read(WASM));
  const old = codeHash(deps.read(OLD_WASM));
  deps.log(`FILE ${WASM} sha256 ${now.sha256} code hash ${now.base58}`);
  deps.log(`FILE ${OLD_WASM} sha256 ${old.sha256} code hash ${old.base58}`);
  const delta = deps.size(WASM) - deps.size(OLD_WASM);
  const parse = (p: string): unknown => JSON.parse(Buffer.from(deps.read(p)).toString('utf8')) as unknown;
  const snap = checkSnapshots(parse(BEFORE), parse(AFTER), old.base58, now.base58, delta);
  fails.push(...snap);
  if (snap.length === 0) deps.log(`SNAPSHOTS same raw state and views before and after the redeploy; storage_usage up ${String(delta)} bytes, the size difference of the two wasm files`);

  if (online) {
    const live = await deps.poolCode();
    deps.log(`CHAIN ${POOL} code hash ${live}`);
    if (live !== now.base58) fails.push(`the pool runs ${live}, not the committed ${WASM} (${now.base58})`);
    const rd = await deps.tx(REDEPLOY_TX, POOL);
    const rf = checkRedeploy(rd, now.base64);
    const h = await deps.blockHeight(rd.blockHash);
    if (h !== REDEPLOY_BLOCK) rf.push(`the redeploy is in block ${String(h)}, not ${String(REDEPLOY_BLOCK)}`);
    fails.push(...rf);
    if (rf.length === 0) deps.log(`REDEPLOY ${REDEPLOY_TX} block ${String(h)}: one DeployContract action of the committed wasm, no function call`);
    const [a, b, c] = await Promise.all([deps.tx(REFUSED_TX, LP), deps.tx(DEPOSIT_TX, LP), deps.tx(WITHDRAW_TX, LP)]);
    const sr = checkStorageRun(a, b, c);
    fails.push(...sr);
    if (sr.length === 0) {
      deps.log(`STORAGE RUN ${REFUSED_TX}: 0.003 NEAR refused (${REFUSAL_TEXT})`);
      deps.log(`STORAGE RUN ${DEPOSIT_TX}: 0.1025 NEAR attached, 0.1 NEAR credited, 0.0025 NEAR storage, ${RUN.shares} shares`);
      deps.log(`STORAGE RUN ${WITHDRAW_TX}: all ${RUN.shares} shares withdrawn for ${RUN.paidOut} yocto`);
    }
  }
  for (const x of fails) deps.log(`FAIL ${x}`);
  const word = online ? 'VERIFY' : 'OFFLINE';
  if (fails.length > 0) {
    deps.log(`POOL CODE ${word} NO (${String(fails.length)} failed)`);
    return 1;
  }
  deps.log(online ? `POOL CODE VERIFY OK ${now.base58}` : 'POOL CODE OFFLINE OK');
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
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
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
    size: (p) => statSync(join(REPO, p)).size,
    poolCode: async () => {
      const r = await rpc(RPCS, 'query', { request_type: 'view_account', finality: 'final', account_id: POOL });
      if (!isObj(r) || typeof r['code_hash'] !== 'string') throw new Error('view_account: no code_hash');
      return r['code_hash'];
    },
    tx: async (hash, sender) => {
      const r = await rpc(ARCHIVAL, 'EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' });
      if (!isObj(r) || !isObj(r['transaction']) || !isObj(r['transaction_outcome'])) throw new Error(`${hash}: unexpected answer`);
      const t = r['transaction'];
      const logs: string[] = [];
      for (const ro of Array.isArray(r['receipts_outcome']) ? (r['receipts_outcome'] as unknown[]) : []) {
        const o = isObj(ro) && isObj(ro['outcome']) ? ro['outcome'] : undefined;
        for (const l of Array.isArray(o?.['logs']) ? (o['logs'] as unknown[]) : []) if (typeof l === 'string') logs.push(l);
      }
      return {
        signer: String(t['signer_id']),
        receiver: String(t['receiver_id']),
        actions: Array.isArray(t['actions']) ? (t['actions'] as unknown[]) : [],
        status: r['status'],
        logs,
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
      console.log(`POOL CODE FAILED ${e instanceof Error ? e.message.slice(0, 400) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

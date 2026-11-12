// The two live cards run the committed bytes (the code-only redeploy with the approver bounds, 2026-11-12 UTC).
//   pnpm tsx scripts/credit-card-code-check.ts --verify     reads the chain, no keys
//   pnpm tsx scripts/credit-card-code-check.ts --offline    the committed files only, no network
// Offline: the code hash (base58 of the sha256) of contracts/airlock-policy/res/airlock_policy.wasm and of the pinned earlier bytes
// res/airlock_policy_6FCZRf51.wasm, and for each card the two committed snapshots around its redeploy (docs/evidence): the same raw state
// hash and entry count, the same view answers and key kinds, the code hashes of the two files, storage_usage up by exactly the size
// difference, and blocks on each side of the redeploy. Verify adds the chain: each card's code hash now (view_account) and its redeploy
// transaction (sent by the card to itself, exactly one DeployContract action whose code hash is the committed file's, success, in the
// recorded block). Last line: CARD CODE VERIFY OK <code hash> (or CARD CODE OFFLINE OK), or CARD CODE VERIFY NO (<n> failed) and exit 1.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeHash } from './credit-pool-code-check.ts';
import type { Tx } from './credit-pool-code-check.ts';

export const WASM = 'contracts/airlock-policy/res/airlock_policy.wasm';
export const OLD_WASM = 'contracts/airlock-policy/res/airlock_policy_6FCZRf51.wasm';
export const NEW_HASH = '79BH9QUuWjxt4SggfgD66maVb7m2ckg5HHq3aB5pKGX7';
export const OLD_HASH = '6FCZRf51teMBxkLb2V5sc5bpLXDWws9RZgT3ERaUowTg';

export type Card = { account: string; before: string; after: string; tx: string; block: number };
export const CARDS: readonly Card[] = [
  { account: 'card.airlock-credit-c1108d.testnet', before: 'docs/evidence/card-redeploy-before.json', after: 'docs/evidence/card-redeploy-after.json', tx: '29FeqZ56VFFKQD3SyZga5ahpVbgRgfR2rpWRBner6ZZM', block: 277286362 },
  { account: 'try.airlock-try-b193fe.testnet', before: 'docs/evidence/try-redeploy-before.json', after: 'docs/evidence/try-redeploy-after.json', tx: '5Ku4XaCa2Wc521MEb5su4LfZ99jpLSC5oAjdaczLsSip', block: 277286792 },
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** One card's two snapshots around its redeploy: what must hold between them. */
export function checkCardSnapshots(c: Card, before: unknown, after: unknown, sizeDelta: number): string[] {
  const f: string[] = [];
  if (!isObj(before) || !isObj(after)) return [`${c.account}: a snapshot is not an object`];
  if (before['account'] !== c.account || after['account'] !== c.account) f.push(`${c.account}: a snapshot is of another account`);
  if (before['code_hash'] !== OLD_HASH) f.push(`${c.account}: the snapshot before runs ${String(before['code_hash'])}, not ${OLD_HASH}`);
  if (after['code_hash'] !== NEW_HASH) f.push(`${c.account}: the snapshot after runs ${String(after['code_hash'])}, not ${NEW_HASH}`);
  if (typeof before['state_sha256'] !== 'string' || before['state_sha256'] !== after['state_sha256']) f.push(`${c.account}: the raw state hash changed`);
  if (before['state_entries'] !== after['state_entries']) f.push(`${c.account}: the number of state entries changed`);
  if (canon(before['views']) !== canon(after['views'])) f.push(`${c.account}: a view answer changed`);
  if (canon(before['keys']) !== canon(after['keys'])) f.push(`${c.account}: the access key kinds changed`);
  const sb = before['storage_usage'];
  const sa = after['storage_usage'];
  if (typeof sb !== 'number' || typeof sa !== 'number' || sa - sb !== sizeDelta) f.push(`${c.account}: storage_usage moved ${String(Number(sa) - Number(sb))} bytes, not the ${String(sizeDelta)} bytes the wasm grew`);
  const hb = before['block_height'];
  const ha = after['block_height'];
  if (typeof hb !== 'number' || typeof ha !== 'number' || !(hb < c.block && c.block < ha)) f.push(`${c.account}: the snapshots do not bracket block ${String(c.block)}`);
  return f;
}

/** A card's redeploy: the card to itself, exactly one DeployContract action whose code hash is `codeBase64`, success. */
export function checkCardRedeploy(c: Card, tx: Tx, codeBase64: string): string[] {
  const f: string[] = [];
  if (tx.signer !== c.account || tx.receiver !== c.account) f.push(`${c.tx}: sent by ${tx.signer} to ${tx.receiver}, not by ${c.account} to itself`);
  const a = tx.actions[0];
  if (tx.actions.length !== 1 || !isObj(a) || !isObj(a['DeployContract'])) f.push(`${c.tx}: not exactly one DeployContract action (an init or migrate call would be a second action)`);
  else if (a['DeployContract']['code'] !== codeBase64) f.push(`${c.tx}: the deployed code hash ${String(a['DeployContract']['code'])} is not the committed wasm's ${codeBase64}`);
  if (!(isObj(tx.status) && 'SuccessValue' in tx.status)) f.push(`${c.tx}: the redeploy did not succeed`);
  return f;
}

export type Deps = {
  log: (s: string) => void;
  read: (path: string) => Uint8Array;
  size: (path: string) => number;
  /** view_account of an account now */
  code: (account: string) => Promise<string>;
  tx: (hash: string, sender: string) => Promise<Tx>;
  blockHeight: (blockHash: string) => Promise<number>;
};

export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const online = argv.includes('--verify');
  if (!online && !argv.includes('--offline')) {
    deps.log('usage: credit-card-code-check.ts --verify | --offline');
    return 2;
  }
  const fails: string[] = [];
  const now = codeHash(deps.read(WASM));
  const old = codeHash(deps.read(OLD_WASM));
  deps.log(`FILE ${WASM} sha256 ${now.sha256} code hash ${now.base58}`);
  deps.log(`FILE ${OLD_WASM} sha256 ${old.sha256} code hash ${old.base58}`);
  if (now.base58 !== NEW_HASH) fails.push(`${WASM} hashes to ${now.base58}, not ${NEW_HASH}`);
  if (old.base58 !== OLD_HASH) fails.push(`${OLD_WASM} hashes to ${old.base58}, not ${OLD_HASH}`);
  const delta = deps.size(WASM) - deps.size(OLD_WASM);
  const parse = (p: string): unknown => JSON.parse(Buffer.from(deps.read(p)).toString('utf8')) as unknown;
  for (const c of CARDS) {
    const snap = checkCardSnapshots(c, parse(c.before), parse(c.after), delta);
    fails.push(...snap);
    if (snap.length === 0) deps.log(`SNAPSHOTS ${c.account}: same raw state, keys and views before and after; storage_usage up ${String(delta)} bytes, the size difference of the two wasm files`);
  }
  if (online) {
    for (const c of CARDS) {
      const live = await deps.code(c.account);
      deps.log(`CHAIN ${c.account} code hash ${live}`);
      if (live !== now.base58) fails.push(`${c.account} runs ${live}, not the committed ${WASM} (${now.base58})`);
      const t = await deps.tx(c.tx, c.account);
      const rf = checkCardRedeploy(c, t, now.base64);
      const h = await deps.blockHeight(t.blockHash);
      if (h !== c.block) rf.push(`${c.tx}: in block ${String(h)}, not ${String(c.block)}`);
      fails.push(...rf);
      if (rf.length === 0) deps.log(`REDEPLOY ${c.tx} block ${String(h)}: one DeployContract action of the committed wasm on ${c.account}, no function call`);
    }
  }
  for (const x of fails) deps.log(`FAIL ${x}`);
  const word = online ? 'VERIFY' : 'OFFLINE';
  if (fails.length > 0) {
    deps.log(`CARD CODE ${word} NO (${String(fails.length)} failed)`);
    return 1;
  }
  deps.log(online ? `CARD CODE VERIFY OK ${now.base58}` : 'CARD CODE OFFLINE OK');
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
    size: (p) => statSync(join(REPO, p)).size,
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
        actions: Array.isArray(t['actions']) ? (t['actions'] as unknown[]) : [],
        status: r['status'],
        logs: [],
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
      console.log(`CARD CODE FAILED ${e instanceof Error ? e.message.slice(0, 400) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

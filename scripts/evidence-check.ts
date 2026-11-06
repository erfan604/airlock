// AIR-243: checks docs/EVIDENCE.md against the chain and the repo.
// Usage: node scripts/evidence-check.ts [--root <repo root>]          (pnpm tsx works too; erasable TypeScript, standard library only)
//        node scripts/evidence-check.ts --video-links <file>          offline: every explorer URL in <file> (a path relative to the
//                                                                     current directory) must be in docs/EVIDENCE.md
//        node scripts/evidence-check.ts --selftest                    flips one character of a hash in memory, needs no tree, no network
// Prints one `PASS <what>`, `WARN <what>: <reason>` or `FAIL <what>: <reason>` per item and, last, `EVIDENCE OK <n> links checked`
// (n counts the distinct testnet.nearblocks.io/txns and sepolia.basescan.org/tx links) or `EVIDENCE FAILED <k> failures, <n> links
// checked`. Exit 0 clean (WARN does not fail), 1 on any FAIL, 2 on a missing input or a usage error (`INPUT MISSING <path>`).
//
// What it checks, in order:
//  1. The nine headings of acceptance check 6 (`## Deployed ids and hashes`, `## Real MPC (AIR-102)`, `## Testnet end to end (AIR-165)`,
//     `## Golden runs (AIR-166)`, `## Wallet matrix`, `## Toolchain`, `## Differential`, `## Video links`, `## Model choice`),
//     `## Model choice` the last `## ` heading with exactly one
//     `planner model: `, `quarantine model: ` and `vanilla models: ` line below it and no `%` below it, no line with `TODO` or
//     `To fill during the build`.
//  2. Rows found by their exact first cell: the seven of `## Deployed ids and hashes` (in that section only) and `Planner and vanilla
//     model` and `Quarantine model` (any table row).
//  3. Code: `Wasm sha256` equals the sha256 of contracts/airlock-policy/res/airlock_policy.wasm; `Code hash (base58)` equals that digest
//     in base58; RPC view_account of the policy account holds the same code_hash; `Deploy transaction` went to the policy account,
//     did not fail and deploys that wasm (a DeployContract action; FastNEAR gives its 32 byte code hash, RPC gives the whole code,
//     which is hashed here); every bench/golden/*.json has the policy account as contractId, except live-latest.json, the live demo's
//     record, which has the current policy account when the file has that row (AIR-316).
//  4. Every testnet.nearblocks.io/txns/<hash> link: one POST of the valid hashes to https://tx.test.fastnear.com/v0/transactions (in
//     batches of 20, the endpoint answers 400 above 20 and for any malformed hash), then for a hash it did not return RPC `tx`
//     (wait_until FINAL) on the archival list of plan/STACK.md section RPC, each account of fixtures/accounts.testnet.json in file
//     order (values that are not NEAR account ids, such as contractor_evm, are skipped), then docs/evidence/near/<hash>.json. A
//     saved file that is not that transaction fails; a missing one is a WARN (the ticket says to save each response when the link is
//     added; this WARN is an addition). The saved file is either shape: one FastNEAR transaction object, the batch envelope, or an RPC
//     `tx` result (with or without the JSON-RPC envelope). A failed transaction still counts as found (the tamper evidence fails by design).
//  5. Every sepolia.basescan.org/tx/0x<64 hex> link: eth_getTransactionReceipt on https://sepolia.base.org, then
//     https://base-sepolia-rpc.publicnode.com, status 0x1.
//  6. The real MPC row: a line of `## Real MPC (AIR-102)` that holds a Base Sepolia link (a table row or a bullet, the NEAR signing
//     transaction is the testnet.nearblocks.io link on the same line). Its NEAR transaction did not fail, has an outcome executed by
//     v1.signer-prod.testnet whose SuccessValue is a JSON object with a `scheme`, and an `EVENT_JSON` log with standard `airlock`
//     and event `signed` carrying a request_id. Its Base receipt `from` is the address given by `node scripts/derive-address.mjs
//     <policy account> airlock-demo-1` (a missing or failing script is a FAIL that names it). Under rung 9 (the file holds
//     `EVM lane not live-proven at G2, rung 9`) the row's first cell must start with `Base Sepolia (spike contract, not the product
//     contract)`, the expected sender is the 0x address written on that row, and the signed event is not required (the spike contract
//     has no callback, so its transaction never carries one; checked on the AIR-272 transaction). Without rung 9 that label is a FAIL.
//     `Derived Base Sepolia address` must equal the derive-address output as well.
//  7. `MPC contract version` and `MPC contract code hash`: the newest row by its YYYY-MM-DD date cell is compared with the live
//     `version` view and view_account code_hash of v1.signer-prod.testnet on the regular node list of plan/STACK.md section RPC. A
//     different version is a FAIL, a different code hash is a WARN (whatever the version says, as in AIR-166's preflight).
//  8. Screenshots: the names wallet-<intear|meteor>-<shot>.png written in `## Wallet matrix` exist under docs/evidence-screenshots as
//     PNG files, at least four, both wallets, and every .png in that folder is referenced there.
//  9. Every URL of `## Video links` is also in an earlier section (an addition: the ticket asks for it of the section, not of the script).
// Parsing: a table row is a line that starts with `|`, cells split on `|`, the first cell compared with backticks and markdown link
// syntax removed; the value is the third cell, the date the fourth. The policy account is the first word of its cell, or the account
// of a nearblocks.io/address link on that row.
//
// Test seams (used by evidence-check.test.ts, harmless otherwise): EVIDENCE_FETCH_FIXTURE=<json file> answers every POST from a list
// of { url, match?: string[], status?, body?, throw? } rules (first rule with the same url whose match strings all occur in the
// request body wins, no rule is a network error); EVIDENCE_FETCH_LOG=<file> appends `<url> <request body>` for every POST.
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HEADINGS = [
  '## Deployed ids and hashes', '## Real MPC (AIR-102)', '## Testnet end to end (AIR-165)', '## Golden runs (AIR-166)', '## Wallet matrix',
  '## Toolchain', '## Differential', '## Video links', '## Model choice',
];
// Optional row: the account that now holds the committed wasm after a redeploy to a new account. The code checks (on-chain code
// hash, deploy transaction receiver) use it; the golden files and the real MPC signer derivation stay tied to 'Policy contract account'.
const CURRENT_LABEL = 'Current policy contract account';
const DEPLOYED_ROWS = [
  'Policy contract account', 'Code hash (base58)', 'Wasm sha256', 'Deploy transaction', 'Derived Base Sepolia address',
  'MPC contract version', 'MPC contract code hash',
];
const MODEL_ROWS = ['Planner and vanilla model', 'Quarantine model'];
const MODEL_LINES = ['planner model: ', 'quarantine model: ', 'vanilla models: '];
const WASM_PATH = 'contracts/airlock-policy/res/airlock_policy.wasm';
const MPC = 'v1.signer-prod.testnet';
const DERIVE_PATH = 'airlock-demo-1';
const RUNG9 = 'EVM lane not live-proven at G2, rung 9';
const SPIKE_LABEL = 'Base Sepolia (spike contract, not the product contract)';
// plan/STACK.md section RPC (order set 2026-10-24): regular nodes for views, archival nodes for old transactions
const NEAR_RPCS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs', 'https://rpc.testnet.near.org'];
const NEAR_ARCHIVAL = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];
const BATCH_URL = 'https://tx.test.fastnear.com/v0/transactions';
const BATCH_MAX = 20;
const BASE_RPCS = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
const EXPLORER_HOSTS = ['testnet.nearblocks.io', 'nearblocks.io', 'sepolia.basescan.org'];
const NEAR_LINK = /https?:\/\/testnet\.nearblocks\.io\/txns\/([A-Za-z0-9]+)/g;
const BASE_LINK = /https?:\/\/sepolia\.basescan\.org\/tx\/(0x[0-9a-fA-F]+)/g;
const URL_RE = /https?:\/\/[^\s<>"'`|)\]]*[^\s<>"'`|)\].,;:!?]/g;
const SHOT_RE = /wallet-(?:intear|meteor)-[A-Za-z0-9_-]+\.png/g;
const ADDR_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const SHA_RE = /(?<![0-9A-Za-z])[0-9a-f]{64}(?![0-9A-Za-z])/;
const B58_RE = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{43,44}(?![0-9A-Za-z])/;
const ACCOUNT_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Level = 'PASS' | 'FAIL' | 'WARN';
type Report = (level: Level, what: string, reason?: string) => void;
type Env = {
  root: string;
  text(rel: string): string | null;
  bytes(rel: string): Uint8Array | null;
  list(rel: string): string[];
  post(url: string, body: unknown): Promise<any>;
  derive(account: string, path: string): Promise<string>;
};
type Outcome = { executor: string; logs: string[]; status: any };
type Tx = { hash: string; signer: string; receiver: string; actions: any[]; outcomes: Outcome[] };
type Row = { cells: string[]; first: string; line: number; raw: string };

// small pure helpers

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}
function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
function b58decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  let zeros = 0;
  for (const c of s) {
    if (c !== '1') break;
    zeros++;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...out]);
}
const isNearHash = (s: string): boolean => b58decode(s)?.length === 32;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160);
const errName = (e: any): string => String(e?.cause?.name ?? e?.name ?? e?.message ?? 'error').slice(0, 60);
function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
const plain = (c: string): string => c.replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
function normUrl(u: string): string {   // URL_RE never ends on punctuation; a slash and the case of a Base hash do not matter
  return u.replace(/\/+$/, '').replace(/\/tx\/0x[0-9a-fA-F]+/, (m) => m.toLowerCase());
}
const urlsIn = (s: string): string[] => (s.match(URL_RE) ?? []).map(normUrl);
function distinct<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function findSection(lines: string[], heading: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) { end = i; break; }
  }
  return { start, end };
}
function tableRows(lines: string[], from: number, to: number): Row[] {
  const rows: Row[] = [];
  for (let i = from; i < to; i++) {
    const raw = lines[i]!;
    if (!raw.startsWith('|')) continue;   // the separator row of a table has only dashes in its first cell and matches no label
    const cells = raw.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    rows.push({ cells, first: plain(cells[0] ?? ''), line: i + 1, raw });
  }
  return rows;
}
const rowValue = (r: Row): string => plain(r.cells[2] ?? '');

// transactions

// both shapes: the FastNEAR transactions API (execution_outcome, receipts[].execution_outcome) and RPC tx (transaction_outcome,
// receipts_outcome); null when it is not the transaction with this hash
function normalizeTx(raw: any, hash: string): Tx | null {
  let x = raw;
  if (x && Array.isArray(x.transactions)) x = x.transactions.find((t: any) => t?.transaction?.hash === hash);
  else if (x && typeof x.result === 'object' && x.transaction === undefined) x = x.result;
  if (!x || typeof x !== 'object' || !x.transaction || x.transaction.hash !== hash) return null;
  const outs: any[] = Array.isArray(x.receipts_outcome)
    ? [x.transaction_outcome?.outcome, ...x.receipts_outcome.map((r: any) => r?.outcome)]
    : [x.execution_outcome?.outcome, ...(Array.isArray(x.receipts) ? x.receipts.map((r: any) => r?.execution_outcome?.outcome) : [])];
  const outcomes = outs.filter((o) => o && typeof o === 'object')
    .map((o) => ({ executor: String(o.executor_id ?? ''), logs: Array.isArray(o.logs) ? o.logs.map(String) : [], status: o.status }));
  const t = x.transaction;
  return { hash, signer: String(t.signer_id ?? ''), receiver: String(t.receiver_id ?? ''), actions: Array.isArray(t.actions) ? t.actions : [], outcomes };
}
const txFailed = (tx: Tx): boolean => tx.outcomes.some((o) => o.status && typeof o.status === 'object' && 'Failure' in o.status);
function deployedHashes(tx: Tx): string[] {
  const out: string[] = [];
  for (const a of tx.actions) {
    const code = a?.DeployContract?.code;
    if (typeof code !== 'string') continue;
    const b = Buffer.from(code, 'base64');
    out.push(b.length === 32 ? b.toString('hex') : sha256(b).toString('hex'));   // FastNEAR sends the hash, RPC the code
  }
  return out;
}
function hasSignerResponse(tx: Tx): boolean {
  return tx.outcomes.some((o) => {
    const v = o.status?.SuccessValue;
    if (o.executor !== MPC || typeof v !== 'string' || v === '') return false;
    try {
      const j = JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
      return j !== null && typeof j === 'object' && typeof j.scheme === 'string';
    } catch {
      return false;
    }
  });
}
function hasSignedEvent(tx: Tx): boolean {
  for (const o of tx.outcomes) {
    for (const l of o.logs) {
      if (!l.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(l.slice('EVENT_JSON:'.length));
        const id = e?.data?.[0]?.request_id;
        if (e?.standard === 'airlock' && e?.event === 'signed' && typeof id === 'string' && id !== '') return true;
      } catch {
        // not JSON: not an event
      }
    }
  }
  return false;
}

async function rpcFirst(env: Env, urls: string[], method: string, params: unknown):
  Promise<{ ok: true; result: any } | { ok: false; reason: string }> {
  const notes: string[] = [];
  for (const url of urls) {
    try {
      const j = await env.post(url, { jsonrpc: '2.0', id: 1, method, params });
      if (j && typeof j === 'object' && j.error === undefined && j.result !== undefined && j.result !== null) {
        if (typeof j.result === 'object' && j.result.error !== undefined) notes.push(host(url) + ': ' + String(j.result.error).slice(0, 60));
        else return { ok: true, result: j.result };
      } else notes.push(host(url) + ': ' + (j?.error ? errName(j.error) : 'empty answer'));
    } catch (e) {
      notes.push(host(url) + ': ' + errMsg(e));
    }
  }
  return { ok: false, reason: notes.join('; ') };
}

function accountsOf(env: Env): string[] {
  const t = env.text('fixtures/accounts.testnet.json');
  if (t === null) return [];
  try {
    const j = JSON.parse(t);
    return distinct(Object.values(j).filter((v): v is string => typeof v === 'string' && v.length >= 2 && v.length <= 64 && ACCOUNT_RE.test(v) && !/^0x[0-9a-f]{40}$/.test(v)));
  } catch {
    return [];
  }
}

// batch endpoint first, then RPC tx per account on the archival list; returns each hash's transaction and where it came from
async function readTxs(env: Env, hashes: string[]): Promise<Map<string, { tx: Tx; how: string }>> {
  const got = new Map<string, { tx: Tx; how: string }>();
  for (let i = 0; i < hashes.length; i += BATCH_MAX) {
    try {
      const res = await env.post(BATCH_URL, { tx_hashes: hashes.slice(i, i + BATCH_MAX) });
      for (const raw of Array.isArray(res?.transactions) ? res.transactions : []) {
        const h = raw?.transaction?.hash;
        const tx = typeof h === 'string' ? normalizeTx(raw, h) : null;
        if (tx !== null && hashes.includes(h) && !got.has(h)) got.set(h, { tx, how: 'batch' });
      }
    } catch {
      // the hashes of this batch fall back to RPC below
    }
  }
  const accounts = accountsOf(env);
  for (const h of hashes) {
    if (got.has(h)) continue;
    for (const url of NEAR_ARCHIVAL) {   // the slow public node is asked only when FastNEAR has none of the accounts
      for (const account of accounts) {
        try {
          const res = await env.post(url, { jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: h, sender_account_id: account, wait_until: 'FINAL' } });
          const tx = res?.error === undefined ? normalizeTx(res?.result, h) : null;
          if (tx !== null) got.set(h, { tx, how: 'rpc ' + host(url) });
        } catch {
          break;   // no answer at all (both archival hosts hang on an unknown hash, 30 s checked 2026-10-26): another account would hang too
        }
        if (got.has(h)) break;
      }
      if (got.has(h)) break;
    }
  }
  return got;
}

// the checks

async function runChecks(env: Env, report: Report): Promise<number> {
  const text = env.text('docs/EVIDENCE.md') ?? '';
  const lines = text.split('\n');
  const guarded = async (what: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      report('FAIL', what, 'internal error: ' + errMsg(e));
    }
  };

  // 1. headings, model choice, placeholders
  await guarded('headings', () => {
    for (const h of HEADINGS) {
      if (lines.some((l) => l.trimEnd() === h)) report('PASS', 'heading ' + h);
      else report('FAIL', 'heading ' + h, 'missing');
    }
    const model = findSection(lines, '## Model choice');
    if (model !== null) {
      const headings = lines.filter((l) => l.startsWith('## '));
      const last = headings[headings.length - 1]!.trimEnd();
      if (last === '## Model choice') report('PASS', 'model choice last section');
      else report('FAIL', 'model choice last section', 'the last section is ' + last + ', Model choice must stay last');
      const below = lines.slice(model.start + 1);
      const problems: string[] = [];
      for (const p of MODEL_LINES) {
        const n = below.filter((l) => l.startsWith(p)).length;
        if (n !== 1) problems.push('expected exactly one line starting "' + p + '", found ' + n);
      }
      const pct = below.filter((l) => l.includes('%')).length;
      if (pct > 0) problems.push(pct + ' line(s) contain %');
      if (problems.length === 0) report('PASS', 'model choice');
      for (const p of problems) report('FAIL', 'model choice', p);
    }
    let bad = 0;
    lines.forEach((l, i) => {
      const hit = l.includes('TODO') ? 'TODO' : /To fill during the build/i.test(l) ? 'To fill during the build' : null;
      if (hit !== null) { bad++; report('FAIL', 'placeholder text', 'line ' + (i + 1) + ' contains ' + hit); }
    });
    if (bad === 0) report('PASS', 'placeholder text');
  });

  // 2. rows by first cell
  const deployed = findSection(lines, '## Deployed ids and hashes');
  const drows = deployed === null ? [] : tableRows(lines, deployed.start + 1, deployed.end);
  const rowsOf = (label: string): Row[] => drows.filter((r) => r.first === label);
  await guarded('rows', () => {
    for (const label of DEPLOYED_ROWS) {
      const n = rowsOf(label).length;
      if (n > 0) report('PASS', 'row ' + label, n > 1 ? n + ' rows' : undefined);
      else report('FAIL', 'row ' + label, 'not found in ## Deployed ids and hashes');
    }
    const all = tableRows(lines, 0, lines.length);
    for (const label of MODEL_ROWS) {
      if (all.some((r) => r.first === label)) report('PASS', 'row ' + label);
      else report('FAIL', 'row ' + label, 'no table row with this first cell');
    }
  });
  const rowVal = (label: string): string | null => {
    const r = rowsOf(label)[0];
    return r === undefined ? null : rowValue(r);
  };
  const policyCell = rowVal('Policy contract account') ?? '';
  const policyToken = /nearblocks\.io\/address\/([a-z0-9._-]+)/.exec(rowsOf('Policy contract account')[0]?.raw ?? '')?.[1] ?? policyCell.split(/\s+/)[0] ?? '';
  const policy = ACCOUNT_RE.test(policyToken) ? policyToken : null;
  const curRow = rowsOf(CURRENT_LABEL)[0];
  const curToken = curRow === undefined ? '' : (/nearblocks\.io\/address\/([a-z0-9._-]+)/.exec(curRow.raw)?.[1] ?? (rowValue(curRow) ?? '').split(/\s+/)[0] ?? '');
  // the account the committed wasm is deployed to: the current row when the file has one, else the policy account row
  const codeAccount = curRow === undefined ? policy : (ACCOUNT_RE.test(curToken) ? curToken : null);

  // 3. code
  const wasm = env.bytes(WASM_PATH);
  const digest = wasm === null ? null : sha256(wasm);
  const wasmHex = digest === null ? null : digest.toString('hex');
  const wasmB58 = digest === null ? null : b58encode(digest);
  await guarded('wasm sha256', () => {
    if (wasmHex === null) return report('FAIL', 'wasm sha256', WASM_PATH + ' is missing');
    const v = rowVal('Wasm sha256');
    if (v === null) return;
    const m = SHA_RE.exec(v);
    if (m === null) report('FAIL', 'wasm sha256', 'the row holds no 64 character lowercase hex digest');
    else if (m[0] !== wasmHex) report('FAIL', 'wasm sha256', 'the row says ' + m[0] + ', sha256 of ' + WASM_PATH + ' is ' + wasmHex);
    else report('PASS', 'wasm sha256', wasmHex);
  });
  await guarded('code hash row', () => {
    if (wasmB58 === null) return report('FAIL', 'code hash row', WASM_PATH + ' is missing');
    const v = rowVal('Code hash (base58)');
    if (v === null) return;
    const m = B58_RE.exec(v);
    if (m === null) report('FAIL', 'code hash row', 'the row holds no base58 hash');
    else if (m[0] !== wasmB58) report('FAIL', 'code hash row', 'the row says ' + m[0] + ', the wasm digest in base58 is ' + wasmB58);
    else report('PASS', 'code hash row', wasmB58);
  });
  await guarded('on-chain code hash', async () => {
    if (codeAccount === null) return report('FAIL', 'on-chain code hash', 'no valid ' + (curRow === undefined ? 'Policy contract account' : CURRENT_LABEL) + ' row');
    if (wasmB58 === null) return report('FAIL', 'on-chain code hash', WASM_PATH + ' is missing');
    const r = await rpcFirst(env, NEAR_RPCS, 'query', { request_type: 'view_account', finality: 'final', account_id: codeAccount });
    if (!r.ok) return report('FAIL', 'on-chain code hash', 'no node answered view_account for ' + codeAccount + ' (' + r.reason + ')');
    const onChain = String(r.result.code_hash ?? '');
    if (onChain === wasmB58) report('PASS', 'on-chain code hash', codeAccount + ' ' + onChain);
    else report('FAIL', 'on-chain code hash', codeAccount + ' holds ' + onChain + ', the committed wasm is ' + wasmB58);
  });
  await guarded('golden contractId', () => {
    const names = env.list('bench/golden').filter((n) => n.endsWith('.json')).sort();
    if (names.length === 0) return report('FAIL', 'golden contractId', 'no bench/golden/*.json files');
    if (policy === null) return report('FAIL', 'golden contractId', 'no valid Policy contract account row to compare with');
    const wrong: string[] = [];
    for (const n of names) {
      let id: unknown;
      try {
        id = JSON.parse(env.text('bench/golden/' + n) ?? '').contractId;
      } catch {
        id = '(not valid JSON)';
      }
      // AIR-316: the live demo's record is written on the account that holds the committed wasm (the current row when there is one)
      const want = n === 'live-latest.json' && curRow !== undefined && codeAccount !== null ? codeAccount : policy;
      if (id !== want) wrong.push('bench/golden/' + n + ' has contractId ' + String(id));
    }
    if (wrong.length === 0) report('PASS', 'golden contractId', names.length + ' files');
    else report('FAIL', 'golden contractId', wrong.join('; ') + '; the row says ' + policy + (curRow !== undefined && codeAccount !== null ? ' (and ' + codeAccount + ' for live-latest.json)' : ''));
  });

  // 4. NEAR transactions
  const nearAll = distinct([...text.matchAll(NEAR_LINK)].map((m) => m[1]!));
  const nearValid = nearAll.filter(isNearHash);
  const txs = new Map<string, Tx>();
  await guarded('near tx', async () => {
    for (const h of nearAll) if (!isNearHash(h)) report('FAIL', 'near tx ' + h, 'not a transaction hash (base58 of 32 bytes)');
    const got = await readTxs(env, nearValid);
    for (const h of nearValid) {
      const savedPath = 'docs/evidence/near/' + h + '.json';
      const savedRaw = env.text(savedPath);
      let saved: Tx | null = null;
      if (savedRaw !== null) {
        try {
          saved = normalizeTx(JSON.parse(savedRaw), h);
        } catch {
          saved = null;
        }
        if (saved === null) report('FAIL', 'near tx ' + h, 'saved response ' + savedPath + ' is not valid JSON or not this transaction');
      }
      const live = got.get(h);
      const tx = live?.tx ?? saved;
      if (live !== undefined) txs.set(h, live.tx);
      else if (saved !== null) txs.set(h, saved);
      if (tx === null || tx === undefined) {
        if (savedRaw === null) {
          report('FAIL', 'near tx ' + h, 'no source returned it (batch endpoint, RPC tx with each of ' + accountsOf(env).length + ' accounts on '
            + NEAR_ARCHIVAL.length + ' archival nodes, no ' + savedPath + ')');
        }
        continue;
      }
      if (savedRaw !== null && saved === null) continue;
      report('PASS', 'near tx ' + h, live?.how ?? 'saved');
      if (savedRaw === null) report('WARN', 'saved response', savedPath + ' is missing');
    }
  });

  // deploy transaction
  await guarded('deploy transaction', () => {
    const r = rowsOf('Deploy transaction')[0];
    if (r === undefined) return;
    const h = [...r.raw.matchAll(NEAR_LINK)].map((m) => m[1]!)[0];
    if (h === undefined) return report('FAIL', 'deploy transaction', 'the row has no testnet.nearblocks.io/txns link');
    const tx = txs.get(h);
    if (tx === undefined) return report('FAIL', 'deploy transaction', 'transaction ' + h + ' could not be read');
    const hashes = deployedHashes(tx);
    if (txFailed(tx)) report('FAIL', 'deploy transaction', h + ' failed');
    else if (codeAccount === null) report('FAIL', 'deploy transaction', 'no valid ' + (curRow === undefined ? 'Policy contract account' : CURRENT_LABEL) + ' row');
    else if (tx.receiver !== codeAccount) report('FAIL', 'deploy transaction', 'receiver is ' + tx.receiver + ', the policy account is ' + codeAccount);
    else if (hashes.length === 0) report('FAIL', 'deploy transaction', 'no DeployContract action in ' + h);
    else if (wasmHex === null) report('FAIL', 'deploy transaction', WASM_PATH + ' is missing');
    else if (!hashes.includes(wasmHex)) report('FAIL', 'deploy transaction', 'deploys code hash ' + hashes.join(', ') + ', the committed wasm is ' + wasmHex);
    else report('PASS', 'deploy transaction', h);
  });

  // 5. Base Sepolia transactions
  const baseAll = distinct([...text.matchAll(BASE_LINK)].map((m) => m[1]!.toLowerCase()));
  const receipts = new Map<string, { status: string; from: string }>();
  await guarded('base tx', async () => {
    for (const h of baseAll) {
      if (!/^0x[0-9a-f]{64}$/.test(h)) { report('FAIL', 'base tx ' + h, 'not a transaction hash (0x and 64 hex characters)'); continue; }
      const r = await rpcFirst(env, BASE_RPCS, 'eth_getTransactionReceipt', [h]);
      if (!r.ok) { report('FAIL', 'base tx ' + h, 'no receipt from any Base Sepolia node (' + r.reason + ')'); continue; }
      const status = String(r.result.status ?? '');
      receipts.set(h, { status, from: String(r.result.from ?? '') });
      if (status === '0x1') report('PASS', 'base tx ' + h);
      else report('FAIL', 'base tx ' + h, 'receipt status ' + status + ', expected 0x1');
    }
  });

  // 6. the real MPC signature row and the derived address
  let derived: Promise<{ ok: true; address: string } | { ok: false; reason: string }> | null = null;
  const derivedAddress = (): Promise<{ ok: true; address: string } | { ok: false; reason: string }> => {
    if (policy === null) return Promise.resolve({ ok: false, reason: 'no valid Policy contract account row to derive from' });
    derived ??= env.derive(policy, DERIVE_PATH).then((address) => ({ ok: true as const, address }), (e) => ({ ok: false as const, reason: errMsg(e) }));
    return derived;
  };
  const rung9 = text.includes(RUNG9);
  await guarded('real MPC', async () => {
    const mpc = findSection(lines, '## Real MPC (AIR-102)');
    const rows = mpc === null ? [] : lines.slice(mpc.start + 1, mpc.end).map((raw, i) => ({ raw, line: mpc.start + 2 + i })).filter((l) => /sepolia\.basescan\.org\/tx\//.test(l.raw));
    if (rows.length === 0) return report('FAIL', 'real MPC row', 'no line of ## Real MPC (AIR-102) has a sepolia.basescan.org/tx link');
    for (const { raw } of rows) {
      const first = plain((raw.startsWith('|') ? raw.trim().replace(/^\|/, '').split('|')[0]! : raw.replace(/^\s*[-*]\s*/, '')));
      const spike = first.startsWith(SPIKE_LABEL);
      if (rung9 && !spike) report('FAIL', 'real MPC row', 'rung 9 is on file, so the first cell of the Base Sepolia row must start with "' + SPIKE_LABEL + '"');
      else if (!rung9 && spike) report('FAIL', 'real MPC row', 'the first cell names the spike contract but "' + RUNG9 + '" is not in the file');
      else report('PASS', 'real MPC row', first);
      const nearHash = [...raw.matchAll(NEAR_LINK)].map((m) => m[1]!)[0];
      const baseHash = [...raw.matchAll(BASE_LINK)].map((m) => m[1]!.toLowerCase())[0]!;
      if (nearHash === undefined) { report('FAIL', 'real MPC row', 'no testnet.nearblocks.io/txns link for the signing transaction on the row'); continue; }
      const name = 'real MPC ' + nearHash.slice(0, 8);
      const tx = txs.get(nearHash);
      if (tx === undefined) {
        report('FAIL', name + ' signer outcome', 'transaction ' + nearHash + ' could not be read');
      } else {
        if (txFailed(tx)) report('FAIL', name + ' signer outcome', 'the transaction failed');
        else if (!hasSignerResponse(tx)) report('FAIL', name + ' signer outcome', 'no outcome executed by ' + MPC + ' with a signature response (a JSON object with scheme)');
        else report('PASS', name + ' signer outcome');
        if (!spike) {
          if (hasSignedEvent(tx)) report('PASS', name + ' signed event');
          else report('FAIL', name + ' signed event', 'no EVENT_JSON log of standard airlock and event signed with a request_id');
        }
      }
      const receipt = receipts.get(baseHash);
      let expected: string;
      if (spike) {
        const a = ADDR_RE.exec(raw);
        if (a === null) { report('FAIL', name + ' Base sender', 'the spike row holds no 0x address to compare with'); continue; }
        expected = a[0];
      } else {
        const d = await derivedAddress();
        if (!d.ok) { report('FAIL', name + ' Base sender', d.reason); continue; }
        expected = d.address;
      }
      if (receipt === undefined) report('FAIL', name + ' Base sender', 'no receipt for ' + baseHash);
      else if (receipt.from.toLowerCase() !== expected.toLowerCase()) report('FAIL', name + ' Base sender', 'sent from ' + receipt.from + ', expected ' + expected);
      else report('PASS', name + ' Base sender', receipt.from);
    }
  });
  await guarded('derived address row', async () => {
    const v = rowVal('Derived Base Sepolia address');
    if (v === null) return;
    const row = ADDR_RE.exec(v);
    if (row === null) return report('FAIL', 'derived address row', 'the row holds no 0x address');
    const d = await derivedAddress();
    if (!d.ok) report('FAIL', 'derived address row', d.reason);
    else if (d.address.toLowerCase() !== row[0].toLowerCase()) report('FAIL', 'derived address row', 'the row says ' + row[0] + ', scripts/derive-address.mjs gives ' + d.address);
    else report('PASS', 'derived address row', d.address);
  });

  // 7. the MPC contract rows against the live contract
  const newest = (label: string, what: string): { value: string; date: string } | null => {
    const rows = rowsOf(label);
    if (rows.length === 0) return null;
    let best: { value: string; date: string } | null = null;
    for (const r of rows) {
      const date = plain(r.cells[3] ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { report('FAIL', what, 'the ' + label + ' row at line ' + r.line + ' has no YYYY-MM-DD date'); return null; }
      if (best === null || date >= best.date) best = { value: rowValue(r), date };
    }
    return best;
  };
  await guarded('MPC version', async () => {
    const row = newest('MPC contract version', 'MPC version');
    if (row === null) return;
    const rowV = /\d+\.\d+\.\d+/.exec(row.value)?.[0];
    if (rowV === undefined) return report('FAIL', 'MPC version', 'the newest row (' + row.date + ') holds no x.y.z version');
    const r = await rpcFirst(env, NEAR_RPCS, 'query', { request_type: 'call_function', finality: 'final', account_id: MPC, method_name: 'version', args_base64: 'e30=' });
    if (!r.ok) return report('FAIL', 'MPC version', 'no node answered version on ' + MPC + ' (' + r.reason + ')');
    let live = Buffer.from(Array.isArray(r.result.result) ? r.result.result : []).toString('utf8');
    try {
      live = String(JSON.parse(live));
    } catch {
      // keep the raw text
    }
    if (live === rowV) report('PASS', 'MPC version', live);
    else report('FAIL', 'MPC version', 'live ' + live + ', the newest row (' + row.date + ') says ' + rowV);
  });
  await guarded('MPC code hash', async () => {
    const row = newest('MPC contract code hash', 'MPC code hash');
    if (row === null) return;
    const rowH = B58_RE.exec(row.value)?.[0];
    if (rowH === undefined) return report('FAIL', 'MPC code hash', 'the newest row (' + row.date + ') holds no base58 hash');
    const r = await rpcFirst(env, NEAR_RPCS, 'query', { request_type: 'view_account', finality: 'final', account_id: MPC });
    if (!r.ok) return report('FAIL', 'MPC code hash', 'no node answered view_account for ' + MPC + ' (' + r.reason + ')');
    const live = String(r.result.code_hash ?? '');
    if (live === rowH) report('PASS', 'MPC code hash', live);
    else report('WARN', 'MPC code hash', 'live ' + live + ', the newest row (' + row.date + ') says ' + rowH);
  });

  // 8. screenshots
  await guarded('screenshots', () => {
    const matrix = findSection(lines, '## Wallet matrix');
    const named = distinct(matrix === null ? [] : lines.slice(matrix.start + 1, matrix.end).join('\n').match(SHOT_RE) ?? []);
    for (const n of named) {
      const b = env.bytes('docs/evidence-screenshots/' + n);
      if (b === null) report('FAIL', 'screenshot ' + n, 'file missing (docs/evidence-screenshots/' + n + ')');
      else if (!PNG_SIGNATURE.every((x, i) => b[i] === x)) report('FAIL', 'screenshot ' + n, 'not a PNG file');
      else report('PASS', 'screenshot ' + n);
    }
    let ok = true;
    if (named.length < 4) { ok = false; report('FAIL', 'screenshots', named.length + ' referenced in ## Wallet matrix, at least four are needed'); }
    for (const w of ['Intear', 'Meteor']) {
      if (!named.some((n) => n.startsWith('wallet-' + w.toLowerCase() + '-'))) { ok = false; report('FAIL', 'screenshots', 'no ' + w + ' screenshot (wallet-' + w.toLowerCase() + '-<shot>.png) referenced'); }
    }
    for (const f of env.list('docs/evidence-screenshots').filter((n) => n.endsWith('.png')).sort()) {
      if (!named.includes(f)) report('FAIL', 'screenshot ' + f, 'not referenced in ## Wallet matrix');
    }
    if (ok) report('PASS', 'screenshots', named.length + ' referenced');
  });

  // 9. video links
  await guarded('video links in earlier sections', () => {
    const video = findSection(lines, '## Video links');
    if (video === null) return;
    const shown = distinct(urlsIn(lines.slice(video.start + 1, video.end).join('\n')));
    const earlier = new Set(urlsIn(lines.slice(0, video.start).join('\n')));
    const missing = shown.filter((u) => !earlier.has(u));
    if (missing.length === 0) report('PASS', 'video links in earlier sections', shown.length + ' links');
    else report('FAIL', 'video links in earlier sections', 'not in an earlier section: ' + missing.join(' '));
  });

  return nearAll.length + baseAll.length;
}

// environments

function realEnv(root: string): Env {
  const canned = process.env['EVIDENCE_FETCH_FIXTURE'];
  const logFile = process.env['EVIDENCE_FETCH_LOG'];
  let rules: { url: string; match?: string[]; status?: number; body?: any; throw?: string }[] | null = null;
  if (canned !== undefined && canned !== '') {
    try {
      rules = JSON.parse(readFileSync(canned, 'utf8'));
    } catch {
      console.log('INPUT MISSING ' + canned);
      process.exit(2);
    }
    console.log('NOTE network answers come from ' + canned);
  }
  return {
    root,
    text(rel) {
      try {
        return readFileSync(join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    bytes(rel) {
      try {
        return readFileSync(join(root, rel));
      } catch {
        return null;
      }
    },
    list(rel) {
      try {
        return readdirSync(join(root, rel));
      } catch {
        return [];
      }
    },
    async post(url, body) {
      const text = JSON.stringify(body);
      if (logFile !== undefined && logFile !== '') appendFileSync(logFile, url + ' ' + text + '\n');
      if (rules !== null) {
        const r = rules.find((x) => x.url === url && (x.match ?? []).every((m) => text.includes(m)));
        if (r === undefined) throw new Error('no canned answer for ' + host(url));
        if (r.throw !== undefined) throw new Error(r.throw);
        if ((r.status ?? 200) !== 200) throw new Error('HTTP ' + r.status);
        return r.body;
      }
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    },
    async derive(account, path) {
      if (this.text('scripts/derive-address.mjs') === null) throw new Error('scripts/derive-address.mjs is missing');
      const r = spawnSync(process.execPath, ['scripts/derive-address.mjs', account, path], { cwd: root, encoding: 'utf8', timeout: 60000 });
      if (r.error) throw new Error('scripts/derive-address.mjs could not run: ' + r.error.message);
      if (r.status !== 0) throw new Error('scripts/derive-address.mjs failed (exit ' + r.status + '): ' + ((r.stderr ?? '').trim().split('\n')[0] ?? ''));
      const m = ADDR_RE.exec(r.stdout ?? '');
      if (m === null) throw new Error('scripts/derive-address.mjs printed no 0x address');
      return m[0];
    },
  };
}

function memoryEnv(files: Map<string, Uint8Array | string>): Env {
  const get = (rel: string): Uint8Array | string | undefined => files.get(rel);
  return {
    root: '(memory)',
    text(rel) {
      const v = get(rel);
      return v === undefined ? null : typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
    },
    bytes(rel) {
      const v = get(rel);
      return v === undefined ? null : typeof v === 'string' ? Buffer.from(v) : v;
    },
    list(rel) {
      return [...files.keys()].filter((k) => k.startsWith(rel + '/')).map((k) => k.slice(rel.length + 1));
    },
    post() {
      return Promise.reject(new Error('selftest: no network'));
    },
    derive() {
      return Promise.reject(new Error('selftest: no derive script'));
    },
  };
}

// modes

async function selftest(): Promise<number> {
  const wasm = Buffer.from('selftest wasm bytes');
  const digest = sha256(wasm);
  const hex = digest.toString('hex');
  const b58 = b58encode(digest);
  const evidence = (h: string, c: string): string => [
    '## Deployed ids and hashes', '', '| What | Network | Id / hash / link | Date |',
    '| Policy contract account | NEAR testnet | policy.selftest.testnet | 2026-11-06 |',
    '| Code hash (base58) | NEAR testnet | ' + c + ' | 2026-11-06 |', '| Wasm sha256 | local build | ' + h + ' | 2026-11-06 |', '',
  ].join('\n');
  const flip = (s: string, alphabet: string): string => {
    const at = 12;
    return s.slice(0, at) + alphabet[(alphabet.indexOf(s[at]!) + 1) % alphabet.length] + s.slice(at + 1);
  };
  const outcome = async (h: string, c: string): Promise<Map<string, Level>> => {
    const seen = new Map<string, Level>();
    await runChecks(memoryEnv(new Map<string, Uint8Array | string>([['docs/EVIDENCE.md', evidence(h, c)], [WASM_PATH, wasm]])), (level, what) => { seen.set(what, level); });
    return seen;
  };
  const base = await outcome(hex, b58);
  const bad: string[] = [];
  for (const what of ['wasm sha256', 'code hash row']) if (base.get(what) !== 'PASS') bad.push('the unaltered ' + what + ' did not pass');
  if ((await outcome(flip(hex, '0123456789abcdef'), b58)).get('wasm sha256') !== 'FAIL') bad.push('an altered wasm sha256 did not fail');
  if ((await outcome(hex, flip(b58, B58))).get('code hash row') !== 'FAIL') bad.push('an altered base58 code hash did not fail');
  // known answers, so a broken hash or base58 that is wrong the same way on both sides cannot pass: the digest of the MPC contract
  // release 3.17.0 and the base58 form NEAR prints for it
  const knownHex = 'b4a9434bd80a446dd2a45fe93d5b444acffff78da6ca517aec11ca8dbe1b4b7c';
  const knownB58 = 'DAE5ng4ZFR2ctMx9SizQBqmGkVbKUutgZ4ZECD4R8Sm9';
  if (b58encode(Buffer.from(knownHex, 'hex')) !== knownB58) bad.push('base58 encoding of the known hash is wrong');
  if (Buffer.from(b58decode(knownB58) ?? []).toString('hex') !== knownHex) bad.push('base58 decoding of the known hash is wrong');
  if (sha256(Buffer.from('abc')).toString('hex') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') bad.push('sha256 of abc is wrong');
  for (const b of bad) console.log('SELFTEST FAIL ' + b);
  if (bad.length === 0) console.log('SELFTEST ok (altered hash failed)');
  return bad.length === 0 ? 0 : 1;
}

function videoLinks(env: Env, file: string): number {
  let shots: string;
  try {
    shots = readFileSync(file, 'utf8');
  } catch {
    console.log('INPUT MISSING ' + file);
    return 2;
  }
  const evidence = env.text('docs/EVIDENCE.md');
  if (evidence === null) {
    console.log('INPUT MISSING ' + join(env.root, 'docs', 'EVIDENCE.md'));
    return 2;
  }
  const have = new Set(urlsIn(evidence));
  const shown = distinct(urlsIn(shots).filter((u) => EXPLORER_HOSTS.includes(host(u))));
  let fails = 0;
  for (const u of shown) {
    if (have.has(u)) console.log('PASS video link ' + u);
    else { fails++; console.log('FAIL video link ' + u + ': not in docs/EVIDENCE.md'); }
  }
  console.log(summary(fails, shown.length));
  return fails === 0 ? 0 : 1;
}

const summary = (fails: number, links: number): string =>
  fails === 0 ? 'EVIDENCE OK ' + links + ' links checked' : 'EVIDENCE FAILED ' + fails + ' failure' + (fails === 1 ? '' : 's') + ', ' + links + ' links checked';

async function main(): Promise<number> {
  let root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let video: string | null = null;
  let self = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--selftest') self = true;
    else if ((a === '--root' || a === '--video-links') && args[i + 1] !== undefined) {
      if (a === '--root') root = args[++i]!;
      else video = args[++i]!;
    } else {
      console.log('usage: evidence-check.ts [--root <dir>] [--video-links <file>] [--selftest]');
      return 2;
    }
  }
  if (self) return await selftest();
  const env = realEnv(root);
  if (video !== null) return videoLinks(env, video);
  if (env.text('docs/EVIDENCE.md') === null) {
    console.log('INPUT MISSING ' + join(root, 'docs', 'EVIDENCE.md'));
    return 2;
  }
  let fails = 0;
  const links = await runChecks(env, (level, what, reason) => {
    if (level === 'FAIL') fails++;
    console.log(level === 'PASS' ? 'PASS ' + what + (reason === undefined ? '' : ' (' + reason + ')') : level + ' ' + what + ': ' + reason);
  });
  console.log(summary(fails, links));
  return fails === 0 ? 0 : 1;
}

// no top-level await: tsx runs a .ts file as CommonJS unless the package says "type": "module"
main().then((code) => process.stdout.write('', () => process.exit(code)));   // the callback: a pipe may still hold the last lines

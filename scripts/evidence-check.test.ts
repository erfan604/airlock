// AIR-243: tests of scripts/evidence-check.ts, one per failure the ticket names, plus the passing tree.
// Each test copies the fixture tree scripts/fixtures/evidence/ok (a product repo in miniature: docs/EVIDENCE.md, the wasm,
// bench/golden, fixtures/accounts.testnet.json, the screenshots, docs/evidence/near, a stand-in scripts/derive-address.mjs)
// into a scratch folder, edits it, and runs the checker as a child process against canned network answers
// (fixtures/evidence/rpc.json, read through EVIDENCE_FETCH_FIXTURE; EVIDENCE_FETCH_LOG records every request).
// The hashes below are base58(sha256("airlock evidence fixture tx <name>")). *.wasm is gitignored in the research repo, so
// the fixture wasm is stored as airlock_policy.wasm.fixture and renamed by world().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'evidence-check.ts');
const FIX = join(HERE, 'fixtures', 'evidence');

const POLICY = 'policy.fixture-owner.testnet';
const H = {
  deploy: 'CxQTsmGLdVmoCyfqjUxbKNqwQceaYJbapGeo4czMZQKv', u01: '5xjwv5gacRrgyxsrBYei7Y2QCmHrzqH4LRkVcac1snJk',
  mpc: 'GDXXqKfrSwJ4gKvz44Mk5Yk1WaYVU3NucuRnF3Npq6fd', esc: '3TMfquuStXyWDQMBDcn4nPG3fRKwUkrdZsZdvS52z69d',
  app: 'Dh43rqMMwY9o4ipXRvhKuC9PRhRpz6NGVkJq7FDAU1o2', tamper: 'Ee4nQECExp2w4kqZztRq4DrgFoAn1CMupWDtrBE8TetJ',
  twin: 'HJJPZ79QMjuL99j4LvFRiSk8WuKZaRtyn8TVqNF8bAFa',
};
const BASE = '0xdb8e05108d6e649f83f02388cb0589d03a29f2c9a30d806f424e23cf5113e900';
const DERIVED = '0x16c089aad87decf4eaaa4a4afeb5926bcd11b410';
const SPIKE_ADDRESS = '0x59b0565b4e395e6ea202ca125c7d1a8e7afb8d21';
const SPIKE_LABEL = 'Base Sepolia (spike contract, not the product contract)';
const RUNG9 = 'EVM lane not live-proven at G2, rung 9';
const MPC_HASH = 'DAE5ng4ZFR2ctMx9SizQBqmGkVbKUutgZ4ZECD4R8Sm9';
const WASM_HEX = '46131d04a43f818225fda0ae5b99e8f9d054cb57cb113fa6604c075fdf471402';
const WASM_B58 = '5iYSgYQBRpLQSFn28qKxNGAJ393zvQpysdZoNS3Q25XF';
const BATCH = 'https://tx.test.fastnear.com/v0/transactions';
const REGULAR = 'https://test.rpc.fastnear.com';
const ARCH1 = 'https://archival-rpc.testnet.fastnear.com';
const ARCH2 = 'https://archival-rpc.testnet.near.org';
const nb = (h: string) => 'https://testnet.nearblocks.io/txns/' + h;
const bs = (h: string) => 'https://sepolia.basescan.org/tx/' + h;

type Rule = { id?: string; url: string; match?: string[]; status?: number; body?: any; throw?: string };
type World = { dir: string; root: string; rpc: string; log: string };

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'ev243-'));
  const root = join(dir, 'root');
  cpSync(join(FIX, 'ok'), root, { recursive: true });
  const res = join(root, 'contracts', 'airlock-policy', 'res');
  renameSync(join(res, 'airlock_policy.wasm.fixture'), join(res, 'airlock_policy.wasm'));
  cpSync(join(FIX, 'rpc.json'), join(dir, 'rpc.json'));
  return { dir, root, rpc: join(dir, 'rpc.json'), log: join(dir, 'requests.log') };
}

function withWorld(fn: (w: World) => void): void {
  const w = world();
  try {
    fn(w);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// replace once and fail the test itself when the text to replace is not there, so an edit never silently tests nothing
function swap(s: string, from: string, to: string): string {
  assert.ok(s.includes(from), 'fixture text not found: ' + from);
  return s.replace(from, to);
}
function edit(w: World, rel: string, fn: (s: string) => string): void {
  const p = join(w.root, rel);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}
function evidence(w: World, fn: (s: string) => string): void {
  edit(w, 'docs/EVIDENCE.md', fn);
}
function rules(w: World, fn: (rs: Rule[]) => Rule[] | void): void {
  const rs = JSON.parse(readFileSync(w.rpc, 'utf8')) as Rule[];
  writeFileSync(w.rpc, JSON.stringify(fn(rs) ?? rs));
}
function rule(rs: Rule[], id: string): Rule {
  const r = rs.find((x) => x.id === id);
  assert.ok(r, 'no canned rule ' + id);
  return r;
}
function without(rs: Rule[], ...ids: string[]): Rule[] {
  for (const id of ids) rule(rs, id);
  return rs.filter((r) => !ids.includes(r.id ?? ''));
}
function batchTx(rs: Rule[], hash: string): any {
  const tx = rule(rs, 'batch').body.transactions.find((t: any) => t.transaction.hash === hash);
  assert.ok(tx, 'no tx ' + hash + ' in the canned batch');
  return tx;
}
function asRpc(tx: any): any {   // the FastNEAR object as an RPC tx result
  return {
    final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: tx.transaction,
    transaction_outcome: { id: tx.transaction.hash, outcome: tx.execution_outcome.outcome },
    receipts_outcome: tx.receipts.map((r: any) => ({ id: r.execution_outcome.id, outcome: r.execution_outcome.outcome })),
  };
}
function serveByRpc(rs: Rule[], hash: string): void {   // out of the batch, onto the archival node (which ignores the signer)
  const tx = batchTx(rs, hash);
  const b = rule(rs, 'batch').body;
  b.transactions = b.transactions.filter((t: any) => t.transaction.hash !== hash);
  rs.push({ id: 'tx-' + hash.slice(0, 4), url: ARCH1, match: ['"tx_hash":"' + hash + '"'], body: { jsonrpc: '2.0', id: 1, result: asRpc(tx) } });
}
function dropSaved(w: World, hash: string): void {
  rmSync(join(w.root, 'docs', 'evidence', 'near', hash + '.json'));
}
function run(w: World, args: string[] = [], env: Record<string, string> = {}): { code: number; out: string; requests: string[] } {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', w.root, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, EVIDENCE_FETCH_FIXTURE: w.rpc, EVIDENCE_FETCH_LOG: w.log, ...env },
  });
  const requests = existsSync(w.log) ? readFileSync(w.log, 'utf8').split('\n').filter((l) => l !== '') : [];
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.ok(!/internal error/.test(out), 'the checker hit an internal error:\n' + out);
  return { code: r.status ?? -1, out, requests };
}
const lastLine = (s: string) => s.trim().split('\n').pop() ?? '';
function failing(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('FAIL '));
}
function assertFails(r: { code: number; out: string }, what: RegExp): void {
  assert.equal(r.code, 1, r.out);
  assert.ok(failing(r.out).some((l) => what.test(l)), 'no FAIL line matching ' + what + ' in:\n' + r.out);
}

// the passing tree

test('a complete tree passes: one PASS per item, no FAIL or WARN, the link count on the last line', () => {
  withWorld((w) => {
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.equal(lastLine(r.out), 'EVIDENCE OK 8 links checked');
    assert.equal(failing(r.out).length, 0, r.out);
    assert.ok(!/^WARN /m.test(r.out), r.out);
    for (const h of Object.values(H)) assert.match(r.out, new RegExp('^PASS near tx ' + h, 'm'), h);
    assert.match(r.out, new RegExp('^PASS base tx ' + BASE, 'm'));
    for (const what of ['wasm sha256', 'code hash row', 'on-chain code hash', 'deploy transaction', 'golden contractId', 'derived address row',
      'MPC version', 'MPC code hash']) assert.match(r.out, new RegExp('^PASS ' + what, 'm'), what);
    assert.match(r.out, /^PASS real MPC GDXXqKfr signer outcome/m);
    assert.match(r.out, /^PASS real MPC GDXXqKfr signed event/m);
    assert.match(r.out, /^PASS real MPC GDXXqKfr Base sender/m);
  });
});

test('every NEAR hash of the file goes in one batch call to the FastNEAR transactions endpoint', () => {
  withWorld((w) => {
    const r = run(w);
    const batches = r.requests.filter((l) => l.startsWith(BATCH + ' '));
    assert.equal(batches.length, 1, r.requests.join('\n'));
    const body = JSON.parse(batches[0]!.slice(BATCH.length + 1)) as { tx_hashes: string[] };
    assert.deepEqual([...body.tx_hashes].sort(), Object.values(H).sort());
  });
});

test('more than 20 hashes are sent in batches of at most 20 (the endpoint answers 400 above 20), a malformed hash never goes out', () => {
  withWorld((w) => {
    const extra: string[] = [];
    for (let i = 0; i < 21; i++) extra.push(H.u01.slice(0, 40) + String(1000 + i).replace(/0/g, 'a'));   // base58, 44 characters
    evidence(w, (s) => s.replace('## Model choice', '## Extra\n\n' + extra.map((h) => nb(h)).join('\n') + '\n' + nb('abc0OIl') + '\n\n## Model choice'));
    const r = run(w);
    const batches = r.requests.filter((l) => l.startsWith(BATCH + ' ')).map((l) => (JSON.parse(l.slice(BATCH.length + 1)) as { tx_hashes: string[] }).tx_hashes);
    assert.ok(batches.length >= 2, r.requests.join('\n'));
    assert.ok(batches.every((b) => b.length <= 20), batches.map((b) => b.length).join(','));
    assert.equal(batches.flat().length, 7 + 21);
    assert.ok(!batches.flat().includes('abc0OIl'));
    assert.match(r.out, /^FAIL near tx abc0OIl: .*not a transaction hash/m);
  });
});

// code and hashes

test('a wasm sha256 row with one altered hex character fails', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Wasm sha256 | local build | 4613', '| Wasm sha256 | local build | 5613'));
    assertFails(run(w), /^FAIL wasm sha256: /);
  });
});

test('a wasm file that is not the one in the row fails the row, the base58 row, the chain and the deploy transaction', () => {
  withWorld((w) => {
    writeFileSync(join(w.root, 'contracts/airlock-policy/res/airlock_policy.wasm'), 'another build\n');
    const r = run(w);
    for (const what of ['wasm sha256', 'code hash row', 'on-chain code hash', 'deploy transaction']) assertFails(r, new RegExp('^FAIL ' + what + ': '));
  });
});

test('a missing wasm file fails by name instead of crashing', () => {
  withWorld((w) => {
    rmSync(join(w.root, 'contracts/airlock-policy/res/airlock_policy.wasm'));
    const r = run(w);
    assertFails(r, /^FAIL wasm sha256: contracts\/airlock-policy\/res\/airlock_policy\.wasm is missing/);
    assert.ok(!/\bat .*evidence-check\.ts:\d+/.test(r.out), r.out);
  });
});

test('an on-chain code hash that differs from the wasm fails, the committed wasm and the row stay green', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'view-policy').body.result.code_hash = MPC_HASH; });
    const r = run(w);
    assertFails(r, /^FAIL on-chain code hash: .*DAE5ng4Z/);
    assert.match(r.out, /^PASS wasm sha256/m);
    assert.match(r.out, /^PASS code hash row/m);
  });
});

test('a base58 code hash row that is not the wasm digest fails', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Code hash (base58) | NEAR testnet | 5iYS', '| Code hash (base58) | NEAR testnet | 6iYS'));
    assertFails(run(w), /^FAIL code hash row: /);
  });
});

test('view_account failing on every node fails the chain check', () => {
  withWorld((w) => {
    rules(w, (rs) => without(rs, 'view-policy'));
    assertFails(run(w), /^FAIL on-chain code hash: .*no node answered/);
  });
});

test('a Current policy contract account row moves the code checks to the redeployed account, the golden files stay on the policy account row', () => {
  const V2 = 'policy-v2.fixture-owner.testnet';
  const addRow = (w: World) => evidence(w, (s) => swap(s, '| Policy contract account | NEAR testnet | ' + POLICY + ' |',
    '| Policy contract account | NEAR testnet | ' + POLICY + ' |\n| Current policy contract account | NEAR testnet | ' + V2 + ' | 2026-11-03 |'));
  withWorld((w) => {   // no node knows the new account: the chain check asks for it, not for the old one
    addRow(w);
    const r = run(w);
    assertFails(r, /^FAIL on-chain code hash: no node answered view_account for policy-v2\.fixture-owner\.testnet/);
    assert.match(r.out, /^PASS golden contractId/m);
  });
  withWorld((w) => {   // a node holding the wasm digest under the new account passes the chain check
    addRow(w);
    rules(w, (rs) => {
      const v = rule(rs, 'view-policy');
      rs.push({ id: 'view-v2', url: v.url, match: (v.match ?? []).map((m) => m.split(POLICY).join(V2)), body: v.body });
    });
    const r = run(w);
    assert.match(r.out, /^PASS on-chain code hash \(policy-v2\.fixture-owner\.testnet /m, r.out);
    assert.match(r.out, /^PASS golden contractId/m);
    assertFails(r, /^FAIL deploy transaction: receiver is policy\.fixture-owner\.testnet, the policy account is policy-v2\.fixture-owner\.testnet/);
  });
});

test('the live demo record bench/golden/live-latest.json may name the current policy account; any other account fails (AIR-316)', () => {
  const V3 = 'policy-v3.fixture-owner.testnet';
  const addRow = (w: World) => evidence(w, (s) => swap(s, '| Policy contract account | NEAR testnet | ' + POLICY + ' |',
    '| Policy contract account | NEAR testnet | ' + POLICY + ' |\n| Current policy contract account | NEAR testnet | ' + V3 + ' | 2026-11-05 |'));
  withWorld((w) => {
    addRow(w);
    writeFileSync(join(w.root, 'bench', 'golden', 'live-latest.json'), JSON.stringify({ contractId: V3 }));
    assert.match(run(w).out, /^PASS golden contractId/m);
  });
  withWorld((w) => {
    addRow(w);
    writeFileSync(join(w.root, 'bench', 'golden', 'live-latest.json'), JSON.stringify({ contractId: 'policy-old.fixture-owner.testnet' }));
    assertFails(run(w), /^FAIL golden contractId: .*live-latest\.json has contractId policy-old\.fixture-owner\.testnet/);
  });
  withWorld((w) => {   // without a current row the live record is held to the policy account like every golden file
    writeFileSync(join(w.root, 'bench', 'golden', 'live-latest.json'), JSON.stringify({ contractId: V3 }));
    assertFails(run(w), /^FAIL golden contractId: .*live-latest\.json has contractId policy-v3\.fixture-owner\.testnet/);
  });
});

test('a golden file with another contract id fails and names the file; a tree with no golden files fails', () => {
  withWorld((w) => {
    edit(w, 'bench/golden/tamper.json', (s) => swap(s, '"policy.fixture-owner.testnet"', '"policy-old.fixture-owner.testnet"'));
    const r = run(w);
    assertFails(r, /^FAIL golden contractId: .*tamper\.json.*policy-old\.fixture-owner\.testnet/);
  });
  withWorld((w) => {
    rmSync(join(w.root, 'bench'), { recursive: true });
    assertFails(run(w), /^FAIL golden contractId: no bench\/golden/);
  });
});

test('the policy account may be given as an explorer address link', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Policy contract account | NEAR testnet | ' + POLICY + ' |',
      '| Policy contract account | NEAR testnet | https://testnet.nearblocks.io/address/' + POLICY + ' |'));
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.equal(lastLine(r.out), 'EVIDENCE OK 8 links checked');
  });
});

test('the deploy transaction must go to the policy account and deploy the committed wasm', () => {
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.deploy).transaction.receiver_id = 'someone.testnet'; });
    assertFails(run(w), /^FAIL deploy transaction: .*receiver/);
  });
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.deploy).transaction.actions.shift(); });
    assertFails(run(w), /^FAIL deploy transaction: .*DeployContract/);
  });
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.deploy).transaction.actions[0].DeployContract.code = Buffer.alloc(32, 7).toString('base64'); });
    assertFails(run(w), /^FAIL deploy transaction: .*code hash/);
  });
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.deploy).receipts[0].execution_outcome.outcome.status = { Failure: { ActionError: {} } }; });
    assertFails(run(w), /^FAIL deploy transaction: .*failed/);
  });
});

test('a deploy transaction served by RPC with the whole code in the action is compared by its sha256', () => {
  withWorld((w) => {
    const code = readFileSync(join(w.root, 'contracts/airlock-policy/res/airlock_policy.wasm'));
    rules(w, (rs) => {
      const tx = batchTx(rs, H.deploy);
      const rpc = {
        final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: tx.transaction,
        transaction_outcome: { id: H.deploy, outcome: { executor_id: POLICY, logs: [], status: { SuccessReceiptId: 'r0' } } },
        receipts_outcome: [{ id: 'r0', outcome: { executor_id: POLICY, logs: [], status: { SuccessValue: '' } } }],
      };
      rpc.transaction.actions[0].DeployContract.code = code.toString('base64');
      const b = rule(rs, 'batch').body;
      b.transactions = b.transactions.filter((t: any) => t.transaction.hash !== H.deploy);
      rs.push({ id: 'tx-deploy', url: ARCH1, match: ['"tx_hash":"' + H.deploy + '"'], body: { jsonrpc: '2.0', id: 1, result: rpc } });
    });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^PASS deploy transaction/m);
  });
});

// transactions

test('a hash the batch endpoint does not return is read through RPC tx on the archival list, trying each account in file order', () => {
  withWorld((w) => {
    const r = run(w);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.twin + ' \\(rpc', 'm'));
    const tries = r.requests.filter((l) => l.includes('"method":"tx"') && l.includes(H.twin));
    assert.deepEqual(tries.map((l) => l.split(' ')[0]), [ARCH1, ARCH1, ARCH1]);
    assert.deepEqual(tries.map((l) => /"sender_account_id":"([^"]+)"/.exec(l)?.[1]),
      ['fixture-owner.testnet', 'fixture-agent.testnet', 'fixture-twin-vanilla.testnet']);
    assert.ok(tries.every((l) => /"wait_until":"FINAL"/.test(l)));
  });
});

test('the regular node answering UNKNOWN_BLOCK is never asked for a transaction, the archival list is', () => {
  withWorld((w) => {
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.requests.some((l) => l.startsWith(REGULAR + ' ') && l.includes('"method":"tx"')), r.requests.join('\n'));
  });
});

test('the second archival node answers when the first one answers UNKNOWN_BLOCK', () => {
  withWorld((w) => {
    rules(w, (rs) => {
      const ok = rule(rs, 'tx-twin-signer');
      rs.push({ id: 'tx-twin-arch2', url: ARCH2, match: ['"tx_hash":"' + H.twin + '"'], body: ok.body });   // archival nodes ignore the signer
      ok.body = { jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { info: {}, name: 'UNKNOWN_BLOCK' } } };
      for (const id of ['tx-twin-owner', 'tx-twin-agent']) rule(rs, id).body = ok.body;
    });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.twin + ' \\(rpc ' + 'archival-rpc\\.testnet\\.near\\.org', 'm'));
  });
});

test('a hash that no source returns fails: the batch misses it, no account answers, no saved file', () => {
  withWorld((w) => {
    rules(w, (rs) => without(rs, 'tx-twin-signer'));
    dropSaved(w, H.twin);
    const r = run(w);
    assertFails(r, new RegExp('^FAIL near tx ' + H.twin + ': .*no source'));
    const tries = r.requests.filter((l) => l.includes('"method":"tx"') && l.includes(H.twin)).map((l) => l.split(' ')[0]);
    assert.deepEqual([...new Set(tries)], [ARCH1, ARCH2], 'both archival nodes are asked, FastNEAR first');
    assert.ok(tries.length >= 3);
    assert.ok(!r.requests.some((l) => l.includes('0x7eafcb38')), 'an EVM address is not a signer account');
  });
});

test('a node that does not answer at all is asked once per hash, not once per account (the archival hosts hang on an unknown hash)', () => {
  withWorld((w) => {
    rules(w, (rs) => {
      for (const id of ['tx-twin-owner', 'tx-twin-agent', 'tx-twin-signer']) { const r = rule(rs, id); delete r.body; r.throw = 'timeout'; }
    });
    const r = run(w);
    const tries = r.requests.filter((l) => l.includes('"method":"tx"') && l.includes(H.twin)).map((l) => l.split(' ')[0]);
    assert.deepEqual(tries, [ARCH1, ARCH2]);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.twin + ' \\(saved\\)', 'm'));
  });
});

test('the saved docs/evidence/near/<hash>.json is used when every node has dropped the history', () => {
  withWorld((w) => {
    rules(w, (rs) => without(rs, 'tx-twin-signer'));
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.twin + ' \\(saved\\)', 'm'));
  });
});

test('with the batch endpoint down, every hash falls back to RPC and then to the saved files', () => {
  withWorld((w) => {
    rules(w, (rs) => { const b = rule(rs, 'batch'); delete b.body; b.throw = 'connect ECONNREFUSED'; });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.mpc + ' \\(saved\\)', 'm'));
  });
});

test('a saved response that belongs to another transaction fails', () => {
  withWorld((w) => {
    const p = join('docs', 'evidence', 'near', H.twin + '.json');
    edit(w, p, (s) => swap(s, '"hash": "' + H.twin + '"', '"hash": "' + H.u01 + '"'));
    const r = run(w);
    assertFails(r, new RegExp('^FAIL near tx ' + H.twin + ': .*saved'));
    assert.ok(!new RegExp('^PASS near tx ' + H.twin, 'm').test(r.out), 'a rejected saved file is no pass, even with a live answer');
  });
});

test('a saved response that is missing is a WARN, not a FAIL', () => {
  withWorld((w) => {
    dropSaved(w, H.u01);
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp('^WARN saved response: docs/evidence/near/' + H.u01 + '\\.json is missing', 'm'));
    assert.equal(lastLine(r.out), 'EVIDENCE OK 8 links checked');
  });
});

test('a batch entry whose hash is not the one asked for is not used', () => {
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.u01).transaction.hash = H.esc; });
    dropSaved(w, H.u01);
    assertFails(run(w), new RegExp('^FAIL near tx ' + H.u01 + ': '));
  });
});

// the real MPC signature

test('a row without a signer outcome fails; one whose signer outcome carries no response fails', () => {
  withWorld((w) => {
    rules(w, (rs) => { const t = batchTx(rs, H.mpc); t.receipts = t.receipts.filter((r: any) => r.execution_outcome.outcome.executor_id !== 'v1.signer-prod.testnet'); });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signer outcome: /);
  });
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.mpc).receipts[2].execution_outcome.outcome.status = { SuccessValue: '' }; });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signer outcome: /);
  });
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.mpc).receipts[2].execution_outcome.outcome.status = { SuccessValue: Buffer.from('{"nope":1}').toString('base64') }; });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signer outcome: /);
  });
});

test('without a signed event the real MPC row fails; a signed event of another standard does not count', () => {
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.mpc).receipts[3].execution_outcome.outcome.logs = []; });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signed event: /);
  });
  withWorld((w) => {
    rules(w, (rs) => {
      const o = batchTx(rs, H.mpc).receipts[3].execution_outcome.outcome;
      o.logs = o.logs.map((l: string) => l.replace('"standard":"airlock"', '"standard":"other"'));
    });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signed event: /);
  });
  withWorld((w) => {
    rules(w, (rs) => {
      const o = batchTx(rs, H.mpc).receipts[3].execution_outcome.outcome;
      o.logs = o.logs.map((l: string) => l.replace('"event":"signed"', '"event":"failed"'));
    });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signed event: /);
  });
});

test('a failed transaction cannot be the real MPC signature', () => {
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.mpc).receipts[0].execution_outcome.outcome.status = { Failure: { ActionError: {} } }; });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signer outcome: .*failed/);
  });
});

test('a Base Sepolia receipt with status 0x0 fails', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'base-receipt').body.result.status = '0x0'; });
    assertFails(run(w), new RegExp('^FAIL base tx ' + BASE + ': .*0x0'));
  });
});

test('a Base Sepolia transaction sent from another address than the derived one fails', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'base-receipt').body.result.from = '0x000000000000000000000000000000000000dead'; });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr Base sender: .*dead/);
  });
});

test('the sender is compared without regard to the case of the address', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'base-receipt').body.result.from = DERIVED.replace('0x16c089', '0x16C089').replace('aad8', 'AAD8'); });
    assert.equal(run(w).code, 0);
  });
});

test('a Base receipt that no node returns fails; the second node is tried when the first has none', () => {
  withWorld((w) => {
    rules(w, (rs) => without(rs, 'base-receipt'));
    assertFails(run(w), new RegExp('^FAIL base tx ' + BASE + ': .*no receipt'));
  });
  withWorld((w) => {
    rules(w, (rs) => {
      const r = rule(rs, 'base-receipt');
      rs.push({ id: 'base-publicnode', url: 'https://base-sepolia-rpc.publicnode.com', match: r.match, body: r.body });
      r.body = { jsonrpc: '2.0', id: 1, result: null };
    });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    const base = r.requests.filter((l) => l.includes('eth_getTransactionReceipt')).map((l) => l.split(' ')[0]);
    assert.deepEqual(base.slice(0, 2), ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com']);
  });
  withWorld((w) => {
    rules(w, (rs) => {
      const r = rule(rs, 'base-receipt');
      rs.push({ id: 'base-publicnode', url: 'https://base-sepolia-rpc.publicnode.com', match: r.match, body: r.body });
      delete r.body; r.throw = 'fetch failed';
    });
    assert.equal(run(w).code, 0);
  });
});

test('a missing scripts/derive-address.mjs is a FAIL that names the script, never a crash', () => {
  withWorld((w) => {
    rmSync(join(w.root, 'scripts', 'derive-address.mjs'));
    const r = run(w);
    assertFails(r, /^FAIL derived address row: scripts\/derive-address\.mjs is missing/);
    assertFails(r, /^FAIL real MPC GDXXqKfr Base sender: .*scripts\/derive-address\.mjs/);
    assert.ok(!/\bat .*evidence-check\.ts:\d+/.test(r.out), r.out);
    assert.match(lastLine(r.out), /^EVIDENCE FAILED \d+ failures/);
    assert.match(r.out, /^PASS wasm sha256/m);
  });
});

test('a derive-address.mjs that exits 1 is a FAIL that names the script; a row that differs from the derived address fails', () => {
  withWorld((w) => {
    writeFileSync(join(w.root, 'scripts', 'derive-address.mjs'), 'console.error("chainsig.js not found"); process.exit(1);\n');
    assertFails(run(w), /^FAIL derived address row: .*scripts\/derive-address\.mjs.*chainsig\.js not found/);
  });
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Derived Base Sepolia address | Base Sepolia | ' + DERIVED, '| Derived Base Sepolia address | Base Sepolia | ' + SPIKE_ADDRESS));
    assertFails(run(w), /^FAIL derived address row: /);
  });
});

test('the derived address is computed for the policy account of the row and the path airlock-demo-1', () => {
  withWorld((w) => {
    writeFileSync(join(w.root, 'scripts', 'derive-address.mjs'),
      'const [a, p] = process.argv.slice(2); console.log(a === "' + POLICY + '" && p === "airlock-demo-1" ? "' + DERIVED + '" : "0x" + "1".repeat(40));\n');
    assert.equal(run(w).code, 0);
  });
});

test('every row of Real MPC whose link is a Base Sepolia transaction is checked; no such row fails', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, nb(H.mpc) + ' then ' + bs(BASE), nb(H.mpc)));
    assertFails(run(w), /^FAIL real MPC row: /);
  });
});

// the world under rung 9: the spike row with its own address, the marker, a spike transaction without a signed event
function rung9(w: World, bullet = false): void {
  evidence(w, (s) => swap(s, '| Real MPC signature | NEAR testnet and Base Sepolia | ' + nb(H.mpc) + ' then ' + bs(BASE),
    '| ' + SPIKE_LABEL + ' | NEAR testnet and Base Sepolia | ' + nb(H.mpc) + ' then ' + bs(BASE) + ' from ' + SPIKE_ADDRESS));
  evidence(w, (s) => s.replace('## Real MPC (AIR-102)\n', '## Real MPC (AIR-102)\n\n' + RUNG9 + '\n'));
  if (bullet) evidence(w, (s) => swap(s, '| ' + SPIKE_LABEL + ' | NEAR testnet and Base Sepolia | ', '- ' + SPIKE_LABEL + ': ').replace(' | 2026-11-07 |', ''));
  rules(w, (rs) => {
    batchTx(rs, H.mpc).receipts[3].execution_outcome.outcome.logs = [];
    rule(rs, 'base-receipt').body.result.from = SPIKE_ADDRESS;
  });
}

test('rung 9: the spike row passes with its own address and without a signed event; the label is required', () => {
  withWorld((w) => {
    rung9(w);
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^PASS real MPC GDXXqKfr Base sender/m);
    assert.ok(!/signed event/.test(r.out.split('\n').filter((l) => l.startsWith('FAIL')).join('\n')));
  });
  withWorld((w) => {
    rung9(w);
    evidence(w, (s) => swap(s, '| ' + SPIKE_LABEL + ' |', '| Real MPC signature |'));
    assertFails(run(w), /^FAIL real MPC row: .*rung 9/);
  });
  withWorld((w) => {
    rung9(w);
    evidence(w, (s) => swap(s, ' from ' + SPIKE_ADDRESS, ''));
    assertFails(run(w), /^FAIL real MPC GDXXqKfr Base sender: .*address/);
  });
  withWorld((w) => {
    rung9(w);
    rules(w, (rs) => { rule(rs, 'base-receipt').body.result.from = DERIVED; });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr Base sender: /);
  });
  withWorld((w) => {
    rung9(w);
    rules(w, (rs) => { batchTx(rs, H.mpc).receipts = batchTx(rs, H.mpc).receipts.filter((r: any) => r.execution_outcome.outcome.executor_id !== 'v1.signer-prod.testnet'); });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signer outcome: /);
  });
});

test('without rung 9 a row labelled as the spike contract fails', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Real MPC signature |', '| ' + SPIKE_LABEL + ' |'));
    assertFails(run(w), /^FAIL real MPC row: .*rung 9/);
  });
});

// the MPC contract rows

test('a live MPC version newer than the newest row fails', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'version').body.result.result = Array.from(Buffer.from('"3.18.0"')); });
    assertFails(run(w), /^FAIL MPC version: .*3\.18\.0.*3\.17\.0/);
  });
});

test('the newest row by date decides, wherever it stands in the file', () => {
  withWorld((w) => {   // the older row says 3.18.0, the newest says 3.17.0 and the chain says 3.17.0: pass
    evidence(w, (s) => swap(s, '| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-01 |', '| MPC contract version | NEAR testnet | 3.18.0 | 2026-11-01 |'));
    assert.equal(run(w).code, 0);
  });
  withWorld((w) => {   // the newest row says 3.18.0, the chain says 3.17.0: fail
    evidence(w, (s) => swap(s, '| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-08 |', '| MPC contract version | NEAR testnet | 3.18.0 | 2026-11-08 |'));
    assertFails(run(w), /^FAIL MPC version: /);
  });
  withWorld((w) => {   // the newest row first in the file
    evidence(w, (s) => {
      s = swap(s, '| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-01 |\n| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-08 |',
        '| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-08 |\n| MPC contract version | NEAR testnet | 3.18.0 | 2026-11-01 |');
      return s;
    });
    assert.equal(run(w).code, 0);
  });
});

test('a code hash change with the same version is a WARN and the run still passes', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'view-mpc').body.result.code_hash = H.u01; });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^WARN MPC code hash: .*DAE5ng4Z/m);
    assert.equal(lastLine(r.out), 'EVIDENCE OK 8 links checked');
  });
});

test('a version change fails even when the code hash is the same; an MPC node that cannot be read fails', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'version').body.result.result = Array.from(Buffer.from('"3.17.1"')); });
    assertFails(run(w), /^FAIL MPC version: /);
  });
  withWorld((w) => {
    rules(w, (rs) => without(rs, 'version'));
    assertFails(run(w), /^FAIL MPC version: .*no node answered/);
  });
  withWorld((w) => {
    rules(w, (rs) => without(rs, 'view-mpc'));
    assertFails(run(w), /^FAIL MPC code hash: .*no node answered/);
  });
});

test('the MPC rows must exist: no version row fails, no code hash row fails', () => {
  withWorld((w) => {
    evidence(w, (s) => s.split('\n').filter((l) => !l.startsWith('| MPC contract version |')).join('\n'));
    assertFails(run(w), /^FAIL row MPC contract version: /);
  });
  withWorld((w) => {
    evidence(w, (s) => s.split('\n').filter((l) => !l.startsWith('| MPC contract code hash |')).join('\n'));
    assertFails(run(w), /^FAIL row MPC contract code hash: /);
  });
});

// sections, rows, text

test('every heading of acceptance check 6 and the AIR-165 heading is required', () => {
  for (const h of ['## Deployed ids and hashes', '## Real MPC (AIR-102)', '## Testnet end to end (AIR-165)', '## Golden runs (AIR-166)', '## Wallet matrix', '## Toolchain', '## Differential', '## Video links', '## Model choice']) {
    withWorld((w) => {
      evidence(w, (s) => swap(s, h + '\n', h + ' (renamed)\n'));
      assertFails(run(w), new RegExp('^FAIL heading ' + h.replace(/[()]/g, '\\$&') + ': '));
    });
  }
});

test('the first cells of the deployed table and of the model rows are required, each once found by its first cell', () => {
  for (const label of ['Policy contract account', 'Code hash (base58)', 'Wasm sha256', 'Deploy transaction', 'Derived Base Sepolia address', 'Planner and vanilla model', 'Quarantine model']) {
    withWorld((w) => {
      evidence(w, (s) => s.split('\n').filter((l) => !l.startsWith('| ' + label + ' |')).join('\n'));
      assertFails(run(w), new RegExp('^FAIL row ' + label.replace(/[()]/g, '\\$&') + ': '));
    });
  }
});

test('a row in the wrong section is not found: the deployed rows are read from their own section', () => {
  withWorld((w) => {
    evidence(w, (s) => {
      const line = '| Wasm sha256 | local build | ' + WASM_HEX + ' | 2026-11-06 |\n';
      return swap(s, line, '').replace('## Toolchain\n', '## Toolchain\n\n' + line);
    });
    assertFails(run(w), /^FAIL row Wasm sha256: /);
  });
});

test('a Model choice section with a percent sign fails; so does a missing or doubled planner line', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, 'chosen on benign task success first', 'chosen at 90% on benign task success first'));
    assertFails(run(w), /^FAIL model choice: .*%/);
  });
  withWorld((w) => {
    evidence(w, (s) => swap(s, 'planner model: fixture-planner-model, chosen', 'planner model:fixture-planner-model, chosen'));
    assertFails(run(w), /^FAIL model choice: .*planner model/);
  });
  withWorld((w) => {
    evidence(w, (s) => s + 'planner model: a second line\n');
    assertFails(run(w), /^FAIL model choice: .*planner model/);
  });
  withWorld((w) => {
    evidence(w, (s) => swap(s, 'vanilla models: fixture-vanilla-model.\n', ''));
    assertFails(run(w), /^FAIL model choice: .*vanilla models/);
  });
  withWorld((w) => {
    evidence(w, (s) => swap(s, 'quarantine model: fixture-quarantine-model.\n', ''));
    assertFails(run(w), /^FAIL model choice: .*quarantine model/);
  });
});

test('a percent sign above the Model choice heading is fine', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, 'identical on 40000 cases', 'identical on 40000 cases (100% of them)'));
    assert.equal(run(w).code, 0);
  });
});

test('Model choice must be the last section; a section inserted above it passes', () => {
  withWorld((w) => {
    evidence(w, (s) => s + '\n## G5 fresh clone\n\nsomething\n');
    assertFails(run(w), /^FAIL model choice last section: .*G5 fresh clone/);
  });
  withWorld((w) => {
    evidence(w, (s) => s.replace('## Model choice', '## G5 fresh clone\n\nsomething\n\n## Model choice'));
    assert.equal(run(w).code, 0);
  });
});

test('a TODO line or the skeleton placeholder fails and names the line', () => {
  withWorld((w) => {
    evidence(w, (s) => s.replace('## Toolchain\n', '## Toolchain\n\nTODO fill the table\n'));
    assertFails(run(w), /^FAIL placeholder text: line \d+ /);
  });
  withWorld((w) => {
    evidence(w, (s) => s.replace('## Toolchain\n', '## Toolchain\n\n_To fill during the build: the table_\n'));
    assertFails(run(w), /^FAIL placeholder text: line \d+ /);
  });
});

test('every link of the Video links section must also be in an earlier section', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '- ' + nb(H.tamper) + '\n', '- ' + nb(H.tamper) + '\n- https://sepolia.basescan.org/tx/0x' + 'ab'.repeat(32) + '\n'));
    assertFails(run(w), /^FAIL video links in earlier sections: .*0xabab/);
  });
  withWorld((w) => {   // a URL that is not an explorer link is held to the same rule
    evidence(w, (s) => swap(s, '- ' + nb(H.tamper) + '\n', '- ' + nb(H.tamper) + '\n- https://example.org/page\n'));
    assertFails(run(w), /^FAIL video links in earlier sections: .*example\.org/);
  });
});

// screenshots

test('a wallet row whose screenshot file is missing fails', () => {
  withWorld((w) => {
    rmSync(join(w.root, 'docs/evidence-screenshots/wallet-meteor-signed.png'));
    assertFails(run(w), /^FAIL screenshot wallet-meteor-signed\.png: .*missing/);
  });
});

test('a screenshot that is not a PNG fails', () => {
  withWorld((w) => {
    writeFileSync(join(w.root, 'docs/evidence-screenshots/wallet-meteor-signed.png'), 'not an image');
    assertFails(run(w), /^FAIL screenshot wallet-meteor-signed\.png: .*PNG/);
  });
});

test('fewer than four referenced screenshots fail; so do a missing wallet and a file nobody references', () => {
  withWorld((w) => {
    evidence(w, (s) => s.split('\n').filter((l) => !l.includes('wallet-meteor-signed.png')).join('\n'));
    rmSync(join(w.root, 'docs/evidence-screenshots/wallet-meteor-signed.png'));
    assertFails(run(w), /^FAIL screenshots: .*3/);
  });
  withWorld((w) => {   // four screenshots, all Intear
    evidence(w, (s) => s.replace(/wallet-meteor-(review|signed)\.png/g, (m) => m.replace('meteor', 'intear').replace('review', 'extra1').replace('signed', 'extra2')));
    for (const [a, b] of [['meteor-review', 'intear-extra1'], ['meteor-signed', 'intear-extra2']]) renameSync(join(w.root, `docs/evidence-screenshots/wallet-${a}.png`), join(w.root, `docs/evidence-screenshots/wallet-${b}.png`));
    assertFails(run(w), /^FAIL screenshots: .*Meteor/);
  });
  withWorld((w) => {
    writeFileSync(join(w.root, 'docs/evidence-screenshots/wallet-intear-stray.png'), readFileSync(join(w.root, 'docs/evidence-screenshots/wallet-intear-review.png')));
    assertFails(run(w), /^FAIL screenshot wallet-intear-stray\.png: .*not referenced/);
  });
});

// flags

test('--selftest flips one hex character of a hash in memory, needs no tree and no network, and prints the ticket line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ev243-self-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--selftest'], { encoding: 'utf8', cwd: dir, env: { ...process.env, EVIDENCE_FETCH_FIXTURE: join(dir, 'none.json') } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lastLine(r.stdout), 'SELFTEST ok (altered hash failed)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--video-links fails for an explorer URL missing from docs/EVIDENCE.md and passes when every one is there', () => {
  withWorld((w) => {
    const f = join(w.dir, 'shots.md');
    writeFileSync(f, ['| S05 | ' + nb(H.mpc) + ' |', 'RUN open ' + bs(BASE) + '.', 'see https://github.com/example/repo and https://example.org/x', ''].join('\n'));
    const ok = run(w, ['--video-links', f]);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(lastLine(ok.out), 'EVIDENCE OK 2 links checked');
    assert.equal(ok.requests.length, 0, 'the video link check is offline');
    writeFileSync(f, 'shown: ' + nb(H.mpc) + ' and ' + nb('4' + H.mpc.slice(1)) + '\n');
    const bad = run(w, ['--video-links', f]);
    assertFails(bad, new RegExp('^FAIL video link ' + nb('4' + H.mpc.slice(1)).replace(/\./g, '\\.') + ': .*not in docs/EVIDENCE\\.md'));
    assert.match(bad.out, new RegExp('^PASS video link ' + nb(H.mpc).replace(/\./g, '\\.'), 'm'));
    assert.match(lastLine(bad.out), /^EVIDENCE FAILED 1 failure/);
  });
});

test('--video-links: a basescan hash is compared without regard to case, a trailing period is not part of the URL', () => {
  withWorld((w) => {
    const f = join(w.dir, 'shots.md');
    writeFileSync(f, 'open `' + bs(BASE.replace('0xdb8e', '0xDB8E')) + '`, then ' + nb(H.mpc) + '.\n');
    const r = run(w, ['--video-links', f]);
    assert.equal(r.code, 0, r.out);
  });
});

test('--video-links with a missing file or a missing EVIDENCE.md exits 2', () => {
  withWorld((w) => {
    const r = run(w, ['--video-links', join(w.dir, 'nope.md')]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /^INPUT MISSING .*nope\.md/m);
    rmSync(join(w.root, 'docs', 'EVIDENCE.md'));
    writeFileSync(join(w.dir, 'x.md'), 'x\n');
    const r2 = run(w, ['--video-links', join(w.dir, 'x.md')]);
    assert.equal(r2.code, 2, r2.out);
    assert.match(r2.out, /^INPUT MISSING .*EVIDENCE\.md/m);
  });
});

test('a missing docs/EVIDENCE.md exits 2 and an unknown flag exits 2', () => {
  withWorld((w) => {
    assert.equal(run(w, ['--nonsense']).code, 2);
    rmSync(join(w.root, 'docs', 'EVIDENCE.md'));
    const r = run(w);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /^INPUT MISSING .*EVIDENCE\.md/m);
  });
});

test('the last line is EVIDENCE FAILED when anything failed, so acceptance check 1 cannot read it as OK', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Wasm sha256 | local build | 4613', '| Wasm sha256 | local build | 5613'));
    const r = run(w);
    assert.match(lastLine(r.out), /^EVIDENCE FAILED 1 failure, 8 links checked$/);
  });
});

test('the fetch seam: a request with no canned answer is a network error, not a pass', () => {
  withWorld((w) => {
    rules(w, () => []);
    for (const h of Object.values(H)) dropSaved(w, h);
    const r = run(w);
    assert.equal(r.code, 1, r.out);
    assert.ok(failing(r.out).length >= 10, r.out);
  });
});

test('every request goes out as a JSON POST', () => {
  withWorld((w) => {
    const r = run(w);
    assert.ok(r.requests.length > 5);
    assert.ok(r.requests.every((l) => /^https:\/\/\S+ \{/.test(l)), r.requests.join('\n'));
  });
});

// further cases found by mutating the checker

test('a hash whose base58 starts with 1 (a leading zero byte) is a valid transaction hash', () => {
  withWorld((w) => {
    const h = '1' + H.u01.slice(1, 43);   // 43 characters of which the first is a zero byte: 32 bytes
    assert.equal(h.length, 43);
    evidence(w, (s) => s.replace('## Model choice', '## Extra\n\n' + nb(h) + '\n\n## Model choice'));
    rules(w, (rs) => {
      const tx = JSON.parse(JSON.stringify(batchTx(rs, H.u01)));
      tx.transaction.hash = h;
      rule(rs, 'batch').body.transactions.push(tx);
    });
    const r = run(w);
    assert.match(r.out, new RegExp('^PASS near tx ' + h + ' \\(batch\\)', 'm'), r.out);
  });
});

test('an RPC answer for another transaction is not accepted', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'tx-twin-signer').body.result.transaction.hash = H.u01; });
    const r = run(w);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.twin + ' \\(saved\\)', 'm'), r.out);
    dropSaved(w, H.twin);
    assertFails(run(w), new RegExp('^FAIL near tx ' + H.twin + ': .*no source'));
  });
});

test('the real MPC transaction read through RPC (the receipts_outcome shape) is judged like one from the batch', () => {
  withWorld((w) => {
    rules(w, (rs) => serveByRpc(rs, H.mpc));
    dropSaved(w, H.mpc);
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^PASS real MPC GDXXqKfr signer outcome/m);
    assert.match(r.out, /^PASS real MPC GDXXqKfr signed event/m);
  });
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.mpc).receipts[3].execution_outcome.outcome.logs = []; serveByRpc(rs, H.mpc); });
    dropSaved(w, H.mpc);
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signed event: /);
  });
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.deploy).receipts[0].execution_outcome.outcome.status = { Failure: { ActionError: {} } }; serveByRpc(rs, H.deploy); });
    dropSaved(w, H.deploy);
    assertFails(run(w), /^FAIL deploy transaction: .*failed/);
  });
});

test('a signature response executed by another account does not count; neither does a signed event with an empty request id', () => {
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.mpc).receipts[2].execution_outcome.outcome.executor_id = 'someone.testnet'; });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signer outcome: /);
  });
  withWorld((w) => {
    rules(w, (rs) => {
      const o = batchTx(rs, H.mpc).receipts[3].execution_outcome.outcome;
      o.logs = o.logs.map((l: string) => l.replace('"request_id":"mpc-1:0"', '"request_id":""'));
    });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signed event: /);
  });
  withWorld((w) => {   // a log line that is not JSON after the marker is skipped, the real event after it still counts
    rules(w, (rs) => { const o = batchTx(rs, H.mpc).receipts[3].execution_outcome.outcome; o.logs = ['EVENT_JSON:{broken', ...o.logs]; });
    assert.equal(run(w).code, 0);
  });
});

test('a node that answers a view with a JSON-RPC error, or with an error inside the result, is skipped for the next node', () => {
  withWorld((w) => {
    rules(w, (rs) => {
      const v = rule(rs, 'view-policy');
      rs.push({ id: 'view-policy-drpc', url: 'https://near-testnet.drpc.org', match: v.match, body: v.body });
      v.body = { jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { info: {}, name: 'UNKNOWN_BLOCK' } } };
    });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    const asked = r.requests.filter((l) => l.includes('"request_type":"view_account"') && l.includes(POLICY)).map((l) => l.split(' ')[0]);
    assert.deepEqual(asked, [REGULAR, 'https://near-testnet.drpc.org']);
  });
  withWorld((w) => {
    rules(w, (rs) => {
      const v = rule(rs, 'view-policy');
      rs.push({ id: 'view-policy-drpc', url: 'https://near-testnet.drpc.org', match: v.match, body: v.body });
      v.body = { jsonrpc: '2.0', id: 1, result: { error: 'unavailable', logs: [] } };
    });
    assert.equal(run(w).code, 0);
  });
  withWorld((w) => {   // an HTTP error status from the node is a network error too
    rules(w, (rs) => {
      const v = rule(rs, 'view-policy');
      rs.push({ id: 'view-policy-drpc', url: 'https://near-testnet.drpc.org', match: v.match, body: v.body });
      delete v.body; v.status = 429;
    });
    assert.equal(run(w).code, 0);
  });
});

test('a value of the accounts file that is not a NEAR account id is never tried as a signer', () => {
  withWorld((w) => {
    const long = 'a'.repeat(65);
    edit(w, 'fixtures/accounts.testnet.json', (s) => swap(s, '"owner"', '"note": "Not An Account!",\n  "one": "a",\n  "long": "' + long + '",\n  "owner"'));
    rules(w, (rs) => without(rs, 'tx-twin-signer'));
    dropSaved(w, H.twin);
    const r = run(w);
    for (const bad of ['Not An Account', '"sender_account_id":"a"', long]) assert.ok(!r.requests.some((l) => l.includes(bad)), bad + '\n' + r.requests.join('\n'));
  });
});

test('the wasm digest in the row must be lowercase hex; backticks around it are fine', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Wasm sha256 | local build | ' + WASM_HEX, '| Wasm sha256 | local build | ' + WASM_HEX.toUpperCase()));
    assertFails(run(w), /^FAIL wasm sha256: .*lowercase/);
  });
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Wasm sha256 | local build | ' + WASM_HEX, '| Wasm sha256 | local build | `' + WASM_HEX + '`'));
    assert.equal(run(w).code, 0);
  });
});

test('a base58 row with the wrong number of characters is not a hash', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Code hash (base58) | NEAR testnet | 5iYSgYQ', '| Code hash (base58) | NEAR testnet | 5iY'));
    assertFails(run(w), /^FAIL code hash row: .*no base58 hash/);
  });
});

test('a golden file that is not JSON fails and a golden file without contractId fails', () => {
  withWorld((w) => {
    writeFileSync(join(w.root, 'bench/golden/broken.json'), '{not json');
    assertFails(run(w), /^FAIL golden contractId: .*broken\.json/);
  });
  withWorld((w) => {
    writeFileSync(join(w.root, 'bench/golden/none.json'), '{"version":1}');
    assertFails(run(w), /^FAIL golden contractId: .*none\.json/);
  });
  withWorld((w) => {   // a file that is not .json is not a golden file
    writeFileSync(join(w.root, 'bench/golden/notes.txt'), 'not a golden run');
    assert.equal(run(w).code, 0);
  });
});

test('a Base link that is not a 64 hex transaction hash fails without a request', () => {
  withWorld((w) => {
    evidence(w, (s) => s.replace('## Model choice', '## Extra\n\nhttps://sepolia.basescan.org/tx/0xabc123\n\n## Model choice'));
    const r = run(w);
    assertFails(r, /^FAIL base tx 0xabc123: .*not a transaction hash/);
    assert.ok(!r.requests.some((l) => l.includes('0xabc123')));
  });
});

test('a Base receipt that is missing fails the sender check too', () => {
  withWorld((w) => {
    rules(w, (rs) => without(rs, 'base-receipt'));
    assertFails(run(w), /^FAIL real MPC GDXXqKfr Base sender: .*no receipt/);
  });
});

test('the derived address is computed once however many items need it', () => {
  withWorld((w) => {
    const count = join(w.dir, 'derive.count');
    writeFileSync(join(w.root, 'scripts', 'derive-address.mjs'),
      'import { appendFileSync } from "node:fs"; appendFileSync(' + JSON.stringify(count) + ', "x\\n"); console.log("' + DERIVED + '");\n');
    assert.equal(run(w).code, 0);
    assert.equal(readFileSync(count, 'utf8').split('\n').filter((l) => l !== '').length, 1);
  });
});

test('a derive-address.mjs that prints no address is a FAIL that names the script', () => {
  withWorld((w) => {
    writeFileSync(join(w.root, 'scripts', 'derive-address.mjs'), 'console.log("hello");\n');
    assertFails(run(w), /^FAIL derived address row: .*scripts\/derive-address\.mjs printed no 0x address/);
  });
});

test('of two rows with the same date the later one in the file is the newest; a row without a date fails', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-01 |', '| MPC contract version | NEAR testnet | 3.18.0 | 2026-11-08 |'));
    assert.equal(run(w).code, 0);
  });
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-01 |', '| MPC contract version | NEAR testnet | 3.17.0 | the first of November |'));
    assertFails(run(w), /^FAIL MPC version: .*line \d+ has no YYYY-MM-DD date/);
  });
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| MPC contract code hash | NEAR testnet | ' + MPC_HASH + ' | 2026-11-01 |', '| MPC contract code hash | NEAR testnet | ' + MPC_HASH + ' |  |'));
    assertFails(run(w), /^FAIL MPC code hash: .*line \d+ has no YYYY-MM-DD date/);
  });
});

test('a version row without x.y.z and a code hash row without a hash fail', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-08 |', '| MPC contract version | NEAR testnet | latest | 2026-11-08 |'));
    assertFails(run(w), /^FAIL MPC version: .*no x\.y\.z/);
  });
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| MPC contract code hash | NEAR testnet | ' + MPC_HASH + ' | 2026-11-08 |', '| MPC contract code hash | NEAR testnet | unknown | 2026-11-08 |'));
    assertFails(run(w), /^FAIL MPC code hash: .*no base58/);
  });
});

test('the live version may come back as plain text instead of a JSON string', () => {
  withWorld((w) => {
    rules(w, (rs) => { rule(rs, 'version').body.result.result = Array.from(Buffer.from('3.17.0')); });
    assert.equal(run(w).code, 0);
  });
});

test('files in docs/evidence-screenshots that are not PNG names are ignored', () => {
  withWorld((w) => {
    writeFileSync(join(w.root, 'docs/evidence-screenshots/notes.txt'), 'x');
    writeFileSync(join(w.root, 'docs/evidence-screenshots/.DS_Store'), 'x');
    assert.equal(run(w).code, 0);
  });
});

test('a batch endpoint that answers HTTP 500 is a network error: the saved files take over', () => {
  withWorld((w) => {
    rules(w, (rs) => { const b = rule(rs, 'batch'); delete b.body; b.status = 500; });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.mpc + ' \\(saved\\)', 'm'));
  });
});

test('a flag without its value is a usage error', () => {
  withWorld((w) => {
    for (const flag of ['--root', '--video-links']) {
      const r = spawnSync(process.execPath, [SCRIPT, flag], { encoding: 'utf8' });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout, /^usage: /m);
    }
  });
});

// round two: survivors of the mutation check

test('a markdown link in a cell counts as its text', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Policy contract account | NEAR testnet | ' + POLICY + ' |',
      '| Policy contract account | NEAR testnet | [' + POLICY + '](https://example.org/where) |'));
    evidence(w, (s) => swap(s, '| Wasm sha256 | local build | ' + WASM_HEX + ' |', '| [Wasm sha256](https://example.org/a) | local build | [' + WASM_HEX + '](https://example.org/b) |'));
    const r = run(w);
    assert.equal(r.code, 0, r.out);
  });
});

test('--video-links: a trailing slash is not part of the URL, a URL shown twice is checked once', () => {
  withWorld((w) => {
    const f = join(w.dir, 'shots.md');
    writeFileSync(f, nb(H.mpc) + '/\n' + nb(H.mpc) + '\n');
    const r = run(w, ['--video-links', f]);
    assert.equal(r.code, 0, r.out);
    assert.equal(lastLine(r.out), 'EVIDENCE OK 1 links checked');
  });
});

test('a heading with trailing spaces is still the heading', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '## Wallet matrix\n', '## Wallet matrix   \n'));
    assert.equal(run(w).code, 0);
  });
});

test('a sub-heading does not end a section', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '## Wallet matrix\n', '## Wallet matrix\n\n### Intear and Meteor\n'));
    assert.equal(run(w).code, 0);
  });
});

test('the saved file may be the batch envelope or an RPC tx answer with its JSON-RPC envelope', () => {
  withWorld((w) => {
    const p = join(w.root, 'docs', 'evidence', 'near', H.u01 + '.json');
    writeFileSync(p, JSON.stringify({ transactions: [JSON.parse(readFileSync(p, 'utf8'))] }));
    rules(w, (rs) => { const b = rule(rs, 'batch'); delete b.body; b.throw = 'down'; });
    const r = run(w);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.u01 + ' \\(saved\\)', 'm'), r.out);
  });
  withWorld((w) => {
    const p = join(w.root, 'docs', 'evidence', 'near', H.twin + '.json');
    writeFileSync(p, JSON.stringify({ jsonrpc: '2.0', id: 1, result: JSON.parse(readFileSync(p, 'utf8')) }));
    rules(w, (rs) => without(rs, 'tx-twin-signer'));
    const r = run(w);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.twin + ' \\(saved\\)', 'm'), r.out);
  });
});

test('a failure at the level of the transaction itself counts, in both shapes', () => {
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.deploy).execution_outcome.outcome.status = { Failure: { InvalidTxError: 'x' } }; });
    assertFails(run(w), /^FAIL deploy transaction: .*failed/);
  });
  withWorld((w) => {
    rules(w, (rs) => { batchTx(rs, H.deploy).execution_outcome.outcome.status = { Failure: { InvalidTxError: 'x' } }; serveByRpc(rs, H.deploy); });
    dropSaved(w, H.deploy);
    assertFails(run(w), /^FAIL deploy transaction: .*failed/);
  });
});

test('a log line that only looks like an event does not count', () => {
  withWorld((w) => {
    rules(w, (rs) => {
      const o = batchTx(rs, H.mpc).receipts[3].execution_outcome.outcome;
      o.logs = o.logs.map((l: string) => l.replace('EVENT_JSON:', 'EVENT_JSOX:'));
    });
    assertFails(run(w), /^FAIL real MPC GDXXqKfr signed event: /);
  });
});

test('the placeholder line number is the line of the file', () => {
  withWorld((w) => {
    evidence(w, (s) => s + '\nTODO later\n');
    const lines = readFileSync(join(w.root, 'docs/EVIDENCE.md'), 'utf8').split('\n');
    const n = lines.findIndex((l) => l === 'TODO later') + 1;
    assertFails(run(w), new RegExp('^FAIL placeholder text: line ' + n + ' contains TODO'));
  });
});

test('the skeleton sentence is found in any case', () => {
  withWorld((w) => {
    evidence(w, (s) => s.replace('## Toolchain\n', '## Toolchain\n\nto fill during the build\n'));
    assertFails(run(w), /^FAIL placeholder text: /);
  });
});

function b58(bytes: Buffer): string {   // an independent encoder for the leading zero case: one 1 per leading zero byte
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + bytes.toString('hex'));
  let s = '';
  while (n > 0n) { s = alphabet[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

test('a wasm digest that starts with a zero byte converts to base58 with a leading 1', () => {
  withWorld((w) => {
    let wasm = Buffer.alloc(0);
    for (let i = 0; ; i++) {
      wasm = Buffer.from('leading zero wasm ' + i);
      if (createHash('sha256').update(wasm).digest()[0] === 0) break;
    }
    const d = createHash('sha256').update(wasm).digest();
    const enc = b58(d);
    assert.ok(enc.startsWith('1'));
    writeFileSync(join(w.root, 'contracts/airlock-policy/res/airlock_policy.wasm'), wasm);
    evidence(w, (s) => s.replace(WASM_HEX, d.toString('hex')).replace(WASM_B58, enc));
    rules(w, (rs) => {
      rule(rs, 'view-policy').body.result.code_hash = enc;
      batchTx(rs, H.deploy).transaction.actions[0].DeployContract.code = d.toString('base64');
    });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^PASS code hash row/m);
    assert.match(r.out, /^PASS on-chain code hash/m);
  });
});

test('a hash with a character outside the base58 alphabet is not a hash, even when the rest is 32 bytes long', () => {
  withWorld((w) => {
    const bad = H.u01.slice(0, 20) + '0' + H.u01.slice(21);
    evidence(w, (s) => s.replace('## Model choice', '## Extra\n\n' + nb(bad) + '\n\n## Model choice'));
    const r = run(w);
    assert.match(r.out, new RegExp('^FAIL near tx ' + bad + ': .*not a transaction hash', 'm'));
    assert.ok(!r.requests.some((l) => l.includes(bad)));
  });
});

test('every account of the file is tried in order on a node that answers, once each, an EVM address never', () => {
  withWorld((w) => {
    edit(w, 'fixtures/accounts.testnet.json', (s) => swap(s, '"agent"', '"owner_again": "fixture-owner.testnet",\n  "agent"'));
    rules(w, (rs) => {
      const unknown = { jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { info: {}, name: 'UNKNOWN_TRANSACTION' } } };
      const keep = rs.filter((r) => !(r.id ?? '').startsWith('tx-twin'));
      keep.push({ id: 'any1', url: ARCH1, match: ['"tx_hash":"' + H.twin + '"'], body: unknown }, { id: 'any2', url: ARCH2, match: ['"tx_hash":"' + H.twin + '"'], body: unknown });
      return keep;
    });
    dropSaved(w, H.twin);
    const r = run(w);
    const asked = r.requests.filter((l) => l.startsWith(ARCH1 + ' ') && l.includes(H.twin)).map((l) => /"sender_account_id":"([^"]+)"/.exec(l)?.[1]);
    assert.deepEqual(asked, ['fixture-owner.testnet', 'fixture-agent.testnet', 'fixture-twin-vanilla.testnet', 'fixture-twin-allow.testnet', 'fixture-sponsor.testnet',
      POLICY, 'accountant.fixture-owner.testnet', 'landlord.fixture-owner.testnet', 'sam.fixture-owner.testnet']);
    const second = r.requests.filter((l) => l.startsWith(ARCH2 + ' ') && l.includes(H.twin));
    assert.equal(second.length, asked.length, 'the second archival node gets the same accounts');
    assertFails(r, new RegExp('^FAIL near tx ' + H.twin + ': .*no source.*9 accounts'));
  });
});

test('a Base link written with an upper case hash is read as the same transaction', () => {
  withWorld((w) => {
    evidence(w, (s) => s.split(BASE).join('0x' + BASE.slice(2).toUpperCase()));
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp('^PASS base tx ' + BASE, 'm'));
    assert.equal(lastLine(r.out), 'EVIDENCE OK 8 links checked');
  });
});

test('a Base receipt whose status is anything but 0x1 fails, a receipt with no status too', () => {
  for (const status of ['0x2', '', undefined]) {
    withWorld((w) => {
      rules(w, (rs) => {
        const res = rule(rs, 'base-receipt').body.result;
        if (status === undefined) delete res.status;
        else res.status = status;
      });
      assertFails(run(w), /^FAIL base tx 0xdb8e[0-9a-f]*: receipt status/);
    });
  }
});

test('a Deploy transaction row with a bare hash and no explorer link fails', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Deploy transaction | NEAR testnet | ' + nb(H.deploy) + ' |', '| Deploy transaction | NEAR testnet | ' + H.deploy + ' |'));
    assertFails(run(w), /^FAIL deploy transaction: the row has no testnet\.nearblocks\.io\/txns link/);
  });
});

test('without a usable Policy contract account row every check that needs the account says so', () => {
  for (const cell of ['(row removed)', 'NOT AN ACCOUNT']) {
    withWorld((w) => {
      evidence(w, (s) => cell === '(row removed)'
        ? s.split('\n').filter((l) => !l.startsWith('| Policy contract account |')).join('\n')
        : swap(s, '| Policy contract account | NEAR testnet | ' + POLICY + ' |', '| Policy contract account | NEAR testnet | ' + cell + ' |'));
      const r = run(w);
      assertFails(r, /^FAIL on-chain code hash: no valid Policy contract account row/);
      assertFails(r, /^FAIL golden contractId: no valid Policy contract account row/);
      assertFails(r, /^FAIL derived address row: no valid Policy contract account row to derive from/);
      assertFails(r, /^FAIL deploy transaction: no valid Policy contract account row/);
      assertFails(r, /^FAIL real MPC GDXXqKfr Base sender: no valid Policy contract account row/);
    });
  }
});

test('a Derived Base Sepolia address row without an address fails', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Derived Base Sepolia address | Base Sepolia | ' + DERIVED + ' |', '| Derived Base Sepolia address | Base Sepolia | pending |'));
    assertFails(run(w), /^FAIL derived address row: the row holds no 0x address/);
  });
});

test('a live answer wins over the saved file', () => {
  withWorld((w) => {
    edit(w, 'docs/evidence/near/' + H.mpc + '.json', (s) => {
      const j = JSON.parse(s);
      j.receipts[3].execution_outcome.outcome.logs = [];
      return JSON.stringify(j);
    });
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp('^PASS near tx ' + H.mpc + ' \\(batch\\)', 'm'));
  });
});

test('under rung 9 the spike row may be a bullet line instead of a table row', () => {
  withWorld((w) => {
    rung9(w, true);
    const r = run(w);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^PASS real MPC row \(Base Sepolia \(spike contract, not the product contract\): /m);
  });
});

test('a Real MPC row with a Base link but no NEAR link fails; so does one whose NEAR transaction cannot be read', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, nb(H.mpc) + ' then ' + bs(BASE), bs(BASE)));
    assertFails(run(w), /^FAIL real MPC row: no testnet\.nearblocks\.io\/txns link/);
  });
  withWorld((w) => {
    rules(w, (rs) => { const b = rule(rs, 'batch').body; b.transactions = b.transactions.filter((t: any) => t.transaction.hash !== H.mpc); });
    dropSaved(w, H.mpc);
    assertFails(run(w), new RegExp('^FAIL real MPC GDXXqKfr signer outcome: transaction ' + H.mpc + ' could not be read'));
  });
});

test('every view call asks for the final block', () => {
  withWorld((w) => {
    const r = run(w);
    const views = r.requests.filter((l) => l.includes('"request_type"'));
    assert.ok(views.length >= 3, views.join('\n'));
    assert.ok(views.every((l) => l.includes('"finality":"final"')), views.join('\n'));
  });
});

test('a saved file that is rejected and has no live answer is one failure, not two', () => {
  withWorld((w) => {
    rules(w, (rs) => without(rs, 'tx-twin-signer'));
    writeFileSync(join(w.root, 'docs', 'evidence', 'near', H.twin + '.json'), '{"junk":true}');
    const r = run(w);
    assert.equal(failing(r.out).filter((l) => l.startsWith('FAIL near tx ' + H.twin)).length, 1, r.out);
  });
});

test('a PNG with one wrong byte in its signature fails', () => {
  for (const at of [0, 7]) {
    withWorld((w) => {
      const png = readFileSync(join(w.root, 'docs/evidence-screenshots/wallet-intear-review.png'));
      png[at] = 0x00;
      writeFileSync(join(w.root, 'docs/evidence-screenshots/wallet-meteor-signed.png'), png);
      assertFails(run(w), /^FAIL screenshot wallet-meteor-signed\.png: .*PNG/);
    });
  }
});

test('a plain line that is only the words of a label is not a row', () => {
  withWorld((w) => {
    evidence(w, (s) => s.split('\n').filter((l) => !l.startsWith('| Quarantine model |')).join('\n').replace('## Toolchain\n', '## Toolchain\n\nQuarantine model\n'));
    assertFails(run(w), /^FAIL row Quarantine model: /);
  });
});

test('a URL in the Model choice section is not a video link', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, 'planner model: fixture-planner-model, chosen', 'planner model: fixture-planner-model (see https://example.org/model), chosen'));
    assert.equal(run(w).code, 0);
  });
});

test('the first cell may carry backticks', () => {
  withWorld((w) => {
    evidence(w, (s) => swap(s, '| Wasm sha256 | local build', '| `Wasm sha256` | local build'));
    assert.equal(run(w).code, 0);
  });
});

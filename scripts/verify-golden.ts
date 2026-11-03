// AIR-166: re-checks every transaction of every bench/golden/*.json against the chain, trusting nothing recorded except the hash.
//   pnpm tsx scripts/verify-golden.ts [--file <path>] [--selftest]
// NEAR transactions come from the archival nodes (regular nodes forget a transaction within a day or two), with the signer by label
// (`submit` the agent, `approve` and `tamper` the owner, `twin` the twin account). Base transactions come from receipt and transaction reads.
// Prints `PASS <label> <hash>` or `FAIL <label> <hash> <reason>` per entry; exit 1 on any FAIL. `--selftest` flips one character of a
// recorded hash in memory and requires a FAIL, then prints `SELFTEST ok (altered hash failed)`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRpc, nearQuery } from './lib/preflight.ts';
import { deriveSender } from '../runtime/src/chain/evm.ts';
import { parseRequestView } from '../runtime/src/chain/types.ts';
import type { ChainEvent, RequestView } from '../runtime/src/chain/types.ts';
import { archivalTx } from './golden.ts';
import type { NearTx } from './golden.ts';
import { readGolden } from './lib/golden.ts';
import type { GoldenRun, GoldenTx } from './lib/golden.ts';

const WRONG_AMOUNT = 'approve rejected: WrongAmount';

export interface VerifyIo {
  accounts: { agent: string; owner: string; twin_vanilla: string; policy: string };
  /** `policy` is the contract account recorded in the run file, never a re-read fixture */
  nearTx(hash: string, signerAccount: string, policy: string): Promise<NearTx>;
  getRequest(id: string, policy: string): Promise<RequestView | null>;
  baseReceipt(hash: string): Promise<{ status: string } | null>;
  baseTx(hash: string): Promise<{ to: string; value: bigint; from: string } | null>;
  derivedSender(policy: string): Promise<string>;
}

export interface Verdict {
  ok: boolean;
  line: string;
}

const verdict = (t: GoldenTx, why: string | null): Verdict => (why === null ? { ok: true, line: `PASS ${t.label} ${t.hash}` } : { ok: false, line: `FAIL ${t.label} ${t.hash} ${why}` });
const bare = (key: string): string => (key.startsWith('near:') ? key.slice('near:'.length) : key);
const ev = <K extends ChainEvent['event']>(events: ChainEvent[], name: K): Extract<ChainEvent, { event: K }>[] => events.filter((e) => e.event === name) as Extract<ChainEvent, { event: K }>[];

async function paidOk(io: VerifyIo, events: ChainEvent[], requestId: string, policy: string): Promise<string | null> {
  const view = await io.getRequest(requestId, policy);
  if (view === null) return `the chain has no request ${requestId}`;
  if (view.asset.startsWith('evm:')) return null;
  const paid = ev(events, 'paid').find((e) => e.data.request_id === requestId);
  if (paid === undefined) return 'no paid event for a NEAR payment';
  if (bare(paid.data.payee) !== bare(view.payee) || paid.data.amount !== view.amount) return 'the paid event differs from the stored payee or amount';
  return null;
}

async function verifyNear(io: VerifyIo, run: GoldenRun, t: GoldenTx): Promise<string | null> {
  const signer = t.label === 'submit' ? io.accounts.agent : t.label === 'twin' ? io.accounts.twin_vanilla : io.accounts.owner;
  const seen = await io.nearTx(t.hash, signer, run.contractId);
  if (seen.status !== t.status) return `recorded ${t.status}, the chain says ${seen.status}`;
  if (t.label === 'twin') return seen.status === 'success' ? null : 'the twin transaction failed';
  if (t.label === 'tamper') return seen.failure.includes(WRONG_AMOUNT) ? null : `the failure text lacks "${WRONG_AMOUNT}"`;
  if (t.label === 'submit') {
    const ids = new Set(run.requests.map((r) => r.request_id));
    const decided = [...ev(seen.events, 'allowed'), ...ev(seen.events, 'escalated'), ...ev(seen.events, 'blocked')];
    const eventIds = new Set(decided.map((e) => e.data.request_id));
    // a run of several submit transactions (AIR-247, live-latest) holds the requests of all of them: every event of this transaction must be a
    // recorded request, and only the requests this transaction decided are checked here. A one-request run behaves as before.
    if (eventIds.size === 0 || [...eventIds].some((id) => !ids.has(id as string))) return 'the request ids of the events differ from the recorded requests';
    for (const r of run.requests.filter((q) => eventIds.has(q.request_id))) {
      const match = decided.find((e) => e.data.request_id === r.request_id);
      if (match === undefined || match.event !== r.outcome) return `the recorded outcome ${r.outcome} is not the event of request ${r.request_id}`;
      if (r.outcome === 'allowed') {
        const bad = await paidOk(io, seen.events, r.request_id, run.contractId);
        if (bad !== null) return bad;
      }
    }
    return null;
  }
  // approve
  const held = run.requests.filter((q) => q.pending_id !== null);
  const r = held.find((q) => ev(seen.events, 'approved').some((e) => e.data.request_id === q.request_id)) ?? held[0];
  if (r === undefined || r.pending_id === null) return 'the run records no pending request to approve';
  const view = await io.getRequest(r.pending_id, run.contractId);
  if (view === null || view.digest === null) return 'the chain has no stored digest for the request';
  const approved = ev(seen.events, 'approved').find((e) => e.data.request_id === r.request_id);
  if (approved === undefined) return 'no approved event for the request';
  if (approved.data.digest !== view.digest) return 'the approved digest differs from get_request';
  return paidOk(io, seen.events, r.request_id, run.contractId);
}

async function verifyBase(io: VerifyIo, run: GoldenRun, t: GoldenTx): Promise<string | null> {
  const receipt = await io.baseReceipt(t.hash);
  if (receipt === null) return 'no receipt on Base Sepolia';
  const chainStatus = receipt.status === '0x1' ? 'success' : 'failure';
  if (chainStatus !== t.status) return `recorded ${t.status}, the chain says ${chainStatus}`;
  const raw = await io.baseTx(t.hash);
  if (raw === null) return 'no transaction on Base Sepolia';
  const r = run.requests[0];
  const view = r === undefined ? null : await io.getRequest(r.request_id, run.contractId);
  if (view === null) return 'the chain has no stored request for the run';
  const to = view.payee.slice(view.payee.lastIndexOf(':') + 1).toLowerCase();
  if (raw.to.toLowerCase() !== to) return 'the recipient differs from the request';
  if (raw.value !== BigInt(view.amount)) return 'the value differs from the request';
  if (raw.from.toLowerCase() !== (await io.derivedSender(run.contractId)).toLowerCase()) return 'the sender is not the derived address';
  return null;
}

export async function verifyRun(io: VerifyIo, run: GoldenRun): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const t of run.txs) {
    let why: string | null;
    try {
      why = t.chain === 'near' ? await verifyNear(io, run, t) : await verifyBase(io, run, t);
    } catch {
      why = 'the chain could not be read';
    }
    out.push(verdict(t, why));
  }
  return out;
}

/** One character of the first recorded hash changed (to another character of the same alphabet), in memory only. */
export function alterHash(run: GoldenRun): GoldenRun {
  const copy = structuredClone(run);
  const first = copy.txs[0];
  if (first === undefined) return copy;
  const last = first.hash.slice(-1);
  first.hash = first.hash.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  return copy;
}

export function parseArgs(argv: readonly string[]): { file: string | null; selftest: boolean } | null {
  let file: string | null = null;
  let selftest = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--selftest' && !selftest) selftest = true;
    else if (argv[i] === '--file' && file === null && argv[i + 1] !== undefined) file = argv[++i] as string;
    else return null;
  }
  return { file, selftest };
}

export async function main(argv: readonly string[], io: VerifyIo, root: string, out: (l: string) => void = (l) => console.log(l)): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    out('usage: verify-golden.ts [--file <path>] [--selftest]');
    return 2;
  }
  let files: string[];
  if (args.file !== null) files = [args.file];
  else {
    const dir = join(root, 'bench', 'golden');
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
    } catch {
      files = [];
    }
  }
  if (files.length === 0) {
    out('FAIL no golden files');
    return 1;
  }
  let runs: GoldenRun[];
  try {
    runs = files.map((f) => readGolden(f));
  } catch {
    out('FAIL a golden file does not match its schema');
    return 1;
  }
  if (args.selftest) {
    const probe = runs.find((r) => r.txs.length > 0);
    if (probe === undefined) {
      out('FAIL no transaction to alter');
      return 1;
    }
    const verdicts = await verifyRun(io, alterHash(probe));
    if (verdicts[0] === undefined || verdicts[0].ok) {
      out('SELFTEST FAILED the altered hash passed');
      return 1;
    }
    out('SELFTEST ok (altered hash failed)');
    return 0;
  }
  let ok = true;
  for (const run of runs) {
    for (const v of await verifyRun(io, run)) {
      out(v.line);
      if (!v.ok) ok = false;
    }
  }
  return ok ? 0 : 1;
}

export function liveVerifyIo(root: string, env: NodeJS.ProcessEnv = process.env): VerifyIo {
  const a = JSON.parse(readFileSync(join(root, 'fixtures', 'accounts.testnet.json'), 'utf8')) as Record<string, string>;
  const policyFile = JSON.parse(readFileSync(join(root, 'fixtures', 'policy.json'), 'utf8')) as { assets: Record<string, { path: string | null }> };
  return {
    accounts: { agent: a.agent as string, owner: a.owner as string, twin_vanilla: a.twin_vanilla as string, policy: a.policy as string },
    nearTx: (hash, signer, policy) => archivalTx(hash, signer, policy),
    getRequest: async (id, policy) => {
      const r = await nearQuery({ request_type: 'call_function', account_id: policy, method_name: 'get_request', args_base64: Buffer.from(JSON.stringify({ id })).toString('base64') });
      const text = Buffer.from(r.result as number[]).toString('utf8');
      return text === 'null' || text === '' ? null : parseRequestView(JSON.parse(text));
    },
    baseReceipt: async (hash) => {
      const r = (await baseRpc(env.BASE_SEPOLIA_RPC, 'eth_getTransactionReceipt', [hash])) as { status?: string } | null;
      return r === null || r === undefined || typeof r.status !== 'string' ? null : { status: r.status };
    },
    baseTx: async (hash) => {
      const r = (await baseRpc(env.BASE_SEPOLIA_RPC, 'eth_getTransactionByHash', [hash])) as { to?: string; value?: string; from?: string } | null;
      if (r === null || r === undefined || typeof r.to !== 'string' || typeof r.value !== 'string' || typeof r.from !== 'string') return null;
      return { to: r.to, value: BigInt(r.value), from: r.from };
    },
    derivedSender: async (policy) => deriveSender(policy, policyFile.assets['evm:84532:native']?.path as string),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  main(process.argv.slice(2), liveVerifyIo(root), root).then((code) => {
    process.exitCode = code;
  });
}

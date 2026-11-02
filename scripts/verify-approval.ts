// AIR-085: recheck an owner approval from public chain data. No AIRLOCK server, no key, no near-api-js: JSON-RPC over fetch, and
// `viem` only decodes the EVM transaction.
//
//   pnpm verify-approval <tx_hash> [--rpc <url>] [--contract <account>] [--sender <account>]
//   pnpm verify-approval --outcome-file <path> --state-file <path> [--contract <account>]     (offline)
//
// Prints `PASS (digest, approver, args, effect)` and exits 0, or `FAIL: <check>: expected <x> got <y>` and exits 1 on the first
// failing check. The checks run in a fixed order and have fixed names: status, call, deposit, approver, event, digest, args, effect.
// The core, `verifyApproval`, is a pure function over the `EXPERIMENTAL_tx_status` result and the two views read at the approval
// receipt's block; the CLI only fetches and prints. Amounts are BigInt and strings only.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTransaction } from 'viem';
import { digestOf } from './lib/digest.ts';
import type { Preimage } from './lib/digest.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The `result` object of the JSON-RPC method `EXPERIMENTAL_tx_status`. */
export type TxStatus = Json;
/** `get_policy` result (only `owner_id` is read). */
export type PolicyView = { owner_id: string } & Record<string, unknown>;
/** `get_request` result after `approve`. */
export type RequestView = Json;

export type Verdict = { ok: true } | { ok: false; check: string; expected: string; got: string };

const MAX_U32 = 4294967295n;
const SIX_KEYS = ['amount', 'asset', 'book', 'id', 'to', 'why'];
const fail = (check: string, expected: string, got: string): Verdict => ({ ok: false, check, expected, got });
const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? 'undefined');

function parseEvents(logs: unknown): Json[] {
  const out: Json[] = [];
  if (!Array.isArray(logs)) return out;
  for (const line of logs) {
    if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
    try {
      out.push(JSON.parse(line.slice('EVENT_JSON:'.length)));
    } catch {
      // a malformed line is not an event
    }
  }
  return out;
}

function callArgsOf(fc: Json): Json | null {
  try {
    const parsed = JSON.parse(Buffer.from(String(fc.args), 'base64').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `[gas, maxFeePerGas, maxPriorityFeePerGas]` that viem reads from the unsigned transaction hex (lowercase, no 0x). */
function evmTriple(unsignedHex: string): [bigint, bigint, bigint] {
  const tx = parseTransaction(`0x${unsignedHex}`);
  if (tx.type !== 'eip1559') throw new Error(`transaction type ${tx.type}`);
  if (tx.gas === undefined || tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined) throw new Error('missing fee fields');
  return [tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas];
}

export function verifyApproval(outcome: TxStatus, state: { policy: PolicyView; request: RequestView }, contract: string): Verdict {
  const { policy, request } = state;
  const tx = outcome?.transaction ?? {};

  // status
  const status = outcome?.status;
  if (status === null || typeof status !== 'object' || !('SuccessValue' in status)) return fail('status', 'SuccessValue', show(status));

  // call
  const actions: Json[] = Array.isArray(tx.actions) ? tx.actions : [];
  const fc = actions.length === 1 ? actions[0]?.FunctionCall : undefined;
  if (!fc || fc.method_name !== 'approve') {
    return fail('call', 'one FunctionCall approve action', `${actions.length} actions, method ${show(fc?.method_name)}`);
  }
  if (tx.receiver_id !== contract) return fail('call', `approve on ${contract}`, `receiver ${show(tx.receiver_id)}`);

  // deposit
  if (fc.deposit !== '1') return fail('deposit', '1', show(fc.deposit));

  // approver
  if (tx.signer_id !== policy?.owner_id) return fail('approver', show(policy?.owner_id), show(tx.signer_id));

  // event
  const args = callArgsOf(fc);
  const first = outcome?.receipts_outcome?.[0]?.outcome;
  const approved = parseEvents(first?.logs).filter((e) => e?.standard === 'airlock' && e?.event === 'approved');
  if (approved.length !== 1) return fail('event', 'exactly one approved event', `${approved.length} approved events`);
  const ev = approved[0].data?.[0] ?? {};
  if (args === null || ev.id !== args.id) return fail('event', `id ${show(args?.id)}`, `id ${show(ev.id)}`);
  if (ev.approver !== tx.signer_id) return fail('event', `approver ${show(tx.signer_id)}`, `approver ${show(ev.approver)}`);

  // digest
  const asset = String(request?.asset ?? '');
  const isEvm = asset.startsWith('evm:');
  let digest: string;
  try {
    const no = BigInt(request.id);
    if (no < 0n || no > MAX_U32) return fail('digest', `id at most ${MAX_U32}`, show(request.id));
    let evm: Preimage['evm'] = null;
    if (isEvm) {
      const hex = request.exec?.unsigned_hex;
      if (typeof hex !== 'string') return fail('digest', 'exec.unsigned_hex of the stored request', 'evm parameters unavailable');
      evm = evmTriple(hex);
    }
    const requestId = String(request.request_id);
    const preimage: Preimage = {
      request_id: requestId,
      no,
      agent: request.agent,
      task_hash: requestId.split(':')[0] ?? '',
      asset,
      payee: request.payee,
      amount: BigInt(request.amount),
      labels: [request.labels.recipient, request.labels.amount, request.labels.pc],
      reason: request.reason,
      book_status: request.book_status,
      evm,
    };
    digest = digestOf(preimage);
  } catch (e) {
    return fail('digest', 'a digest computed from the stored request', e instanceof Error ? e.message : String(e));
  }
  if (digest !== ev.digest) return fail('digest', `event digest ${show(ev.digest)}`, `computed ${digest}`);
  if (digest !== request.digest) return fail('digest', `stored digest ${show(request.digest)}`, `computed ${digest}`);

  // args
  const keys = Object.keys(args).sort();
  if (keys.join(',') !== SIX_KEYS.join(',')) return fail('args', `keys ${SIX_KEYS.join(',')}`, `keys ${keys.join(',')}`);
  const wanted: Record<string, unknown> = {
    id: request.id,
    to: request.payee,
    asset: request.display?.asset_symbol,
    amount: request.display?.amount_decimal,
    why: request.reason,
    book: request.book_status,
  };
  for (const k of ['id', 'to', 'asset', 'amount', 'why', 'book']) {
    if (args[k] !== wanted[k]) return fail('args', `${k} ${show(wanted[k])}`, `${k} ${show(args[k])}`);
  }

  // effect
  return isEvm ? evmEffect(outcome, request, asset) : nearEffect(outcome, request, contract);
}

function nearEffect(outcome: TxStatus, request: RequestView, contract: string): Verdict {
  if (request.asset !== 'near') return fail('effect', 'asset near or evm:<chain>:<token>', show(request.asset));
  const payee = String(request.payee).replace(/^near:/, '');
  const want = BigInt(request.amount);
  const receipts: Json[] = Array.isArray(outcome.receipts) ? outcome.receipts : [];
  const paid = receipts.some(
    (r) =>
      r?.predecessor_id === contract &&
      r?.receiver_id === payee &&
      Array.isArray(r?.receipt?.Action?.actions) &&
      r.receipt.Action.actions.some((a: Json) => a?.Transfer && String(a.Transfer.deposit) === want.toString()),
  );
  return paid ? { ok: true } : fail('effect', `Transfer of ${want} from ${contract} to ${payee}`, 'no such receipt');
}

function evmEffect(outcome: TxStatus, request: RequestView, asset: string): Verdict {
  const chain = asset.split(':')[1] ?? '';
  const payee = String(request.payee).split(':')[2] ?? '';
  const logs: unknown[] = (Array.isArray(outcome.receipts_outcome) ? outcome.receipts_outcome : []).flatMap((ro: Json) => ro?.outcome?.logs ?? []);
  const signed = parseEvents(logs).filter((e) => e?.standard === 'airlock' && e?.event === 'signed' && e?.data?.[0]?.request_id === request.request_id);
  if (signed.length === 0) return fail('effect', `a signed event for ${request.request_id}`, 'signed event missing');
  const hex = signed[0].data[0].unsigned_hex;
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    if (typeof hex !== 'string' || hex !== hex.toLowerCase() || hex.startsWith('0x')) throw new Error('unsigned_hex is not lowercase hex without 0x');
    parsed = parseTransaction(`0x${hex}`);
  } catch (e) {
    return fail('effect', 'a parseable unsigned EIP-1559 transaction', e instanceof Error ? e.message : String(e));
  }
  if (parsed.type !== 'eip1559') return fail('effect', 'type eip1559', `type ${parsed.type}`);
  if (String(parsed.chainId) !== chain) return fail('effect', `chainId ${chain}`, `chainId ${parsed.chainId}`);
  if ((parsed.to ?? '').toLowerCase() !== payee.toLowerCase()) return fail('effect', `to ${payee}`, `to ${show(parsed.to)}`);
  if (parsed.value !== BigInt(request.amount)) return fail('effect', `value ${request.amount}`, `value ${parsed.value}`);
  return { ok: true };
}

// ---- the CLI: fetch and print ----

const USAGE = `usage: verify-approval <tx_hash> [--rpc <url>] [--contract <account>] [--sender <account>]
       verify-approval --outcome-file <path> --state-file <path> [--contract <account>]
Recomputes the digest of an approval from public chain data, checks the approver is the owner and that the executed effect
matches the stored request. Prints PASS (digest, approver, args, effect) or FAIL: <check>: expected <x> got <y> (exit 1).
Offline runs on the sandbox fixtures need --contract policy.sandbox.
  --rpc       archival JSON-RPC url (default: $ARCHIVAL_RPC, else https://archival-rpc.testnet.fastnear.com)
  --contract  policy account (default: policy of fixtures/accounts.testnet.json)
  --sender    signer account of the transaction (default: owner of fixtures/accounts.testnet.json)`;

class UsageError extends Error {}

function parseArgs(argv: string[]): { hash?: string; rpc?: string; contract?: string; sender?: string; outcomeFile?: string; stateFile?: string; help: boolean } {
  const o: ReturnType<typeof parseArgs> = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--rpc') o.rpc = val();
    else if (a === '--contract') o.contract = val();
    else if (a === '--sender') o.sender = val();
    else if (a === '--outcome-file') o.outcomeFile = val();
    else if (a === '--state-file') o.stateFile = val();
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (o.hash === undefined) o.hash = a;
    else throw new UsageError('one tx hash only');
  }
  return o;
}

async function rpc(url: string, method: string, params: unknown): Promise<Json> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body: Json = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error.cause?.name ?? body.error.message ?? body.error)}`);
  const inner = body.result?.error;
  if (inner) throw new Error(`${method}: ${show(inner)}`);
  return body.result;
}

async function view(url: string, contract: string, blockHash: string, method: string, args: unknown): Promise<Json> {
  const result = await rpc(url, 'query', {
    request_type: 'call_function',
    block_id: blockHash,
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
  });
  return JSON.parse(Buffer.from(result.result as number[]).toString('utf8'));
}

async function main(argv: string[]): Promise<number> {
  let o: ReturnType<typeof parseArgs>;
  try {
    o = parseArgs(argv);
    if (o.help) {
      console.log(USAGE);
      return 0;
    }
    const offline = o.outcomeFile !== undefined || o.stateFile !== undefined;
    if (offline && (o.outcomeFile === undefined || o.stateFile === undefined || o.hash !== undefined)) {
      throw new UsageError('--outcome-file and --state-file go together and replace the tx hash');
    }
    if (!offline && o.hash === undefined) throw new UsageError('a tx hash or --outcome-file with --state-file is needed');
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const accounts = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'accounts.testnet.json'), 'utf8')) as Record<string, string>;
  const contract = o.contract ?? (accounts.policy as string);
  let outcome: TxStatus;
  let state: { policy: PolicyView; request: RequestView };
  try {
    if (o.outcomeFile !== undefined && o.stateFile !== undefined) {
      outcome = JSON.parse(readFileSync(o.outcomeFile, 'utf8'));
      state = JSON.parse(readFileSync(o.stateFile, 'utf8'));
    } else {
      const url = o.rpc ?? process.env.ARCHIVAL_RPC ?? 'https://archival-rpc.testnet.fastnear.com';
      outcome = await rpc(url, 'EXPERIMENTAL_tx_status', { tx_hash: o.hash, sender_account_id: o.sender ?? accounts.owner, wait_until: 'FINAL' });
      const block = outcome?.receipts_outcome?.[0]?.block_hash;
      if (typeof block !== 'string') throw new Error('the transaction has no receipts_outcome yet');
      const fc = outcome?.transaction?.actions?.[0]?.FunctionCall;
      const id = fc ? callArgsOf(fc)?.id : undefined;
      state = {
        policy: await view(url, contract, block, 'get_policy', {}),
        request: typeof id === 'string' ? await view(url, contract, block, 'get_request', { id }) : {},
      };
    }
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const verdict = verifyApproval(outcome, state, contract);
  if (verdict.ok) {
    console.log('PASS (digest, approver, args, effect)');
    return 0;
  }
  console.log(`FAIL: ${verdict.check}: expected ${verdict.expected} got ${verdict.got}`);
  return 1;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}

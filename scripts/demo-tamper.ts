// AIR-182: the tamper demo. `tsx scripts/demo-tamper.ts <no>` (Erfan runs it: it needs his keychain). It reads the pending request <no> from
// the chain, sends `approve` with ONE of the five card values changed, and shows that the contract refused it and the request is still
// pending with its stored amount. The value that changes is the amount: 4.2, or 9.4 when the stored amount text is already 4.2.
// Reads go through RPC (web/src/chain/rpc.ts), the one transaction through the near CLI as an argument array (no shell).
// Env: NEAR (the binary, default near), OWNER and POLICY (default: fixtures/accounts.testnet.json), AIRLOCK_RPC_URLS (comma list, default the
// NEAR testnet nodes of plan/STACK.md), AIRLOCK_TX_POLLS (default 6) and AIRLOCK_POLL_MS (default 2000) for the transaction lookup.
// Exit 0 and `TAMPER REVERTED <hash> approve rejected: WrongAmount` when the contract refused; 1 for anything else; 2 for a bad argument.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRequestView } from '../runtime/src/chain/types.ts';
import type { RequestView } from '../runtime/src/chain/types.ts';
import { NEAR_RPC } from '../web/csp.ts';
import { rpcCall, rpcView } from '../web/src/chain/rpc.ts';
import { APPROVE_PREPAID_TGAS } from '../web/src/wallet/approve.ts';

const EXPECTED = 'approve rejected: WrongAmount';
const here = fileURLToPath(new URL('.', import.meta.url));

type Accounts = { owner?: string; policy?: string };

function usage(): never {
  console.error('usage: tsx scripts/demo-tamper.ts <no>   (the pending number of an escalated request)');
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function txFailureText(rpcUrls: string[], owner: string, hash: string): Promise<string | null> {
  const polls = Number(process.env.AIRLOCK_TX_POLLS ?? '6');
  const pollMs = Number(process.env.AIRLOCK_POLL_MS ?? '2000');
  for (let i = 0; i < polls; i += 1) {
    try {
      const result = (await rpcCall({ rpcUrls }, 'tx', { tx_hash: hash, sender_account_id: owner, wait_until: 'FINAL' })) as {
        status?: unknown;
        receipts_outcome?: { outcome?: { status?: unknown } }[];
      } | null;
      if (result !== null && typeof result === 'object' && result.status !== undefined) {
        const parts = [JSON.stringify(result.status), ...(result.receipts_outcome ?? []).map((r) => JSON.stringify(r.outcome?.status ?? null))];
        return parts.join(' ');
      }
    } catch {
      // not indexed yet, or a node that cannot answer: try again
    }
    if (i + 1 < polls) await sleep(pollMs);
  }
  return null;
}

async function main(): Promise<number> {
  const no = process.argv[2];
  if (no === undefined || process.argv.length > 3 || !/^[1-9][0-9]{0,9}$/.test(no)) usage();

  const accounts = JSON.parse(readFileSync(`${here}../fixtures/accounts.testnet.json`, 'utf8')) as Accounts;
  const owner = process.env.OWNER ?? accounts.owner;
  const policy = process.env.POLICY ?? accounts.policy;
  if (owner === undefined || owner === '' || policy === undefined || policy === '') {
    console.error('owner or policy account missing (fixtures/accounts.testnet.json, OWNER, POLICY)');
    return 1;
  }
  const rpcUrls = process.env.AIRLOCK_RPC_URLS !== undefined && process.env.AIRLOCK_RPC_URLS !== '' ? process.env.AIRLOCK_RPC_URLS.split(',') : [...NEAR_RPC];
  const view = rpcView({ contractId: policy, rpcUrls });
  const read = async (): Promise<RequestView | null> => parseRequestView(await view('get_request', { id: no }));

  const stored = await read();
  if (stored === null) {
    console.error(`unknown id ${no}`);
    return 1;
  }
  if (stored.state !== 'Pending') {
    console.log(`NOT PENDING: state ${stored.state}`);
    return 1;
  }
  if (stored.tombstone === true || stored.display === null || stored.reason === null || stored.book_status === null || stored.id === null) {
    console.error('this request has no card values to change');
    return 1;
  }
  const storedAmount = stored.display.amount_decimal;
  const tampered = { id: stored.id, to: stored.payee, asset: stored.display.asset_symbol, amount: storedAmount === '4.2' ? '9.4' : '4.2', why: stored.reason, book: stored.book_status };

  const near = process.env.NEAR ?? 'near';
  const run = spawnSync(
    near,
    ['contract', 'call-function', 'as-transaction', policy, 'approve', 'json-args', JSON.stringify(tampered), 'prepaid-gas', `${APPROVE_PREPAID_TGAS} Tgas`, 'attached-deposit', '1 yoctoNEAR', 'sign-as', owner, 'network-config', 'testnet', 'sign-with-keychain', 'send'],
    { encoding: 'utf8' },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const hash = /Transaction ID: ([A-Za-z0-9]{1,64})/.exec(output)?.[1];
  if (hash === undefined) {
    console.log(output);
    console.error('no "Transaction ID" in the output of near. Paste the hash from its summary into: scripts/golden.ts tamper --tamper-tx <hash>');
    return 1;
  }

  const failure = await txFailureText(rpcUrls, owner, hash);
  if (failure === null) {
    console.error(`could not read transaction ${hash} from RPC`);
    return 1;
  }
  if (!failure.includes(EXPECTED)) {
    console.error(`transaction ${hash} did not fail with "${EXPECTED}": ${failure.slice(0, 300)}`);
    return 1;
  }
  const after = await read();
  if (after === null || after.state !== 'Pending' || after.display?.amount_decimal !== storedAmount) {
    console.error(`the request is not still Pending with amount ${storedAmount}: state ${after?.state ?? 'missing'}`);
    return 1;
  }
  console.log(`TAMPER REVERTED ${hash} ${EXPECTED}`);
  console.log(`LINK https://testnet.nearblocks.io/txns/${hash}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);

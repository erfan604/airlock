// AIR-107: the gas of one testnet transaction, read from `EXPERIMENTAL_tx_status` (read only, no key).
//   pnpm tsx scripts/gas-testnet.ts <label> <tx_hash> [--sender <account>]
//   pnpm tsx scripts/gas-testnet.ts <label> --file <saved tx status json>      offline: the file is a saved JSON-RPC answer or its result
// Prints
//   GAS TESTNET <label> burnt_total=<n> burnt_first=<n> receipts=<k> reserved=<n> need=<n>
// in Tgas with three decimals. `burnt_total` is the transaction outcome plus every receipt outcome (`gas_burnt`), `burnt_first` is
// `receipts_outcome[0]` (the call's own receipt), `reserved` is `GAS_MPC_SIGN + GAS_ON_SIGNED` (the `from_tgas(<n>)` constants of
// contracts/airlock-policy/src/exec.rs) times the number of `evm_unsigned` events in the logs, and `need = burnt_first + reserved`.
// Exits 1 for label `batch3` when `need` is above 225 Tgas (25 percent headroom under 300). BigInt arithmetic only.
// The method is `EXPERIMENTAL_tx_status`, never `tx_status` (the name nearcore 2.14.0 added: dRPC answers -32601 for it, CLAUDE.md).
// FastNEAR keeps about 34 hours; an older transaction is read from the archival host, which is the second URL.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RPCS = ['https://test.rpc.fastnear.com', 'https://archival-rpc.testnet.fastnear.com'];
const TGAS = 1_000_000_000_000n;
const BATCH_NEED_MAX = 225n * TGAS;

interface Outcome {
  outcome?: { gas_burnt?: number | string; logs?: string[]; status?: unknown };
}

export interface TxStatus {
  status?: unknown;
  transaction_outcome?: Outcome;
  receipts_outcome?: Outcome[];
}

export interface GasRow {
  burntTotal: bigint;
  burntFirst: bigint;
  receipts: number;
  reserved: bigint;
  need: bigint;
}

/** The `from_tgas(<n>)` value of the constant `name` in the text of exec.rs, in gas units. */
export function constantGas(execRs: string, name: string): bigint {
  const m = new RegExp(`pub const ${name}: Gas = Gas::from_tgas\\((\\d+)\\)`).exec(execRs);
  if (!m) throw new Error(`${name} not found in exec.rs`);
  return BigInt(m[1] as string) * TGAS;
}

function burnt(o: Outcome | undefined): bigint {
  const g = o?.outcome?.gas_burnt;
  if (g === undefined) throw new Error('an outcome has no gas_burnt');
  return BigInt(g);
}

function countEvents(tx: TxStatus, name: string): number {
  let n = 0;
  for (const o of [tx.transaction_outcome, ...(tx.receipts_outcome ?? [])]) {
    for (const line of o?.outcome?.logs ?? []) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      try {
        const j = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: unknown; event?: unknown };
        if (j.standard === 'airlock' && j.event === name) n += 1;
      } catch {
        // not an event line
      }
    }
  }
  return n;
}

/** The row of one transaction: `perEvm` is the gas reserved per `evm_unsigned` event (`GAS_MPC_SIGN + GAS_ON_SIGNED`). */
export function summarize(tx: TxStatus, perEvm: bigint): GasRow {
  const receipts = tx.receipts_outcome ?? [];
  if (receipts.length === 0) throw new Error('the transaction has no receipt outcome');
  let total = burnt(tx.transaction_outcome);
  for (const r of receipts) total += burnt(r);
  const first = burnt(receipts[0]);
  const reserved = perEvm * BigInt(countEvents(tx, 'evm_unsigned'));
  return { burntTotal: total, burntFirst: first, receipts: receipts.length, reserved, need: first + reserved };
}

/** Gas units as Tgas with three decimals, rounded half up. */
export function tgas3(gas: bigint): string {
  const milli = (gas + 500_000_000n) / 1_000_000_000n;
  return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, '0')}`;
}

export function format(label: string, row: GasRow): string {
  return `GAS TESTNET ${label} burnt_total=${tgas3(row.burntTotal)} burnt_first=${tgas3(row.burntFirst)} receipts=${row.receipts} reserved=${tgas3(row.reserved)} need=${tgas3(row.need)}`;
}

function failed(tx: TxStatus): boolean {
  const s = tx.status;
  return typeof s === 'object' && s !== null && 'Failure' in s;
}

async function fetchTx(hash: string, senders: string[]): Promise<TxStatus> {
  let last = 'no rpc answered';
  for (const url of RPCS) {
    for (const sender of senders) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'EXPERIMENTAL_tx_status', params: { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' } }),
          signal: AbortSignal.timeout(30_000),
        });
        const j = (await res.json()) as { result?: TxStatus; error?: unknown };
        if (j.result?.receipts_outcome) return j.result;
        last = `${url}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`;
      } catch (e) {
        last = `${url}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  throw new Error(`no transaction status for ${hash}: ${last}`);
}

function readSaved(path: string): TxStatus {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { result?: TxStatus } & TxStatus;
  return j.result ?? j;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const label = argv[0];
  if (label === undefined || label.startsWith('--')) {
    process.stderr.write('usage: gas-testnet.ts <label> <tx_hash> [--sender <account>] | <label> --file <json>\n');
    return 2;
  }
  const execRs = readFileSync(join(ROOT, 'contracts', 'airlock-policy', 'src', 'exec.rs'), 'utf8');
  const perEvm = constantGas(execRs, 'GAS_MPC_SIGN') + constantGas(execRs, 'GAS_ON_SIGNED');
  const file = flag(argv, '--file');
  let tx: TxStatus;
  if (file !== undefined) {
    tx = readSaved(file);
  } else {
    const hash = argv[1];
    if (hash === undefined || !/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(hash)) {
      process.stderr.write('a transaction hash (base58) is required\n');
      return 2;
    }
    const accounts = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'accounts.testnet.json'), 'utf8')) as Record<string, string>;
    const senders = [flag(argv, '--sender'), accounts.agent, accounts.owner, accounts.policy].filter((s): s is string => typeof s === 'string');
    tx = await fetchTx(hash, senders);
  }
  if (failed(tx)) {
    process.stdout.write(`transaction ${label} failed: ${JSON.stringify(tx.status).slice(0, 300)}\n`);
    return 1;
  }
  const row = summarize(tx, perEvm);
  process.stdout.write(`${format(label, row)}\n`);
  if (label === 'batch3' && row.need > BATCH_NEED_MAX) {
    process.stdout.write(`batch3 needs ${tgas3(row.need)} Tgas, above 225\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

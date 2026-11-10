// AIR-355: strict mode on the live credit card, one script with three modes. Strict is a book in which no entry has a cap for amounts read
// from text, so the card holds every such amount for the owner; the card stores only the book's root, so the change is one owner call.
//   pnpm tsx scripts/credit-strict.ts            dry (the default): writes the strict vault as a NEW file next to the old one, prints the
//                                                old root, the new root, what changes and the exact owner call, and sends nothing
//   pnpm tsx scripts/credit-strict.ts --live     sends the one book_set_root, only with CREDIT_STRICT_LIVE_OK=1 and only when the dry plan
//                                                is ready (the old vault is the card's book, nothing is held, no live switch exists)
//   pnpm tsx scripts/credit-strict.ts --verify   read only: the strict vault has no cap, its root is the card's root, and (card not paused)
//                                                the card's own preview holds an amount read from text and allows the owner's amount
// Options: --vault <the old book vault> (default target/credit-run/book.vault.json), --out <the strict vault> (default
// book.vault.strict.json next to the old one). The old vault file is never written. A vault is a secret file: no payee, no salt and no
// key is printed. The owner call is signed by the near CLI from its keychain; this script reads no key.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARENA_ACCOUNTS } from '../runtime/src/arena/index.ts';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { rpcBlockMs, rpcView } from '../runtime/src/credit/rpc.ts';
import { STRICT_FLAG, bookSetRootCommand, planStrict, sendStrict, strictVaultOf, verifyStrict, whyNotStrict } from '../runtime/src/credit/strict.ts';
import type { StrictIo } from '../runtime/src/credit/strict.ts';
import { loadVault, saveVault } from '../runtime/src/vault/file.ts';
import type { Vault } from '../runtime/src/vault/index.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARD = ARENA_ACCOUNTS.card;
const OWNER = ARENA_ACCOUNTS.issuer;
const AGENT = ARENA_ACCOUNTS.agent;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The live card, read over RPC; `send` runs the near CLI, which signs from its keychain. */
export function liveIo(print: (line: string) => void): StrictIo {
  const rpc = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
  const view = (method: string, args: object = {}): Promise<unknown> => rpcView(rpc, CARD, method, args);
  return {
    bookRoot: async () => {
      const root = await view('get_book_root');
      if (typeof root !== 'string' || !/^[0-9a-f]{64}$/.test(root)) throw new Error('get_book_root answered something unexpected');
      return root;
    },
    bookEpoch: async () => {
      const epoch = await view('get_book_epoch');
      if (typeof epoch !== 'string' || !/^[0-9]+$/.test(epoch)) throw new Error('get_book_epoch answered something unexpected');
      return BigInt(epoch);
    },
    paused: async () => {
      const policy = await view('get_policy');
      if (!isObj(policy) || typeof policy['paused'] !== 'boolean') throw new Error('get_policy answered something unexpected');
      return policy['paused'];
    },
    pendingCount: async () => {
      let n = 0;
      for (let page = 0; page < 20; page += 1) {
        const rows = await view('get_pending', { from_index: page * 20, limit: 20 });
        if (!Array.isArray(rows)) throw new Error('get_pending answered something unexpected');
        n += rows.filter((r) => isObj(r) && r['state'] === 'Pending').length;
        if (rows.length < 20) break;
      }
      return n;
    },
    rejectStreak: async () => {
      const s = await view('get_escalation_state', { agent: AGENT });
      const limits = isObj(s) && isObj(s['limits']) ? s['limits'] : null;
      if (!isObj(s) || limits === null || typeof s['consecutive_rejects'] !== 'number' || typeof limits['lock_consecutive'] !== 'number') throw new Error('get_escalation_state answered something unexpected');
      return { streak: s['consecutive_rejects'], lock: limits['lock_consecutive'] };
    },
    blockMs: () => rpcBlockMs(rpc),
    preview: async (req, task) => {
      const a = await view('preview', { req, task });
      if (!isObj(a) || typeof a['outcome'] !== 'string') throw new Error('preview answered something unexpected');
      return { outcome: a['outcome'], reason: typeof a['reason'] === 'string' ? a['reason'] : null };
    },
    send: async (args) => {
      const r = spawnSync(process.env['NEAR'] ?? 'near', bookSetRootCommand(CARD, OWNER, args), { encoding: 'utf8' });
      const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
      const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1];
      if (r.status !== 0 || tx === undefined || /ExecutionError|Failure|panicked/.test(out)) throw new Error(`book_set_root failed: ${out.slice(-400)}`);
      return tx;
    },
    log: print,
  };
}

export type StrictDeps = { io: StrictIo; env: Record<string, string | undefined>; print: (line: string) => void; switches: () => string[] };

/** Live switches of the jobs that sign as the card's agent, as they exist in this repo. */
const liveSwitches = (): string[] => ['target/arena/LIVE_OK', 'target/economy/LIVE_OK'].filter((p) => existsSync(join(REPO, p)));

const sameBook = (a: Vault, b: Vault): boolean =>
  a.entries.length === b.entries.length && a.entries.every((e) => b.entries.some((x) => x.payee === e.payee && x.daily_limit === e.daily_limit && x.label === e.label && x.listed === e.listed));

export async function main(argv: readonly string[], deps?: Partial<StrictDeps>): Promise<number> {
  const print = deps?.print ?? ((l: string) => console.log(l));
  const env = deps?.env ?? process.env;
  const switches = deps?.switches ?? liveSwitches;
  let vaultPath = join(REPO, 'target', 'credit-run', 'book.vault.json');
  let outPath: string | null = null;
  let mode: 'dry' | 'live' | 'verify' = 'dry';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--vault' && next !== undefined) vaultPath = argv[(i += 1)] ?? vaultPath;
    else if (a === '--out' && next !== undefined) outPath = argv[(i += 1)] ?? null;
    else if (a === '--live' && mode === 'dry') mode = 'live';
    else if (a === '--verify' && mode === 'dry') mode = 'verify';
    else {
      print('usage: credit-strict.ts [--vault <old vault>] [--out <strict vault>] [--live | --verify]');
      return 2;
    }
  }
  const strictPath = outPath ?? join(dirname(vaultPath), 'book.vault.strict.json');
  const io = deps?.io ?? liveIo(print);

  if (mode === 'verify') {
    if (!existsSync(strictPath)) {
      print(`CREDIT STRICT NO the strict vault file is missing (${strictPath})`);
      return 1;
    }
    const v = await verifyStrict({ io, vault: loadVault(strictPath), card: CARD, agent: AGENT });
    print(v.line);
    return v.code;
  }

  if (!existsSync(vaultPath)) {
    print(`CREDIT STRICT NO the old book vault is missing (${vaultPath}); pass --vault`);
    return 1;
  }
  const oldVault = loadVault(vaultPath);
  let newVault: Vault;
  if (existsSync(strictPath)) {
    newVault = loadVault(strictPath);
    const why = whyNotStrict(newVault) ?? (sameBook(oldVault, newVault) ? null : 'it does not hold the payees, limits and labels of the old vault');
    if (why !== null) {
      print(`CREDIT STRICT NO the file ${strictPath} is not the strict copy of the old vault (${why}); move it away or pass --out`);
      return 1;
    }
    print(`strict vault file ${strictPath} (already there, read as it is)`);
  } else {
    newVault = strictVaultOf(oldVault);
    saveVault(newVault, strictPath);
    print(`strict vault file ${strictPath} (written now, mode 0600)`);
  }
  print(`old vault file ${vaultPath} (not changed by this script)`);
  print(`after the change the arena and the credit scripts must read ${strictPath}: ARENA_BOOK_VAULT and ECONOMY_BOOK_VAULT for the arena and the loop (or a copy at target/arena/book.vault.strict.json), and loadVault of that path in scripts/credit-testnet.ts and scripts/credit-passport-run.ts`);
  const args = { io, oldVault, newVault, card: CARD, owner: OWNER, agent: AGENT, switches: switches() };

  if (mode === 'live') {
    const sent = await sendStrict({ ...args, flag: env[STRICT_FLAG] === '1' });
    print(sent.line);
    return sent.code;
  }
  const plan = await planStrict(args);
  for (const l of plan.lines) print(l);
  print(`CREDIT STRICT DRY: nothing was sent; ${plan.notReady === null ? `ready, send with ${STRICT_FLAG}=1 and --live` : `not ready: ${plan.notReady}`}`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`CREDIT STRICT FAILED ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

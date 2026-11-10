// AIR-356: the refill and renew job of the "try it live" card, one run per call (the keep-alive job calls scripts/try-refill-cron.sh).
// Visitors sign as the try agent with its published keys: they spend its gas and leave request records and holds on the try policy. A
// run, in order: expires holds past their time (at most 50, every slot of the policy: a slot is freed only by an expire call), renews the agent's registration when it has under 3 days left, tops the
// agent up to 3 NEAR when it is under 1 (at most 6 NEAR a UTC day) and the policy's free float up to 5 NEAR when it is under 3 (at most
// 4 NEAR a day), both from the owner, which always keeps 1 NEAR. It prints an ALERT line when the published tasks have under 30 hours
// left (publishing needs a site deploy, which this job does not do), when a ceiling is used, or when the policy is paused.
//   pnpm tsx scripts/try-refill.ts          dry (the default): the state, the alerts, and each action with its exact command; sends nothing
//   pnpm tsx scripts/try-refill.ts --live   runs the actions, only while target/try/LIVE_OK exists; a stop exits 0, a failed action exits 1
// The accounts come from target/try/published.json (written by scripts/try-publish.ts; it holds no key) or from TRY_OWNER_ACCOUNT,
// TRY_POLICY_ACCOUNT and TRY_AGENT_ACCOUNT. Every transaction is signed by the near CLI from its keychain (the owner for expire and the
// transfers, the agent for its own registration); this script reads no key. Actions are logged to target/try/refill.jsonl. Testnet only.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { rpcAccount, rpcView } from '../runtime/src/credit/rpc.ts';
import { refusedAccount, runRefill } from '../runtime/src/trycard/index.ts';
import type { RefillIo, RefillRecord, RefillState, TryNames } from '../runtime/src/trycard/index.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const msOf = (v: unknown): number => {
  if (typeof v !== 'string' || !/^[0-9]{1,16}$/.test(v)) throw new Error('a policy view answered a time that is not ms');
  // a time in ms: far below 2^53
  return +v;
};

export function liveIo(): RefillIo {
  const dir = env['TRY_DIR'] ?? join(REPO, 'target', 'try');
  const rpc = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
  const log = join(dir, 'refill.jsonl');
  const note = join(dir, 'published.json');
  const published = existsSync(note) ? (JSON.parse(readFileSync(note, 'utf8')) as Record<string, unknown>) : null;
  const pick = (key: string, name: string): string => {
    const v = published !== null && typeof published[key] === 'string' ? published[key] : env[name];
    if (typeof v !== 'string' || v === '') throw new Error(`the try accounts are unknown: publish first (target/try/published.json) or set ${name}`);
    const refused = refusedAccount(v);
    if (refused !== null) throw new Error(refused);
    return v;
  };
  const owner = pick('owner', 'TRY_OWNER_ACCOUNT');
  const names: TryNames = { owner, policy: pick('policy', 'TRY_POLICY_ACCOUNT'), agent: pick('agent', 'TRY_AGENT_ACCOUNT'), shop: `shop.${owner}` };
  const tasksExpireMs = published !== null && typeof published['expiresAt'] === 'string' && !Number.isNaN(Date.parse(published['expiresAt'])) ? Date.parse(published['expiresAt']) : null;
  const balance = async (id: string): Promise<{ amount: bigint; storage: bigint }> => {
    const a = await rpcAccount(rpc, id);
    if (a === null) throw new Error(`the account ${id} does not exist`);
    return a;
  };
  return {
    nowMs: () => Date.now(),
    liveOk: () => existsSync(join(dir, 'LIVE_OK')),
    state: async (): Promise<RefillState> => {
      const policy = await balance(names.policy);
      const pol = await rpcView(rpc, names.policy, 'get_policy', {});
      if (!isObj(pol) || typeof pol['paused'] !== 'boolean') throw new Error('get_policy answered something unexpected');
      const pending: RefillState['pending'] = [];
      for (let page = 0; page < 5; page += 1) {
        const rows = await rpcView(rpc, names.policy, 'get_pending', { from_index: page * 20, limit: 20 });
        if (!Array.isArray(rows)) throw new Error('get_pending answered something unexpected');
        for (const r of rows) if (isObj(r) && typeof r['id'] === 'string' && r['state'] === 'Pending') pending.push({ id: r['id'], expiresMs: msOf(r['expires_ms']) });
        if (rows.length < 20) break;
      }
      const agent = await rpcView(rpc, names.policy, 'get_agent', { account_id: names.agent });
      return {
        names,
        owner: (await balance(names.owner)).amount,
        agent: (await balance(names.agent)).amount,
        policy: { balance: policy.amount, storageBytes: policy.storage },
        paused: pol['paused'],
        pending,
        agentValid: (await rpcView(rpc, names.policy, 'is_agent_valid', { account_id: names.agent })) === true,
        agentValidUntilMs: isObj(agent) ? msOf(agent['valid_until_ms']) : null,
        tasksExpireMs,
      };
    },
    run: async (command) => {
      const r = spawnSync('bash', ['-c', command], { cwd: REPO, encoding: 'utf8', env: process.env });
      const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
      const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1] ?? null;
      const ok = r.status === 0 && tx !== null && !/ExecutionError|Failure|panicked/.test(out);
      return { ok, tx, tail: out.trim().split('\n').slice(-2).join(' | ').slice(-300) };
    },
    records: () => {
      if (!existsSync(log)) return [];
      const out: RefillRecord[] = [];
      for (const line of readFileSync(log, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          out.push(JSON.parse(line) as RefillRecord);
        } catch {
          // a torn last line is skipped
        }
      }
      return out;
    },
    append: (r) => {
      mkdirSync(dir, { recursive: true });
      appendFileSync(log, `${JSON.stringify(r)}\n`);
    },
    print: (l) => console.log(l),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const live = argv.length === 1 && argv[0] === '--live';
  if (argv.length > 0 && !live) {
    console.log('usage: try-refill.ts [--live]');
    return 2;
  }
  return runRefill(liveIo(), { live });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`TRY REFILL FAILED ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

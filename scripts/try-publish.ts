// AIR-356: writes web/public/try-public.json, the one file the "try it live" page needs next to the site: the try policy and its agent,
// the three published function-call keys (their secrets are public on purpose: each can only call submit_batch on the try policy), the
// booked shop with its book proof, and 60 tasks the owner signed ahead of time (the shop bounded at 0.01 NEAR, 99 actions, 7 days: 5,940
// attempt slots, because a request id is used once). The site has no server and a task lives at most 7 days, so this is run again, and the
// site deployed again, before the tasks expire: the last line says when.
//   set -a; . ~/.airlock-try.env; set +a
//   pnpm tsx scripts/try-publish.ts [--out web/public/try-public.json]     reads the chain, refuses or writes the file
//   pnpm tsx scripts/try-publish.ts --verify [--file <path> | --url <https url>] [--expect-day <NEAR>] [--expect-tasks <n>]
//                                                     read only: checks an existing file against the chain, then prints the card's state
//                                                     (the NEAR day cap, the shop's daily limit in the proof the page sends, the tasks, the
//                                                     free slots) and, with the expect options, fails when the day cap, the shop's limit or
//                                                     the task count differ (AIR-364)
// Before anything is written the chain is read (views only) and the publish is refused for a key that is not a function-call key of the
// try agent for submit_batch on the try policy and nothing else, a full-access key, a stale book proof, another task key, an agent that
// is not valid, a paused policy, or any credit account. Env (from scripts/try-setup.ts): TRY_OWNER_ACCOUNT, TRY_POLICY_ACCOUNT,
// TRY_AGENT_ACCOUNT, TRY_SHOP_ACCOUNT, TRY_TASK_KEY_FILE, TRY_BOOK_VAULT, TRY_KEY_PUBLIC_1..3, TRY_KEY_SECRET_1..3. It sends nothing.
// The output is ignored by git; a note without any key (when the tasks expire) goes to target/try/published.json for the refill job.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { rpcView } from '../runtime/src/credit/rpc.ts';
import { taskSigner } from '../runtime/src/mcp/boot.ts';
import { TRY_KEY_COUNT, buildTryPublic, nearText, parseTryPublic, publishRefusal, refusedAccount } from '../runtime/src/trycard/index.ts';
import type { TryChainFacts, TryChainKey } from '../runtime/src/trycard/index.ts';
import { loadVault } from '../runtime/src/vault/file.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const env = process.env;

const need = (name: string): string => {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new Error(`missing ${name} (source the try env file first: set -a; . ~/.airlock-try.env; set +a)`);
  return v.trim();
};
const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** What the checks read from the chain: views only. */
export async function chainFacts(policy: string, agent: string): Promise<TryChainFacts> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'try', method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: agent } }), signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as { result?: { keys?: TryChainKey[] } };
  if (!res.ok || !Array.isArray(body.result?.keys)) throw new Error(`the access keys of ${agent} could not be read`);
  const view = (method: string, args: object = {}): Promise<unknown> => rpcView(RPC, policy, method, args);
  const pol = await view('get_policy');
  const flags = isObj(pol) && isObj(pol['flags']) ? pol['flags'] : null;
  if (!isObj(pol) || flags === null || typeof pol['paused'] !== 'boolean') throw new Error('get_policy answered something unexpected');
  const ms = (v: unknown): number => {
    if (typeof v !== 'string' || !/^[0-9]{1,13}$/.test(v)) throw new Error('a policy flag is not a time in ms');
    return +v;
  };
  const assets = await view('list_assets');
  const near = Array.isArray(assets) ? assets.find((a) => Array.isArray(a) && a[0] === 'near') : undefined;
  const entry = Array.isArray(near) && isObj(near[1]) ? near[1] : null;
  if (entry === null || typeof entry['hard_cap'] !== 'string' || typeof entry['quick_task_cap'] !== 'string') throw new Error('the policy has no NEAR asset');
  const root = await view('get_book_root');
  const taskKey = await view('get_task_key');
  const valid = await view('is_agent_valid', { account_id: agent });
  if (typeof root !== 'string' || typeof flags['max_task_actions'] !== 'number') throw new Error('a policy view answered something unexpected');
  return {
    keys: body.result.keys,
    bookRoot: root,
    taskKey: typeof taskKey === 'string' ? taskKey : null,
    agentValid: valid === true,
    paused: pol['paused'],
    flags: { max_task_ttl_ms: ms(flags['max_task_ttl_ms']), max_task_actions: flags['max_task_actions'], pending_ttl_ms: ms(flags['pending_ttl_ms']) },
    hardCap: BigInt(entry['hard_cap']),
    quickTaskCap: BigInt(entry['quick_task_cap']),
  };
}

export type CardState = { dailyCap: bigint; shopLimit: bigint; tasks: number; free: number; total: number };

/** The state line of --verify, and why the state is not what the expect options say (null when it is, or when nothing is expected). */
export function stateCheck(s: CardState, expect: { day?: string; tasks?: number }): { line: string; why: string | null } {
  const line = `TRY CARD STATE day cap ${nearText(s.dailyCap)} NEAR, shop daily limit ${nearText(s.shopLimit)} NEAR in the proof the page sends, ${String(s.tasks)} tasks, ${String(s.free)} of ${String(s.total)} slots free`;
  if (expect.day !== undefined && nearText(s.dailyCap) !== expect.day) return { line, why: `the day cap is ${nearText(s.dailyCap)} NEAR, not ${expect.day}` };
  if (expect.day !== undefined && nearText(s.shopLimit) !== expect.day) return { line, why: `the shop's daily limit in the published proof is ${nearText(s.shopLimit)} NEAR, not ${expect.day}` };
  if (expect.tasks !== undefined && s.tasks !== expect.tasks) return { line, why: `the file holds ${String(s.tasks)} live tasks, not ${String(expect.tasks)}` };
  return { line, why: null };
}

/** The card's state from the chain for a parsed file: the NEAR day cap, the shop's proven limit, and the free slots of its tasks. */
async function cardState(policy: string, shopLimit: string, tasks: readonly { task_hash: string; task: { max_actions: number } }[]): Promise<CardState> {
  const asset = await rpcView(RPC, policy, 'get_asset', { asset: 'near' });
  if (!isObj(asset) || typeof asset['daily_cap'] !== 'string' || !/^[0-9]{1,39}$/.test(asset['daily_cap'])) throw new Error('get_asset answered something unexpected');
  let free = 0;
  let total = 0;
  for (const t of tasks) {
    const st = await rpcView(RPC, policy, 'get_task_state', { task_hash: t.task_hash });
    if (!isObj(st) || typeof st['actions_used'] !== 'number' || typeof st['revoked'] !== 'boolean') throw new Error('get_task_state answered something unexpected');
    total += t.task.max_actions;
    if (!st['revoked']) free += Math.max(0, t.task.max_actions - st['actions_used']);
  }
  return { dailyCap: BigInt(asset['daily_cap']), shopLimit: BigInt(shopLimit), tasks: tasks.length, free, total };
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--verify')) {
    const url = flag(argv, 'url');
    const path = resolve(REPO, flag(argv, 'file') ?? join('web', 'public', 'try-public.json'));
    let raw: unknown;
    if (url !== undefined) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${String(res.status)}`);
      raw = await res.json();
    } else {
      if (!existsSync(path)) throw new Error(`${path} is missing`);
      raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    }
    if (!isObj(raw) || typeof raw['policy'] !== 'string' || typeof raw['agent'] !== 'string') {
      console.log('TRY PUBLIC NO the file is not in the try card format');
      return 1;
    }
    for (const id of [raw['policy'], raw['agent']]) {
      const refused = refusedAccount(id);
      if (refused !== null) {
        console.log(`TRY PUBLIC NO ${refused}`);
        return 1;
      }
    }
    const why = await publishRefusal(raw, await chainFacts(raw['policy'], raw['agent']), Date.now());
    const tasks = Array.isArray(raw['tasks']) ? raw['tasks'] : [];
    const first = isObj(tasks[0]) && typeof tasks[0]['expiresAt'] === 'string' ? tasks[0]['expiresAt'] : 'unknown';
    if (why !== null) {
      console.log(`TRY PUBLIC NO ${why}`);
      return 1;
    }
    const parsed = parseTryPublic(raw, Date.now());
    if (!('ok' in parsed)) throw new Error(parsed.refuse);
    const expectTasks = flag(argv, 'expect-tasks');
    if (expectTasks !== undefined && !/^[0-9]{1,4}$/.test(expectTasks)) throw new Error('--expect-tasks takes a whole number');
    const expectDay = flag(argv, 'expect-day');
    const state = stateCheck(await cardState(parsed.ok.policy, parsed.ok.shop.proof.daily_limit, parsed.ok.tasks), { ...(expectDay === undefined ? {} : { day: expectDay }), ...(expectTasks === undefined ? {} : { tasks: +expectTasks }) });
    console.log(state.line);
    if (state.why !== null) {
      console.log(`TRY PUBLIC NO ${state.why}`);
      return 1;
    }
    console.log(`TRY PUBLIC OK ${raw['policy']}: ${String(Array.isArray(raw['keys']) ? raw['keys'].length : 0)} keys, ${String(tasks.length)} tasks, valid until ${first}`);
    return 0;
  }

  const names = { owner: need('TRY_OWNER_ACCOUNT'), policy: need('TRY_POLICY_ACCOUNT'), agent: need('TRY_AGENT_ACCOUNT'), shop: need('TRY_SHOP_ACCOUNT') };
  for (const id of Object.values(names)) {
    const refused = refusedAccount(id);
    if (refused !== null) throw new Error(`REFUSED: ${refused}`);
  }
  const keys = Array.from({ length: TRY_KEY_COUNT }, (_, i) => ({ publicKey: need(`TRY_KEY_PUBLIC_${String(i + 1)}`), secretKey: need(`TRY_KEY_SECRET_${String(i + 1)}`) }));
  const chain = await chainFacts(names.policy, names.agent);
  const nowMs = Date.now();
  const file = buildTryPublic({ names, keys, vault: loadVault(need('TRY_BOOK_VAULT')), nowMs, sign: taskSigner(need('TRY_TASK_KEY_FILE')), pendingTtlMs: chain.flags.pending_ttl_ms });
  const why = await publishRefusal(file, chain, nowMs);
  if (why !== null) throw new Error(`REFUSED: ${why}`);
  const out = resolve(REPO, flag(argv, 'out') ?? join('web', 'public', 'try-public.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  const expiresAt = file.tasks[0]?.expiresAt ?? 'unknown';
  // for the refill job: when the tasks expire and their hashes (to count the free slots), and nothing else (no key)
  const note = join(REPO, 'target', 'try', 'published.json');
  mkdirSync(dirname(note), { recursive: true });
  writeFileSync(note, `${JSON.stringify({ policy: names.policy, agent: names.agent, owner: names.owner, publishedAt: file.publishedAt, expiresAt, tasks: file.tasks.length, slots: file.tasks.length * (file.tasks[0]?.task.max_actions ?? 0), maxActions: file.tasks[0]?.task.max_actions ?? 0, taskHashes: file.tasks.map((t) => t.task_hash) }, null, 2)}\n`);
  console.log(`wrote ${out}`);
  console.log(`keys ${keys.map((k) => k.publicKey).join(', ')} on ${names.agent}: function call, receiver ${names.policy}, submit_batch only`);
  console.log(`tasks ${String(file.tasks.length)} of ${String(file.tasks[0]?.task.max_actions ?? 0)} actions (${String(file.tasks.length * (file.tasks[0]?.task.max_actions ?? 0))} attempt slots), each bounding the shop at 0.01 NEAR`);
  console.log(`PUBLISH THE SITE AGAIN BEFORE ${expiresAt}`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`TRY PUBLISH FAILED ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

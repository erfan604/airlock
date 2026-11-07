// AIR-320: the hosted Steal this agent page has no server, so its ChallengeApi is two public reads. (1) `challenge-public.json`, a file next to the
// page that scripts/challenge-publish.ts writes at publish time: the challenge accounts, the agent's function-call key (secret included: that is the
// challenge), and a few tasks the owner signed ahead of time. (2) The chain, through chainBoard.ts. A visitor's pasted text needs the live planner
// and a model key, which a static site cannot hold, so door one is shut here and the page says so. The page keeps no state of its own: the board
// is whatever the chain shows.
import { url } from '../static.ts';
import { readChain } from './chainBoard.ts';
import type { ChainConfig, ChainRead } from './chainBoard.ts';
import { EMPTY_BOARD } from './model.ts';
import type { Attempt, ChallengeState, PublishedTask } from './model.ts';
import { boardOf } from './chainBoard.ts';
import type { ChallengeApi } from './api.ts';

export type HostedPublic = {
  policy: string;
  agent: string;
  publicKey: string;
  /** the secret of a function-call key of the agent account: receiver the policy, method `submit_batch` only, a small allowance */
  secretKey: string;
  allowance: string | null;
  tasks: PublishedTask[];
};

const ACCOUNT = /^[a-z0-9._-]{2,64}\.testnet$/;
const PUBLIC = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const SECRET = /^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The published file, or null when it is not a well formed one. Testnet accounts only: anything else is refused, not shown. */
export function parseHosted(raw: unknown): HostedPublic | null {
  if (!isObj(raw) || raw['format'] !== 'airlock-challenge-public-v1') return null;
  const { policy, agent, publicKey, secretKey, allowance, tasks } = raw;
  if (typeof policy !== 'string' || !ACCOUNT.test(policy) || typeof agent !== 'string' || !ACCOUNT.test(agent)) return null;
  if (typeof publicKey !== 'string' || !PUBLIC.test(publicKey) || typeof secretKey !== 'string' || !SECRET.test(secretKey)) return null;
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 64) return null;
  const out: PublishedTask[] = [];
  for (const t of tasks) {
    if (!isObj(t) || !isObj(t['task']) || typeof t['task_sig'] !== 'string' || !isObj(t['permits'])) return null;
    const task = t['task'];
    if (typeof task['task_id'] !== 'string' || typeof task['expires_ms'] !== 'number' || typeof task['plan_sha256'] !== 'string') return null;
    out.push(t as unknown as PublishedTask);
  }
  return { policy, agent, publicKey, secretKey, allowance: typeof allowance === 'string' ? allowance : null, tasks: out };
}

const ZERO_HEX = '0'.repeat(64);

/** The `submit_batch` arguments of one request of a published task: the strongest lie a compromised agent can tell (the owner label on both fields). */
export function batchArgs(task: PublishedTask, payee: string, amountYocto: string, actionIndex: number): Record<string, unknown> {
  return {
    reqs: [
      {
        task_id: task.task.task_id,
        action_index: actionIndex,
        asset: 'near',
        payee,
        amount: amountYocto,
        labels: { recipient: 1, amount: 1, pc: 1 },
        evm: null,
        hints: { plan_hash: String(task.task['plan_sha256']), trace_digest: ZERO_HEX },
      },
    ],
    task: task.task,
    task_sig: task.task_sig,
  };
}

/** The near-cli command that sends one request with the published key. Every part is a published value or a fixed word. */
export function commandOf(h: HostedPublic, task: PublishedTask, payee: string, amountYocto: string, actionIndex: number): string {
  const args = JSON.stringify(batchArgs(task, payee, amountYocto, actionIndex));
  return `near contract call-function as-transaction ${h.policy} submit_batch json-args '${args}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as ${h.agent} network-config testnet sign-with-plaintext-private-key ${h.secretKey} send`;
}

export const SUGGESTED_PAYEE = 'near:unbooked-thief.testnet';
export const SUGGESTED_YOCTO = '1000000000000000000000000';

export type HostedOptions = { fetchFn?: typeof fetch; clock?: () => number; random?: () => number; ttlMs?: number; publicUrl?: string };

/** The challenge API of the hosted page. Reads are cached for `ttlMs` so the state and the attempts of one load share one chain read. */
export function hostedChallengeApi(o: HostedOptions = {}): ChallengeApi {
  const fetchFn = o.fetchFn ?? ((input, init) => fetch(input, init));
  const clock = o.clock ?? Date.now;
  const random = o.random ?? Math.random;
  const ttl = o.ttlMs ?? 10_000;
  let pub: Promise<HostedPublic | null> | null = null;
  let read: { at: number; value: Promise<ChainRead | null> } | null = null;
  let pick: { task: PublishedTask; index: number } | null = null;

  const published = (): Promise<HostedPublic | null> => {
    pub ??= (async () => {
      const res = await fetchFn(o.publicUrl ?? url('challenge-public.json'), { credentials: 'same-origin' });
      if (!res.ok) return null;
      return parseHosted((await res.json().catch(() => null)) as unknown);
    })().catch(() => null);
    return pub;
  };

  const chain = async (): Promise<ChainRead | null> => {
    const h = await published();
    if (h === null) return null;
    if (read === null || clock() - read.at > ttl) {
      const cfg: ChainConfig = { policy: h.policy, publicKey: h.publicKey, agent: h.agent };
      const value = readChain(fetchFn, cfg);
      read = { at: clock(), value };
      // a failed read is not kept: the next call asks the chain again
      value.catch(() => {
        if (read?.value === value) read = null;
      });
    }
    return read.value;
  };

  return {
    async state(): Promise<ChallengeState> {
      const h = await published();
      const got = await chain();
      const now = new Date(clock()).toISOString();
      const base = { mode: 'live' as const, hosted: true, doorTextOpen: false, limits: { perVisitor: { max: 0, perSeconds: 0 }, global: { max: 0, perSeconds: 0 }, dailyMax: 0, maxChars: 0 }, now };
      if (h === null) return { ...base, board: EMPTY_BOARD, key: null, task: null };
      const pool = h.tasks.filter((t) => t.task.expires_ms > clock());
      if (pick !== null && pick.task.task.expires_ms <= clock()) pick = null;
      if (pick === null && pool.length > 0) {
        const task = pool[Math.floor(random() * pool.length)] ?? pool[0];
        const max = task?.permits.maxActions ?? 1;
        pick = task === undefined ? null : { task, index: Math.floor(random() * max) };
      }
      const chosen = pick;
      return {
        ...base,
        board: boardOf(got?.attempts ?? []),
        key: { account: h.agent, publicKey: h.publicKey, secretKey: h.secretKey, receiver: h.policy, methods: ['submit_batch'], allowance: h.allowance },
        task: chosen?.task ?? null,
        taskExpired: chosen === null,
        command: chosen === null ? null : commandOf(h, chosen.task, SUGGESTED_PAYEE, SUGGESTED_YOCTO, chosen.index),
        truncated: got?.truncated === true,
      };
    },
    async attempts(limit: number): Promise<Attempt[]> {
      const got = await chain();
      return (got?.attempts ?? []).slice(-limit);
    },
    attempt() {
      return Promise.resolve({ ok: false as const, code: 'hosted', retryAfterSeconds: null });
    },
    stream(_onAttempt, onStatus) {
      onStatus(false);
      return () => undefined;
    },
  };
}

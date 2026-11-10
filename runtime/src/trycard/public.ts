// AIR-356: the public file of the "try it live" card (try-public.json, written by scripts/try-publish.ts and served next to the site): the
// try policy and its agent, the published function-call keys (their secrets are public on purpose: each can only call submit_batch on the
// try policy), the booked shop with its book proof, and the tasks the owner signed ahead of time. Parsed strictly: a file that names a
// credit account or a personal name, has a malformed key, or has no task that is still valid is refused. Pure and free of Node imports: the page reads it through @airlock/runtime/try-public.
export const TRY_PUBLIC_FORMAT = 'airlock-try-public-v1';
/** The tag of an owner task (runtime/src/dsl/task.ts TASK_TAG). */
export const TRY_TASK_TAG = 'airlock-task-v1';

export type TryProof = { salt: string; cap: string | null; daily_untrusted_budget: string; daily_limit: string; index: number; siblings: string[] };
export type TryTask = {
  task: {
    tag: typeof TRY_TASK_TAG;
    task_id: string;
    contract_id: string;
    agent_id: string;
    plan_sha256: string;
    instruction_sha256_salted: string;
    issued_ms: number;
    expires_ms: number;
    max_actions: number;
    bounds: { payee_key: string; max_total: string }[];
  };
  /** the owner's signature over the task, base64 */
  task_sig: string;
  /** a request id is `<task_hash>:<action_index>`, used once */
  task_hash: string;
  issuedAt: string;
  expiresAt: string;
};
export type TryPublic = {
  format: typeof TRY_PUBLIC_FORMAT;
  policy: string;
  agent: string;
  keys: { publicKey: string; secretKey: string }[];
  /** the one booked payee and the proof a request to it carries */
  shop: { payee: string; proof: TryProof };
  /** the booked payee keys (the policy contract has no book view) */
  book: string[];
  /** how long a held request lives on the try policy */
  pendingTtlMs: number;
  /** the amount of the honest request, yocto */
  honestAmount: string;
  publishedAt: string;
  tasks: TryTask[];
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HEX64 = /^[0-9a-f]{64}$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const SECRET_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const ACCOUNT = /^[a-z0-9._-]{2,64}\.testnet$/;

/** Why an account must not be part of the try card, or null. */
export function refusedTryAccount(id: unknown): string | null {
  if (typeof id !== 'string' || !ACCOUNT.test(id)) return 'an account id is missing or malformed';
  if (id.endsWith('airlock-credit-c1108d.testnet')) return 'the file names a credit account';
  if (/erfan/i.test(id)) return 'the file names an account with a personal name';
  return null;
}

function proofOf(v: unknown): TryProof | null {
  if (!isObj(v) || typeof v['salt'] !== 'string' || !HEX64.test(v['salt'])) return null;
  const cap = v['cap'];
  if (cap !== null && (typeof cap !== 'string' || !DEC.test(cap))) return null;
  const [budget, limit, index, siblings] = [v['daily_untrusted_budget'], v['daily_limit'], v['index'], v['siblings']];
  if (typeof budget !== 'string' || !DEC.test(budget) || typeof limit !== 'string' || !DEC.test(limit)) return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 255) return null;
  if (!Array.isArray(siblings) || siblings.length > 16 || !siblings.every((s): s is string => typeof s === 'string' && HEX64.test(s))) return null;
  return { salt: v['salt'], cap, daily_untrusted_budget: budget, daily_limit: limit, index, siblings };
}

function taskOf(v: unknown, policy: string, agent: string): TryTask | 'foreign' | null {
  if (!isObj(v) || !isObj(v['task'])) return null;
  const t = v['task'];
  const strings = ['tag', 'task_id', 'contract_id', 'agent_id', 'plan_sha256', 'instruction_sha256_salted'].every((k) => typeof t[k] === 'string');
  const numbers = ['issued_ms', 'expires_ms', 'max_actions'].every((k) => typeof t[k] === 'number' && Number.isSafeInteger(t[k]) && t[k] >= 0);
  const bounds = Array.isArray(t['bounds']) && t['bounds'].length > 0 && t['bounds'].every((b) => isObj(b) && typeof b['payee_key'] === 'string' && typeof b['max_total'] === 'string' && DEC.test(b['max_total']));
  if (!strings || !numbers || !bounds || t['tag'] !== TRY_TASK_TAG) return null;
  if (typeof v['task_sig'] !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(v['task_sig'])) return null;
  if (typeof v['task_hash'] !== 'string' || !HEX64.test(v['task_hash'])) return null;
  if (typeof v['issuedAt'] !== 'string' || typeof v['expiresAt'] !== 'string') return null;
  if (t['contract_id'] !== policy || t['agent_id'] !== agent) return 'foreign';
  return v as unknown as TryTask;
}

/** The parsed file with its tasks that are still valid at `nowMs`, or the reason it is refused (one line, no secret in it). */
export function parseTryPublic(raw: unknown, nowMs: number): { ok: TryPublic } | { refuse: string } {
  if (!isObj(raw) || raw['format'] !== TRY_PUBLIC_FORMAT) return { refuse: 'the file is not in the try card format' };
  for (const id of [raw['policy'], raw['agent']]) {
    const why = refusedTryAccount(id);
    if (why !== null) return { refuse: why };
  }
  const policy = raw['policy'] as string;
  const agent = raw['agent'] as string;
  const keys = raw['keys'];
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8) return { refuse: 'the file holds no published key' };
  const outKeys: TryPublic['keys'] = [];
  for (const k of keys) {
    if (!isObj(k) || typeof k['publicKey'] !== 'string' || !PUBLIC_KEY.test(k['publicKey']) || typeof k['secretKey'] !== 'string' || !SECRET_KEY.test(k['secretKey'])) return { refuse: 'a published key is malformed' };
    outKeys.push({ publicKey: k['publicKey'], secretKey: k['secretKey'] });
  }
  const shop = raw['shop'];
  const book = raw['book'];
  if (!isObj(shop) || typeof shop['payee'] !== 'string' || !/^near:[a-z0-9._-]{2,64}$/.test(shop['payee'])) return { refuse: 'the booked shop is missing' };
  const shopWhy = refusedTryAccount(shop['payee'].slice('near:'.length));
  if (shopWhy !== null) return { refuse: shopWhy };
  if (!Array.isArray(book) || !book.every((b): b is string => typeof b === 'string') || !book.includes(shop['payee'])) return { refuse: 'the book list does not hold the booked shop' };
  const proof = proofOf(shop['proof']);
  if (proof === null) return { refuse: "the shop's book proof is malformed" };
  const ttl = raw['pendingTtlMs'];
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 1000) return { refuse: 'the hold time is missing' };
  if (typeof raw['honestAmount'] !== 'string' || !DEC.test(raw['honestAmount'])) return { refuse: 'the honest amount is missing' };
  if (typeof raw['publishedAt'] !== 'string') return { refuse: 'the publish time is missing' };
  if (!Array.isArray(raw['tasks'])) return { refuse: 'the file holds no task' };
  const tasks: TryTask[] = [];
  for (const item of raw['tasks']) {
    const t = taskOf(item, policy, agent);
    if (t === null) return { refuse: 'a task is malformed' };
    if (t === 'foreign') return { refuse: 'a task is for another policy or agent' };
    if (t.task.expires_ms > nowMs) tasks.push(t);
  }
  if (tasks.length === 0) return { refuse: 'the file holds no task that is still valid' };
  return { ok: { format: TRY_PUBLIC_FORMAT, policy, agent, keys: outKeys, shop: { payee: shop['payee'], proof }, book, pendingTtlMs: ttl, honestAmount: raw['honestAmount'], publishedAt: raw['publishedAt'], tasks } };
}

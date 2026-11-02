#!/usr/bin/env node
// AIR-024: writes the shared vector file family that pins every encoding crossing the Rust, Lean and TypeScript boundary.
//   fixtures/verdict-vectors.json    labels, 200 verdicts (full SubmitRequest JSON), owner_task, payee_keys, decimals, submit_rejections
//   fixtures/owner-task.json         the owner_task object alone, the same bytes as inside verdict-vectors.json
//   fixtures/verdict-vectors.lines   the 200 verdicts as the 21 natural numbers per line that proofs/VerdictRun.lean reads
//   fixtures/verdict-vectors.expect  the 200 expected tags, one per line, same order
//   fixtures/verdict-vectors.sha256  one line per file above, `<hash>  fixtures/<name>`, for `sha256sum -c` from the repo root
// Usage: node scripts/gen_vectors.mjs [--check]   (Node 24, node:crypto only; --check regenerates in memory and compares byte for byte)
// The file is data: all non-ASCII is written as \uXXXX escapes, here and in the output. The vector seed and key are a published
// throwaway (32 bytes of 01) and must never be used outside tests.
//
// How the expected tags come about: the 14 rows of the DAY1-3 table, one case per reason, the boundary cases (limit and limit plus one
// for every limit) and the u128 maximum cases carry hand-written `expect` values, and the generator exits 1 if refVerdict disagrees
// with any of them. refVerdict is a BigInt reading of SPEC 8.3 rules 0 to 12, written from the spec text and not translated from the
// Rust or the Lean; it labels the seeded random cases. Rust, Lean and TypeScript each check all 200 against `expect`.
//
// Mapping used by every consumer: Request.amount = request.amount; fee_per_gas = request.evm.max_fee_per_gas and gas =
// request.evm.gas_limit when evm is not null, otherwise both None; max_priority_fee_per_gas is not read by the verdict; labels as
// sent; Flags.paused = context.paused; asset, payee and task_remaining become the Option arguments from context.
//
// Payee key classification (the `error` of each payee_keys.reject entry; AIR-043 implements the same order): any byte above 0x7f
// is NonAscii before anything else; the scheme is `near:` or `evm:`, anything else is UnknownScheme; a near account is 2 to 64
// characters (BadLength), characters of [a-z0-9] and the separators - _ . (BadChar for others), no leading, trailing or doubled
// separator (BadSeparator); an evm key is `evm:<chain id>:<address>` with a chain id of decimal digits, no leading zero, from 1 to
// 2^64 - 1 (BadChainId, including an empty one), and an address of exactly `0x` plus 40 lowercase hex digits (BadLength for any
// other length, BadChar for a wrong prefix letter, uppercase or a non-hex digit of a 42 character address). AIR-109 adds the form
// `erc20:<chain id>:<token>:<payee>`: the chain id as above, then the token address, then the payee address, in that order (a missing
// token or payee is an empty address, BadLength).
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures');
const SEED = 'airlock-verdict-vectors-v1';
const U128_MAX = (1n << 128n) - 1n;

const sha256 = (data) => createHash('sha256').update(data).digest();
const hex = (buf) => Buffer.from(buf).toString('hex');

// ---- seeded generator: sha256(seed + ":" + counter), the first 4 bytes over 2^32 ----
class Rng {
  constructor(seed) {
    this.seed = seed;
    this.counter = 0;
  }
  u32() {
    return sha256(`${this.seed}:${this.counter++}`).readUInt32BE(0);
  }
  below(n) {
    return Math.floor((this.u32() / 4294967296) * n);
  }
  chance(p) {
    return this.u32() / 4294967296 < p;
  }
  between(lo, hi) {
    return lo + this.below(hi - lo + 1);
  }
  pick(list) {
    return list[this.below(list.length)];
  }
}

// ---- labels (F01 3.2): bit i is name i ----
const LABEL_NAMES = [
  'Owner',
  'Book',
  'Policy',
  'Oracle',
  'Unresolved',
  'Untrusted:email',
  'Untrusted:web',
  'Untrusted:file',
  'Untrusted:chat',
  'Untrusted:social',
  'Untrusted:tool_output',
  'Untrusted:memory',
  'Untrusted:quarantine',
  'Untrusted:payment_protocol',
  'Untrusted:other',
];
const INVALID_LABEL_NAMES = [
  'untrusted:email',
  'Untrusted:Email',
  'Owner ',
  '',
  'Untrusted:unknown',
  'Untrusted:',
  'Untrusted:tool',
  'Untrusted:token_meta',
  'Untrusted:paste',
  '0',
  'OWNER',
  'Own\u200ber',
];
const OWNER = 1;
const BOOK = 2;
const POLICY = 4;
const ORACLE = 8;
const UNRESOLVED = 16;
const EMAIL = 32;
const WEB = 64;
const FILE = 128;
const CHAT = 256;
const namesOf = (mask) => LABEL_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);

// ---- the reference verdict: SPEC 8.3 rules 0 to 12 on the JSON shape (strings, BigInt) ----
function refVerdict(request, context) {
  const amount = BigInt(request.amount);
  const limits = context.asset;
  if (limits === null) return 'block:UnknownAsset'; // 0
  if (context.paused) return 'block:Paused'; // 1
  if (amount === 0n || amount > BigInt(limits.hard_cap)) return 'block:AmountOutOfBounds'; // 2
  if (amount > BigInt(limits.remaining_daily)) return 'block:DailyLimit';
  const evm = request.evm;
  if (evm !== null && (BigInt(evm.max_fee_per_gas) > BigInt(limits.max_fee_per_gas) || BigInt(evm.gas_limit) > BigInt(limits.max_gas))) {
    return 'block:FeeTooHigh'; // 3
  }
  const { recipient, amount: amountLabels, pc } = request.labels;
  if (recipient === 0 || amountLabels === 0 || pc === 0) return 'block:MissingProvenance'; // 4
  if ((recipient & 0b10) !== 0 && context.payee === null) return 'block:BookLabelNotInBook'; // 5
  if (context.task_remaining === null) return 'escalate:OutsideTask'; // 6
  if (amount > BigInt(context.task_remaining)) return 'escalate:OverTaskBound';
  if ((pc & ~0b1111) !== 0) return 'escalate:UntrustedTrigger'; // 7: outside Owner, Book, Policy, Oracle
  if ((recipient & ~0b0111) !== 0) return 'escalate:UntrustedRecipient'; // 8: outside Owner, Book, Policy
  const payee = context.payee;
  if (payee === null) return 'escalate:NewRecipient'; // 9
  if (amount > BigInt(payee.limit_remaining)) return 'escalate:OverPayeeLimit'; // 10
  if ((amountLabels & ~0b1111) !== 0) {
    // 11: an untrusted amount passes only inside the payee cap and budget and never when Unresolved
    const unresolved = (amountLabels & 0b10000) !== 0;
    const inside = payee.cap !== null && amount <= BigInt(payee.cap) && amount <= BigInt(payee.budget_remaining);
    return !unresolved && inside ? 'allow' : 'escalate:UntrustedAmount';
  }
  return 'allow'; // 12
}

// ---- the vector task (single source of the OwnerTask layout; AIR-045 and the TypeScript ownerTaskBorsh reproduce it) ----
const borshString = (s) => {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const u128le = (n) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
};
function taskBytes(t) {
  const parts = [
    borshString(t.tag),
    borshString(t.task_id),
    borshString(t.contract_id),
    borshString(t.agent_id),
    Buffer.from(t.plan_sha256, 'hex'),
    Buffer.from(t.instruction_sha256_salted, 'hex'),
    u64le(t.issued_ms),
    u64le(t.expires_ms),
    Buffer.from([t.max_actions]),
    u32le(t.bounds.length),
  ];
  for (const b of t.bounds) parts.push(borshString(b.payee_key), u128le(BigInt(b.max_total)));
  return Buffer.concat(parts);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${hex(bytes)}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const KEY_SEED = Buffer.alloc(32, 1);
const KNOWN_PUBLIC_KEY = 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';

const TASK = {
  tag: 'airlock-task-v1',
  task_id: 'task-\u00e9\u4e2d-0001', // non-ASCII on purpose: 12 characters, 15 UTF-8 bytes, pins the length prefix
  contract_id: 'policy.test.near',
  agent_id: 'agent.test.near',
  plan_sha256: hex(sha256('airlock-vector-plan')),
  instruction_sha256_salted: hex(sha256('airlock-vector-instruction-salt')),
  issued_ms: 1800000000000,
  expires_ms: 1800001800000,
  max_actions: 3,
  bounds: [
    { payee_key: 'near:accountant.test.near', max_total: '5000000000000000000000000' },
    { payee_key: 'evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045', max_total: '1000000000000000' },
  ],
};

function buildOwnerTask() {
  const bytes = taskBytes(TASK);
  const taskHash = sha256(bytes);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, KEY_SEED]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicKey = `ed25519:${base58(spki.subarray(spki.length - 32))}`;
  if (publicKey !== KNOWN_PUBLIC_KEY) fail(`public key of the vector seed is ${publicKey}, expected ${KNOWN_PUBLIC_KEY}`);
  return {
    tag: TASK.tag,
    task_id: TASK.task_id,
    contract_id: TASK.contract_id,
    agent_id: TASK.agent_id,
    plan_sha256: TASK.plan_sha256,
    instruction_sha256_salted: TASK.instruction_sha256_salted,
    issued_ms: TASK.issued_ms,
    expires_ms: TASK.expires_ms,
    max_actions: TASK.max_actions,
    bounds: TASK.bounds,
    borsh_hex: hex(bytes),
    sha256_hex: hex(taskHash),
    request_ids: [0, 1, 2].map((i) => `${hex(taskHash)}:${i}`),
    seed_hex: hex(KEY_SEED),
    public_key: publicKey,
    signature_hex: hex(edSign(null, bytes, privateKey)),
  };
}

// ---- verdict cases ----
const NEAR_PAYEES = ['near:accountant.test.near', 'near:landlord.test.near', 'near:vendor-1.test.near'];
const EVM_PAYEES = ['evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 'evm:84532:0x1111111111111111111111111111111111111111'];

function baseCase() {
  return {
    lane: 'near',
    payeeIndex: 0,
    amount: 10n,
    r: BOOK,
    a: OWNER,
    pc: OWNER,
    fee: 10n,
    gas: 21000n,
    limits: { hard: 1000n, daily: 1000n, fee: 50n, gas: 100000n },
    payee: { cap: null, budget: 0n, limit: 1000n },
    task: 1000n,
    paused: false,
  };
}

// edits: any field of baseCase; `limits` and `payee` merge field by field, null removes them; setting fee or gas moves the case to the EVM lane
function makeCase(edits) {
  const c = { ...baseCase(), ...edits };
  const base = baseCase();
  c.limits = edits.limits === null ? null : { ...base.limits, ...(edits.limits ?? {}) };
  c.payee = edits.payee === null ? null : { ...base.payee, ...(edits.payee ?? {}) };
  if ('fee' in edits || 'gas' in edits) c.lane = 'evm';
  return c;
}

const dec = (n) => n.toString();

function entryOf(name, c, expect) {
  const evm = c.lane === 'evm';
  const payees = evm ? EVM_PAYEES : NEAR_PAYEES;
  return {
    name,
    request: {
      task_id: TASK.task_id,
      asset: evm ? 'evm:84532:native' : 'near',
      payee: payees[c.payeeIndex % payees.length],
      amount: dec(c.amount),
      labels: { recipient: c.r, amount: c.a, pc: c.pc },
      evm: evm ? { gas_limit: dec(c.gas), max_fee_per_gas: dec(c.fee), max_priority_fee_per_gas: dec((c.fee + 1n) / 2n) } : null,
      hints: { plan_hash: TASK.plan_sha256, trace_digest: hex(sha256(`airlock-vector-trace:${name}`)) },
    },
    label_names: { recipient: namesOf(c.r), amount: namesOf(c.a), pc: namesOf(c.pc) },
    context: {
      asset:
        c.limits === null
          ? null
          : {
              hard_cap: dec(c.limits.hard),
              remaining_daily: dec(c.limits.daily),
              max_fee_per_gas: dec(c.limits.fee),
              max_gas: dec(c.limits.gas),
            },
      payee:
        c.payee === null
          ? null
          : { cap: c.payee.cap === null ? null : dec(c.payee.cap), budget_remaining: dec(c.payee.budget), limit_remaining: dec(c.payee.limit) },
      task_remaining: c.task === null ? null : dec(c.task),
      paused: c.paused,
    },
    expect,
  };
}

const MAX = U128_MAX;
const ALL_MAX = { limits: { hard: MAX, daily: MAX, fee: MAX, gas: MAX }, payee: { limit: MAX }, task: MAX, amount: MAX };

// [name, hand-written expect, edits]
const TABLE = [
  ['row01_base_allow', 'allow', {}],
  ['row02_untrusted_amount_inside_cap_and_budget', 'allow', { a: EMAIL, amount: 400n, payee: { cap: 500n, budget: 1000n } }],
  ['row03_untrusted_amount_over_budget', 'escalate:UntrustedAmount', { a: EMAIL, amount: 400n, payee: { cap: 500n, budget: 300n } }],
  ['row04_untrusted_amount_over_cap', 'escalate:UntrustedAmount', { a: EMAIL, amount: 940n, payee: { cap: 500n, budget: 1000n } }],
  ['row05_untrusted_pc', 'escalate:UntrustedTrigger', { pc: OWNER | EMAIL }],
  ['row06_book_label_not_in_book', 'block:BookLabelNotInBook', { payee: null }],
  ['row07_email_recipient', 'escalate:UntrustedRecipient', { r: EMAIL, payee: null }],
  ['row08_oracle_recipient', 'escalate:UntrustedRecipient', { r: ORACLE, payee: null }],
  ['row09_owner_recipient_not_in_book', 'escalate:NewRecipient', { r: OWNER, payee: null }],
  ['row10_amount_over_hard_cap', 'block:AmountOutOfBounds', { amount: 5000n }],
  ['row11_empty_pc', 'block:MissingProvenance', { pc: 0 }],
  ['row12_unknown_asset', 'block:UnknownAsset', { limits: null }],
  ['row13_fee_and_gas_over_caps', 'block:FeeTooHigh', { fee: 10n, gas: 200000n }],
  ['row14_paused', 'block:Paused', { paused: true }],
];

const REASONS = [
  ['reason_UnknownAsset', 'block:UnknownAsset', { limits: null, r: POLICY }],
  ['reason_Paused', 'block:Paused', { paused: true, amount: 1n }],
  ['reason_AmountOutOfBounds_zero', 'block:AmountOutOfBounds', { amount: 0n }],
  ['reason_DailyLimit', 'block:DailyLimit', { limits: { daily: 100n }, amount: 101n }],
  ['reason_FeeTooHigh', 'block:FeeTooHigh', { fee: 51n }],
  ['reason_MissingProvenance_recipient', 'block:MissingProvenance', { r: 0 }],
  ['reason_BookLabelNotInBook', 'block:BookLabelNotInBook', { r: BOOK | OWNER, payee: null }],
  ['reason_OutsideTask', 'escalate:OutsideTask', { task: null }],
  ['reason_OverTaskBound', 'escalate:OverTaskBound', { task: 5n }],
  ['reason_UntrustedTrigger', 'escalate:UntrustedTrigger', { pc: OWNER | WEB }],
  ['reason_UntrustedRecipient', 'escalate:UntrustedRecipient', { r: FILE }],
  ['reason_NewRecipient', 'escalate:NewRecipient', { r: POLICY, payee: null }],
  ['reason_OverPayeeLimit', 'escalate:OverPayeeLimit', { payee: { limit: 5n } }],
  ['reason_UntrustedAmount_unresolved', 'escalate:UntrustedAmount', { a: UNRESOLVED, payee: { cap: 500n, budget: 500n } }],
  ['allow_oracle_amount_and_oracle_pc', 'allow', { a: ORACLE, pc: OWNER | ORACLE }],
  ['allow_policy_recipient_in_book', 'allow', { r: POLICY }],
  ['allow_book_and_owner_recipient', 'allow', { r: BOOK | OWNER }],
  ['allow_evm_lane_within_limits', 'allow', { fee: 20n, gas: 50000n }],
];

const EDGES = [
  ['edge_hard_cap_at', 'allow', { amount: 1000n }],
  ['edge_hard_cap_over', 'block:AmountOutOfBounds', { amount: 1001n }],
  ['edge_daily_at', 'allow', { limits: { daily: 100n }, amount: 100n }],
  ['edge_daily_over', 'block:DailyLimit', { limits: { daily: 100n }, amount: 101n }],
  ['edge_fee_at', 'allow', { fee: 50n }],
  ['edge_fee_over', 'block:FeeTooHigh', { fee: 51n }],
  ['edge_gas_at', 'allow', { gas: 100000n }],
  ['edge_gas_over', 'block:FeeTooHigh', { gas: 100001n }],
  ['edge_task_at', 'allow', { task: 500n, amount: 500n }],
  ['edge_task_over', 'escalate:OverTaskBound', { task: 500n, amount: 501n }],
  ['edge_payee_limit_at', 'allow', { payee: { limit: 500n }, amount: 500n }],
  ['edge_payee_limit_over', 'escalate:OverPayeeLimit', { payee: { limit: 500n }, amount: 501n }],
  ['edge_cap_at', 'allow', { a: EMAIL, payee: { cap: 500n, budget: 1000n }, amount: 500n }],
  ['edge_cap_over', 'escalate:UntrustedAmount', { a: EMAIL, payee: { cap: 500n, budget: 1000n }, amount: 501n }],
  ['edge_budget_at', 'allow', { a: EMAIL, payee: { cap: 1000n, budget: 500n }, amount: 500n }],
  ['edge_budget_over', 'escalate:UntrustedAmount', { a: EMAIL, payee: { cap: 1000n, budget: 500n }, amount: 501n }],
  ['edge_amount_one', 'allow', { amount: 1n }],
  ['edge_amount_zero', 'block:AmountOutOfBounds', { amount: 0n }],
];

const MAXES = [
  ['max_every_limit_at_u128_max', 'allow', { ...ALL_MAX }],
  ['max_hard_cap_one_below', 'block:AmountOutOfBounds', { ...ALL_MAX, limits: { hard: MAX - 1n, daily: MAX, fee: MAX, gas: MAX } }],
  ['max_daily_one_below', 'block:DailyLimit', { ...ALL_MAX, limits: { hard: MAX, daily: MAX - 1n, fee: MAX, gas: MAX } }],
  ['max_task_one_below', 'escalate:OverTaskBound', { ...ALL_MAX, task: MAX - 1n }],
  ['max_payee_limit_one_below', 'escalate:OverPayeeLimit', { ...ALL_MAX, payee: { limit: MAX - 1n } }],
  ['max_untrusted_at_cap_and_budget', 'allow', { ...ALL_MAX, a: EMAIL, payee: { cap: MAX, budget: MAX, limit: MAX } }],
  ['max_untrusted_cap_one_below', 'escalate:UntrustedAmount', { ...ALL_MAX, a: EMAIL, payee: { cap: MAX - 1n, budget: MAX, limit: MAX } }],
  ['max_untrusted_budget_one_below', 'escalate:UntrustedAmount', { ...ALL_MAX, a: EMAIL, payee: { cap: MAX, budget: MAX - 1n, limit: MAX } }],
  ['max_evm_fee_and_gas_at_limits', 'allow', { ...ALL_MAX, fee: MAX, gas: MAX }],
  ['max_evm_fee_one_over', 'block:FeeTooHigh', { ...ALL_MAX, limits: { hard: MAX, daily: MAX, fee: MAX - 1n, gas: MAX }, fee: MAX, gas: MAX }],
];

const HAND_WRITTEN = [...TABLE, ...REASONS, ...EDGES, ...MAXES];
const TOTAL_VERDICTS = 200;

// seeded random cases: a valid base with 0 to 2 breakages, and some wild ones
function goodCase(rng) {
  const hard = BigInt(rng.between(200, 2000));
  const daily = BigInt(rng.between(100, 2000));
  const amount = BigInt(rng.between(1, Number(hard < daily ? hard : daily)));
  const c = makeCase({
    amount,
    payeeIndex: rng.below(3),
    r: rng.pick([BOOK, BOOK, BOOK, OWNER | BOOK, POLICY, BOOK | POLICY]),
    a: rng.pick([OWNER, OWNER, ORACLE, OWNER | ORACLE, BOOK, POLICY, EMAIL, WEB | OWNER]),
    pc: rng.pick([OWNER, OWNER, OWNER | ORACLE, OWNER | POLICY]),
    limits: { hard, daily, fee: BigInt(rng.between(20, 100)), gas: BigInt(rng.between(21000, 200000)) },
    task: amount + BigInt(rng.below(1000)),
    payee: { cap: rng.chance(0.2) ? null : amount + BigInt(rng.below(500)), budget: amount + BigInt(rng.below(500)), limit: amount + BigInt(rng.below(1000)) },
  });
  if (rng.chance(0.4)) {
    c.lane = 'evm';
    c.fee = BigInt(rng.between(1, Number(c.limits.fee)));
    c.gas = BigInt(rng.between(21000, Number(c.limits.gas)));
  }
  return c;
}

function breakCase(rng, c) {
  const evmLane = () => {
    if (c.lane !== 'evm') {
      c.lane = 'evm';
      c.fee = 1n;
      c.gas = 21000n;
    }
  };
  switch (rng.below(16)) {
    case 0:
      c.limits = null;
      break;
    case 1:
      c.paused = true;
      break;
    case 2:
      c.amount = rng.chance(0.5) ? 0n : (c.limits?.hard ?? 1000n) + BigInt(rng.between(1, 50));
      break;
    case 3:
      if (c.limits) c.limits.daily = c.amount - BigInt(rng.between(0, Number(c.amount < 50n ? c.amount : 50n)));
      break;
    case 4:
      evmLane();
      c.fee = (c.limits?.fee ?? 50n) + BigInt(rng.between(1, 30));
      break;
    case 5:
      evmLane();
      c.gas = (c.limits?.gas ?? 100000n) + BigInt(rng.between(1, 30000));
      break;
    case 6:
      rng.pick([() => (c.r = 0), () => (c.a = 0), () => (c.pc = 0)])();
      break;
    case 7:
      c.r |= rng.pick([EMAIL, WEB, FILE, CHAT, ORACLE, UNRESOLVED]);
      break;
    case 8:
      c.payee = null;
      break;
    case 9:
      c.task = rng.chance(0.4) ? null : c.amount - BigInt(rng.between(1, Number(c.amount < 20n ? c.amount : 20n)));
      break;
    case 10:
      c.pc |= rng.pick([EMAIL, WEB, FILE, CHAT, UNRESOLVED, 1 << 14]);
      break;
    case 11:
      if (c.payee) c.payee.limit = c.amount - BigInt(rng.between(1, Number(c.amount < 20n ? c.amount : 20n)));
      break;
    case 12:
      c.a = rng.pick([EMAIL, UNRESOLVED, UNRESOLVED | OWNER, EMAIL | ORACLE, 1 << 13]);
      if (c.payee) c.payee.cap = rng.pick([null, c.amount, c.amount - 1n, c.amount + 1n]);
      break;
    case 13:
      c.a = rng.pick([EMAIL, FILE | OWNER, 1 << 11]);
      if (c.payee) {
        c.payee.cap = c.amount + 100n;
        c.payee.budget = rng.pick([c.amount, c.amount - 1n, c.amount + 1n]);
      }
      break;
    case 14:
      c.r = rng.pick([OWNER, POLICY, OWNER | POLICY]);
      c.payee = rng.chance(0.5) ? null : c.payee;
      break;
    default:
      c.limits = c.limits && { ...c.limits, hard: c.amount - BigInt(rng.between(0, 1)) };
      break;
  }
  if (c.amount < 0n) c.amount = 0n;
  if (c.task !== null && c.task < 0n) c.task = 0n;
  if (c.payee && c.payee.limit < 0n) c.payee.limit = 0n;
  if (c.payee && c.payee.cap !== null && c.payee.cap < 0n) c.payee.cap = 0n;
  if (c.payee && c.payee.budget < 0n) c.payee.budget = 0n;
  if (c.limits && c.limits.daily < 0n) c.limits.daily = 0n;
  if (c.limits && c.limits.hard < 0n) c.limits.hard = 0n;
}

function wildCase(rng) {
  const value = () => (rng.chance(0.08) ? MAX - BigInt(rng.below(3)) : BigInt(rng.below(1500)));
  const labels = () => {
    let m = 0;
    for (let i = 0; i < 15; i++) if (rng.chance(0.12)) m |= 1 << i;
    return m;
  };
  const c = makeCase({
    amount: value(),
    payeeIndex: rng.below(3),
    r: labels(),
    a: labels(),
    pc: labels(),
    limits: rng.chance(0.06) ? null : { hard: value(), daily: value(), fee: value(), gas: value() },
    payee: rng.chance(0.2) ? null : { cap: rng.chance(0.3) ? null : value(), budget: value(), limit: value() },
    task: rng.chance(0.1) ? null : value(),
    paused: rng.chance(0.05),
  });
  if (rng.chance(0.35)) {
    c.lane = 'evm';
    c.fee = value();
    c.gas = value();
  }
  return c;
}

function buildVerdicts() {
  const entries = [];
  for (const [name, expect, edits] of HAND_WRITTEN) {
    const entry = entryOf(name, makeCase(edits), expect);
    const reference = refVerdict(entry.request, entry.context);
    if (reference !== expect) fail(`refVerdict disagrees with the hand-written expect of ${name}: ${reference} versus ${expect}`);
    entries.push(entry);
  }
  const rng = new Rng(SEED);
  for (let i = 1; entries.length < TOTAL_VERDICTS; i++) {
    const name = `rand_${String(i).padStart(3, '0')}`;
    let c;
    if (rng.chance(0.15)) {
      c = wildCase(rng);
    } else {
      c = goodCase(rng);
      for (let k = rng.pick([0, 1, 1, 1, 2]); k > 0; k--) breakCase(rng, c);
    }
    const entry = entryOf(name, c, '');
    entry.expect = refVerdict(entry.request, entry.context);
    entries.push(entry);
  }
  const tags = new Set(entries.map((e) => e.expect));
  for (const reason of [
    'UnknownAsset', 'Paused', 'AmountOutOfBounds', 'DailyLimit', 'FeeTooHigh', 'MissingProvenance', 'BookLabelNotInBook',
  ]) {
    if (!tags.has(`block:${reason}`)) fail(`no vector expects block:${reason}`);
  }
  for (const reason of [
    'OutsideTask', 'OverTaskBound', 'UntrustedTrigger', 'UntrustedRecipient', 'NewRecipient', 'OverPayeeLimit', 'UntrustedAmount',
  ]) {
    if (!tags.has(`escalate:${reason}`)) fail(`no vector expects escalate:${reason}`);
  }
  if (!tags.has('allow')) fail('no vector expects allow');
  return entries;
}

// ---- the 21 natural numbers per line of proofs/VerdictRun.lean, from the JSON entry ----
function lineOf(entry) {
  const r = entry.request;
  const c = entry.context;
  const n = (s) => BigInt(s);
  const some = (present, value) => (present ? [1n, value] : [0n, 0n]);
  const asset = c.asset;
  const payee = c.payee;
  const cols = [
    n(r.amount),
    ...some(r.evm !== null, r.evm !== null ? n(r.evm.max_fee_per_gas) : 0n),
    ...some(r.evm !== null, r.evm !== null ? n(r.evm.gas_limit) : 0n),
    BigInt(r.labels.recipient),
    BigInt(r.labels.amount),
    BigInt(r.labels.pc),
    ...some(asset !== null, asset !== null ? n(asset.hard_cap) : 0n),
    asset !== null ? n(asset.remaining_daily) : 0n,
    asset !== null ? n(asset.max_fee_per_gas) : 0n,
    asset !== null ? n(asset.max_gas) : 0n,
    payee !== null ? 1n : 0n,
    ...some(payee !== null && payee.cap !== null, payee !== null && payee.cap !== null ? n(payee.cap) : 0n),
    payee !== null ? n(payee.budget_remaining) : 0n,
    payee !== null ? n(payee.limit_remaining) : 0n,
    ...some(c.task_remaining !== null, c.task_remaining !== null ? n(c.task_remaining) : 0n),
    c.paused ? 1n : 0n,
  ];
  if (cols.length !== 21) fail(`a line has ${cols.length} columns, want 21`);
  return cols.map((x) => x.toString()).join(' ');
}

// ---- payee keys ----
const A40 = 'd8da6bf26964af9d7eed9e03e53415d37aa96045';
const USDC40 = '036cbd53842c5426634e7929541ec2318f3dcf7e';
const PAYEE_KEYS = {
  accept: [
    'near:accountant.test.near',
    'near:ab',
    'near:a1-b_c.d',
    `near:${'a'.repeat(64)}`,
    'near:0123456789',
    `evm:84532:0x${A40}`,
    'evm:1:0x0000000000000000000000000000000000000000',
    'evm:8453:0xffffffffffffffffffffffffffffffffffffffff',
    `evm:18446744073709551615:0x${A40}`,
    `erc20:84532:0x${USDC40}:0x${A40}`,
  ].map((key) => ({ key })),
  reject: [
    // NonAscii: before any case folding, so the Kelvin sign (which lowercases to k) never reaches a book key
    ['near:\u212aelvin.test.near', 'NonAscii'],
    ['near:accou\u200dntant.test.near', 'NonAscii'],
    ['near:\u202eaccountant.test.near', 'NonAscii'],
    ['evm:\uff18\uff14\uff15\uff13\uff12:0x' + A40, 'NonAscii'],
    ['near:\u0430ccountant.test.near', 'NonAscii'],
    [`erc20:84532:0x${USDC40}:0x${A40.slice(0, 39)}\u0430`, 'NonAscii'],
    ['near:accountant.t\u0435st.near', 'NonAscii'],
    [`evm:84532:0x${A40.slice(0, 39)}\u0431`, 'NonAscii'],
    // BadChar
    [`erc20:84532:0x${USDC40.replace('c', 'C')}:0x${A40}`, 'BadChar'],
    [`erc20:84532:0x${USDC40}:0X${A40}`, 'BadChar'],
    ['evm:84532:0x' + A40.toUpperCase(), 'BadChar'],
    [`evm:84532:0X${A40}`, 'BadChar'],
    ['near:Accountant.testnet', 'BadChar'],
    ['near:account ant.near', 'BadChar'],
    [`evm:84532:0xg${A40.slice(1)}`, 'BadChar'],
    // BadLength
    [`erc20:84532:0x${USDC40}`, 'BadLength'],
    [`erc20:84532:0x${USDC40}:0x${A40.slice(0, 39)}`, 'BadLength'],
    [`evm:84532:${A40}`, 'BadLength'],
    [`evm:84532:0x${A40.slice(0, 39)}`, 'BadLength'],
    [`evm:84532:0x${A40}5`, 'BadLength'],
    [`near:${'a'.repeat(65)}`, 'BadLength'],
    ['near:a', 'BadLength'],
    // BadSeparator
    ['near:account..test.near', 'BadSeparator'],
    ['near:.account.near', 'BadSeparator'],
    ['near:account.near.', 'BadSeparator'],
    ['near:ac--count.near', 'BadSeparator'],
    ['near:ac._count.near', 'BadSeparator'],
    // BadChainId
    [`erc20:0:0x${USDC40}:0x${A40}`, 'BadChainId'],
    [`erc20:084532:0x${USDC40}:0x${A40}`, 'BadChainId'],
    [`evm:0:0x${A40}`, 'BadChainId'],
    [`evm:084532:0x${A40}`, 'BadChainId'],
    [`evm:abc:0x${A40}`, 'BadChainId'],
    [`evm:99999999999999999999:0x${A40}`, 'BadChainId'],
    [`evm::0x${A40}`, 'BadChainId'],
    // UnknownScheme
    ['ft:usdc.test.near:accountant.test.near', 'UnknownScheme'],
    ['bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'UnknownScheme'],
    ['NEAR:accountant.test.near', 'UnknownScheme'],
    [`eth:0x${A40}`, 'UnknownScheme'],
  ].map(([key, error]) => ({ key, error })),
};

// ---- decimals: canonical text of an integer of base units at a number of decimals ----
function formatDecimal(amount, decimals) {
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  const fraction = amount % unit;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function buildDecimals() {
  const accept = [
    ['9400000000000000000000000', 24, '9.4'],
    ['4200000000000000000000000', 24, '4.2'],
    ['1500000000000000000000000', 24, '1.5'],
    ['0', 24, '0'],
    ['1', 24, '0.000000000000000000000001'],
    ['1', 0, '1'],
    ['420000000', 6, '420'],
    ['10025', 2, '100.25'],
    ['1000000000000000000', 18, '1'],
    [U128_MAX.toString(), 0, U128_MAX.toString()],
    [U128_MAX.toString(), 38, '3.40282366920938463463374607431768211455'],
  ];
  for (const [amount, decimals, text] of accept) {
    if (formatDecimal(BigInt(amount), decimals) !== text) fail(`decimal accept case ${amount} at ${decimals} formats as ${formatDecimal(BigInt(amount), decimals)}, not ${text}`);
  }
  const reject = [
    ['9.40', 24],
    ['09.4', 24],
    ['1,000', 24],
    ['4.2e2', 24],
    ['.5', 24],
    ['1.', 24],
    ['-1', 24],
    ['1e3', 24],
    ['01.5', 24],
    ['1.50', 2],
    ['1.23456789', 6],
    ['0.0000005', 6],
    ['0.5', 0],
    ['1.234', 2],
    ['+1', 24],
    [' 1', 24],
    ['1 ', 24],
    ['1.0', 24],
    ['00', 0],
    ['-0', 24],
    ['', 24],
    ['0x10', 0],
    ['1_000', 0],
    [(U128_MAX + 1n).toString(), 0],
  ];
  return {
    accept: accept.map(([amount, decimals, text]) => ({ amount, decimals, text })),
    reject: reject.map(([text, decimals]) => ({ text, decimals })),
  };
}

// ---- JSON output, ASCII only ----
// JSON.stringify already escapes control characters; every other character outside printable ASCII (DEL included) becomes a \uXXXX escape
const asciiEscape = (s) => s.replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const compact = (value) => asciiEscape(JSON.stringify(value));

// objects are laid out one key per line, arrays one element per line, and every element and the owner_task object on one line
function layout(value, indent, key) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${pad}  ${compact(item)}`).join(',\n')}\n${pad}]`;
  }
  if (value !== null && typeof value === 'object' && key !== 'owner_task') {
    const lines = Object.keys(value).map((k) => `${pad}  ${compact(k)}: ${layout(value[k], indent + 2, k)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  return compact(value);
}

function submitRejections(verdicts) {
  const base = verdicts[0].request;
  const text = (edit) => compact(edit(structuredClone(base)));
  const duplicateAmount = compact(base).replace(`"amount":"${base.amount}"`, `"amount":"${base.amount}","amount":"11"`);
  if (duplicateAmount === compact(base)) fail('the duplicate amount key was not inserted');
  return [
    { name: 'duplicate_amount_key', raw: duplicateAmount, error: 'duplicate field' },
    { name: 'numeric_amount', raw: text((r) => ((r.amount = 10), r)), error: 'invalid type' },
    { name: 'label_mask_bit_15_set', raw: text((r) => ((r.labels.recipient = 32768), r)), error: 'unknown label bit' },
    { name: 'asset_does_not_match_payee_prefix', raw: text((r) => ((r.payee = EVM_PAYEES[0]), r)), error: 'asset does not match payee' },
    { name: 'plan_hash_63_characters', raw: text((r) => ((r.hints.plan_hash = r.hints.plan_hash.slice(0, 63)), r)), error: 'plan_hash' },
    { name: 'payee_with_uppercase_letter', raw: text((r) => ((r.payee = 'near:Accountant.test.near'), r)), error: 'payee' },
  ];
}

function fail(message) {
  console.error(`gen_vectors: ${message}`);
  process.exit(1);
}

function build() {
  const verdicts = buildVerdicts();
  if (verdicts.length !== TOTAL_VERDICTS) fail(`${verdicts.length} verdicts, want ${TOTAL_VERDICTS}`);
  const names = new Set(verdicts.map((v) => v.name));
  if (names.size !== verdicts.length) fail('vector names are not unique');
  const ownerTask = buildOwnerTask();
  if (LABEL_NAMES.length !== 15 || INVALID_LABEL_NAMES.length !== 12) fail('the label tables have the wrong size');
  const doc = {
    format: 'airlock-verdict-vectors-v1',
    labels: {
      valid: LABEL_NAMES.map((name, i) => ({ name, mask: 1 << i })),
      invalid: INVALID_LABEL_NAMES,
    },
    verdicts,
    owner_task: ownerTask,
    payee_keys: PAYEE_KEYS,
    decimals: buildDecimals(),
    submit_rejections: submitRejections(verdicts),
  };
  const files = new Map();
  files.set('verdict-vectors.json', `${layout(doc, 0, '')}\n`);
  files.set('owner-task.json', `${compact(ownerTask)}\n`);
  files.set('verdict-vectors.lines', `${verdicts.map(lineOf).join('\n')}\n`);
  files.set('verdict-vectors.expect', `${verdicts.map((v) => v.expect).join('\n')}\n`);
  const sums = ['verdict-vectors.json', 'owner-task.json', 'verdict-vectors.lines', 'verdict-vectors.expect'];
  files.set('verdict-vectors.sha256', sums.map((f) => `${hex(sha256(files.get(f)))}  fixtures/${f}`).join('\n') + '\n');
  for (const [name, content] of files) {
    if (/[^\x20-\x7e\n]/.test(content)) fail(`${name} holds a character outside printable ASCII`);
  }
  return { files, verdicts };
}

const args = process.argv.slice(2);
if (args.some((a) => a !== '--check')) {
  console.error('usage: node scripts/gen_vectors.mjs [--check]');
  process.exit(2);
}
const { files, verdicts } = build();
if (args.includes('--check')) {
  const stale = [];
  for (const [name, content] of files) {
    const path = join(FIXTURES, name);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) stale.push(`fixtures/${name}`);
  }
  if (stale.length > 0) fail(`stale or missing: ${stale.join(', ')} (run node scripts/gen_vectors.mjs)`);
  console.log(`vectors current (${files.size} files, ${verdicts.length} verdicts)`);
} else {
  mkdirSync(FIXTURES, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(FIXTURES, name), content);
  const counts = {};
  for (const v of verdicts) counts[v.expect] = (counts[v.expect] ?? 0) + 1;
  console.log(`wrote ${files.size} files, ${verdicts.length} verdicts`);
  for (const tag of Object.keys(counts).sort()) console.log(`  ${tag}: ${counts[tag]}`);
}

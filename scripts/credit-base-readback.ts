// AIR-350: the credit pool asks NEAR's MPC network whether one Base Sepolia payment landed, and this script checks the stored answer
// back on NEAR, independently of the pool.
//   pnpm tsx scripts/credit-base-readback.ts [--tx 0x<hash>] [--caller <account>]        dry: reads, sends nothing
//   BASE_READBACK_LIVE=1 pnpm tsx scripts/credit-base-readback.ts --live [--tx 0x<hash>]    one check_base_payment call, then the verify
//   pnpm tsx scripts/credit-base-readback.ts --verify [--tx 0x<hash>] [--answer-file <json>] reads, no keys
// The Base tx id defaults to the `payment` row of target/credit-base/rows.json (written by scripts/credit-base-spend.ts --live).
// Live: preconditions (each a stop before anything is sent), signer weather, ONE call of check_base_payment with 0.01 NEAR and 100 Tgas
// signed by the near CLI keychain (no key file is read), one retry, and that when the pool emitted base_payment_unchecked and the signer's own
// receipt failed with a timeout, never after a refusal. Rows go to target/credit-base/readback.json.
// Verify: recompute the payload hash from the request and the Base block hash, require it to equal the stored one, check the stored
// signature against the signer's public_key for the domain, and require the Base receipt to be a success in a finalized block.
//
// The payload hash, as the signer computes it (near/mpc tag 3.18.0, commit e691bdb98d68dcf74653da58d043453a6318765f,
// crates/near-mpc-contract-interface/src/types/foreign_chain.rs, `ForeignTxSignPayload::compute_msg_hash`): sha256 of the Borsh bytes of
//   ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
//     request: ForeignChainRpcRequest::Base(EvmRpcRequest { tx_id, extractors: [EvmExtractor::BlockHash], finality: EvmFinality::Finalized }),
//     values: [ExtractedValue::EvmExtractedValue(EvmExtractedValue::BlockHash(block_hash))] })
// Borsh: an enum is its variant index as one byte, a [u8; 32] is its 32 bytes, a Vec is a u32 little endian length then the items.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverPublicKey } from 'viem';

export const POOL = 'pool.airlock-credit-c1108d.testnet';
export const EXPECTED_SIGNER = 'v1.signer-prod.testnet';
/** The signer's ForeignTx domain on testnet (domain 3, CaitSith, purpose ForeignTx; AIR-342 spike). */
export const EXPECTED_DOMAIN = 3;
export const METHOD = 'check_base_payment';
export const FEE_YOCTO = 10n ** 22n; // 0.01 NEAR, the pool's BASE_CHECK_FEE
export const FEE_TEXT = '0.01 NEAR';
/** The pool refuses under 60 Tgas; the rehearsal burnt 13.74 Tgas in all receipts. */
export const GAS_TGAS = 100;
export const POOL_MIN_GAS_TGAS = 60;
export const MIN_CALLER_YOCTO = 5n * 10n ** 23n; // 0.5 NEAR
export const CALLER_DEFAULT = 'lp1.airlock-credit-c1108d.testnet';
export const LIVE_ENV = 'BASE_READBACK_LIVE';
export const MAX_ATTEMPTS = 2; // the call and one retry
const NEARBLOCKS = 'https://testnet.nearblocks.io/txns/';
const BASESCAN = 'https://sepolia.basescan.org/tx/';

// Borsh variant indexes, from the enum declaration order at near/mpc 3.18.0 (EvmExtractor uses explicit discriminants, BlockHash = 0).
const V1 = 0; // ForeignTxSignPayload::V1
const CHAIN_BASE = 6; // ForeignChainRpcRequest: Abstract, Ethereum, Solana, Bitcoin, Starknet, Bnb, Base
const EXTRACTOR_BLOCK_HASH = 0; // EvmExtractor::BlockHash
const FINALITY_FINALIZED = 2; // EvmFinality: Latest, Safe, Finalized
const VALUE_EVM = 1; // ExtractedValue: BitcoinExtractedValue, EvmExtractedValue
const EVM_VALUE_BLOCK_HASH = 0; // EvmExtractedValue::BlockHash

export type Signature = { bigR: string; s: string; recoveryId: number; text: string };
export type Answer = { txId: string; payloadHash: string; signature: Signature; askedBy: string; recordedMs: string };
export type ReceiptInfo = {
  status: string;
  blockHash: string;
  blockNumber: bigint;
  from: string;
  to: string;
  valueWei: bigint;
  /** the number of the newest block the RPC calls finalized, or null when it would not say */
  finalizedHead: bigint | null;
  /** the hash the RPC gives for the block at `blockNumber` now, or null */
  canonicalHash: string | null;
};
export type Plan = { contract: string; method: string; args: { tx_id: string }; depositYocto: bigint; deposit: string; gasTgas: number; signer: string };
export type ChainEvent = { event: string; data: Record<string, unknown> };
/** `refused`: the failure text when the pool's own call failed (a refusal); `signerFailure`: failure texts of the signer's receipts. */
export type SendResult = { tx: string; refused: string; events: ChainEvent[]; signerFailure: string };
export type Row = { what: string; account: string; tx: string; link: string };
export type Deps = {
  log: (s: string) => void;
  nearView: (contract: string, method: string, args: object) => Promise<unknown>;
  balanceYocto: (account: string) => Promise<bigint>;
  /** null when Base has no receipt for the hash */
  receipt: (txHash: string) => Promise<ReceiptInfo | null>;
  weather: () => { code: number; line: string };
  send: (plan: Plan) => Promise<SendResult>;
  readRows: () => Row[];
  appendRow: (r: Row) => void;
  /** the Base tx hash of the `payment` row of target/credit-base/rows.json, or undefined */
  rowsBaseTx: () => string | undefined;
  readAnswerFile: (path: string) => unknown;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HEX64 = /^[0-9a-fA-F]{64}$/;

/** 64 hex with or without 0x, as 32 bytes. */
function bytes32(hex: string, what: string): Buffer {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (!HEX64.test(h)) throw new Error(`${what} must be 64 hex characters, got ${JSON.stringify(hex)}`);
  return Buffer.from(h, 'hex');
}

/** The bare lowercase id the pool and the signer take (no 0x). */
export function toTxId(hash: string): string {
  return bytes32(hash, 'the Base tx id').toString('hex');
}

const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** The Borsh bytes of the V1 payload the signer signs for a Base request with the BlockHash extractor at Finalized. */
export function payloadBytes(txId: string, blockHash: string): Buffer {
  return Buffer.concat([
    Buffer.from([V1, CHAIN_BASE]),
    bytes32(txId, 'the Base tx id'),
    u32le(1),
    Buffer.from([EXTRACTOR_BLOCK_HASH, FINALITY_FINALIZED]),
    u32le(1),
    Buffer.from([VALUE_EVM, EVM_VALUE_BLOCK_HASH]),
    bytes32(blockHash, 'the Base block hash'),
  ]);
}

/** sha256 of `payloadBytes`, 64 lowercase hex: what the signer signs and the pool stores as `payload_hash`. */
export function payloadHash(txId: string, blockHash: string): string {
  return createHash('sha256').update(payloadBytes(txId, blockHash)).digest('hex');
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A NEAR `secp256k1:<base58 of x||y>` key as an uncompressed point, `0x04` plus 128 hex. */
export function nearKeyToUncompressed(key: string): string {
  if (!key.startsWith('secp256k1:')) throw new Error('the signer key must start with secp256k1:');
  const body = key.slice('secp256k1:'.length);
  let n = 0n;
  for (const ch of body) {
    const d = B58.indexOf(ch);
    if (d < 0) throw new Error(`the signer key is not base58 (${JSON.stringify(ch)})`);
    n = n * 58n + BigInt(d);
  }
  let lead = 0;
  while (body[lead] === '1') lead += 1;
  const hex = `${'00'.repeat(lead)}${n === 0n ? '' : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0')}`;
  if (hex.length !== 128) throw new Error(`the signer key is ${String(hex.length / 2)} bytes, not 64`);
  return `0x04${hex}`;
}

/**
 * The signature check: recover the public key from (r = x of big_r, s, recovery_id) over the 32 byte payload hash (no further hashing) and
 * require it to equal the signer's key. A recovered key equal to the expected one means the ECDSA signature (r, s) verifies against that
 * key. Recovery is viem's `recoverPublicKey` (which runs @noble/curves secp256k1). big_r must be a compressed point (02 or 03); its parity
 * is not bound by (r, s) and is not checked.
 */
export async function checkSignature(hash: string, sig: Signature, nearKey: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const expected = nearKeyToUncompressed(nearKey);
    if (!/^0[23][0-9a-fA-F]{64}$/.test(sig.bigR)) return { ok: false, reason: 'big_r is not a compressed point' };
    if (!HEX64.test(sig.s)) return { ok: false, reason: 's is not 64 hex' };
    if (sig.recoveryId !== 0 && sig.recoveryId !== 1) return { ok: false, reason: 'recovery_id is not 0 or 1' };
    const h = `0x${bytes32(hash, 'the payload hash').toString('hex')}` as const;
    const got = await recoverPublicKey({ hash: h, signature: { r: `0x${sig.bigR.slice(2).toLowerCase()}`, s: `0x${sig.s.toLowerCase()}`, yParity: sig.recoveryId } });
    if (got.toLowerCase() !== expected.toLowerCase()) return { ok: false, reason: `the signature recovers ${got.slice(0, 20)}..., not the signer key` };
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: `the signature does not recover: ${e instanceof Error ? e.message.split('\n')[0] ?? '' : 'unknown'}` };
  }
}

/** The pool's `get_base_check` view (or an answer file of the same shape) for `expectedTxId`, checked field by field. */
export function parseAnswer(raw: unknown, expectedTxId: string): { ok: true; answer: Answer } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (raw === null || raw === undefined) return no('no answer recorded for this id');
  if (!isObj(raw)) return no('the answer is not an object');
  const want = toTxId(expectedTxId);
  if (raw['tx_id'] !== want) return no(`the answer is for another transaction (${String(raw['tx_id'])})`);
  const ph = raw['payload_hash'];
  if (typeof ph !== 'string' || !HEX64.test(ph)) return no('the payload_hash is not 64 hex');
  const text = raw['signature'];
  if (typeof text !== 'string') return no('the signature is not a string');
  let sig: unknown;
  try {
    sig = JSON.parse(text);
  } catch {
    return no('the signature is not JSON text');
  }
  if (!isObj(sig)) return no('the signature is not a JSON object');
  if (sig['scheme'] !== 'Secp256k1') return no('the signature scheme is not Secp256k1');
  const bigR = isObj(sig['big_r']) ? sig['big_r']['affine_point'] : undefined;
  if (typeof bigR !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(bigR)) return no('big_r.affine_point is not a compressed point');
  const s = isObj(sig['s']) ? sig['s']['scalar'] : undefined;
  if (typeof s !== 'string' || !HEX64.test(s)) return no('s.scalar is not 64 hex');
  const rid = sig['recovery_id'];
  if (rid !== 0 && rid !== 1) return no('recovery_id is not 0 or 1');
  const askedBy = raw['asked_by'];
  if (typeof askedBy !== 'string' || askedBy === '') return no('asked_by is not an account');
  const rec = raw['recorded_ms'];
  if (typeof rec !== 'string' || !/^[0-9]{1,20}$/.test(rec)) return no('recorded_ms is not a decimal string');
  return { ok: true, answer: { txId: want, payloadHash: ph.toLowerCase(), signature: { bigR, s, recoveryId: rid, text }, askedBy, recordedMs: rec } };
}

/** The one call the live mode sends. */
export function buildPlan(txHash: string, caller: string): Plan {
  return { contract: POOL, method: METHOD, args: { tx_id: toTxId(txHash) }, depositYocto: FEE_YOCTO, deposit: FEE_TEXT, gasTgas: GAS_TGAS, signer: caller };
}

/** A plain LP account under our credit or try accounts; never the pool, card, agent, issuer or anyone else's account. */
export function callerAllowed(caller: string): boolean {
  if ([POOL, 'card.airlock-credit-c1108d.testnet', 'agent.airlock-credit-c1108d.testnet', 'airlock-credit-c1108d.testnet'].includes(caller)) return false;
  return /^lp\d+\.(airlock-credit-c1108d|airlock-try-b193fe)\.testnet$/.test(caller);
}

/**
 * Every live precondition. `config` is the pool's get_base_check_config answer (null or a string when unreadable), `existing` its
 * get_base_check answer. An id already recorded goes to verify (nothing to send), checked after the config and the receipt.
 */
export function evaluatePreconditions(p: { config: unknown; receipt: ReceiptInfo | null; caller: string; callerYocto: bigint; existing: unknown; plan: Plan }): {
  action: 'send' | 'verify' | 'stop';
  stops: string[];
} {
  const stops: string[] = [];
  const c = p.config;
  if (!isObj(c)) stops.push('the pool does not answer get_base_check_config (not upgraded, or unreadable)');
  else {
    if (c['mpc_signer'] !== EXPECTED_SIGNER) stops.push(`the pool asks ${String(c['mpc_signer'])}, not ${EXPECTED_SIGNER}`);
    if (c['domain_id'] !== EXPECTED_DOMAIN) stops.push(`the pool asks domain ${String(c['domain_id'])}, not ${String(EXPECTED_DOMAIN)}`);
    const fee = c['fee'];
    if (typeof fee !== 'string' || !/^[0-9]{1,40}$/.test(fee)) stops.push('the pool fee is not a decimal string');
    else if (BigInt(fee) > p.plan.depositYocto) stops.push(`the pool fee ${fee} yocto is above the ${p.plan.deposit} the plan attaches`);
  }
  if (p.plan.gasTgas < POOL_MIN_GAS_TGAS) stops.push(`the plan's ${String(p.plan.gasTgas)} Tgas is under the pool's ${String(POOL_MIN_GAS_TGAS)}`);
  if (p.receipt === null) stops.push('Base has no receipt for this transaction');
  else if (p.receipt.status !== '0x1') stops.push(`the Base receipt status is ${p.receipt.status}, not success (0x1)`);
  if (stops.length > 0) return { action: 'stop', stops };
  if (p.existing !== null && p.existing !== undefined) return { action: 'verify', stops: [] };
  if (!callerAllowed(p.caller)) stops.push(`the caller ${p.caller} is not a plain LP account of ours (never the pool, card, agent or issuer)`);
  if (p.callerYocto < MIN_CALLER_YOCTO) stops.push(`the caller holds ${p.callerYocto.toString()} yocto, under 0.5 NEAR`);
  return stops.length > 0 ? { action: 'stop', stops } : { action: 'send', stops: [] };
}

/** The entry to add to web/src/credit/base-checks.json under `checks`. */
export function webEntry(txHash: string, nearTx: string): { tx_id: string; near_tx: string } {
  return { tx_id: toTxId(txHash), near_tx: nearTx };
}

// ---- attempts, kept as rows ----

const attemptPrefix = (txId: string): string => `${METHOD} ${txId} attempt `;
const isTimeoutText = (s: string): boolean => /timed out|time ?out|Exceeded the prepaid gas/i.test(s);

/** What one send ended as: the answer recorded, a signer timeout (the one retryable end), or anything else. */
export function classify(r: SendResult): { kind: 'checked' | 'timeout' | 'other'; detail: string } {
  if (r.tx === '' || r.refused !== '') return { kind: 'other', detail: `refused: ${(r.refused || 'no transaction id').slice(0, 200)}` };
  if (r.events.some((e) => e.event === 'base_payment_checked')) return { kind: 'checked', detail: 'checked' };
  const un = r.events.find((e) => e.event === 'base_payment_unchecked');
  if (un !== undefined) {
    const reason = String(un.data['reason'] ?? '');
    if (reason === 'the signer call failed or timed out' && isTimeoutText(r.signerFailure)) return { kind: 'timeout', detail: 'unchecked, signer timeout' };
    return { kind: 'other', detail: `unchecked: ${reason}; signer: ${r.signerFailure.slice(0, 160) || 'no failure text'}` };
  }
  return { kind: 'other', detail: 'no base_payment event in the transaction' };
}

// ---- the run ----

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

type Read<T> = { ok: true; value: T } | { ok: false; old: boolean; why: string };
async function readView(deps: Deps, contract: string, method: string, args: object): Promise<Read<unknown>> {
  try {
    return { ok: true, value: await deps.nearView(contract, method, args) };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, old: /MethodNotFound/.test(why), why: why.slice(0, 200) };
  }
}
async function readReceipt(deps: Deps, txHash: string): Promise<{ receipt: ReceiptInfo | null; why: string }> {
  try {
    const r = await deps.receipt(txHash);
    return { receipt: r, why: r === null ? 'Base has no receipt for this hash' : '' };
  } catch (e) {
    return { receipt: null, why: `the Base RPC failed: ${e instanceof Error ? e.message.slice(0, 160) : 'unknown'}` };
  }
}

const finalizedOf = (r: ReceiptInfo): { ok: boolean; text: string } => {
  if (r.finalizedHead === null || r.canonicalHash === null) return { ok: false, text: 'unknown (the RPC did not say)' };
  if (r.canonicalHash.toLowerCase() !== r.blockHash.toLowerCase()) return { ok: false, text: `no: the block at ${r.blockNumber.toString()} is now ${r.canonicalHash}` };
  if (r.blockNumber > r.finalizedHead) return { ok: false, text: `not yet (finalized head ${r.finalizedHead.toString()})` };
  return { ok: true, text: `yes (finalized head ${r.finalizedHead.toString()})` };
};

function logReceipt(deps: Deps, txHash: string, r: ReceiptInfo): void {
  deps.log(`BASE receipt ${BASESCAN}0x${toTxId(txHash)}: status ${r.status} block ${r.blockNumber.toString()} hash ${r.blockHash}`);
  deps.log(`BASE read from Base by this script, not from the signed answer: from ${r.from} to ${r.to} value ${r.valueWei.toString()} wei`);
  deps.log(`BASE finalized as far as the public RPC says: ${finalizedOf(r).text}`);
}

/** The checks of --verify, also run after a live call. Returns the exit code; the last line is the verdict. */
async function verify(deps: Deps, txHash: string, answerFile: string | undefined, nearTx: string | undefined): Promise<number> {
  const fails: string[] = [];
  let signer = EXPECTED_SIGNER;
  let domain = EXPECTED_DOMAIN;
  const cfg = await readView(deps, POOL, 'get_base_check_config', {});
  if (cfg.ok && isObj(cfg.value) && typeof cfg.value['mpc_signer'] === 'string' && typeof cfg.value['domain_id'] === 'number') {
    signer = cfg.value['mpc_signer'];
    domain = cfg.value['domain_id'];
    deps.log(`VERIFY the pool asks ${signer} domain ${String(domain)}`);
  } else if (answerFile !== undefined) {
    deps.log(`POOL NOT UPGRADED or unreadable (${cfg.ok ? 'unexpected config' : cfg.why}); checking against ${signer} domain ${String(domain)}`);
  } else {
    fails.push(cfg.ok || !cfg.old ? `the pool config is unreadable (${cfg.ok ? 'unexpected shape' : cfg.why})` : 'POOL NOT UPGRADED: the pool has no get_base_check_config');
  }

  let raw: unknown = null;
  if (answerFile !== undefined) {
    raw = deps.readAnswerFile(answerFile);
    deps.log(`VERIFY answer from ${answerFile} (not read from the pool)`);
  } else {
    const a = await readView(deps, POOL, 'get_base_check', { tx_id: toTxId(txHash) });
    if (a.ok) raw = a.value;
    else fails.push(a.old ? 'POOL NOT UPGRADED: the pool has no get_base_check' : `get_base_check is unreadable (${a.why})`);
  }
  const parsed = parseAnswer(raw, txHash);
  if (!parsed.ok) fails.push(`answer: ${parsed.reason}`);
  else deps.log(`VERIFY stored answer: payload_hash ${parsed.answer.payloadHash} asked_by ${parsed.answer.askedBy} recorded_ms ${parsed.answer.recordedMs}`);

  const key = await readView(deps, signer, 'public_key', { domain_id: domain });
  const nearKey = key.ok && typeof key.value === 'string' ? key.value : undefined;
  if (nearKey === undefined) fails.push(`the signer public_key for domain ${String(domain)} is unreadable`);
  else deps.log(`VERIFY ${signer} public_key domain ${String(domain)}: ${nearKey}`);

  const { receipt, why } = await readReceipt(deps, txHash);
  if (receipt === null) fails.push(`the Base receipt is unreadable: ${why}`);
  else {
    logReceipt(deps, txHash, receipt);
    if (receipt.status !== '0x1') fails.push(`the Base receipt status is ${receipt.status}, not success`);
    const fin = finalizedOf(receipt);
    if (!fin.ok) fails.push(`the Base block is not finalized as far as the RPC says: ${fin.text}`);
  }

  if (parsed.ok && receipt !== null) {
    const recomputed = payloadHash(txHash, receipt.blockHash);
    deps.log(`VERIFY recomputed payload hash ${recomputed} (Base, tx id, [BlockHash], Finalized, block hash ${receipt.blockHash})`);
    if (recomputed !== parsed.answer.payloadHash) fails.push(`the stored payload_hash ${parsed.answer.payloadHash} is not the recomputed ${recomputed}`);
  }
  if (parsed.ok && nearKey !== undefined) {
    const s = await checkSignature(parsed.answer.payloadHash, parsed.answer.signature, nearKey);
    if (s.ok) deps.log(`VERIFY the signature over ${parsed.answer.payloadHash} recovers the signer key (recovery_id ${String(parsed.answer.signature.recoveryId)})`);
    else fails.push(`signature: ${s.reason}`);
  }

  deps.log('NOT SHOWN the signed answer says the Base transaction succeeded in a finalized block and binds its id to that block hash;');
  deps.log('NOT SHOWN it does not name the payee or the amount: the to and value above are read from Base by this script, not from the signed answer.');
  if (nearTx !== undefined) deps.log(`NEAR transaction of the check ${NEARBLOCKS}${nearTx}`);
  if (fails.length > 0) {
    for (const f of fails) deps.log(`FAIL ${f}`);
    deps.log(`BASE READBACK VERIFY NO (${String(fails.length)} failed)`);
    return 1;
  }
  deps.log('BASE READBACK VERIFY OK');
  return 0;
}

export async function run(argv: readonly string[], env: Record<string, string | undefined>, deps: Deps): Promise<number> {
  const live = argv.includes('--live');
  const verifyOnly = argv.includes('--verify');
  if (live && env[LIVE_ENV] !== '1') {
    deps.log(`STOP live needs both --live and ${LIVE_ENV}=1`);
    return 2;
  }
  if (live && verifyOnly) {
    deps.log('STOP --live and --verify are separate modes');
    return 2;
  }
  const txHash = flag(argv, '--tx') ?? deps.rowsBaseTx();
  if (txHash === undefined) {
    deps.log('STOP no Base tx id: pass --tx 0x<hash> or run credit-base-spend.ts --live before (its payment row)');
    return 1;
  }
  let txId: string;
  try {
    txId = toTxId(txHash);
  } catch (e) {
    deps.log(`STOP ${(e as Error).message}`);
    return 1;
  }
  const answerFile = flag(argv, '--answer-file');
  const prior = deps.readRows().filter((r) => r.what.startsWith(attemptPrefix(txId)));
  const recordedTx = prior.find((r) => r.what.endsWith(': checked'))?.tx;
  if (verifyOnly) return verify(deps, txHash, answerFile, recordedTx);

  const caller = flag(argv, '--caller') ?? CALLER_DEFAULT;
  const plan = buildPlan(txHash, caller);
  deps.log(`PLAN pool ${plan.contract} method ${plan.method} caller ${plan.signer} tx_id ${txId} fee ${plan.deposit} gas ${String(plan.gasTgas)} Tgas`);

  const cfg = await readView(deps, POOL, 'get_base_check_config', {});
  const existing = await readView(deps, POOL, 'get_base_check', { tx_id: txId });
  if (!cfg.ok && cfg.old) deps.log('POOL NOT UPGRADED: the pool answers neither get_base_check_config nor get_base_check (old wasm); continuing with the reads');
  else if (!cfg.ok) deps.log(`POOL config unreadable: ${cfg.why}`);
  else deps.log(`POOL get_base_check_config ${JSON.stringify(cfg.value)}`);
  if (existing.ok) deps.log(existing.value === null ? 'POOL get_base_check: nothing recorded for this id' : `POOL get_base_check: already recorded ${JSON.stringify(existing.value)}`);

  const { receipt, why } = await readReceipt(deps, txHash);
  if (receipt === null) deps.log(`BASE ${why}`);
  else {
    logReceipt(deps, txHash, receipt);
    deps.log(`OFFLINE expected payload hash ${payloadHash(txId, receipt.blockHash)} (sha256 of the Borsh V1 payload: Base, tx id, [BlockHash], Finalized, block hash)`);
  }
  const key = await readView(deps, EXPECTED_SIGNER, 'public_key', { domain_id: EXPECTED_DOMAIN });
  deps.log(key.ok ? `OFFLINE ${EXPECTED_SIGNER} public_key domain ${String(EXPECTED_DOMAIN)}: ${String(key.value)}` : `OFFLINE signer public_key unreadable: ${key.why}`);

  let callerYocto = 0n;
  try {
    callerYocto = await deps.balanceYocto(caller);
  } catch {
    deps.log(`CALLER balance of ${caller} unreadable`);
  }
  deps.log(`CALLER ${caller} holds ${callerYocto.toString()} yocto`);
  const pre = evaluatePreconditions({ config: cfg.ok ? cfg.value : null, receipt, caller, callerYocto, existing: existing.ok ? existing.value : null, plan });

  if (!live) {
    for (const s of pre.stops) deps.log(`WOULD STOP ${s}`);
    if (pre.action === 'verify') deps.log('WOULD SKIP the id is already recorded: live goes straight to verify');
    deps.log('DRY RUN nothing sent');
    return 0;
  }

  if (pre.action === 'stop') {
    for (const s of pre.stops) deps.log(`STOP ${s}`);
    return 1;
  }
  if (pre.action === 'verify') {
    deps.log('the id is already recorded: nothing sent, going to verify');
    const code = await verify(deps, txHash, undefined, recordedTx);
    if (code === 0 && recordedTx !== undefined) deps.log(`WEB ENTRY ${JSON.stringify(webEntry(txId, recordedTx))}`);
    return code;
  }

  const last = prior.at(-1);
  if (prior.length >= MAX_ATTEMPTS || (last !== undefined && !last.what.endsWith(': unchecked, signer timeout'))) {
    deps.log(`STOP budget used: ${String(prior.length)} attempt(s) recorded for this id, no further call`);
    return 3;
  }

  const w = deps.weather();
  deps.log(`WEATHER ${w.line}`);
  if (w.code === 1 || w.code === 2 || /SIGNER WEATHER (SLOW|BAD)/.test(w.line)) {
    deps.log('STOP signer weather is SLOW or BAD: check again in 30 minutes');
    return 1;
  }

  let n = prior.length;
  while (n < MAX_ATTEMPTS) {
    n += 1;
    const r = await deps.send(plan);
    const c = classify(r);
    const row: Row = { what: `${attemptPrefix(txId)}${String(n)}: ${c.detail}`, account: caller, tx: r.tx, link: r.tx === '' ? '' : `${NEARBLOCKS}${r.tx}` };
    deps.appendRow(row);
    deps.log(`ROW ${row.what} | ${row.account} | ${row.link}`);
    if (c.kind === 'checked') {
      const code = await verify(deps, txHash, undefined, r.tx);
      if (code === 0) deps.log(`WEB ENTRY ${JSON.stringify(webEntry(txId, r.tx))}`);
      return code;
    }
    if (c.kind !== 'timeout') {
      deps.log(`STOP ${c.detail}: no retry`);
      return 1;
    }
    if (n < MAX_ATTEMPTS) deps.log('RETRY once: the signer timed out');
  }
  deps.log('STOP the retry also timed out: no further call');
  return 1;
}

// ---- the real dependencies ----

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR_CLI = process.env.NEAR_CLI ?? 'near';
const NEAR_RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const BASE_RPC = 'https://sepolia.base.org';
const ROWS_IN = join(REPO, 'target', 'credit-base', 'rows.json');
const ROWS_OUT = join(REPO, 'target', 'credit-base', 'readback.json');
const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

async function nearRpc(method: string, params: object): Promise<unknown> {
  let last = '';
  for (const url of NEAR_RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = (await r.json()) as { result?: unknown; error?: unknown };
      if (j.error !== undefined) {
        last = JSON.stringify(j.error);
        if (/MethodNotFound|UNKNOWN_ACCOUNT|does not exist/.test(last)) throw new Error(last);
        continue;
      }
      const res = j.result;
      if (isObj(res) && typeof res['error'] === 'string') throw new Error(res['error']);
      return res;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (/MethodNotFound|UNKNOWN_ACCOUNT|does not exist/.test(last)) throw new Error(last);
    }
  }
  throw new Error(`NEAR RPC ${method} failed: ${last.slice(0, 200)}`);
}

async function eth(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(BASE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: unknown };
  if (j.error !== undefined) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
const hexBig = (v: unknown): bigint => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : -1n);

function realDeps(): Deps {
  return {
    log: (s) => console.log(s),
    nearView: async (contract, method, args) => {
      const res = await nearRpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
      if (!isObj(res) || !Array.isArray(res['result'])) throw new Error(`${method}: unexpected answer`);
      return JSON.parse(Buffer.from(res['result'] as number[]).toString('utf8')) as unknown;
    },
    balanceYocto: async (account) => {
      const res = await nearRpc('query', { request_type: 'view_account', finality: 'final', account_id: account });
      const amount = isObj(res) ? res['amount'] : undefined;
      if (typeof amount !== 'string') throw new Error('view_account: no amount');
      return BigInt(amount);
    },
    receipt: async (txHash) => {
      const h = `0x${toTxId(txHash)}`;
      const rc = await eth('eth_getTransactionReceipt', [h]);
      if (rc === null) return null;
      if (!isObj(rc)) throw new Error('the receipt is not an object');
      const tx = await eth('eth_getTransactionByHash', [h]);
      const blockNumber = hexBig(rc['blockNumber']);
      let finalizedHead: bigint | null = null;
      let canonicalHash: string | null = null;
      try {
        const fin = await eth('eth_getBlockByNumber', ['finalized', false]);
        if (isObj(fin)) finalizedHead = hexBig(fin['number']);
        const at = await eth('eth_getBlockByNumber', [rc['blockNumber'], false]);
        if (isObj(at) && typeof at['hash'] === 'string') canonicalHash = at['hash'];
      } catch {
        // the RPC would not say: left unknown, which --verify counts as a failure
      }
      return {
        status: String(rc['status']),
        blockHash: String(rc['blockHash']),
        blockNumber,
        from: String(rc['from']).toLowerCase(),
        to: String(rc['to']).toLowerCase(),
        valueWei: isObj(tx) ? hexBig(tx['value']) : -1n,
        finalizedHead,
        canonicalHash,
      };
    },
    weather: () => {
      const r = spawnSync('python3', [join(REPO, 'scripts', 'signer-weather.py')], { encoding: 'utf8', timeout: 300_000 });
      const lines = `${r.stdout ?? ''}`.trim().split('\n');
      return { code: r.status ?? 3, line: lines.at(-1) ?? 'SIGNER WEATHER UNKNOWN (no output)' };
    },
    send: async (plan) => {
      const r = spawnSync(NEAR_CLI, ['contract', 'call-function', 'as-transaction', plan.contract, plan.method, 'json-args', JSON.stringify(plan.args),
        'prepaid-gas', `${String(plan.gasTgas)} Tgas`, 'attached-deposit', plan.deposit, 'sign-as', plan.signer, 'network-config', 'testnet', 'sign-with-keychain', 'send'],
      { encoding: 'utf8', timeout: 600_000 });
      const out = clean(`${r.stdout ?? ''}${r.stderr ?? ''}`);
      const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1] ?? '';
      if (tx === '') return { tx: '', refused: out.slice(-400) || 'the near CLI printed no transaction id', events: [], signerFailure: '' };
      // the outcome from the chain, not from the CLI text: the pool's status, its events and the signer's receipts
      const st = await nearRpc('tx', { tx_hash: tx, sender_account_id: plan.signer, wait_until: 'FINAL' });
      const events: ChainEvent[] = [];
      const signerFailures: string[] = [];
      let refused = '';
      if (isObj(st)) {
        const status = st['status'];
        if (isObj(status) && status['Failure'] !== undefined) refused = JSON.stringify(status['Failure']);
        for (const ro of Array.isArray(st['receipts_outcome']) ? (st['receipts_outcome'] as unknown[]) : []) {
          const o = isObj(ro) && isObj(ro['outcome']) ? ro['outcome'] : undefined;
          if (o === undefined) continue;
          for (const l of Array.isArray(o['logs']) ? (o['logs'] as unknown[]) : []) {
            if (typeof l !== 'string' || !l.startsWith('EVENT_JSON:')) continue;
            try {
              const e = JSON.parse(l.slice('EVENT_JSON:'.length)) as { event?: unknown; data?: unknown };
              const d = Array.isArray(e.data) ? (e.data[0] as unknown) : e.data;
              if (typeof e.event === 'string') events.push({ event: e.event, data: isObj(d) ? d : {} });
            } catch {
              // not an event of ours
            }
          }
          const os = o['status'];
          if (o['executor_id'] === EXPECTED_SIGNER && isObj(os) && os['Failure'] !== undefined) signerFailures.push(JSON.stringify(os['Failure']));
        }
      } else refused = 'the transaction status is unreadable';
      return { tx, refused, events, signerFailure: signerFailures.join(' | ') };
    },
    readRows: () => (existsSync(ROWS_OUT) ? (JSON.parse(readFileSync(ROWS_OUT, 'utf8')) as Row[]) : []),
    appendRow: (row) => {
      const all = existsSync(ROWS_OUT) ? (JSON.parse(readFileSync(ROWS_OUT, 'utf8')) as Row[]) : [];
      all.push(row);
      mkdirSync(dirname(ROWS_OUT), { recursive: true });
      writeFileSync(ROWS_OUT, JSON.stringify(all, null, 2));
    },
    rowsBaseTx: () => {
      if (!existsSync(ROWS_IN)) return undefined;
      const rows = JSON.parse(readFileSync(ROWS_IN, 'utf8')) as unknown;
      const pay = Array.isArray(rows) ? (rows as unknown[]).find((r) => isObj(r) && r['what'] === 'payment') : undefined;
      return isObj(pay) && typeof pay['tx'] === 'string' ? pay['tx'] : undefined;
    },
    readAnswerFile: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2), process.env, realDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`BASE READBACK FAILED ${e instanceof Error ? e.message.slice(0, 400) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

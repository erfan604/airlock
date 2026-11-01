#!/usr/bin/env node
// AIR-080: writes fixtures/digest-vector.json, the pinned encoding of the escalation digest of contracts/airlock-policy/src/escalation.rs.
// The contract stores `digest = sha256(borsh(DigestPreimage))` when it escalates a request and `approve` emits it; the verifier script
// (AIR-085) recomputes it from public data. This file writes the borsh by hand over `node:crypto` and BigInt, so the layout is fixed by
// something other than the Rust derive, and the Rust test `digest_vector` compares the two.
//
//   fixtures/digest-vector.json   { record, preimage_layout, borsh_hex, digest }
//     record           the DigestPreimage fields by name: request_id, no (a number), agent, task_hash (64 lowercase hex), asset, payee,
//                      amount (a decimal string), labels (three numbers: recipient, amount, pc), reason, book_status, evm (null, or the
//                      three decimal strings gas_limit, max_fee_per_gas, max_priority_fee_per_gas)
//     preimage_layout  the ordered list of { name, borsh_type }, the field order of the Rust struct
//     borsh_hex        the lowercase hex of the borsh bytes of the record in that order
//     digest           the 64 lowercase hex characters of sha256(borsh bytes)
//
// Borsh as used here: String is a u32 little-endian length and the UTF-8 bytes; u32 is 4 bytes little-endian; u128 is 16 bytes
// little-endian; [u8; 32] is the 32 raw bytes; [u16; 3] is three u16 little-endian with no length; Option<T> is a 0 byte for None, or a
// 1 byte and then T. The record below uses the EVM shape (evm is not null) and an amount above 2^64, so the multi limb encoding of
// u128 and the Some branch of Option are both covered; the None branch is one 0 byte (tested in the Rust unit tests).
//
// Usage: node scripts/gen_digest_vector.mjs [--check]   (Node 24, node:crypto only)
//   no flag   writes fixtures/digest-vector.json
//   --check   regenerates in memory and compares with the file byte for byte: prints `digest matches` and exits 0 when equal, prints
//             `digest differs` and exits 1 otherwise (also when the file is missing)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'digest-vector.json');

const sha256 = (data) => createHash('sha256').update(data).digest();

// ---- the borsh writer: only the types of the preimage ----
function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u128le(value) {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << 128n) throw new Error(`u128 out of range: ${value}`);
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
function str(s) {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([u32le(body.length), body]);
}
function rawHex32(hexText) {
  if (!/^[0-9a-f]{64}$/.test(hexText)) throw new Error(`not 64 lowercase hex characters: ${hexText}`);
  return Buffer.from(hexText, 'hex');
}
function option(inner) {
  return inner === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), inner]);
}

// The field order of `DigestPreimage` in contracts/airlock-policy/src/escalation.rs. AIR-085 reads this list, so the order and the
// type names are part of the file.
const LAYOUT = [
  ['request_id', 'String'],
  ['no', 'u32'],
  ['agent', 'String'],
  ['task_hash', '[u8; 32]'],
  ['asset', 'String'],
  ['payee', 'String'],
  ['amount', 'u128'],
  ['labels', '[u16; 3]'],
  ['reason', 'String'],
  ['book_status', 'String'],
  ['evm', 'Option<[u128; 3]>'],
];

const WRITERS = {
  request_id: (r) => str(r.request_id),
  no: (r) => u32le(r.no),
  agent: (r) => str(r.agent),
  task_hash: (r) => rawHex32(r.task_hash),
  asset: (r) => str(r.asset),
  payee: (r) => str(r.payee),
  amount: (r) => u128le(r.amount),
  labels: (r) => Buffer.concat(r.labels.map(u16le)),
  reason: (r) => str(r.reason),
  book_status: (r) => str(r.book_status),
  evm: (r) => option(r.evm === null ? null : Buffer.concat(r.evm.map(u128le))),
};

function borsh(record) {
  return Buffer.concat(LAYOUT.map(([name]) => WRITERS[name](record)));
}

// ---- the fixed record: a 20 ETH escalation to a book payee, an untrusted amount (the payee has no cap), EVM parameters ----
const TASK_HASH = sha256('airlock-digest-vector-task-v1').toString('hex');
const RECORD = {
  request_id: `${TASK_HASH}:3`,
  no: 7,
  agent: 'agent.sandbox',
  task_hash: TASK_HASH,
  asset: 'evm:84532:native',
  payee: 'evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
  amount: '20000000000000000000',
  labels: [2, 32, 1],
  reason: 'UntrustedAmount',
  book_status: 'in_book',
  evm: ['21000', '2000000000', '1000000000'],
};

function generate() {
  const bytes = borsh(RECORD);
  const vector = {
    record: RECORD,
    preimage_layout: LAYOUT.map(([name, borsh_type]) => ({ name, borsh_type })),
    borsh_hex: bytes.toString('hex'),
    digest: sha256(bytes).toString('hex'),
  };
  return `${JSON.stringify(vector, null, 2)}\n`;
}

const text = generate();
if (process.argv.includes('--check')) {
  const same = existsSync(OUT) && readFileSync(OUT, 'utf8') === text;
  console.log(same ? 'digest matches' : 'digest differs');
  process.exit(same ? 0 : 1);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
console.log(`wrote ${OUT}`);

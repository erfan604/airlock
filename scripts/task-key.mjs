#!/usr/bin/env node
// AIR-049: the owner's task key (Ed25519). The seed is 32 random bytes kept as 64 lowercase hex characters plus a newline in
// ${AIRLOCK_TASK_KEY_FILE:-$HOME/.airlock-task-key}, mode 0600, outside the repo. Nothing here ever prints the seed.
//   node scripts/task-key.mjs init        write a new seed; refuses to overwrite (exit 1, prints `exists`)
//   node scripts/task-key.mjs pubkey      print ed25519:<base58 public key>
//   node scripts/task-key.mjs --selftest  derive from the seed of 32 bytes of 01 and check AIR-024's vector
// Exports for scripts/sign-task.ts (AIR-102): loadSeedHex(), publicKeyBase58(seedHex), signMessage(seedHex, bytes).
// adapted from the research repo spike spikes/real-mpc/task.mjs (own code, same author): PKCS8 prefix and base58 encoder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const VECTOR_PUBKEY = 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';

function keyFilePath() {
  return process.env.AIRLOCK_TASK_KEY_FILE || path.join(os.homedir(), '.airlock-task-key');
}

function base58(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

function privateKeyOf(seedHex) {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('task key seed must be 64 lowercase hex characters');
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Read the seed file; throws if it is missing or malformed. The seed never leaves the caller. */
export function loadSeedHex() {
  const file = keyFilePath();
  if (!fs.existsSync(file)) throw new Error(`task key file ${file} is missing; run: node scripts/task-key.mjs init`);
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`task key file ${file} does not hold 64 lowercase hex characters`);
  return text;
}

/** The public key as `ed25519:<base58>`, the form the contract's set_task_key takes. */
export function publicKeyBase58(seedHex) {
  const spki = crypto.createPublicKey(privateKeyOf(seedHex)).export({ format: 'der', type: 'spki' });
  return 'ed25519:' + base58(spki.subarray(spki.length - 32));
}

/** Ed25519 signature over the bytes. */
export function signMessage(seedHex, bytes) {
  return crypto.sign(null, Buffer.from(bytes), privateKeyOf(seedHex));
}

function main() {
  const cmd = process.argv[2];
  if (process.argv.length !== 3) {
    process.stderr.write('usage: node scripts/task-key.mjs init|pubkey|--selftest\n');
    return 2;
  }
  if (cmd === 'init') {
    const file = keyFilePath();
    if (fs.existsSync(file)) {
      process.stdout.write('exists\n');
      return 1;
    }
    const seed = crypto.randomBytes(32).toString('hex') + '\n';
    fs.writeFileSync(file, seed, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(file, 0o600);
    process.stdout.write(`task key written to ${file}\n`);
    return 0;
  }
  if (cmd === 'pubkey') {
    process.stdout.write(publicKeyBase58(loadSeedHex()) + '\n');
    return 0;
  }
  if (cmd === '--selftest') {
    const got = publicKeyBase58('01'.repeat(32));
    if (got !== VECTOR_PUBKEY) {
      process.stdout.write(`task key MISMATCH: got ${got}\n`);
      return 1;
    }
    process.stdout.write('task key matches vector\n');
    return 0;
  }
  process.stderr.write('usage: node scripts/task-key.mjs init|pubkey|--selftest\n');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

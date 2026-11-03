#!/usr/bin/env node
// AIR-301: a fresh ed25519 key pair in NEAR's text form, for the published function-call key of the Steal this agent challenge.
//   node scripts/challenge-keygen.mjs            print {"public":"ed25519:<base58 of 32 bytes>","secret":"ed25519:<base58 of 64 bytes>"} on stdout
//   node scripts/challenge-keygen.mjs --selftest check the form on a fresh pair and print `challenge keygen ok`
// The secret key of this pair is published on purpose (that is the challenge), but it is still never printed by scripts/challenge-setup.sh:
// the setup script captures this output into a variable and writes it only to the env file outside the repo.
import crypto from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(buf) {
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

export function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { public: `ed25519:${base58(pub)}`, secret: `ed25519:${base58(Buffer.concat([seed, pub]))}` };
}

if (process.argv[2] === '--selftest') {
  const k = generate();
  const decode = (s) => {
    let n = 0n;
    for (const c of s.slice('ed25519:'.length)) n = n * 58n + BigInt(B58.indexOf(c));
    return Buffer.from(n.toString(16).padStart(2, '0').replace(/^(.(.{2})*)$/, (m) => (m.length % 2 ? '0' + m : m)), 'hex');
  };
  const secret = decode(k.secret);
  const pub = decode(k.public);
  const sig = crypto.sign(null, Buffer.from('x'), crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32)]), format: 'der', type: 'pkcs8' }));
  const ok = secret.length === 64 && pub.length === 32 && Buffer.compare(secret.subarray(32), pub) === 0 && crypto.verify(null, Buffer.from('x'), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' }), sig);
  console.log(ok ? 'challenge keygen ok' : 'challenge keygen BAD');
  process.exit(ok ? 0 : 1);
}
if (process.argv[2] === undefined) process.stdout.write(`${JSON.stringify(generate())}\n`);
else {
  console.error('usage: node scripts/challenge-keygen.mjs [--selftest]');
  process.exit(2);
}

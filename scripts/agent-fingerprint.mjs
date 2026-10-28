#!/usr/bin/env node
// AIR-046: the fingerprint of an agent account, the text the owner compares before `allow_agent`.
//   node scripts/agent-fingerprint.mjs <account>      prints the 12 characters and a newline
// The rule is the same as `airlock_policy::agents::fingerprint` in the contract: the first 12 characters of the lowercase hex
// of the SHA-256 of the account id (UTF-8). It is a typo guard of 48 bits, not authentication: every owner task binds `agent_id`
// (SPEC R3-07). The runtime boot code imports `fingerprint` from here, so the boot log and the contract agree.
// Vectors (also asserted by the Rust test `agents_fingerprint_vectors`):
//   agent.example.testnet  c11e2c219f09
//   agent.test.near        1573203cff8b
//   agent.examp1e.testnet  68ddd2e20b90
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** @param {string} account the agent account id, for example `agent.test.near` */
export function fingerprint(account) {
  return createHash('sha256').update(account, 'utf8').digest('hex').slice(0, 12);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const account = process.argv[2];
  if (process.argv.length !== 3 || !account) {
    process.stderr.write('usage: node scripts/agent-fingerprint.mjs <account>\n');
    process.exit(2);
  }
  process.stdout.write(`${fingerprint(account)}\n`);
}

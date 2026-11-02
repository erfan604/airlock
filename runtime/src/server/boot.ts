import { createHash } from 'node:crypto';

// The line the owner compares with `node scripts/agent-fingerprint.mjs <account>` before `allow_agent` (SPEC R3-07, AIR-046). The rule is
// the one of that script and of the contract: the first 12 lowercase hex characters of the sha256 of the account id (UTF-8). The equality
// with the script is a test (test/boot.test.ts). AIR-169 calls this before listening, in local mode and in TEE mode.

/** Logs `AIRLOCK agent fingerprint <12 hex> for <agentAccountId>` once and returns the 12 characters. */
export function printBootFingerprint(agentAccountId: string, log: (line: string) => void = (line) => console.log(line)): string {
  const fp = createHash('sha256').update(agentAccountId, 'utf8').digest('hex').slice(0, 12);
  log(`AIRLOCK agent fingerprint ${fp} for ${agentAccountId}`);
  return fp;
}

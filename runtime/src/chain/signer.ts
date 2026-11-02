// The agent's signer from a near-cli-rs credentials file. AIR-165 and AIR-169 both build the agent signer with it. Every error here is a
// fixed text: nothing read from the file, and above all never the private key, reaches a message.
import { readFileSync } from 'node:fs';
import { KeyPairSigner } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';

/**
 * Reads `{ account_id, public_key, private_key }` (`private_key` is `ed25519:<base58>`), refuses a file for another account than
 * `expectedAccountId`, and returns the signer of its private key.
 */
export function signerFromCredentials(path: string, expectedAccountId: string): KeyPairSigner {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('credentials file cannot be read as JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('credentials file is not a JSON object');
  const file = raw as Record<string, unknown>;
  if (file.account_id !== expectedAccountId) throw new Error('credentials are for another account');
  const key = file.private_key;
  if (typeof key !== 'string' || !key.startsWith('ed25519:')) throw new Error('credentials have no ed25519 private_key');
  try {
    return KeyPairSigner.fromSecretKey(key as KeyPairString);
  } catch {
    throw new Error('credentials private_key is not a valid ed25519 key');
  }
}

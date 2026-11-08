// The vault file (Node only): `book.vault.json`, mode 0600. The pure vault (vault.ts) has no Node import, so the console shares it.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { Vault, VaultError } from './vault.ts';

export function loadVault(path: string): Vault {
  try {
    return Vault.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError('BadFile', 'the book vault file cannot be read');
  }
}

export function saveVault(vault: Vault, path: string): void {
  writeFileSync(path, `${JSON.stringify(vault.toJSON(), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

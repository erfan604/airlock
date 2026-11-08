// The owner's private book in the browser (AIR-326): held in memory only, never stored and never sent anywhere. The owner drops the
// book file (`book.vault.json`) on the page; without it the console still shows every card from the contract's own record, and says the
// look-alike check did not run. After an approve-and-remember the vault changes: the next file is offered for download.
import { Vault } from '@airlock/runtime/vault';

let current: Vault | null = null;
let dirty = false;
const listeners = new Set<() => void>();

export const getVault = (): Vault | null => current;
/** True after a change the owner has not saved to a file yet. */
export const vaultNeedsSaving = (): boolean => dirty;

export function setVault(v: Vault | null, changed = false): void {
  current = v;
  dirty = changed;
  for (const f of listeners) f();
}

export function onVaultChange(f: () => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** Parses the text of a book file; throws a `VaultError` for anything else. */
export function vaultFromText(text: string): Vault {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('the book file is not JSON');
  }
  return Vault.parse(raw);
}

/** The text to save as `book.vault.json`. */
export const vaultText = (v: Vault): string => `${JSON.stringify(v.toJSON(), null, 2)}\n`;

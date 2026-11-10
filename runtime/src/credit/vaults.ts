// AIR-355: which book vault file a job that signs as the card's agent reads. The card stores only the book's root, and a proof built from
// another book does not verify (the payee is then held as a new one), so the rule is: the first file, in order, whose root is the root the
// card holds. The strict vault is looked for first; before the root change the card still holds the old book and the old file is the one.
import { join } from 'node:path';

/** The file names, strict first. */
export const VAULT_NAMES = ['book.vault.strict.json', 'book.vault.json'] as const;
/** The folders under the repo, the arena's own first. */
export const VAULT_DIRS = [join('target', 'arena'), join('target', 'credit-run')] as const;

/** The files to look at, in order: the one named by the env variable alone, or every name in every folder. */
export function vaultCandidates(repo: string, envPath: string | undefined): string[] {
  if (envPath !== undefined && envPath !== '') return [envPath];
  return VAULT_DIRS.flatMap((dir) => VAULT_NAMES.map((name) => join(repo, dir, name)));
}

/** `found`: the files that exist, in order, each with its root (null when the file cannot be read as a vault). */
export function pickVault(found: readonly { path: string; root: string | null }[], chainRoot: string): { path: string } | { refuse: string } {
  if (found.length === 0) return { refuse: 'no book vault file was found (set ARENA_BOOK_VAULT, or copy the vault to target/arena/)' };
  const hit = found.find((f) => f.root === chainRoot);
  if (hit !== undefined) return { path: hit.path };
  const unread = found.filter((f) => f.root === null);
  if (unread.length === found.length) return { refuse: `the book vault file cannot be read (${unread.map((f) => f.path).join(', ')})` };
  return { refuse: `none of the ${String(found.length)} book vault files is the book the card holds (their roots differ from get_book_root): ${found.map((f) => f.path).join(', ')}` };
}

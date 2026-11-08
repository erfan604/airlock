// AIR-326: builds the owner's private book (book.vault.json) from the book of a policy file and prints its Merkle root, the one value the
// policy contract stores. Used by scripts/bootstrap-policy.sh and `pnpm airlock init`; this file never sends a transaction and never prints
// a salt or a payee.
//   tsx scripts/book-vault.ts sync <expected-policy.json> <vault path>   create or update the vault so it holds exactly the file's book
//   tsx scripts/book-vault.ts root <vault path>                          print the root of a vault
// An entry whose numbers and label did not change keeps its salt; a changed entry gets a new one. `"listed": true` in the policy entry
// marks an alias the model may read and resolve over MCP; the default is unlisted.
import { existsSync, readFileSync } from 'node:fs';
import { Vault } from '../runtime/src/vault/index.ts';
import { loadVault, saveVault } from '../runtime/src/vault/file.ts';

interface PolicyEntry {
  key: string;
  cap: string | null;
  daily_untrusted_budget: string;
  daily_limit: string;
  label: string;
  listed?: boolean;
}

function sync(policyPath: string, vaultPath: string): string {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as { book: PolicyEntry[] };
  let vault = existsSync(vaultPath) ? loadVault(vaultPath) : Vault.empty();
  const wanted = new Set(policy.book.map((e) => e.key));
  for (const have of vault.entries) if (!wanted.has(have.payee)) vault = vault.remove(have.payee);
  for (const e of policy.book) {
    const have = vault.entries.find((x) => x.payee === e.key);
    const same =
      have !== undefined &&
      have.cap === e.cap &&
      have.daily_untrusted_budget === e.daily_untrusted_budget &&
      have.daily_limit === e.daily_limit &&
      have.label === e.label &&
      have.listed === (e.listed === true);
    if (same) continue;
    if (have !== undefined) vault = vault.remove(e.key);
    vault = vault.add({
      payee: e.key,
      cap: e.cap === null ? null : BigInt(e.cap),
      dailyUntrustedBudget: BigInt(e.daily_untrusted_budget),
      dailyLimit: BigInt(e.daily_limit),
      label: e.label,
      listed: e.listed === true,
    });
  }
  saveVault(vault, vaultPath);
  return vault.root();
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'sync' && a !== undefined && b !== undefined) console.log(sync(a, b));
else if (cmd === 'root' && a !== undefined) console.log(loadVault(a).root());
else {
  console.error('usage: book-vault.ts sync <policy.json> <vault> | root <vault>');
  process.exit(2);
}

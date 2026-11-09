// The owner rule for visible web text: an account name that contains "erfan" is never printed (a neutral label stands for it), and an account is
// linked through the explorer only when it is a plain testnet account name. Shared by every page; /credit was the first.

/** An account as the page may print it: a name that contains "erfan" is never shown, a neutral label stands for it (the owner's rule for /credit). */
export function shownAccount(id: string, what = 'demo account'): string {
  return /erfan/i.test(id) ? what : id;
}

/**
 * The testnet explorer page of an account, or null unless the id is a plain lowercase testnet account: at most 64 characters, ending in `.testnet`,
 * or an implicit account of 64 lowercase hex digits. No slash, query, quote, space or uppercase can pass.
 */
export function explorerAccount(id: string): string | null {
  const named = id.length <= 64 && /^[a-z0-9][a-z0-9._-]*\.testnet$/.test(id);
  return named || /^[0-9a-f]{64}$/.test(id) ? `https://testnet.nearblocks.io/address/${id}` : null;
}

/**
 * The hosted replay shows recorded runs whose accounts carry the owner's name. Their text is rewritten where the page reads it (never in the files):
 * "erfan-airlock" and "erfan" become "demo", so `accountant.erfan-airlock.testnet` reads `accountant.demo.testnet`, still a well formed account name,
 * and two different names stay different (a replay compares them).
 */
export const scrubOwner = (text: string): string => text.replace(/erfan(?:-airlock)?/gi, 'demo');

// The owner rule for visible web text: an account name that contains "erfan" is never printed (a neutral label stands for it), and an account is
// linked through the explorer only when it is a plain testnet account name. Shared by every page; /credit was the first.
import { STATIC } from '../static.ts';


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
 * A plain label for a recorded account that carries the owner's name, for places that show it as text. It is never shaped like an account id (it has
 * spaces and brackets), because an invented id such as `accountant.demo.testnet` would look real and be found nowhere on the chain. The real id stays
 * in the data and in link targets; only what is drawn changes. `near:accountant.erfan-airlock.testnet` is "Accountant (demo)", the owner's own
 * account "demo owner", a policy "demo policy", an agent "demo agent".
 */
export function demoLabel(id: string): string {
  const bare = id.replace(/^near:/, '');
  const first = bare.split('.')[0] ?? bare;
  if (/policy/i.test(first)) return 'demo policy';
  if (/agent/i.test(first)) return 'demo agent';
  if (/erfan/i.test(first)) return 'demo owner';
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} (demo)`.replace(/[-_]/g, ' ');
}

const OWNER_TOKEN = /(?:near:)?[a-z0-9_.-]*erfan[a-z0-9_.-]*/gi;

/** Text with every account that carries the owner's name replaced by its plain label (see demoLabel). Text without such an account is returned as it is. */
export const labelOwner = (text: string): string => text.replace(OWNER_TOKEN, (m) => demoLabel(m));

/** `labelOwner` on the hosted site; the live console shows its own server's text exactly as it is. */
export const hostedText = (text: string): string => (STATIC ? labelOwner(text) : text);

/** An account as visible text: the owner's own names are a plain label, any other account is shown without its `.testnet` suffix (the word stays out of the design; the link carries the full id). */
export function accountText(id: string, what = 'demo account'): string {
  return /erfan/i.test(id) ? what : id.replace(/\.testnet$/, '');
}

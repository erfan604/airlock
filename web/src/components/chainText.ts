// The display rule for strings read from the chain (red team 2026-11-11). Strangers control strings that land on the chain and then on these pages
// and in the site state file: payees and request fields sent with a published key, lender account names, event fields. A chain string is kept only
// when it matches the grammar of what it claims to be (a NEAR account, a payee key, an asset, an EVM address, a transaction hash, a decimal amount,
// a request id, a reason code); anything else becomes `unshown:<length>`, which the pages print as a neutral placeholder with the length and never
// the text. A grammar-valid account name the team does not run can still carry words aimed at a model that reads the page, so such a name longer
// than 24 characters is shown cut in the middle (the first 12 characters, an ellipsis, the last 8); the full id goes only into an explorer link.
// The readers apply `keep` as they parse, the state script applies `foreignShort` before it writes, and the state parser applies both again.

export type ChainKind = 'account' | 'payee' | 'asset' | 'evm' | 'tx' | 'amount' | 'request' | 'reason' | 'task' | 'symbol' | 'decimal' | 'word';

/** NEAR account ids (nearcore's rule): 2 to 64 characters, lowercase parts joined by `-` or `_`, and parts joined by `.`. */
export const NEAR_ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const CHAIN_ID = '[1-9][0-9]{0,19}';
const EVM = '0x[0-9a-f]{40}';
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const SOL_CLUSTER = '(?:devnet|testnet|mainnet)';

const GRAMMAR: Record<ChainKind, RegExp> = {
  account: NEAR_ACCOUNT,
  payee: new RegExp(`^(?:near:.+|evm:${CHAIN_ID}:${EVM}|erc20:${CHAIN_ID}:${EVM}:${EVM}|sol:${SOL_CLUSTER}:${B58}{32,44})$`),
  asset: new RegExp(`^(?:near|evm:${CHAIN_ID}:native|evm:${CHAIN_ID}:erc20:${EVM}|sol:${SOL_CLUSTER})$`),
  evm: new RegExp(`^${EVM}$`),
  tx: new RegExp(`^${B58}{43,44}$`),
  amount: /^(?:0|[1-9][0-9]{0,38})$/,
  request: /^[0-9a-f]{64}:(?:0|[1-9][0-9]{0,4})$/,
  reason: /^[A-Z][A-Za-z]{2,39}$/,
  /** an owner task id, as the task scripts write them (`try-0-1794322920088`) */
  task: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/,
  /** an asset symbol (`NEAR`) */
  symbol: /^[A-Za-z0-9]{1,12}$/,
  /** a decimal amount as a view formats it (`0.5`) */
  decimal: /^(?:0|[1-9][0-9]{0,38})(?:\.[0-9]{1,24})?$/,
  /** a status word (`Booked`) */
  word: /^[A-Za-z][A-Za-z_]{0,39}$/,
};

/** Whether `s` is a string in the grammar of `kind`. A `near:` payee key must name a valid account. */
export function fits(kind: ChainKind, s: unknown): s is string {
  if (typeof s !== 'string' || !GRAMMAR[kind].test(s)) return false;
  return kind !== 'payee' || !s.startsWith('near:') || NEAR_ACCOUNT.test(s.slice(5));
}

const UNSHOWN = /^unshown:(0|[1-9][0-9]{0,8})$/;

/** The placeholder of a value that is not in its grammar: its length in characters, never its text. */
export function unshown(raw: unknown): string {
  return `unshown:${String(typeof raw === 'string' ? [...raw].length : 0)}`;
}

export const isUnshown = (s: string): boolean => UNSHOWN.test(s);

/** A chain value as it may be kept: itself when it fits its grammar, a placeholder made earlier as it is, otherwise a new placeholder. */
export function keep(kind: ChainKind, raw: unknown): string {
  if (fits(kind, raw)) return raw;
  return typeof raw === 'string' && UNSHOWN.test(raw) ? raw : unshown(raw);
}

/** `keep` for a value that may be null: null stays null. */
export const keepOrNull = (kind: ChainKind, raw: unknown): string | null => (raw === null || raw === undefined ? null : keep(kind, raw));

/** How many characters of a name the team does not run are shown whole. */
export const FOREIGN_MAX = 24;
const ELLIPSIS = '…';

/** The names /lend's faucet makes (`lender-` and 10 random base36 characters): random, so they carry no words and are shown whole. */
const FAUCET_LENDER = /^lender-[a-z0-9]{10}\.testnet$/;

/** A shortened name (from `cut`): 12 account characters, the ellipsis, 8 account characters. */
const SHORT = new RegExp(`^[a-z0-9._-]{12}${ELLIPSIS}[a-z0-9._-]{8}$`);

const cut = (id: string): string => `${id.slice(0, 12)}${ELLIPSIS}${id.slice(-8)}`;

/** A NEAR account the team does not run, as it may be printed or written: whole up to 24 characters (or a faucet name), else cut in the middle. */
export function foreignShort(id: string): string {
  if (SHORT.test(id) || isUnshown(id)) return id;
  if (!NEAR_ACCOUNT.test(id)) return unshown(id);
  return id.length <= FOREIGN_MAX || FAUCET_LENDER.test(id) ? id : cut(id);
}

/** A payee key of someone the team does not run: a `near:` key with its account shortened; other keys (hex or base58) as they are. */
export function foreignPayee(key: string): string {
  if (isUnshown(key)) return key;
  if (key.startsWith('near:')) {
    const short = foreignShort(key.slice(5));
    return isUnshown(short) ? short : `near:${short}`;
  }
  return fits('payee', key) ? key : unshown(key);
}

/** Whether a stored account is a shortened one (from the state file): such a name cannot be read on chain or linked. */
export const isShortened = (id: string): boolean => SHORT.test(id.replace(/^near:/, ''));

/** A stored account as the state parser accepts it: a valid account, a shortened one, or a placeholder; anything else becomes a placeholder. */
export function keepStoredAccount(raw: unknown): string {
  return typeof raw === 'string' && (NEAR_ACCOUNT.test(raw) || SHORT.test(raw) || UNSHOWN.test(raw)) ? raw : unshown(raw);
}

/** A stored payee key: a valid key, a `near:` key with a shortened account, or a placeholder; anything else becomes a placeholder. */
export function keepStoredPayee(raw: unknown): string {
  if (typeof raw === 'string' && raw.startsWith('near:') && SHORT.test(raw.slice(5))) return raw;
  return keep('payee', raw);
}

/** The words a placeholder is printed as. */
export function unshownText(s: string): string | null {
  const m = UNSHOWN.exec(s);
  if (m === null) return null;
  const n = m[1] ?? '0';
  return `a value not shown (${n} ${n === '1' ? 'character' : 'characters'})`;
}

/** An account of someone the team does not run, as visible text: the placeholder in words, else the shortened name. */
export function foreignText(id: string): string {
  const s = foreignShort(id);
  return unshownText(s) ?? s;
}

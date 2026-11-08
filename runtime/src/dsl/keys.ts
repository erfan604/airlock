// Payee keys: exact canonical ASCII, ported from contracts/airlock-verdict/src/keys.rs, whose header is binding. The book is keyed by
// these strings and a request names its payee by one, so the match is a string for string comparison; anything that is not already
// canonical is refused at the door, never repaired. Forms: `near:<account>` and `evm:<chain id>:0x<40 lowercase hex>`.
//
// The check order decides which KeyError a refusal names: a character above 0x7f is NonAscii before anything else (on the raw
// string, before any case folding: a validator that lowercased first would take the Kelvin sign for a k); then the scheme (`near:` or
// `evm:`, else UnknownScheme, so an `ft:` key is refused); a near account is 2 to 64 characters (BadLength), of [a-z0-9] and the
// separators - _ . (BadChar), with no leading, trailing or doubled separator (BadSeparator); an evm key has a chain id of decimal
// digits with no leading zero from 1 to 2^64 - 1 (BadChainId, also an empty one and a key with no second colon whose rest is not a
// chain id) and an address of exactly `0x` plus 40 lowercase hex digits (BadLength for any other length, BadChar for a wrong prefix
// letter or a digit that is uppercase or not hex; a valid chain id and no second colon is an empty address, BadLength).
// Chain ids stay strings or bigint here; no number parsing.
// AIR-325: `sol:<cluster>:<base58 address>`, cluster `devnet`, `testnet` or `mainnet` (else BadChainId), the address 32 to 44 characters
// (BadLength), of the base58 alphabet (BadChar), decoding to exactly 32 bytes (BadLength); a cluster and no second colon is an empty
// address, BadLength. fixtures/sol-vectors.json is the shared contract with contracts/airlock-verdict/src/keys.rs.

export type KeyErrorCode = 'NonAscii' | 'BadLength' | 'BadChar' | 'BadSeparator' | 'BadChainId' | 'UnknownScheme' | 'TargetMismatch';

/** `TargetMismatch` is TypeScript only: it stands for the contract revert `asset does not match payee`. */
export class KeyError extends Error {
  constructor(readonly code: KeyErrorCode) {
    super(`KeyError: ${code}`);
    this.name = 'KeyError';
  }
}

const MIN_NEAR_ACCOUNT = 2;
const MAX_NEAR_ACCOUNT = 64;
const EVM_ADDRESS_LEN = 42;
const U64_MAX = (1n << 64n) - 1n;
const HEX_DIGITS = '0123456789abcdef';

const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isLowerAlnum = (c: string): boolean => isDigit(c) || (c >= 'a' && c <= 'z');
const isSeparator = (c: string): boolean => c === '-' || c === '_' || c === '.';
const isLowerHex = (c: string): boolean => HEX_DIGITS.includes(c) && c.length === 1;

// the first reason a near account is not valid, in the order length, characters, separators
function nearAccountError(account: string): KeyErrorCode | null {
  const n = account.length;
  if (n < MIN_NEAR_ACCOUNT || n > MAX_NEAR_ACCOUNT) return 'BadLength';
  for (let i = 0; i < n; i++) {
    const c = account.charAt(i);
    if (!isLowerAlnum(c) && !isSeparator(c)) return 'BadChar';
  }
  if (isSeparator(account.charAt(0)) || isSeparator(account.charAt(n - 1))) return 'BadSeparator';
  for (let j = 1; j < n; j++) if (isSeparator(account.charAt(j)) && isSeparator(account.charAt(j - 1))) return 'BadSeparator';
  return null;
}

// decimal digits only, no leading zero (so 0 is refused too), at most 2^64 - 1; 20 digits reach the maximum
function chainIdOk(s: string): boolean {
  if (s.length === 0 || s.length > 20 || s.charAt(0) === '0') return false;
  for (let i = 0; i < s.length; i++) if (!isDigit(s.charAt(i))) return false;
  return BigInt(s) <= U64_MAX;
}

// the first reason an address is not `0x` plus 40 lowercase hex digits
function evmAddressError(addr: string): KeyErrorCode | null {
  if (addr.length !== EVM_ADDRESS_LEN) return 'BadLength';
  if (addr.charAt(0) !== '0' || addr.charAt(1) !== 'x') return 'BadChar';
  for (let i = 2; i < EVM_ADDRESS_LEN; i++) if (!isLowerHex(addr.charAt(i))) return 'BadChar';
  return null;
}

const SOL_CLUSTERS = ['devnet', 'testnet', 'mainnet'];
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SOL_ADDRESS_MIN = 32;
const SOL_ADDRESS_MAX = 44;
const TWO_256 = 1n << 256n;

/** The 32 bytes a base58 Solana address spells, or the KeyError code of the first rule it breaks (length, alphabet, exactly 32 bytes). */
export function solAddressBytes(addr: string): Uint8Array | KeyErrorCode {
  if (!isAscii(addr)) return 'NonAscii';
  if (addr.length < SOL_ADDRESS_MIN || addr.length > SOL_ADDRESS_MAX) return 'BadLength';
  let value = 0n;
  let zeros = 0;
  let leading = true;
  for (let i = 0; i < addr.length; i++) {
    const digit = BASE58_ALPHABET.indexOf(addr.charAt(i));
    if (digit < 0) return 'BadChar';
    if (leading && digit === 0) zeros += 1;
    else leading = false;
    value = value * 58n + BigInt(digit);
  }
  if (value >= TWO_256) return 'BadLength';
  // big-endian bytes through the hex text (no number conversion on the money path)
  const text = value.toString(16).padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = HEX_DIGITS.indexOf(text.charAt(2 * i)) * 16 + HEX_DIGITS.indexOf(text.charAt(2 * i + 1));
  let valueZeros = 0;
  while (valueZeros < 32 && out[valueZeros] === 0) valueZeros += 1;
  return zeros === valueZeros ? out : 'BadLength';
}

function solKeyError(rest: string): KeyErrorCode | null {
  const c = rest.indexOf(':');
  if (!SOL_CLUSTERS.includes(c < 0 ? rest : rest.slice(0, c))) return 'BadChainId';
  const bytes = solAddressBytes(c < 0 ? '' : rest.slice(c + 1));
  return typeof bytes === 'string' ? bytes : null;
}

// AIR-109: `erc20:<chain id>:0x<token>:0x<payee>`, checked in the order chain id, token, payee (a missing token or payee is an empty
// address, BadLength). The token inside the key gives each token its own bounds, caps and ledgers.
function erc20KeyError(rest: string): KeyErrorCode | null {
  const c1 = rest.indexOf(':');
  if (!chainIdOk(c1 < 0 ? rest : rest.slice(0, c1))) return 'BadChainId';
  const afterChain = c1 < 0 ? '' : rest.slice(c1 + 1);
  const c2 = afterChain.indexOf(':');
  const tokenError = evmAddressError(c2 < 0 ? afterChain : afterChain.slice(0, c2));
  if (tokenError !== null) return tokenError;
  return evmAddressError(c2 < 0 ? '' : afterChain.slice(c2 + 1));
}

/** A key must already be canonical: `near:<account>`, `evm:<chain id>:0x<40 lowercase hex>` or `erc20:<chain id>:0x<token>:0x<payee>`. Nothing is folded or repaired. */
export function validatePayeeKey(key: string): void {
  if (typeof key !== 'string') throw new KeyError('UnknownScheme');
  if (!isAscii(key)) throw new KeyError('NonAscii');
  if (key.startsWith('near:')) {
    const error = nearAccountError(key.slice(5));
    if (error !== null) throw new KeyError(error);
    return;
  }
  if (key.startsWith('evm:')) {
    const rest = key.slice(4);
    const colon = rest.indexOf(':');
    const id = colon < 0 ? rest : rest.slice(0, colon);
    if (!chainIdOk(id)) throw new KeyError('BadChainId');
    const error = evmAddressError(colon < 0 ? '' : rest.slice(colon + 1));
    if (error !== null) throw new KeyError(error);
    return;
  }
  if (key.startsWith('erc20:')) {
    const error = erc20KeyError(key.slice(6));
    if (error !== null) throw new KeyError(error);
    return;
  }
  if (key.startsWith('sol:')) {
    const error = solKeyError(key.slice(4));
    if (error !== null) throw new KeyError(error);
    return;
  }
  throw new KeyError('UnknownScheme');
}

/** The asset a payee key implies: `near`, `evm:<chain id>:native`, `evm:<chain id>:erc20:0x<token>` or (AIR-325) `sol:<cluster>`. Call it after validatePayeeKey. */
export function assetForPayeeKey(key: string): string {
  if (typeof key !== 'string') throw new KeyError('UnknownScheme');
  if (key.startsWith('near:')) return 'near';
  if (key.startsWith('evm:')) {
    const rest = key.slice(4);
    const colon = rest.indexOf(':');
    const id = colon < 0 ? rest : rest.slice(0, colon);
    if (!chainIdOk(id)) throw new KeyError('BadChainId');
    return `evm:${id}:native`;
  }
  if (key.startsWith('erc20:')) {
    const rest = key.slice(6);
    const c1 = rest.indexOf(':');
    const id = c1 < 0 ? rest : rest.slice(0, c1);
    if (!chainIdOk(id)) throw new KeyError('BadChainId');
    const token = c1 < 0 ? '' : rest.slice(c1 + 1).split(':')[0] ?? '';
    return `evm:${id}:erc20:${token}`;
  }
  if (key.startsWith('sol:')) {
    const rest = key.slice(4);
    const c = rest.indexOf(':');
    const cluster = c < 0 ? rest : rest.slice(0, c);
    if (!SOL_CLUSTERS.includes(cluster)) throw new KeyError('BadChainId');
    return `sol:${cluster}`;
  }
  throw new KeyError('UnknownScheme');
}

/** A valid lowercase near account is returned unchanged; anything else throws (an uppercase letter is BadChar, nothing is lowercased). */
export function canonicalNear(input: string): string {
  if (typeof input !== 'string' || !isAscii(input)) throw new KeyError('NonAscii');
  const error = nearAccountError(input);
  if (error !== null) throw new KeyError(error);
  return input;
}

/** `0x` in lowercase or no prefix, then 40 hex digits of any case; returns `0x` plus the digits in lowercase. */
export function canonicalEvm(input: string): string {
  if (typeof input !== 'string' || !isAscii(input)) throw new KeyError('NonAscii');
  let digits: string;
  if (input.length === EVM_ADDRESS_LEN) {
    if (input.charAt(0) !== '0' || input.charAt(1) !== 'x') throw new KeyError('BadChar');
    digits = input.slice(2);
  } else if (input.length === EVM_ADDRESS_LEN - 2) {
    digits = input;
  } else {
    throw new KeyError('BadLength');
  }
  const lower = digits.toLowerCase();
  for (let i = 0; i < lower.length; i++) if (!isLowerHex(lower.charAt(i))) throw new KeyError('BadChar');
  return `0x${lower}`;
}

/** Derived from the plan action: `transfer` is `near`, `evm_transfer` carries its `chain_id`. Runtime internal, never on the wire. */
export type Target = { kind: 'near' } | { kind: 'evm'; chain_id: number };

// the chain id of a target as decimal text; it must be a positive safe integer (the plan's integer literal)
function targetChainId(target: { kind: 'evm'; chain_id: number }): string {
  const id = target.chain_id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new KeyError('BadChainId');
  return String(id);
}

/** The asset of a target: `near` or `evm:<chain id>:native`. */
export function assetOfTarget(target: Target): string {
  return target.kind === 'near' ? 'near' : `evm:${targetChainId(target)}:native`;
}

/**
 * The canonical payee key of a recipient for a target. A bare account or address is canonicalized by the target's kind. An input that
 * already starts with `near:` or `evm:` must match the target (`near:` for NEAR, `evm:<same chain id>:` for EVM) and pass
 * validatePayeeKey, otherwise TargetMismatch: the contract would revert the whole batch with `asset does not match payee`.
 */
export function payeeKey(target: Target, recipient: string): string {
  if (typeof recipient !== 'string' || !isAscii(recipient)) throw new KeyError('NonAscii');
  const prefixed = recipient.startsWith('near:') || recipient.startsWith('evm:');
  if (target.kind === 'near') {
    if (!prefixed) return `near:${canonicalNear(recipient)}`;
    if (!recipient.startsWith('near:')) throw new KeyError('TargetMismatch');
    validatePayeeKey(recipient);
    return recipient;
  }
  const id = targetChainId(target);
  if (!prefixed) return `evm:${id}:${canonicalEvm(recipient)}`;
  if (!recipient.startsWith(`evm:${id}:`)) throw new KeyError('TargetMismatch');
  validatePayeeKey(recipient);
  return recipient;
}

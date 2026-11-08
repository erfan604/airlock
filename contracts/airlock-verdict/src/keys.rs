//! Payee keys: exact canonical ASCII (no_std, no alloc, byte slices). The address book is keyed by these strings and a request names its
//! payee by one, so the match is a byte for byte comparison; anything that is not already canonical is refused at the door, never
//! repaired (F03 3.1, F10 3.1, SPEC R3-12, P16).
//!
//! Forms: `near:<account>`, `evm:<chain id>:0x<40 lowercase hex>` and (AIR-109) `erc20:<chain id>:0x<40 lowercase hex token>:0x<40 lowercase hex payee>`;
//! the token inside the key gives each token its own bounds, caps and ledgers. The P16 proofs cover the `near:` and `evm:` forms; the erc20 form is
//! covered by the vectors and unit tests. AIR-325 adds `sol:<cluster>:<base58 address>` (cluster `devnet`, `testnet` or `mainnet`; the address
//! 32 to 44 base58 characters that decode to exactly 32 bytes), covered by fixtures/sol-vectors.json and unit tests: a wrong cluster is
//! `BadChainId`, a character outside the base58 alphabet `BadChar`, any other length or a value that is not exactly 32 bytes `BadLength`.
//! Base58 decoding is injective, so a string that decodes to exactly 32 bytes is the one canonical spelling of those bytes. `ft:` keys are rejected on purpose (`UnknownScheme`): the NEP-141
//! lane is not shipped, so R5-04's `ft:<token>:<account>` form is documented, not accepted.
//!
//! The ASCII check runs on the raw bytes first, before any case folding: a validator that lowercased first would accept U+212A (the
//! Kelvin sign) as `k` (the spike's bug; the integration test `kelvin_sign_is_rejected` pins it). Errors are reported in this order,
//! which is the header of scripts/gen_vectors.mjs and the contract for the TypeScript canonicalizers: any byte above 0x7f is
//! `NonAscii` before anything else; the scheme is `near:` or `evm:`, anything else is `UnknownScheme`; a near account is 2 to 64
//! characters (`BadLength`), only `[a-z0-9]` and the separators `-` `_` `.` (`BadChar` for others), no leading, trailing or doubled
//! separator (`BadSeparator`); an evm key is `evm:<chain id>:<address>` with a chain id of decimal digits, no leading zero, from 1 to
//! 2^64 - 1 (`BadChainId`, also for an empty one, and for a key with no second colon whose rest is not a chain id), and an address of
//! exactly `0x` plus 40 lowercase hex digits (`BadLength` for any other length, `BadChar` for a wrong prefix letter, an uppercase
//! or non-hex digit of a 42 character address). A key with a valid chain id and no second colon has an empty address: `BadLength`.

/// Why a payee key was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    NonAscii,
    BadLength,
    BadChar,
    BadSeparator,
    BadChainId,
    UnknownScheme,
}

/// A near account is 2 to 64 characters.
pub const MIN_NEAR_ACCOUNT: usize = 2;
pub const MAX_NEAR_ACCOUNT: usize = 64;
/// `0x` plus 40 hex digits.
pub const EVM_ADDRESS_LEN: usize = 42;

fn is_ascii(s: &[u8]) -> bool {
    let mut i = 0;
    while i < s.len() {
        if s[i] > 0x7f {
            return false;
        }
        i += 1;
    }
    true
}

fn starts_with(s: &[u8], prefix: &[u8]) -> bool {
    if s.len() < prefix.len() {
        return false;
    }
    let mut i = 0;
    while i < prefix.len() {
        if s[i] != prefix[i] {
            return false;
        }
        i += 1;
    }
    true
}

fn is_lower_alnum(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit()
}

fn is_separator(b: u8) -> bool {
    b == b'-' || b == b'_' || b == b'.'
}

fn is_lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// The first reason a near account is not valid, in the order length, characters, separators; `None` when it is valid.
fn near_account_error(account: &[u8]) -> Option<KeyError> {
    let n = account.len();
    if !(MIN_NEAR_ACCOUNT..=MAX_NEAR_ACCOUNT).contains(&n) {
        return Some(KeyError::BadLength);
    }
    let mut i = 0;
    while i < n {
        let b = account[i];
        if !is_lower_alnum(b) && !is_separator(b) {
            return Some(KeyError::BadChar);
        }
        i += 1;
    }
    if is_separator(account[0]) || is_separator(account[n - 1]) {
        return Some(KeyError::BadSeparator);
    }
    let mut j = 1;
    while j < n {
        if is_separator(account[j]) && is_separator(account[j - 1]) {
            return Some(KeyError::BadSeparator);
        }
        j += 1;
    }
    None
}

/// A near account: 2 to 64 characters, runs of `[a-z0-9]` separated by single `-`, `_` or `.`, no leading, trailing or doubled
/// separator. Equal to `near_sdk::AccountId` parsing (the contract pays an `AccountId` parsed from the key; checked on 100,000 strings
/// by the policy crate's `account_grammar_matches_near_sdk`).
pub fn validate_near_account(account: &[u8]) -> bool {
    near_account_error(account).is_none()
}

/// The value of a chain id: decimal digits only, no leading zero (so 0 is refused too), at most 2^64 - 1.
fn chain_id(s: &[u8]) -> Option<u64> {
    if s.is_empty() || s[0] == b'0' {
        return None;
    }
    let mut value: u64 = 0;
    let mut i = 0;
    while i < s.len() {
        if !s[i].is_ascii_digit() {
            return None;
        }
        let digit = u64::from(s[i] - b'0');
        value = value.checked_mul(10)?.checked_add(digit)?;
        i += 1;
    }
    Some(value)
}

/// The first reason an address is not `0x` plus 40 lowercase hex digits; `None` when it is.
fn evm_address_error(addr: &[u8]) -> Option<KeyError> {
    if addr.len() != EVM_ADDRESS_LEN {
        return Some(KeyError::BadLength);
    }
    if addr[0] != b'0' || addr[1] != b'x' {
        return Some(KeyError::BadChar);
    }
    let mut i = 2;
    while i < EVM_ADDRESS_LEN {
        if !is_lower_hex(addr[i]) {
            return Some(KeyError::BadChar);
        }
        i += 1;
    }
    None
}

/// The lowercase form of one hex digit, `None` for anything else.
fn lower_hex_digit(b: u8) -> Option<u8> {
    if b.is_ascii_digit() || (b'a'..=b'f').contains(&b) {
        Some(b)
    } else if (b'A'..=b'F').contains(&b) {
        Some(b + 32)
    } else {
        None
    }
}

/// The canonical form of an EVM address: `input` is `0x` plus 40 hex digits (42 bytes, a lowercase `x`) or 40 hex digits (no prefix), any
/// hex case; `out` receives `0x` plus the 40 digits in lowercase. Errors: `NonAscii` (checked first, on the raw bytes), `BadLength` for
/// any other length, `BadChar` for a wrong prefix or a non-hex digit. `out` is only meaningful when the result is `Ok`.
pub fn canonical_evm_address(
    input: &[u8],
    out: &mut [u8; EVM_ADDRESS_LEN],
) -> Result<(), KeyError> {
    if !is_ascii(input) {
        return Err(KeyError::NonAscii);
    }
    let start = if input.len() == EVM_ADDRESS_LEN {
        if input[0] != b'0' || input[1] != b'x' {
            return Err(KeyError::BadChar);
        }
        2
    } else if input.len() == EVM_ADDRESS_LEN - 2 {
        0
    } else {
        return Err(KeyError::BadLength);
    };
    out[0] = b'0';
    out[1] = b'x';
    let mut i = 0;
    while i < EVM_ADDRESS_LEN - 2 {
        match lower_hex_digit(input[start + i]) {
            Some(d) => out[2 + i] = d,
            None => return Err(KeyError::BadChar),
        }
        i += 1;
    }
    Ok(())
}

/// A payee key must already be canonical: `near:<account>` or `evm:<chain id>:0x<40 lowercase hex>` (see the module text for the order
/// of the errors). Nothing is folded or repaired.
pub fn validate_payee_key(key: &[u8]) -> Result<(), KeyError> {
    if !is_ascii(key) {
        return Err(KeyError::NonAscii);
    }
    if starts_with(key, b"near:") {
        return match near_account_error(&key[5..]) {
            Some(e) => Err(e),
            None => Ok(()),
        };
    }
    if starts_with(key, b"evm:") {
        let rest = &key[4..];
        let mut colon = rest.len();
        let mut i = 0;
        while i < rest.len() {
            if rest[i] == b':' {
                colon = i;
                break;
            }
            i += 1;
        }
        if chain_id(&rest[..colon]).is_none() {
            return Err(KeyError::BadChainId);
        }
        let addr = if colon < rest.len() {
            &rest[colon + 1..]
        } else {
            &rest[rest.len()..]
        };
        return match evm_address_error(addr) {
            Some(e) => Err(e),
            None => Ok(()),
        };
    }
    if starts_with(key, b"erc20:") {
        return match erc20_key_error(&key[6..]) {
            Some(e) => Err(e),
            None => Ok(()),
        };
    }
    if starts_with(key, b"sol:") {
        return sol_key_error(&key[4..]);
    }
    Err(KeyError::UnknownScheme)
}

/// AIR-325: the Solana clusters a `sol:` key may name. A Solana message carries no chain id, so the cluster lives in the key (and so in the
/// asset `sol:<cluster>`), and the registry gives each Solana asset its own signing path.
pub const SOL_CLUSTERS: [&[u8]; 3] = [b"devnet", b"testnet", b"mainnet"];
/// A base58 spelling of 32 bytes is 32 (all leading zero bytes) to 44 characters long.
pub const SOL_ADDRESS_MIN: usize = 32;
pub const SOL_ADDRESS_MAX: usize = 44;

fn bytes_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && starts_with(a, b)
}

/// Whether `s` is one of `SOL_CLUSTERS`, exactly (lowercase, no padding).
pub fn is_sol_cluster(s: &[u8]) -> bool {
    bytes_eq(s, SOL_CLUSTERS[0]) || bytes_eq(s, SOL_CLUSTERS[1]) || bytes_eq(s, SOL_CLUSTERS[2])
}

/// The value of one base58 digit (alphabet `1-9 A-H J-N P-Z a-k m-z`: no `0`, `I`, `O` or `l`), `None` for any other byte. Written with
/// ranges, no loop over the alphabet, so the Kani harnesses of this module unwind no further.
fn base58_digit(b: u8) -> Option<u32> {
    let v = match b {
        b'1'..=b'9' => b - b'1',
        b'A'..=b'H' => 9 + (b - b'A'),
        b'J'..=b'N' => 17 + (b - b'J'),
        b'P'..=b'Z' => 22 + (b - b'P'),
        b'a'..=b'k' => 33 + (b - b'a'),
        b'm'..=b'z' => 44 + (b - b'm'),
        _ => return None,
    };
    Some(u32::from(v))
}

/// The 32 bytes a base58 Solana address spells. Errors, in this order: `NonAscii` (any byte above 0x7f), `BadLength` (fewer than 32 or more
/// than 44 characters, checked before any decoding), `BadChar` (a byte outside the base58 alphabet), `BadLength` (the value needs more than
/// 32 bytes, or the leading `1`s (zero bytes) plus the bytes of the value are not exactly 32). `out` is only meaningful on `Ok`. The value is
/// kept in eight 32-bit limbs, so no loop runs more than 44 times and the inner one 8 times.
pub fn sol_address_bytes(text: &[u8], out: &mut [u8; 32]) -> Result<(), KeyError> {
    if !is_ascii(text) {
        return Err(KeyError::NonAscii);
    }
    if text.len() < SOL_ADDRESS_MIN || text.len() > SOL_ADDRESS_MAX {
        return Err(KeyError::BadLength);
    }
    let mut limbs = [0u32; 8];
    let mut zeros = 0usize;
    let mut leading = true;
    let mut i = 0;
    while i < text.len() {
        let Some(digit) = base58_digit(text[i]) else {
            return Err(KeyError::BadChar);
        };
        if leading && digit == 0 {
            zeros += 1;
        } else {
            leading = false;
        }
        let mut carry = u64::from(digit);
        let mut j = 0;
        while j < 8 {
            let v = u64::from(limbs[j]) * 58 + carry;
            limbs[j] = v as u32;
            carry = v >> 32;
            j += 1;
        }
        if carry != 0 {
            return Err(KeyError::BadLength);
        }
        i += 1;
    }
    // big-endian bytes of the value
    let mut k = 0;
    while k < 8 {
        let word = limbs[7 - k].to_be_bytes();
        out[4 * k] = word[0];
        out[4 * k + 1] = word[1];
        out[4 * k + 2] = word[2];
        out[4 * k + 3] = word[3];
        k += 1;
    }
    let mut value_zeros = 0usize;
    while value_zeros < 32 && out[value_zeros] == 0 {
        value_zeros += 1;
    }
    // the leading `1`s must spell exactly the leading zero bytes: zeros + (32 - value_zeros) == 32
    if zeros != value_zeros {
        return Err(KeyError::BadLength);
    }
    Ok(())
}

/// The first reason what follows `sol:` is not `<cluster>:<base58 address>`; `Ok` when it is. A key with a cluster and no second colon has
/// an empty address: `BadLength`.
fn sol_key_error(rest: &[u8]) -> Result<(), KeyError> {
    let c = colon_at(rest);
    if !is_sol_cluster(&rest[..c]) {
        return Err(KeyError::BadChainId);
    }
    let addr = if c < rest.len() {
        &rest[c + 1..]
    } else {
        &rest[rest.len()..]
    };
    let mut out = [0u8; 32];
    sol_address_bytes(addr, &mut out)
}

/// The index of the first `:` in `s`, or `s.len()` when there is none.
fn colon_at(s: &[u8]) -> usize {
    let mut i = 0;
    while i < s.len() {
        if s[i] == b':' {
            return i;
        }
        i += 1;
    }
    s.len()
}

/// The first reason what follows `erc20:` is not `<chain id>:0x<40 lowercase hex token>:0x<40 lowercase hex payee>`, checked in that order
/// (chain id, token, payee); `None` when it is. A missing token or payee is an empty address, `BadLength`. AIR-109.
fn erc20_key_error(rest: &[u8]) -> Option<KeyError> {
    let c1 = colon_at(rest);
    if chain_id(&rest[..c1]).is_none() {
        return Some(KeyError::BadChainId);
    }
    let after_chain = if c1 < rest.len() {
        &rest[c1 + 1..]
    } else {
        &rest[rest.len()..]
    };
    let c2 = colon_at(after_chain);
    if let Some(e) = evm_address_error(&after_chain[..c2]) {
        return Some(e);
    }
    let payee = if c2 < after_chain.len() {
        &after_chain[c2 + 1..]
    } else {
        &after_chain[after_chain.len()..]
    };
    evm_address_error(payee)
}

#[cfg(kani)]
mod proofs {
    use super::*;

    fn has_high_byte(s: &[u8]) -> bool {
        let mut i = 0;
        while i < s.len() {
            if s[i] > 0x7f {
                return true;
            }
            i += 1;
        }
        false
    }

    /// P16: a near key of up to 24 bytes with a byte above 0x7f is never accepted. 24 bytes reach an accepted `near:` key (`near:` plus
    /// two characters is 7 bytes).
    #[kani::proof]
    #[kani::unwind(30)]
    fn p16_non_ascii_never_accepted_near() {
        let len: usize = kani::any();
        kani::assume(len <= 24);
        let buf: [u8; 24] = kani::any();
        let key = &buf[..len];
        let r = validate_payee_key(key);
        if has_high_byte(key) {
            assert!(r.is_err());
        }
        kani::cover!(
            r.is_ok() && starts_with(key, b"near:"),
            "an accepted near key"
        );
        kani::cover!(has_high_byte(key), "a key with a non-ASCII byte");
    }

    /// P16: `evm:1:0x` followed by 40 symbolic bytes (48 bytes, the least an accepted evm key has) never accepts a byte above 0x7f.
    #[kani::proof]
    #[kani::unwind(52)]
    fn p16_non_ascii_never_accepted_evm() {
        let tail: [u8; 40] = kani::any();
        let mut key = [0u8; 48];
        key[..8].copy_from_slice(b"evm:1:0x");
        key[8..].copy_from_slice(&tail);
        let r = validate_payee_key(&key);
        if has_high_byte(&tail) {
            assert!(r.is_err());
        }
        kani::cover!(r.is_ok(), "an accepted evm key");
    }

    /// P16: an accepted near key of up to 20 bytes uses only `[a-z0-9._-]` after the prefix, so it is its own canonical form.
    #[kani::proof]
    #[kani::unwind(26)]
    fn p16_validated_key_is_canonical_fixed_point() {
        let len: usize = kani::any();
        kani::assume(len <= 20);
        let buf: [u8; 20] = kani::any();
        let key = &buf[..len];
        let r = validate_payee_key(key);
        if r.is_ok() && starts_with(key, b"near:") {
            let mut i = 5;
            while i < len {
                assert!(is_lower_alnum(key[i]) || is_separator(key[i]));
                i += 1;
            }
        }
        kani::cover!(
            r.is_ok() && starts_with(key, b"near:"),
            "an accepted near key"
        );
    }

    /// P16: an EVM address of 40 or 42 symbolic bytes that canonicalizes gives `0x` plus 40 lowercase hex digits, which a payee key
    /// accepts and which canonicalizes to itself.
    #[kani::proof]
    #[kani::unwind(52)]
    fn p16_evm_canonical_round_trip() {
        let raw: [u8; 42] = kani::any();
        let long: bool = kani::any();
        let len = if long { 42 } else { 40 };
        let mut out = [0u8; 42];
        let r = canonical_evm_address(&raw[..len], &mut out);
        if r.is_ok() {
            assert!(out[0] == b'0' && out[1] == b'x');
            let mut i = 2;
            while i < 42 {
                assert!(is_lower_hex(out[i]));
                i += 1;
            }
            let mut key = [0u8; 48];
            key[..6].copy_from_slice(b"evm:1:");
            key[6..].copy_from_slice(&out);
            assert!(validate_payee_key(&key).is_ok());
            let mut again = [0u8; 42];
            assert!(canonical_evm_address(&out, &mut again).is_ok());
            assert!(again == out);
        }
        kani::cover!(r.is_ok(), "an address canonicalizes");
    }
}

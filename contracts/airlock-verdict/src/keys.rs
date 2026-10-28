//! Payee keys: exact canonical ASCII (no_std, no alloc, byte slices). The address book is keyed by these strings and a request names its
//! payee by one, so the match is a byte for byte comparison; anything that is not already canonical is refused at the door, never
//! repaired (F03 3.1, F10 3.1, SPEC R3-12, P16).
//!
//! Forms: `near:<account>` and `evm:<chain id>:0x<40 lowercase hex>`. `ft:` keys are rejected on purpose (`UnknownScheme`): the NEP-141
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
    Err(KeyError::UnknownScheme)
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

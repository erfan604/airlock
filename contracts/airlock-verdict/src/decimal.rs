//! Base units <-> canonical decimal text (no_std, no alloc). Canonical form: digits, optional "." plus the fraction with trailing zeros
//! removed, no leading zeros except a single "0" before the point, no sign, no exponent, no separators. The contract formats the stored
//! amount and compares it byte for byte with the `amount_decimal` the wallet showed, so there is exactly one text per amount (F03, F13).
//! There is no rounding anywhere: a text with more places than the asset has is refused, never truncated.
//!
//! `format_digits` and `parse_digits` are the digit-level core, kept apart from the u128 conversion so that Kani checks the placement
//! logic without any 128-bit division; the u128 to digits step is covered by the unit tests (tests/decimal.rs).

pub const MAX_LEN: usize = 48;
/// Largest supported `decimals`: u128::MAX has 39 digits, so 38 places keeps one integer digit. The contract's asset registry rejects
/// anything above this.
pub const MAX_DECIMALS: u8 = 38;

/// Format `amount` (base units) with `decimals` places; returns the buffer and length, or None above MAX_DECIMALS.
pub fn format(amount: u128, decimals: u8) -> Option<([u8; MAX_LEN], usize)> {
    if decimals > MAX_DECIMALS {
        return None;
    }
    let mut digits = [0u8; 40];
    let mut n = 0usize;
    let mut v = amount;
    loop {
        digits[n] = b'0' + (v % 10) as u8;
        n += 1;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    Some(format_digits(&digits, n, decimals))
}

/// Parse canonical decimal text into little-endian digits (fraction padded to `decimals` places) and their count.
/// None for anything non-canonical: empty, leading zero, trailing fraction zero, more places than the asset has,
/// separators, signs, exponents, or more than 40 digits.
pub fn parse_digits(s: &[u8], decimals: u8) -> Option<([u8; 40], usize)> {
    if s.is_empty() || s.len() > MAX_LEN || decimals > MAX_DECIMALS {
        return None;
    }
    let d = decimals as usize;
    let mut int_end = s.len();
    let mut k = 0;
    while k < s.len() {
        if s[k] == b'.' {
            int_end = k;
            break;
        }
        k += 1;
    }
    let int_len = int_end;
    if int_len == 0 || (int_len > 1 && s[0] == b'0') {
        return None;
    }
    let has_frac = int_end < s.len();
    let frac_len = if has_frac { s.len() - int_end - 1 } else { 0 };
    if has_frac && (frac_len == 0 || frac_len > d || s[s.len() - 1] == b'0') {
        return None;
    }
    if int_len + d > 40 {
        return None;
    }
    let mut out = [b'0'; 40];
    // integer digits: s[int_len - 1 - k] goes to position d + k
    let mut k = 0;
    while k < int_len {
        let c = s[int_len - 1 - k];
        if !c.is_ascii_digit() {
            return None;
        }
        out[d + k] = c;
        k += 1;
    }
    // fraction digits: s[int_end + 1 + j] goes to position d - 1 - j
    let mut j = 0;
    while j < frac_len {
        let c = s[int_end + 1 + j];
        if !c.is_ascii_digit() {
            return None;
        }
        out[d - 1 - j] = c;
        j += 1;
    }
    Some((out, int_len + d))
}

/// Parse canonical decimal text into base units; None for anything non-canonical or out of range.
pub fn parse(s: &[u8], decimals: u8) -> Option<u128> {
    let (digits, n) = parse_digits(s, decimals)?;
    let mut v: u128 = 0;
    let mut i = n;
    while i > 0 {
        i -= 1;
        v = v
            .checked_mul(10)?
            .checked_add(u128::from(digits[i] - b'0'))?;
    }
    Some(v)
}

/// Digit-level core shared by `format` (after the u128 to digits step): `digits` are ASCII digit bytes, little-endian (index 0 the least
/// significant, the `decimals` fraction digits first), `n0` of them significant. Kept separate so the placement logic can be model-checked
/// without 128-bit division.
pub fn format_digits(digits: &[u8; 40], n0: usize, decimals: u8) -> ([u8; MAX_LEN], usize) {
    let mut digits = *digits;
    let mut n = if n0 == 0 { 1 } else { n0 };
    while n < decimals as usize + 1 {
        digits[n] = b'0';
        n += 1;
    }
    let d = decimals as usize;
    let mut lo = 0usize;
    while lo < d && digits[lo] == b'0' {
        lo += 1;
    }
    let mut out = [0u8; MAX_LEN];
    let mut len = 0usize;
    let mut i = n;
    while i > d {
        i -= 1;
        out[len] = digits[i];
        len += 1;
    }
    if lo < d {
        out[len] = b'.';
        len += 1;
        let mut j = d;
        while j > lo {
            j -= 1;
            out[len] = digits[j];
            len += 1;
        }
    }
    (out, len)
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// digits up to and including the highest non-zero one (at least 1): what `format` passes as `n`
    fn significant(digits: &[u8; 40]) -> usize {
        let mut n = 40;
        while n > 1 && digits[n - 1] == b'0' {
            n -= 1;
        }
        n
    }

    fn has_point(t: &[u8]) -> bool {
        let mut i = 0;
        while i < t.len() {
            if t[i] == b'.' {
                return true;
            }
            i += 1;
        }
        false
    }

    /// D1: the digits of any canonical value format to text that parse_digits turns back into exactly the same digits. Digit level
    /// only (1 to 10 significant digits, decimals 0 to 24): 16 digits take 69 s, the full 40 digit range 597 s.
    #[kani::proof]
    #[kani::unwind(50)]
    fn placement_round_trip() {
        let n: usize = kani::any();
        kani::assume(n >= 1 && n <= 10);
        let decimals: u8 = kani::any();
        kani::assume(decimals <= 24);
        let mut digits = [b'0'; 40];
        let mut k = 0;
        while k < 10 {
            let c: u8 = kani::any();
            kani::assume(c <= 9);
            digits[k] = b'0' + c;
            k += 1;
        }
        let mut z = n;
        while z < 40 {
            digits[z] = b'0';
            z += 1;
        }
        kani::assume(n == 1 || digits[n - 1] != b'0');
        let (buf, len) = format_digits(&digits, n, decimals);
        let Some((back, _m)) = parse_digits(&buf[..len], decimals) else {
            assert!(false, "formatted text must parse");
            return;
        };
        let mut k = 0;
        while k < 40 {
            assert!(back[k] == digits[k]);
            k += 1;
        }
        kani::cover!(has_point(&buf[..len]), "the text has a decimal point");
        kani::cover!(
            !has_point(&buf[..len]) && len > 1,
            "an integer text of several digits"
        );
        kani::cover!(
            has_point(&buf[..len]) && n > decimals as usize,
            "integer and fraction digits both present"
        );
    }

    /// D2: any text that parse_digits accepts is exactly the canonical text of its value.
    #[kani::proof]
    #[kani::unwind(50)]
    fn formatted_text_is_canonical() {
        let len: usize = kani::any();
        kani::assume(len >= 1 && len <= 12);
        let decimals: u8 = kani::any();
        kani::assume(decimals <= 8);
        let mut s = [0u8; MAX_LEN];
        let mut k = 0;
        while k < 12 {
            s[k] = kani::any();
            k += 1;
        }
        match parse_digits(&s[..len], decimals) {
            Some((digits, _n)) => {
                // NOT the n that parse_digits returned: that n keeps a leading zero, so "09.4" would format back to itself
                let (buf, flen) = format_digits(&digits, significant(&digits), decimals);
                assert!(flen == len);
                let mut k = 0;
                while k < len {
                    assert!(buf[k] == s[k]);
                    k += 1;
                }
                kani::cover!(has_point(&s[..len]), "a text with a decimal point parses");
                kani::cover!(
                    len > 1 && !has_point(&s[..len]),
                    "a multi-digit integer text parses"
                );
            }
            None => {
                kani::cover!(true, "a text is rejected");
            }
        }
    }

    /// D3: parse_digits returns without panic or overflow for any bytes and any decimals.
    #[kani::proof]
    #[kani::unwind(50)]
    fn parse_digits_never_panics() {
        let len: usize = kani::any();
        kani::assume(len <= MAX_LEN);
        let s: [u8; MAX_LEN] = kani::any();
        let decimals: u8 = kani::any();
        let r = parse_digits(&s[..len], decimals);
        kani::cover!(r.is_some(), "some input parses");
        kani::cover!(r.is_none(), "some input is rejected");
    }
}

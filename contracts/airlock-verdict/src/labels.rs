//! Label names and the closed name table (F01 3.2, AIR-024): the single definition of the wire names that the Rust crate, the
//! Lean model and the TypeScript console share through `fixtures/verdict-vectors.json`.
//!
//! A name maps to exactly one bit. Unknown names, other spellings, the empty string and bit 15 never map to anything: the
//! contract reverts on an unknown label (invariant I9). The masks of bits 0 to 4 come from the constants of the verdict; the
//! ten untrusted channels at bits 5 to 14 are named here.

use crate::{BOOK, ORACLE, OWNER, POLICY, UNRESOLVED};

pub const EMAIL: u16 = 1 << 5;
pub const WEB: u16 = 1 << 6;
pub const FILE: u16 = 1 << 7;
pub const CHAT: u16 = 1 << 8;
pub const SOCIAL: u16 = 1 << 9;
pub const TOOL_OUTPUT: u16 = 1 << 10;
pub const MEMORY: u16 = 1 << 11;
pub const QUARANTINE: u16 = 1 << 12;
pub const PAYMENT_PROTOCOL: u16 = 1 << 13;
pub const OTHER: u16 = 1 << 14;

/// The 15 wire names in bit order: `NAMES[i].1 == 1 << i`.
pub const NAMES: [(&str, u16); 15] = [
    ("Owner", OWNER),
    ("Book", BOOK),
    ("Policy", POLICY),
    ("Oracle", ORACLE),
    ("Unresolved", UNRESOLVED),
    ("Untrusted:email", EMAIL),
    ("Untrusted:web", WEB),
    ("Untrusted:file", FILE),
    ("Untrusted:chat", CHAT),
    ("Untrusted:social", SOCIAL),
    ("Untrusted:tool_output", TOOL_OUTPUT),
    ("Untrusted:memory", MEMORY),
    ("Untrusted:quarantine", QUARANTINE),
    ("Untrusted:payment_protocol", PAYMENT_PROTOCOL),
    ("Untrusted:other", OTHER),
];

/// The mask bit of a name, or `None` for anything outside the 15 names (exact match: case, spaces and non-ASCII all fail).
pub fn from_name(name: &str) -> Option<u16> {
    NAMES.iter().find(|(n, _)| *n == name).map(|(_, m)| *m)
}

/// The name of a mask that has exactly one bit set and that bit is one of the 15; `None` for 0, several bits and bit 15.
pub fn to_name(mask: u16) -> Option<&'static str> {
    if mask.count_ones() != 1 {
        return None;
    }
    NAMES.iter().find(|(_, m)| *m == mask).map(|(n, _)| *n)
}

/// The names behind the bits of a mask, in bit order. Bit 15 has no name and is skipped (see `is_valid_mask`).
pub fn names_of(mask: u16) -> impl Iterator<Item = &'static str> {
    NAMES
        .iter()
        .filter(move |(_, m)| mask & *m != 0)
        .map(|(n, _)| *n)
}

/// A mask is valid when bit 15 is clear (an unknown label channel reverts).
pub fn is_valid_mask(mask: u16) -> bool {
    mask & (1 << 15) == 0
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// P17: the name conversion is closed. A string that converts has exactly one bit and converts back to itself; every other
    /// string, the empty one included, maps to nothing. 28 bytes exceed the longest name (26 characters) and `str ==` compares
    /// the length first, so longer strings cannot match. `from_utf8_unchecked` is deliberate: with UTF-8 validation a symbolic
    /// 28 byte string gives no result in 280 s, and the comparison is byte wise either way.
    #[kani::proof]
    #[kani::unwind(30)]
    fn p17_label_conversion_closed() {
        let bytes: [u8; 28] = kani::any();
        let len: usize = kani::any();
        kani::assume(len <= 28);
        let s = unsafe { core::str::from_utf8_unchecked(&bytes[..len]) };
        match from_name(s) {
            Some(m) => {
                kani::cover!(true, "a string converts to a mask");
                assert!(m.count_ones() == 1);
                assert!(to_name(m) == Some(s));
            }
            None => {
                kani::cover!(true, "no name matched");
            }
        }
    }

    /// P17b: a mask that has a name converts back to the same mask.
    #[kani::proof]
    fn p17b_to_name_from_name_roundtrip() {
        let m: u16 = kani::any();
        match to_name(m) {
            Some(n) => {
                kani::cover!(true, "a single bit has a name");
                assert!(from_name(n) == Some(m));
            }
            None => {}
        }
    }
}

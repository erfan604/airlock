//! AIR-024: unit tests of `airlock_verdict::labels` that need no vector file.

use airlock_verdict::labels::*;
use airlock_verdict::{BOOK, ORACLE, OWNER, POLICY, RECIPIENT_TRUSTED, UNRESOLVED, UNTRUSTED_MASK};

#[test]
fn names_table_is_in_bit_order() {
    for (i, (_, mask)) in NAMES.iter().enumerate() {
        assert_eq!(*mask, 1u16 << i, "NAMES[{i}] is bit {i}");
    }
    assert_eq!(NAMES[0], ("Owner", OWNER));
    assert_eq!(NAMES[1], ("Book", BOOK));
    assert_eq!(NAMES[2], ("Policy", POLICY));
    assert_eq!(NAMES[3], ("Oracle", ORACLE));
    assert_eq!(NAMES[4], ("Unresolved", UNRESOLVED));
}

#[test]
fn names_are_unique_and_ascii() {
    for (i, (a, _)) in NAMES.iter().enumerate() {
        assert!(a.is_ascii());
        for (b, _) in NAMES.iter().skip(i + 1) {
            assert_ne!(a, b);
        }
    }
}

#[test]
fn untrusted_channels_fill_the_untrusted_mask() {
    let channels: u16 = NAMES.iter().skip(4).fold(0, |m, (_, bit)| m | bit);
    assert_eq!(channels, UNTRUSTED_MASK);
}

#[test]
fn only_owner_book_and_policy_are_inside_the_recipient_mask() {
    let inside: Vec<&str> = NAMES
        .iter()
        .filter(|(_, m)| m & !RECIPIENT_TRUSTED == 0)
        .map(|(n, _)| *n)
        .collect();
    assert_eq!(inside, ["Owner", "Book", "Policy"]);
}

#[test]
fn from_name_is_exact() {
    assert_eq!(from_name("Owner"), Some(OWNER));
    assert_eq!(from_name("Untrusted:email"), Some(EMAIL));
    assert_eq!(from_name("Untrusted:other"), Some(OTHER));
    for bad in [
        "owner",
        "OWNER",
        "Owner ",
        " Owner",
        "",
        "Untrusted:",
        "Untrusted:Email",
        "Untrusted:unknown",
    ] {
        assert_eq!(from_name(bad), None, "{bad:?}");
    }
}

#[test]
fn to_name_needs_exactly_one_known_bit() {
    assert_eq!(to_name(0), None);
    assert_eq!(to_name(OWNER | BOOK), None);
    assert_eq!(to_name(1 << 15), None);
    assert_eq!(to_name(EMAIL), Some("Untrusted:email"));
    for (name, mask) in NAMES {
        assert_eq!(to_name(mask), Some(name));
    }
}

#[test]
fn names_of_lists_bits_in_order_and_skips_bit_15() {
    assert_eq!(names_of(0).count(), 0);
    assert_eq!(
        names_of(OWNER | EMAIL).collect::<Vec<_>>(),
        ["Owner", "Untrusted:email"]
    );
    assert_eq!(names_of(1 << 15).count(), 0);
    assert_eq!(names_of(0x7fff).count(), 15);
}

#[test]
fn bit_15_is_the_only_invalid_mask_bit() {
    assert!(is_valid_mask(0));
    assert!(is_valid_mask(0x7fff));
    assert!(!is_valid_mask(1 << 15));
    assert!(!is_valid_mask(u16::MAX));
}

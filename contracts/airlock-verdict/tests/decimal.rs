//! AIR-027: canonical decimal text of base units (`airlock_verdict::decimal`). One canonical text per amount, no panics, no guessing:
//! the Kani harnesses check the digit logic, these tests cover the u128 to digits step on the full range and every vector of the shared
//! file (`fixtures/verdict-vectors.json`, section `decimals`).

use airlock_verdict::decimal::{format, parse, MAX_DECIMALS, MAX_LEN};
use serde_json::Value;

const VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/verdict-vectors.json"
));

fn f(amount: u128, decimals: u8) -> String {
    let (buf, len) = format(amount, decimals).expect("decimals within the limit");
    String::from_utf8(buf[..len].to_vec()).expect("canonical text is ASCII")
}

#[test]
fn f03_vectors() {
    assert_eq!(f(9_400_000_000_000_000_000_000_000, 24), "9.4");
    assert_eq!(f(4_200_000_000_000_000_000_000_000, 24), "4.2");
    assert_eq!(f(1, 24), "0.000000000000000000000001");
    assert_eq!(f(0, 0), "0");
    assert_eq!(f(0, 24), "0");
    assert_eq!(f(10_000_000_000_000_000, 18), "0.01");
    assert_eq!(f(420_000_000, 6), "420");
    assert_eq!(f(u128::MAX, 0), "340282366920938463463374607431768211455");
    assert_eq!(f(u128::MAX, 38), "3.40282366920938463463374607431768211455");
    assert_eq!(parse(b"9.4", 24), Some(9_400_000_000_000_000_000_000_000));
    assert_eq!(parse(b"0", 24), Some(0));
    assert_eq!(
        parse(b"340282366920938463463374607431768211455", 0),
        Some(u128::MAX)
    );
    assert_eq!(
        parse(b"3.40282366920938463463374607431768211455", 38),
        Some(u128::MAX)
    );
}

#[test]
fn u128_max_round_trips_at_every_decimals_0_to_38() {
    for d in 0..=MAX_DECIMALS {
        let text = f(u128::MAX, d);
        assert_eq!(
            parse(text.as_bytes(), d),
            Some(u128::MAX),
            "decimals {d}: {text}"
        );
        // 39 digits in all: one point when there are fraction digits
        assert_eq!(text.len(), 39 + usize::from(d > 0), "decimals {d}: {text}");
    }
}

#[test]
fn reject_list() {
    let bad: [(&[u8], u8); 32] = [
        (b"9.40", 24),
        (b"09.4", 24),
        (b"00", 6),
        (b"0.0", 6),
        (b"1,000", 6),
        (b"4.2e2", 6),
        (b"0.0000001", 6),
        (b"", 6),
        (b".", 6),
        (b"1.", 6),
        (b".5", 6),
        (b"-1", 6),
        (b"+1", 6),
        (b"1.5.5", 6),
        (b" 1", 6),
        (b"1 ", 6),
        (b"340282366920938463463374607431768211456", 0), // u128::MAX + 1
        (b"1", 39),                                      // above MAX_DECIMALS
        (b"1e3", 6),
        (b"01.5", 6),
        (b"1.50", 2),
        (b"1.23456789", 6),
        (b"0.0000005", 6),
        (b"0x10", 0),
        (b"-0", 24),
        (b"1.2.3", 6),
        (b"\x00", 6),         // a NUL byte
        (b"\n1", 6),          // a newline before the digit
        (b"\xef\xbc\x98", 0), // the three bytes of a full-width digit eight
        (b"1.5", 0),          // more places than the asset has
        (b"1_000", 0),
        (b"340282366920938463463374607431768211455", 38), // the integer digits and 38 places do not fit 40 digits
    ];
    for (s, d) in bad {
        assert_eq!(
            parse(s, d),
            None,
            "{:?} at {d} decimals",
            String::from_utf8_lossy(s)
        );
    }
    // 39 places at 38 decimals
    let too_many_places = format!("0.{}1", "0".repeat(38));
    assert_eq!(parse(too_many_places.as_bytes(), 38), None);
    // one place fewer is the canonical text of one base unit
    let one_unit = format!("0.{}1", "0".repeat(37));
    assert_eq!(parse(one_unit.as_bytes(), 38), Some(1));
    // a 48 byte text is within MAX_LEN, but 48 digits do not fit a u128 either; 49 and 50 bytes are over MAX_LEN
    assert_eq!(parse(&[b'1'; MAX_LEN], 0), None);
    assert_eq!(parse(&[b'1'; MAX_LEN + 1], 0), None);
    assert_eq!(parse(&[b'1'; MAX_LEN + 2], 0), None);
}

#[test]
fn format_above_38_is_none_and_parse_above_38_is_none() {
    assert!(format(1, MAX_DECIMALS + 1).is_none());
    assert!(format(0, 255).is_none());
    assert!(format(u128::MAX, 39).is_none());
    assert_eq!(parse(b"1", MAX_DECIMALS + 1), None);
    assert_eq!(parse(b"0", 255), None);
    assert!(format(1, MAX_DECIMALS).is_some());
}

#[test]
fn zero_formats_as_zero_at_every_decimals() {
    for d in 0..=MAX_DECIMALS {
        assert_eq!(f(0, d), "0", "decimals {d}");
        assert_eq!(parse(b"0", d), Some(0), "decimals {d}");
    }
}

#[test]
fn one_base_unit_at_every_decimals() {
    for d in 0..=MAX_DECIMALS {
        let want = if d == 0 {
            "1".to_string()
        } else {
            format!("0.{}1", "0".repeat(usize::from(d) - 1))
        };
        assert_eq!(f(1, d), want, "decimals {d}");
        assert_eq!(parse(want.as_bytes(), d), Some(1), "decimals {d}");
    }
}

#[test]
fn vector_file_accept_and_reject() {
    let d: Value = serde_json::from_str(VECTORS).unwrap();
    let accept = d["decimals"]["accept"].as_array().unwrap();
    let reject = d["decimals"]["reject"].as_array().unwrap();
    for v in accept {
        let amount: u128 = v["amount"].as_str().unwrap().parse().unwrap();
        let decimals = u8::try_from(v["decimals"].as_u64().unwrap()).unwrap();
        let text = v["text"].as_str().unwrap();
        assert_eq!(f(amount, decimals), text, "format {amount} at {decimals}");
        assert_eq!(
            parse(text.as_bytes(), decimals),
            Some(amount),
            "parse {text:?} at {decimals}"
        );
    }
    for v in reject {
        let decimals = u8::try_from(v["decimals"].as_u64().unwrap()).unwrap();
        let text = v["text"].as_str().unwrap();
        assert_eq!(
            parse(text.as_bytes(), decimals),
            None,
            "reject {text:?} at {decimals}"
        );
    }
    println!("vector accept={} reject={}", accept.len(), reject.len());
}

/// Full-range round trip on 200,000 pseudo-random amounts (xorshift, fixed seed of the spike) at every supported decimals. Covers the
/// u128 to digits conversion that the Kani harnesses leave to arithmetic.
#[test]
fn random_round_trip_full_range() {
    let mut x: u128 = 0x2545_f491_4f6c_dd1d_9e37_79b9_7f4a_7c15;
    for i in 0..200_000u32 {
        x ^= x << 23;
        x ^= x >> 17;
        x ^= x << 26;
        let a = match i % 4 {
            0 => x,
            1 => x >> 64,
            2 => x % 1_000_000_000_000_000_000_000_000_000,
            _ => x >> (i % 128),
        };
        let d = u8::try_from(i % (u32::from(MAX_DECIMALS) + 1)).unwrap();
        let t = f(a, d);
        assert!(
            t.bytes().all(|c| c.is_ascii_digit() || c == b'.') && t.matches('.').count() <= 1,
            "{t}"
        );
        assert_eq!(parse(t.as_bytes(), d), Some(a), "a={a} d={d} t={t}");
    }
}

/// Every two-byte string at every decimals: parse returns without panic, and whatever it accepts is the canonical text of its value.
#[test]
fn parse_never_panics_on_every_byte_pair_and_decimals() {
    let mut accepted = 0u32;
    for d in 0..=MAX_DECIMALS {
        for a in 0..=255u8 {
            for b in 0..=255u8 {
                let s = [a, b];
                if let Some(v) = parse(&s, d) {
                    accepted += 1;
                    assert_eq!(f(v, d).as_bytes(), s, "{s:?} at {d}");
                }
            }
        }
    }
    assert!(accepted > 0, "no two-byte text parsed at all");
}

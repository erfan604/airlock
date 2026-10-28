//! AIR-043: payee keys through `airlock_verdict::keys`. The vector test reads `fixtures/verdict-vectors.json` (section `payee_keys`,
//! the contract for the TypeScript canonicalizers too); `kelvin_sign_is_rejected` is the detector for a validator that lowercases
//! before it checks (Kani does not run on that mutant: CBMC unwinds UTF-8 and the Unicode tables). No code here is escaped with a
//! backslash and `u`: characters are built from their code points.

use airlock_verdict::keys::{
    canonical_evm_address, validate_near_account, validate_payee_key, KeyError,
};
use serde_json::Value;

const JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/verdict-vectors.json"
));

const ADDR: &str = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

fn code_point(n: u32) -> char {
    char::from_u32(n).unwrap()
}

fn check(key: &str) -> Result<(), KeyError> {
    validate_payee_key(key.as_bytes())
}

fn canon(input: &str) -> Result<String, KeyError> {
    let mut out = [0u8; 42];
    canonical_evm_address(input.as_bytes(), &mut out)?;
    Ok(String::from_utf8(out.to_vec()).unwrap())
}

/// Every `accept` key is `Ok`, every `reject` key fails with exactly its `error` variant name.
#[test]
fn payee_key_vectors() {
    let doc: Value = serde_json::from_str(JSON).unwrap();
    let keys = &doc["payee_keys"];
    let accept = keys["accept"].as_array().unwrap();
    let reject = keys["reject"].as_array().unwrap();
    assert!(!accept.is_empty() && !reject.is_empty());
    for entry in accept {
        let key = entry["key"].as_str().unwrap();
        assert_eq!(check(key), Ok(()), "accept {key:?}");
    }
    for entry in reject {
        let key = entry["key"].as_str().unwrap();
        let want = entry["error"].as_str().unwrap();
        match check(key) {
            Ok(()) => panic!("reject {key:?} was accepted"),
            Err(e) => assert_eq!(format!("{e:?}"), want, "reject {key:?}"),
        }
    }
    println!("PAYEE_KEY_VECTORS {}", accept.len() + reject.len());
}

/// U+212A (the Kelvin sign) lowercases to `k`. A validator that folds case first would accept the key below as `near:kelvin...`; the
/// ASCII check on the raw bytes refuses it.
#[test]
fn kelvin_sign_is_rejected() {
    let kelvin = code_point(0x212A);
    assert_eq!(
        kelvin.to_lowercase().to_string(),
        "k",
        "the premise: U+212A lowercases to k"
    );
    let key = format!("near:{kelvin}elvin.test.near");
    assert_eq!(check(&key), Err(KeyError::NonAscii));
    // the same character in an EVM key and in the address
    let key = format!("evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa9604{kelvin}");
    assert_eq!(check(&key), Err(KeyError::NonAscii));
    assert_eq!(
        canon(&format!("{kelvin}{}", &ADDR[1..])),
        Err(KeyError::NonAscii)
    );
}

#[test]
fn non_ascii_is_reported_before_anything_else() {
    // each of these is also a bad scheme, bad length or bad chain id, and the answer is still NonAscii
    for key in [
        format!("btc:{}", code_point(0x430)),
        format!("near:{}", code_point(0x430)),
        format!("evm:{}:{ADDR}", code_point(0xFF14)),
        format!("{}", code_point(0x430)),
        format!("evm:0:{ADDR}{}", code_point(0x200B)),
    ] {
        assert_eq!(check(&key), Err(KeyError::NonAscii), "{key:?}");
    }
    // a lone byte above 0x7f that is not valid UTF-8 is refused too
    assert_eq!(validate_payee_key(b"near:ab\xff"), Err(KeyError::NonAscii));
}

#[test]
fn schemes_are_exact() {
    for key in [
        "",
        "near",
        "near-ab",
        "evm",
        "NEAR:ab",
        "Near:ab",
        "EVM:1:0x",
        "ft:usdc.near:ab",
        "eth:0x",
        " near:ab",
    ] {
        assert_eq!(check(key), Err(KeyError::UnknownScheme), "{key:?}");
    }
}

#[test]
fn near_account_grammar_boundaries() {
    let ok = |s: &str| validate_near_account(s.as_bytes());
    assert!(ok("ab"));
    assert!(ok("a1"));
    assert!(ok("a-b_c.d"));
    assert!(ok(&"a".repeat(64)));
    assert!(!ok(""));
    assert!(!ok("a"));
    assert!(!ok(&"a".repeat(65)));
    for bad in [
        "-a", "a-", "_a", "a_", ".a", "a.", "a--b", "a__b", "a..b", "a-.b", "a._b", "a_-b", "A",
        "aB", "a b", "a/b", "a:b", "a@b",
    ] {
        assert!(!ok(bad), "{bad:?}");
    }
    // the error order: length, then characters, then separators
    assert_eq!(check("near:"), Err(KeyError::BadLength));
    assert_eq!(check("near:A"), Err(KeyError::BadLength));
    assert_eq!(check("near:A."), Err(KeyError::BadChar));
    assert_eq!(check("near:a.."), Err(KeyError::BadSeparator));
    assert_eq!(check("near:A.."), Err(KeyError::BadChar));
    assert_eq!(check("near:.."), Err(KeyError::BadSeparator));
    // a named account that looks like an implicit or an ETH-implicit account stays a valid near key
    assert_eq!(check(&format!("near:{}", "a".repeat(64))), Ok(()));
    assert_eq!(check(&format!("near:{ADDR}")), Ok(()));
}

#[test]
fn chain_id_range() {
    let key = |chain: &str| format!("evm:{chain}:{ADDR}");
    for ok in ["1", "84532", "8453", "18446744073709551615"] {
        assert_eq!(check(&key(ok)), Ok(()), "{ok}");
    }
    for bad in [
        "",
        "0",
        "00",
        "01",
        "007",
        "084532",
        "-1",
        "+1",
        " 1",
        "1 ",
        "1.0",
        "abc",
        "0x1",
        "18446744073709551616",
        "99999999999999999999",
        "100000000000000000000",
    ] {
        assert_eq!(check(&key(bad)), Err(KeyError::BadChainId), "{bad:?}");
    }
    // the chain id is checked before the address, and a key without a second colon has no address
    assert_eq!(check("evm:0:"), Err(KeyError::BadChainId));
    assert_eq!(check("evm:abc"), Err(KeyError::BadChainId));
    assert_eq!(check("evm:84532"), Err(KeyError::BadLength));
    assert_eq!(check("evm:84532:"), Err(KeyError::BadLength));
    assert_eq!(check("evm:"), Err(KeyError::BadChainId));
}

#[test]
fn evm_address_in_a_key_is_strict() {
    let key = |addr: &str| format!("evm:1:{addr}");
    assert_eq!(check(&key(ADDR)), Ok(()));
    // already canonical only: no folding, no missing prefix
    assert_eq!(
        check(&key(&ADDR.to_uppercase().replace("0X", "0x"))),
        Err(KeyError::BadChar)
    );
    assert_eq!(
        check(&key(&ADDR.replacen("0x", "0X", 1))),
        Err(KeyError::BadChar)
    );
    assert_eq!(check(&key(&ADDR[2..])), Err(KeyError::BadLength));
    assert_eq!(check(&key(&ADDR[..41])), Err(KeyError::BadLength));
    assert_eq!(check(&key(&format!("{ADDR}0"))), Err(KeyError::BadLength));
    assert_eq!(check(&key(&ADDR.replace('d', "g"))), Err(KeyError::BadChar));
    assert_eq!(
        check(&key(&format!("1x{}", &ADDR[2..]))),
        Err(KeyError::BadChar)
    );
    // a third colon is part of the address
    assert_eq!(
        check(&key(&format!("0x{}:", &ADDR[2..41]))),
        Err(KeyError::BadChar)
    );
}

#[test]
fn evm_canonicalization() {
    let want = ADDR.to_string();
    for input in [
        ADDR.to_string(),
        ADDR[2..].to_string(),
        ADDR.to_uppercase().replacen("0X", "0x", 1),
        ADDR[2..].to_uppercase(),
        "0xD8da6bF26964aF9D7eEd9e03E53415D37aA96045".to_string(),
    ] {
        assert_eq!(canon(&input).as_deref(), Ok(want.as_str()), "{input}");
    }
    // the canonical output is a fixed point and a valid key tail
    let once = canon("0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045").unwrap();
    assert_eq!(canon(&once), Ok(once.clone()));
    assert_eq!(check(&format!("evm:84532:{once}")), Ok(()));
    // 41 and 39 characters, 0X, a non-hex digit and an empty input
    assert_eq!(canon(&ADDR[..41]), Err(KeyError::BadLength));
    assert_eq!(canon(&ADDR[3..]), Err(KeyError::BadLength));
    assert_eq!(canon(""), Err(KeyError::BadLength));
    assert_eq!(canon(&ADDR.replacen("0x", "0X", 1)), Err(KeyError::BadChar));
    assert_eq!(canon(&ADDR.replace('d', "g")), Err(KeyError::BadChar));
    assert_eq!(canon(&format!("1x{}", &ADDR[2..])), Err(KeyError::BadChar));
    // 40 characters are taken as an address without a prefix, so an `x` inside is a non-hex digit (a prefix needs 42 characters)
    assert_eq!(canon(&format!("0x{}", &ADDR[4..])), Err(KeyError::BadChar));
    assert_eq!(canon(&format!("{}x", &ADDR[2..41])), Err(KeyError::BadChar));
}

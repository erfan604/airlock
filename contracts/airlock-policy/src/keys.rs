// AIR-043: payee keys on the contract side. The validator is `airlock_verdict::keys` (no_std, byte slices, proven by Kani, P16); this
// module panics with its error name and derives the asset a payee is paid in. A request carries an already canonical `payee`; nothing
// here repairs a key. The same vectors (fixtures/verdict-vectors.json, section `payee_keys`) are the contract for the TypeScript
// canonicalizers.
use crate::*;
use airlock_verdict::keys as verdict_keys;

pub use airlock_verdict::keys::KeyError;

/// Reverts `bad payee key: <KeyError variant name>` (for example `bad payee key: NonAscii`) unless the key is already canonical:
/// `near:<account>`, `evm:<chain id>:0x<40 lowercase hex>` or `erc20:<chain id>:0x<token>:0x<payee>` (AIR-109).
pub fn validate_payee_key(key: &str) {
    if let Err(error) = verdict_keys::validate_payee_key(key.as_bytes()) {
        env::panic_str(&format!("bad payee key: {error:?}"));
    }
}

/// The asset a payee is paid in: `near` for a `near:` key, `evm:<chain_id>:native` for an `evm:` key and (AIR-109)
/// `evm:<chain_id>:erc20:0x<token>` for an `erc20:<chain_id>:0x<token>:0x<payee>` key and (AIR-325) `sol:<cluster>` for a
/// `sol:<cluster>:<base58 address>` key. Call it after `validate_payee_key`.
pub fn asset_for_payee_key(key: &str) -> String {
    // AIR-325: `sol:<cluster>:<address>` is paid in `sol:<cluster>`
    if let Some(rest) = key.strip_prefix("sol:") {
        let cluster = rest.split(':').next().unwrap_or("");
        return format!("sol:{cluster}");
    }
    if let Some(rest) = key.strip_prefix("erc20:") {
        let mut parts = rest.split(':');
        let chain_id = parts.next().unwrap_or("");
        let token = parts.next().unwrap_or("");
        return format!("evm:{chain_id}:erc20:{token}");
    }
    match key.strip_prefix("evm:") {
        Some(rest) => {
            let chain_id = rest.split(':').next().unwrap_or("");
            format!("evm:{chain_id}:native")
        }
        None => "near".to_string(),
    }
}

/// The book key of a near account (helper for owner tooling and tests): `near:<account>`, or the validator's error.
pub fn book_key_near(account: &str) -> Result<String, KeyError> {
    let key = format!("near:{account}");
    verdict_keys::validate_payee_key(key.as_bytes())?;
    Ok(key)
}

/// The book key of an EVM address (helper for owner tooling and tests): the address may come with or without `0x` and in any hex
/// case, the key has `0x` and lowercase hex. A chain id of 0 is `BadChainId`.
pub fn book_key_evm(chain_id: u64, addr: &str) -> Result<String, KeyError> {
    let mut out = [0u8; verdict_keys::EVM_ADDRESS_LEN];
    verdict_keys::canonical_evm_address(addr.as_bytes(), &mut out)?;
    let canonical = core::str::from_utf8(&out).map_err(|_| KeyError::BadChar)?;
    let key = format!("evm:{chain_id}:{canonical}");
    verdict_keys::validate_payee_key(key.as_bytes())?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/verdict-vectors.json"
    ));

    fn panic_text(f: impl FnOnce()) -> String {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(()) => panic!("expected a revert, the call succeeded"),
            Err(payload) => payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                .unwrap_or_default(),
        }
    }

    #[test]
    fn keys_validate_payee_key_panics_with_the_error_name() {
        validate_payee_key("near:accountant.test.near");
        validate_payee_key("evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
        for (key, name) in [
            ("near:Accountant.testnet", "BadChar"),
            ("near:a", "BadLength"),
            ("near:a..b", "BadSeparator"),
            (
                "evm:0:0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
                "BadChainId",
            ),
            ("ft:usdc.near:alice.near", "UnknownScheme"),
            (
                "evm:84532:0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045",
                "BadChar",
            ),
        ] {
            let text = panic_text(|| validate_payee_key(key));
            assert!(
                text.contains(&format!("bad payee key: {name}")),
                "{key}: {text}"
            );
        }
        let kelvin = format!("near:{}elvin.near", char::from_u32(0x212A).unwrap());
        let text = panic_text(|| validate_payee_key(&kelvin));
        assert!(text.contains("bad payee key: NonAscii"), "{text}");
    }

    #[test]
    fn keys_asset_for_payee_key() {
        assert_eq!(asset_for_payee_key("near:accountant.test.near"), "near");
        assert_eq!(
            asset_for_payee_key("evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045"),
            "evm:84532:native"
        );
        assert_eq!(
            asset_for_payee_key(
                "evm:18446744073709551615:0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
            ),
            "evm:18446744073709551615:native"
        );
        // the asset a valid key names is a valid asset id
        for key in [
            "near:ab",
            "evm:1:0x0000000000000000000000000000000000000000",
        ] {
            assert!(
                crate::policy::valid_asset_id(&asset_for_payee_key(key)),
                "{key}"
            );
        }
    }

    #[test]
    fn keys_book_key_helpers() {
        let want = "evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
        for addr in [
            "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
            "d8da6bf26964af9d7eed9e03e53415d37aa96045",
            "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        ] {
            assert_eq!(book_key_evm(84532, addr).as_deref(), Ok(want), "{addr}");
        }
        assert_eq!(book_key_evm(84532, "0x123"), Err(KeyError::BadLength));
        assert_eq!(
            book_key_evm(0, "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"),
            Err(KeyError::BadChainId)
        );
        assert_eq!(
            book_key_near("accountant.test.near").as_deref(),
            Ok("near:accountant.test.near")
        );
        assert_eq!(book_key_near("Accountant.testnet"), Err(KeyError::BadChar));
        assert_eq!(book_key_near("a"), Err(KeyError::BadLength));
    }

    /// RT-23: the contract pays an `AccountId` parsed from the key, so the grammar of a `near:` key must equal that parser. The accounts
    /// of the `payee_keys` vectors plus 100,000 strings from a fixed seed over `a-z A-Z 0-9 . - _` (lengths 1 to 8 and 63 to 66; a third
    /// of them over the whole alphabet, the rest mostly lowercase so that valid long accounts occur) must agree.
    #[test]
    fn account_grammar_matches_near_sdk() {
        let agree = |s: &str| {
            assert_eq!(
                verdict_keys::validate_near_account(s.as_bytes()),
                near_sdk::AccountId::from_str(s).is_ok(),
                "{s:?}"
            );
        };
        let doc: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let mut from_vectors = 0;
        for list in ["accept", "reject"] {
            for entry in doc["payee_keys"][list].as_array().unwrap() {
                if let Some(account) = entry["key"].as_str().and_then(|k| k.strip_prefix("near:")) {
                    agree(account);
                    from_vectors += 1;
                }
            }
        }
        assert!(from_vectors >= 10, "{from_vectors} accounts in the vectors");

        const WHOLE: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_";
        const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
        const SEPARATORS: &[u8] = b".-_";
        // splitmix64 with a fixed seed
        let mut state: u64 = 0x5eed_0043_a1b2_c3d4;
        let mut next = move || {
            state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^ (z >> 31)
        };
        let (mut short_ok, mut long_ok, mut long_total) = (0u32, 0u32, 0u32);
        for i in 0..100_000u32 {
            let long = i % 2 == 1;
            let len = if long {
                63 + (next() % 4) as usize
            } else {
                1 + (next() % 8) as usize
            };
            let whole = next() % 3 == 0;
            let mut s = String::with_capacity(len);
            for _ in 0..len {
                let c = if whole {
                    WHOLE[(next() % WHOLE.len() as u64) as usize]
                } else if next() % 100 < 3 {
                    SEPARATORS[(next() % 3) as usize]
                } else {
                    LOWER[(next() % LOWER.len() as u64) as usize]
                };
                s.push(c as char);
            }
            agree(&s);
            let valid = verdict_keys::validate_near_account(s.as_bytes());
            if long {
                long_total += 1;
                long_ok += u32::from(valid);
            } else {
                short_ok += u32::from(valid);
            }
        }
        // the test must see both outcomes in both length classes, or it proves nothing
        assert!(short_ok > 2_000, "only {short_ok} valid short accounts");
        assert!(
            long_ok > 2_000 && long_ok < long_total,
            "{long_ok} of {long_total} long accounts valid"
        );
        // the boundaries by hand
        for len in [0usize, 1, 2, 63, 64, 65, 66] {
            agree(&"a".repeat(len));
        }
    }
}

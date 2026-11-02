// AIR-109: the x402 lane. An asset `evm:<chain_id>:erc20:0x<token>` with an `eip712` entry is paid by signing an EIP-3009
// `transferWithAuthorization` instead of a transaction: the contract builds the EIP-712 digest itself from the stored record and the
// registry, asks the MPC signer to sign it, and `on_signed` (AIR-105) stores the signature and emits `x402_signed`. Nothing the agent
// sent selects the path, the payer, the window or the nonce; the asset alone selects this lane, and the payee key carries the token so
// that bounds, caps and ledgers of one token never share a key with another asset.
//
// Placement (security): every helper and `start_x402` live in a plain `impl Contract` or free functions, so none is an exported method
// (`tests/x402.rs::x402_helpers_not_exported`). The module is `pub` and every item is `pub` (see lib.rs).
use crate::callback::{FailReason, ParsedSignature};
use crate::exec::{GAS_MPC_SIGN, GAS_ON_SIGNED, Payload, SIGN_DEPOSIT, SignRequest, mpc};
use crate::request::{ExecInfo, Hex32, RequestState, X402Exec};
use crate::*;

/// The authorization is valid for 300 s from the block time of the signing transaction: the facilitator needs at least now + 6 s and
/// the MPC answers within 200 blocks (about 116 s at the measured 0.58 s per block).
pub const X402_WINDOW_S: u64 = 300;

/// keccak256 of `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`.
pub const TRANSFER_WITH_AUTHORIZATION_TYPEHASH: [u8; 32] = [
    0x7c, 0x7c, 0x6c, 0xdb, 0x67, 0xa1, 0x87, 0x43, 0xf4, 0x9e, 0xc6, 0xfa, 0x9b, 0x35, 0xf5, 0x0d,
    0x52, 0xed, 0x05, 0xcb, 0xed, 0x4c, 0xc5, 0x92, 0xe1, 0x3b, 0x44, 0x50, 0x1c, 0x1a, 0x22, 0x67,
];

fn is_lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// `0x` plus 40 lowercase hex digits.
fn is_address(text: &str) -> bool {
    text.len() == 42 && text.starts_with("0x") && text.bytes().skip(2).all(is_lower_hex)
}

/// The shape of `Eip712Entry.from`: `0x` plus 40 lowercase hex digits.
pub fn valid_from(from: &str) -> bool {
    is_address(from)
}

/// Exactly the asset form `evm:<chain_id>:erc20:0x<40 lowercase hex>`, the chain id a decimal u64 of at least 1 without a leading zero.
pub fn is_erc20_asset(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("evm:") else {
        return false;
    };
    let mut parts = rest.split(':');
    let (Some(chain), Some("erc20"), Some(token), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    !chain.starts_with('0')
        && !chain.is_empty()
        && chain.bytes().all(|b| b.is_ascii_digit())
        && chain.parse::<u64>().is_ok()
        && is_address(token)
}

/// The end of the window, in Unix seconds: the block time in whole seconds plus `X402_WINDOW_S`.
pub fn valid_before_at(now_ms: u64) -> u64 {
    now_ms / 1000 + X402_WINDOW_S
}

/// The EIP-3009 nonce of a request: keccak256 of the receipt's random seed followed by the request id bytes. `env::random_seed()` is one
/// value for the whole receipt, so two x402 requests of one `submit_batch` would share it; the request id makes each nonce unique. A
/// block producer can predict the seed, which is harmless: the nonce only has to be unique, never secret.
pub fn x402_nonce(seed: &[u8; 32], request_id: &str) -> [u8; 32] {
    let mut input = Vec::with_capacity(32 + request_id.len());
    input.extend_from_slice(seed);
    input.extend_from_slice(request_id.as_bytes());
    env::keccak256_array(&input)
}

fn word_address(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn word_u64(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

/// keccak256 of seven 32-byte big-endian words (224 bytes): typehash, from, to, value, validAfter, validBefore, nonce.
pub fn struct_hash(
    from: &[u8; 20],
    to: &[u8; 20],
    value: u128,
    valid_after: u64,
    valid_before: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut buf = Vec::with_capacity(224);
    buf.extend_from_slice(&TRANSFER_WITH_AUTHORIZATION_TYPEHASH);
    buf.extend_from_slice(&word_address(from));
    buf.extend_from_slice(&word_address(to));
    buf.extend_from_slice(&word_u128(value));
    buf.extend_from_slice(&word_u64(valid_after));
    buf.extend_from_slice(&word_u64(valid_before));
    buf.extend_from_slice(nonce);
    env::keccak256_array(&buf)
}

/// The EIP-712 digest: keccak256(0x19 0x01 || domain separator || struct hash).
pub fn eip3009_digest(domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 66];
    buf[0] = 0x19;
    buf[1] = 0x01;
    buf[2..34].copy_from_slice(domain_separator);
    buf[34..].copy_from_slice(struct_hash);
    env::keccak256_array(buf)
}

/// `(v, r, s)` of a signer answer for `ecrecover`: `recovery_id` 0 or 1 gives `v` 27 or 28, `r` is `big_r` without its `02` or `03` prefix
/// (64 hex) and `s` is as parsed; 2 or 3 is a bad response (`ecrecover` takes `v` 27 or 28 only, and a response with `recovery_id` 2 or
/// 3 recovers a different address).
pub fn x402_sig_parts(
    big_r: &str,
    s: &str,
    recovery_id: u8,
) -> Result<(u8, String, String), FailReason> {
    if recovery_id > 1 || big_r.len() != 66 || !(big_r.starts_with("02") || big_r.starts_with("03"))
    {
        return Err(FailReason::MpcBadResponse);
    }
    Ok((27 + recovery_id, big_r[2..].to_string(), s.to_string()))
}

/// The 20 bytes of an address text (`0x` plus 40 hex digits, or the last 40 digits of a payee key).
fn address_bytes(text: &str) -> [u8; 20] {
    let digits = text
        .len()
        .checked_sub(40)
        .and_then(|from| text.get(from..))
        .unwrap_or_else(|| env::panic_str("bad address"));
    let mut out = [0u8; 20];
    hex::decode_to_slice(digits, &mut out).unwrap_or_else(|_| env::panic_str("bad address"));
    out
}

/// The 20 bytes of the payee address of an erc20 payee key (its last 40 hex digits).
pub fn x402_payee_address(payee_key: &str) -> [u8; 20] {
    address_bytes(payee_key)
}

/// The one authorization a request id was signed as (AIR-109, the x402 counterpart of `EvmAttempt`). Recorded before the first signing
/// call and never replaced: a retry signs `digest` again and takes no new nonce or window, so the signer can never hold two valid
/// authorizations for one request id.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct X402Attempt {
    pub nonce: [u8; 32],
    pub valid_after: u64,
    pub valid_before: u64,
    pub digest: [u8; 32],
}

impl Contract {
    /// The x402 lane of `start_execution` (AIR-109): builds the EIP-3009 authorization of an `Executing` erc20 record, records it as the
    /// request's `X402Attempt`, stores its digest with the payer, the window and the nonce, and asks the signer to sign the digest with
    /// `on_signed` as the callback. Everything comes from the stored record and the registry. The window and the nonce are computed at
    /// the first signing (the Allow in `submit_batch` or the `approve` of an escalation), never earlier, and exactly once per request id.
    /// A retry (AIR-105, Retryable once) rebuilds the digest from the stored attempt, checks it equals the stored one and signs it again:
    /// the first signing may have completed in the signer even though the callback saw a failure, so a fresh nonce could leave the payee
    /// two valid authorizations. When block time is at or past the stored `valid_before` the old authorization is expired, so the retry
    /// signs nothing: the request fails with `AuthorizationExpired` through `fail_request` (the refunding path, as `InsufficientBalance`
    /// of the NEAR lane; a second failure is final) and `None` comes back. A panic reverts the whole `submit_batch` (charges included) or
    /// leaves the escalation Pending (`approve`). Plain `impl`: never exported.
    pub fn start_x402(&mut self, id: &str) -> Option<Promise> {
        let mut rec = match self.records.get(id) {
            Some(rec) if rec.state == RequestState::Executing => rec.clone(),
            _ => env::panic_str("unexpected state"),
        };
        let asset = self
            .asset(&rec.asset)
            .unwrap_or_else(|| env::panic_str("unknown asset"));
        let eip712 = asset
            .eip712
            .unwrap_or_else(|| env::panic_str("eip712 missing"));
        let path = asset
            .path
            .unwrap_or_else(|| env::panic_str("evm path missing"));
        let from = address_bytes(&eip712.from);
        let to = x402_payee_address(&rec.payee);
        let digest_of = |nonce: &[u8; 32], valid_before: u64| {
            eip3009_digest(
                &eip712.domain_separator.0,
                &struct_hash(&from, &to, rec.amount, 0, valid_before, nonce),
            )
        };
        let attempt = match self.x402_attempts.get(id).cloned() {
            Some(stored) => {
                if env::block_timestamp_ms() / 1000 >= stored.valid_before {
                    self.fail_request(id, FailReason::AuthorizationExpired);
                    return None;
                }
                require!(
                    stored.valid_after == 0
                        && digest_of(&stored.nonce, stored.valid_before) == stored.digest,
                    "stored attempt does not match request"
                );
                stored
            }
            None => {
                let valid_before = valid_before_at(env::block_timestamp_ms());
                let nonce = x402_nonce(&env::random_seed_array(), id);
                let attempt = X402Attempt {
                    nonce,
                    valid_after: 0,
                    valid_before,
                    digest: digest_of(&nonce, valid_before),
                };
                self.x402_attempts.insert(id.to_string(), attempt.clone());
                attempt
            }
        };
        let digest_hex = hex::encode(attempt.digest);
        rec.exec = Some(ExecInfo {
            unsigned_hex: Some(digest_hex.clone()),
            x402: Some(X402Exec {
                from: eip712.from,
                valid_before: attempt.valid_before,
                nonce: Hex32(attempt.nonce),
            }),
            ..ExecInfo::default()
        });
        self.records.insert(id.to_string(), rec);
        // `with_unused_gas_weight(0)`: the signer receives exactly GAS_MPC_SIGN, as in the EVM lane
        Some(
            mpc::ext(self.mpc_contract_id.clone())
                .with_static_gas(GAS_MPC_SIGN)
                .with_attached_deposit(SIGN_DEPOSIT)
                .with_unused_gas_weight(0)
                .sign(SignRequest {
                    path,
                    payload_v2: Payload::Ecdsa(digest_hex.clone()),
                    domain_id: 0,
                })
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_SIGNED)
                        .on_signed(id.to_string(), digest_hex),
                ),
        )
    }

    /// Stores the signature of an x402 record (called by `store_signature` when `exec.x402` is set): `recovery_id` 2 or 3 is a bad
    /// response, which keeps the charges and ends the request `Failed` (D17, `fail_request` sends `MpcBadResponse` to
    /// `fail_kept_charged`); otherwise the record becomes `Executed` with the digest as `unsigned_hex` and `x402_signed` is emitted
    /// instead of `signed`. Plain `impl`: never exported.
    pub fn store_x402_signature(&mut self, id: &str, digest_hex: String, sig: ParsedSignature) {
        let Some(mut rec) = self.records.get(id).cloned() else {
            return;
        };
        if rec.state != RequestState::Executing {
            return;
        }
        let Some(x402) = rec.exec.as_ref().and_then(|e| e.x402.clone()) else {
            return;
        };
        let (v, r, s) = match x402_sig_parts(&sig.big_r, &sig.s, sig.recovery_id) {
            Ok(parts) => parts,
            Err(reason) => {
                self.fail_request(id, reason);
                return;
            }
        };
        let to = format!("0x{}", hex::encode(x402_payee_address(&rec.payee)));
        let nonce_text = format!("0x{}", x402.nonce.to_hex());
        Event::X402Signed {
            id,
            from: &x402.from,
            to: &to,
            value: rec.amount.to_string(),
            valid_after: "0",
            valid_before: x402.valid_before.to_string(),
            nonce: &nonce_text,
            v,
            r: &r,
            s: &s,
        }
        .emit();
        rec.exec = Some(ExecInfo {
            unsigned_hex: Some(digest_hex),
            big_r: Some(sig.big_r),
            s: Some(sig.s),
            recovery_id: Some(sig.recovery_id),
            x402: Some(x402),
        });
        rec.state = RequestState::Executed;
        self.records.insert(id.to_string(), rec);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::valid_asset_id;
    use crate::testutil::{POLICY, ctx};
    use near_sdk::testing_env;
    use serde_json::Value;

    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/eip3009-vectors.json"
    ));
    const TOKEN: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    const PAYEE: &str = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

    fn vm() {
        testing_env!(ctx(POLICY, 1_000, 0).build());
    }

    fn b32(text: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        hex::decode_to_slice(text.trim_start_matches("0x"), &mut out).unwrap();
        out
    }

    fn b20(text: &str) -> [u8; 20] {
        let mut out = [0u8; 20];
        hex::decode_to_slice(text.trim_start_matches("0x"), &mut out).unwrap();
        out
    }

    fn row_digest(row: &Value) -> [u8; 32] {
        let text = |k: &str| row[k].as_str().unwrap().to_string();
        let nonce = b32(&text("nonce"));
        let sh = struct_hash(
            &b20(&text("from")),
            &b20(&text("to")),
            text("value").parse().unwrap(),
            text("valid_after").parse().unwrap(),
            text("valid_before").parse().unwrap(),
            &nonce,
        );
        eip3009_digest(&b32(&text("domain_separator")), &sh)
    }

    /// The EIP-712 domain separator of `{name, version, chainId, verifyingContract}`, for the pinned-separator test only: the contract
    /// stores the separator and never rebuilds it.
    fn domain_separator_of(
        name: &str,
        version: &str,
        chain_id: u64,
        verifying: &[u8; 20],
    ) -> [u8; 32] {
        let type_hash = env::keccak256_array(
            b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        );
        let mut buf = Vec::new();
        buf.extend_from_slice(&type_hash);
        buf.extend_from_slice(&env::keccak256_array(name.as_bytes()));
        buf.extend_from_slice(&env::keccak256_array(version.as_bytes()));
        buf.extend_from_slice(&word_u64(chain_id));
        buf.extend_from_slice(&word_address(verifying));
        env::keccak256_array(&buf)
    }

    #[test]
    fn x402_typehash_matches_type_string() {
        vm();
        let type_string = "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
        assert_eq!(
            env::keccak256_array(type_string.as_bytes()),
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH
        );
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(
            b32(doc["typehash"].as_str().unwrap()),
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH
        );
    }

    #[test]
    fn x402_domain_separator_pinned() {
        vm();
        let usdc = b20(TOKEN);
        let pinned = domain_separator_of("USDC", "2", 84532, &usdc);
        assert_eq!(
            hex::encode(pinned),
            "71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818"
        );
        // the trap: mainnet's name is `USD Coin`, and the separator differs
        assert_ne!(domain_separator_of("USD Coin", "2", 84532, &usdc), pinned);
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(b32(doc["domain_separator"].as_str().unwrap()), pinned);
    }

    #[test]
    fn x402_digest_m2_example() {
        vm();
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        let m2 = &doc["m2_example"];
        assert_eq!(
            hex::encode(row_digest(&{
                let mut row = m2.clone();
                row["domain_separator"] = doc["domain_separator"].clone();
                row
            })),
            "2178b44a8b4de3e9911b1ae6639674f3f844d1ea965bc358ece95239ab834f8d"
        );
        assert_eq!(
            m2["digest"].as_str().unwrap(),
            "0x2178b44a8b4de3e9911b1ae6639674f3f844d1ea965bc358ece95239ab834f8d"
        );
    }

    #[test]
    fn x402_digest_vectors_100() {
        vm();
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        let rows = doc["vectors"].as_array().unwrap();
        assert_eq!(rows.len(), 100);
        for (i, row) in rows.iter().enumerate() {
            assert_eq!(
                format!("0x{}", hex::encode(row_digest(row))),
                row["digest"].as_str().unwrap(),
                "vector {i}"
            );
        }
        println!("EIP3009_VECTORS {}", rows.len());
    }

    #[test]
    fn x402_nonce_depends_on_request_id() {
        vm();
        let seed = [7u8; 32];
        let (a, b) = ("aa:0", "aa:1");
        assert_ne!(x402_nonce(&seed, a), x402_nonce(&seed, b));
        assert_eq!(x402_nonce(&seed, a), x402_nonce(&seed, a));
        let mut input = seed.to_vec();
        input.extend_from_slice(a.as_bytes());
        assert_eq!(x402_nonce(&seed, a), env::keccak256_array(&input));
        assert_ne!(x402_nonce(&[8u8; 32], a), x402_nonce(&seed, a));
    }

    #[test]
    fn x402_window_is_300_s_from_block_time() {
        assert_eq!(valid_before_at(1_700_000_000_999), 1_700_000_300);
        assert_eq!(valid_before_at(0), 300);
        assert_eq!(X402_WINDOW_S, 300);
    }

    #[test]
    fn x402_sig_parts_table() {
        let r = format!("02{}", "11".repeat(32));
        let s = "22".repeat(32);
        let (v0, r0, s0) = x402_sig_parts(&r, &s, 0).unwrap();
        assert_eq!((v0, r0.len(), s0.len()), (27, 64, 64));
        assert_eq!(r0, "11".repeat(32));
        let (v1, _, _) = x402_sig_parts(&format!("03{}", "11".repeat(32)), &s, 1).unwrap();
        assert_eq!(v1, 28);
        for id in [2u8, 3] {
            assert_eq!(x402_sig_parts(&r, &s, id), Err(FailReason::MpcBadResponse));
        }
        assert_eq!(
            x402_sig_parts(&format!("04{}", "11".repeat(32)), &s, 0),
            Err(FailReason::MpcBadResponse)
        );
    }

    #[test]
    fn x402_asset_grammar_and_key_map() {
        let ok = format!("evm:84532:erc20:{TOKEN}");
        assert!(is_erc20_asset(&ok) && valid_asset_id(&ok));
        let upper = format!("evm:84532:erc20:0x{}", TOKEN[2..].to_uppercase());
        let short = format!("evm:84532:erc20:0x{}", &TOKEN[2..41]);
        for bad in [
            upper.as_str(),
            short.as_str(),
            &format!("evm:0:erc20:{TOKEN}"),
            &format!("evm:084532:erc20:{TOKEN}"),
            "evm:84532:erc20:0x",
            "evm:84532:erc20:",
            &format!("evm:84532:erc20:{TOKEN}:x"),
            "evm:84532:native",
            "near",
        ] {
            assert!(!is_erc20_asset(bad), "{bad}");
        }
        for bad in [
            upper.as_str(),
            short.as_str(),
            "evm:0:erc20:0x",
            "evm:84532:erc20:0x",
        ] {
            assert!(!valid_asset_id(bad), "{bad}");
        }
        let key = format!("erc20:84532:{TOKEN}:{PAYEE}");
        crate::keys::validate_payee_key(&key);
        assert_eq!(crate::keys::asset_for_payee_key(&key), ok);
        assert_eq!(
            crate::keys::asset_for_payee_key(&format!("evm:84532:{PAYEE}")),
            "evm:84532:native"
        );
        assert_eq!(x402_payee_address(&key), b20(PAYEE));
        assert!(valid_from(PAYEE) && !valid_from(&PAYEE[..41]));
    }
}

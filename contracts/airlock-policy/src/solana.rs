// AIR-325: the Solana lane (MPC domain 1, Ed25519). An Executing record (an Allow, or an approved escalation) in an asset `sol:<cluster>`
// becomes a legacy SystemProgram transfer message built inside the contract from the stored request, the registry and the sender the owner
// registered for the asset; the message bytes go to the MPC signer as an `Eddsa` payload (signed as is, never hashed), and `on_sol_signed`
// checks the signature against the sender with `env::ed25519_verify` before it stores and announces it. A relayer assembles and broadcasts.
//
// Why a separate `sign_sol` step: a Solana message carries a recent blockhash that expires after about 150 slots (60 to 90 s), while an
// escalation waits for the owner for minutes or hours. So `start_execution` starts no promise for a Solana record; the agent (or the owner)
// calls `sign_sol(request_id, recent_blockhash)` once the record is Executing. The blockhash is untrusted and harmless: it only bounds how
// long the signed message stays valid. One request id maps to one stored message (`SolAttempt`, written at the first `sign_sol`, never
// replaced): a retry signs the identical bytes again, so one id can never yield two different transfers (the same message signed twice is
// one transaction for Solana, whose status cache refuses a message it has already processed).
//
// The sender is registered, not derived here: the MPC key is bound to (this account, the asset's path), so a wrong registered sender only
// yields a signature that does not verify (`MpcBadResponse` at the first signing), and no other key can be made to sign. Its derivation is
// pinned by `derivation_matches_chainsig` below (root key plus G times the tweak, refs near/mpc crypto_shared/kdf.rs) and by the live
// `derived_public_key` view. A Solana message has no chain id, so each Solana asset has its own path (`asset_set` refuses a path any other
// asset uses) and a blockhash of another cluster can only make a message the derived key of this path signs.
//
// Placement (security): `sign_sol` (agent or owner), `sol_sender_set` (owner), the callback `on_sol_signed` (`#[private]`) and two views are
// the only exported methods; every helper is a free function or lives in a plain `impl Contract`. New state lives in two maps under appended
// `StorageKey`s, opened where they are used (the AIR-315 pattern), so no earlier Borsh layout changes.
use crate::callback::{FailReason, MAX_MPC_RESPONSE};
use crate::exec::{GAS_MPC_SIGN, GAS_ON_SIGNED, Payload, SIGN_DEPOSIT, SignRequest, mpc};
use crate::request::{ExecInfo, RequestState};
use crate::*;
use airlock_verdict::keys::{is_sol_cluster, sol_address_bytes};
use near_sdk::PromiseError;
use omni_transaction::TxBuilder;
use omni_transaction::solana::SolanaTransactionBuilder;
use omni_transaction::solana::types::{Blockhash, SolanaAddress};
use omni_transaction::solana::utils::system_transfer;

/// The MPC domain of Ed25519 (domain 0 is secp256k1).
pub const SOL_DOMAIN_ID: u64 = 1;
/// The System program, all zero bytes (`11111111111111111111111111111111`).
pub const SYSTEM_PROGRAM_ID: [u8; 32] = [0; 32];
/// A Solana amount is a u64 of lamports: the hard cap of a Solana asset may not be above it.
pub const MAX_SOL_LAMPORTS: u128 = u64::MAX as u128;

/// The asset form `sol:<cluster>` (cluster `devnet`, `testnet` or `mainnet`).
pub fn is_sol_asset(id: &str) -> bool {
    id.strip_prefix("sol:")
        .is_some_and(|cluster| is_sol_cluster(cluster.as_bytes()))
}

/// The 32 bytes a base58 address or blockhash spells (exactly 32 bytes, the verdict crate's decoder), `None` for anything else.
pub fn sol_bytes(text: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    sol_address_bytes(text.as_bytes(), &mut out).ok()?;
    Some(out)
}

/// The base58 spelling of 32 bytes.
pub fn sol_base58(bytes: &[u8; 32]) -> String {
    SolanaAddress(*bytes).to_base58()
}

/// The 32 bytes of the address of a `sol:<cluster>:<address>` payee key (validated at submit).
pub fn sol_payee_bytes(payee_key: &str) -> [u8; 32] {
    payee_key
        .strip_prefix("sol:")
        .and_then(|rest| rest.split(':').nth(1))
        .and_then(sol_bytes)
        .unwrap_or_else(|| env::panic_str("bad sol payee key"))
}

/// The legacy message of one SystemProgram transfer of `lamports` from `from` (fee payer and only signer) to `to` under `blockhash`: header
/// (1, 0, 1), keys [from, to, System program], the blockhash, one instruction (program 2, accounts [0, 1], data `02000000` plus the
/// lamports as u64 little-endian). These are the bytes the Ed25519 signature covers.
pub fn build_sol_transfer(
    from: &[u8; 32],
    to: &[u8; 32],
    lamports: u64,
    blockhash: &[u8; 32],
) -> Vec<u8> {
    let payer = SolanaAddress(*from);
    SolanaTransactionBuilder::new()
        .payer(payer)
        .instructions(vec![system_transfer(payer, SolanaAddress(*to), lamports)])
        .recent_blockhash(Blockhash(*blockhash))
        .build()
        .build_for_signing()
}

/// The signer's Ed25519 answer, `{"scheme":"Ed25519","signature":[64 numbers]}` (near/mpc 3.17.0 `SignatureResponse::Ed25519`). serde
/// ignores unknown extra fields and rejects a duplicate key, a missing field and a number above 255.
#[near(serializers = [json])]
struct Ed25519Response {
    scheme: String,
    signature: Vec<u8>,
}

/// Parses the signer's answer: the scheme must be `Ed25519` and the signature exactly 64 bytes. The error is the text of the first check
/// that fails (`bad scheme`, `bad signature length`, or the serde error).
pub fn parse_ed25519_signature(bytes: &[u8]) -> Result<[u8; 64], String> {
    let response: Ed25519Response =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if response.scheme != "Ed25519" {
        return Err("bad scheme".to_string());
    }
    <[u8; 64]>::try_from(response.signature.as_slice())
        .map_err(|_| "bad signature length".to_string())
}

/// The one message a request id was signed as: written at the first `sign_sol` and never replaced (a retry signs `message` again).
/// `in_flight` is true while a `sign` call is out, so a second `sign_sol` cannot ask for a second signature at the same time.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolAttempt {
    pub sender: [u8; 32],
    pub blockhash: [u8; 32],
    pub message: Vec<u8>,
    pub in_flight: bool,
    pub signature: Option<[u8; 64]>,
}

/// `get_sol_attempt`: addresses and the blockhash in base58, the message and the signature in lowercase hex.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolAttemptView {
    pub sender: String,
    pub blockhash: String,
    pub message_hex: String,
    pub in_flight: bool,
    pub signature_hex: Option<String>,
}

impl From<&SolAttempt> for SolAttemptView {
    fn from(a: &SolAttempt) -> Self {
        Self {
            sender: sol_base58(&a.sender),
            blockhash: sol_base58(&a.blockhash),
            message_hex: hex::encode(&a.message),
            in_flight: a.in_flight,
            signature_hex: a.signature.map(hex::encode),
        }
    }
}

fn senders() -> LookupMap<String, [u8; 32]> {
    LookupMap::new(StorageKey::SolSenders)
}

fn attempts() -> LookupMap<String, SolAttempt> {
    LookupMap::new(StorageKey::SolAttempts)
}

/// The events of this lane, in the contract's one NEP-297 envelope (`internal/events.rs`): `standard` airlock, `version` 1.0.0, `data` a
/// one-element array. docs/events.md lists them.
#[derive(Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
#[serde(tag = "event", content = "data")]
#[serde(rename_all = "snake_case")]
#[must_use = "Don't forget to `.emit()` this event"]
pub enum SolEvent<'a> {
    /// The owner registered the sender (base58) of a Solana asset.
    SolSenderSet { asset: &'a str, sender: &'a str },
    /// `sign_sol` asked the signer to sign this message (lowercase hex). A retry emits it again with the same value.
    SolUnsigned {
        request_id: &'a str,
        message_hex: &'a str,
    },
    /// `on_sol_signed` stored a signature that verifies against the sender; `signature` is 128 lowercase hex.
    SolSigned {
        request_id: &'a str,
        message_hex: &'a str,
        signature: &'a str,
    },
}

impl SolEvent<'_> {
    pub fn emit(&self) {
        let data = serde_json::json!(self);
        let event_json = serde_json::json!({
            "standard": "airlock",
            "version": "1.0.0",
            "event": data["event"],
            "data": [data["data"]]
        })
        .to_string();
        log!("EVENT_JSON:{}", event_json);
    }
}

impl Contract {
    /// The checks `asset_set` runs for a Solana asset (after the common ones): a path (`sol path required`, `sol path invalid`, `sol path
    /// already used` by any other asset), no fee or gas caps (`fee and gas caps only for evm`) and caps a u64 of lamports can hold (`sol caps
    /// above u64`). Plain `impl`: never exported.
    pub fn check_sol_asset(&self, asset: &str, entry: &crate::policy::AssetEntryJson) {
        let path = entry.path.as_deref().filter(|p| !p.is_empty());
        let path = path.unwrap_or_else(|| env::panic_str("sol path required"));
        require!(crate::policy::valid_path(path), "sol path invalid");
        require!(
            !self
                .assets
                .iter()
                .any(|(id, e)| id != asset && e.path.as_deref() == Some(path)),
            "sol path already used"
        );
        require!(
            entry.max_fee_per_gas.0 == 0 && entry.max_gas.0 == 0,
            "fee and gas caps only for evm"
        );
        require!(
            entry.hard_cap.0 <= MAX_SOL_LAMPORTS,
            "sol caps above u64"
        );
    }

    /// Who may call `sign_sol` for `rec`: the owner, or the agent that submitted it while it is still a valid, allowed agent. Returns the
    /// failure promise of `require_valid_agent` when there is one. Plain `impl`: never exported.
    fn sol_signer_check(&mut self, agent: &AccountId) -> Option<Promise> {
        let caller = env::predecessor_account_id();
        if caller == self.owner_id {
            return None;
        }
        if let Some(failure) = self.require_valid_agent() {
            return Some(failure);
        }
        require!(caller == *agent, "not the agent of this request");
        None
    }
}

#[near]
impl Contract {
    /// Owner: the sender of a Solana asset, the base58 Ed25519 public key the MPC signer derives for (this account, the asset's path). The
    /// asset must be registered (`unknown sol asset`) and the key 32 bytes in base58 (`bad sol sender`). Emits `sol_sender_set`.
    #[payable]
    pub fn sol_sender_set(&mut self, asset: String, sender: String) {
        self.owner_call();
        require!(
            is_sol_asset(&asset) && self.assets.contains_key(&asset),
            "unknown sol asset"
        );
        let bytes = sol_bytes(&sender).unwrap_or_else(|| env::panic_str("bad sol sender"));
        let mut map = senders();
        map.insert(asset.clone(), bytes);
        map.flush();
        SolEvent::SolSenderSet {
            asset: &asset,
            sender: &sol_base58(&bytes),
        }
        .emit();
    }

    /// The registered sender of a Solana asset (base58), if any.
    pub fn get_sol_sender(&self, asset: String) -> Option<String> {
        senders().get(&asset).map(sol_base58)
    }

    /// The message (and, once signed, the signature) of a Solana request, if `sign_sol` ran for it.
    pub fn get_sol_attempt(&self, request_id: String) -> Option<SolAttemptView> {
        attempts().get(&request_id).map(SolAttemptView::from)
    }

    /// Signs an Executing Solana request: the record's agent (a valid, allowed agent) or the owner calls it with a recent blockhash of the
    /// cluster (base58). Reverts, in order: the caller check (`require_valid_agent`'s failure promise, `not the agent of this request`),
    /// `unknown request`, `paused`, `request is not executing`, `not a solana request`, `sol path missing`, `sol sender not set`, `bad
    /// blockhash`, `payee is the sender`, `payee is the system program`, `amount above u64`; on a retry `signing in flight`, `already signed`
    /// and `stored attempt does not match request`. The first call builds the message from the stored payee and amount, the registered
    /// sender and this blockhash and records it; a later call (after `MpcFailed` and the gate's retry) signs the stored message again and
    /// does not use its blockhash. Emits `sol_unsigned` and asks the signer (`sign` with domain 1, the message bytes as the `Eddsa`
    /// payload, 1 yocto, `GAS_MPC_SIGN`), with `on_sol_signed` as the callback. Not payable: the contract pays the signer's deposit.
    pub fn sign_sol(&mut self, request_id: String, recent_blockhash: String) -> Promise {
        let rec = self
            .records
            .get(&request_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown request"));
        if let Some(failure) = self.sol_signer_check(&rec.agent) {
            return failure;
        }
        require!(!self.paused, "paused");
        require!(
            rec.state == RequestState::Executing,
            "request is not executing"
        );
        require!(is_sol_asset(&rec.asset), "not a solana request");
        let path = self
            .asset(&rec.asset)
            .and_then(|a| a.path)
            .unwrap_or_else(|| env::panic_str("sol path missing"));
        let sender = senders()
            .get(&rec.asset)
            .copied()
            .unwrap_or_else(|| env::panic_str("sol sender not set"));
        let blockhash =
            sol_bytes(&recent_blockhash).unwrap_or_else(|| env::panic_str("bad blockhash"));
        let to = sol_payee_bytes(&rec.payee);
        require!(to != sender, "payee is the sender");
        require!(to != SYSTEM_PROGRAM_ID, "payee is the system program");
        let lamports =
            u64::try_from(rec.amount).unwrap_or_else(|_| env::panic_str("amount above u64"));
        let mut map = attempts();
        let mut attempt = match map.get(&request_id).cloned() {
            Some(stored) => {
                require!(!stored.in_flight, "signing in flight");
                require!(stored.signature.is_none(), "already signed");
                let rebuilt = build_sol_transfer(&stored.sender, &to, lamports, &stored.blockhash);
                require!(
                    rebuilt == stored.message,
                    "stored attempt does not match request"
                );
                stored
            }
            None => SolAttempt {
                sender,
                blockhash,
                message: build_sol_transfer(&sender, &to, lamports, &blockhash),
                in_flight: false,
                signature: None,
            },
        };
        attempt.in_flight = true;
        let message_hex = hex::encode(&attempt.message);
        let payload = Payload::Eddsa(message_hex.clone());
        map.insert(request_id.clone(), attempt);
        map.flush();
        let mut rec = rec;
        rec.exec = Some(ExecInfo {
            unsigned_hex: Some(message_hex.clone()),
            ..ExecInfo::default()
        });
        self.records.insert(request_id.clone(), rec);
        SolEvent::SolUnsigned {
            request_id: &request_id,
            message_hex: &message_hex,
        }
        .emit();
        // `with_unused_gas_weight(0)`: the signer receives exactly GAS_MPC_SIGN, as in the EVM lane
        mpc::ext(self.mpc_contract_id.clone())
            .with_static_gas(GAS_MPC_SIGN)
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_unused_gas_weight(0)
            .sign(SignRequest {
                path,
                payload_v2: payload,
                domain_id: SOL_DOMAIN_ID,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SIGNED)
                    .on_sol_signed(request_id),
            )
    }

    /// The callback of the Ed25519 `sign` call. The attempt is no longer in flight whatever the answer. A failed receipt is `MpcFailed`
    /// through `fail_request` (refund, `Retryable` once, then `Failed`). An answer that does not parse, or a signature that does not verify
    /// against the stored sender over the stored message, is `MpcBadResponse` through `fail_kept_charged` (the request keeps its charges and
    /// is `Failed`). A good signature on an Executing record is stored on the attempt, the record becomes `Executed` and `sol_signed` is
    /// emitted. A record that is not Executing is left alone. Never panics on a payload: a panic here would roll the state back.
    #[private]
    pub fn on_sol_signed(&mut self, request_id: String) {
        let outcome = match env::promise_result_checked(0, MAX_MPC_RESPONSE) {
            Ok(bytes) => parse_ed25519_signature(&bytes).map_err(|_| FailReason::MpcBadResponse),
            Err(PromiseError::Failed) => Err(FailReason::MpcFailed),
            // `PromiseError` is `#[non_exhaustive]`: `TooLong` and anything else is a receipt that succeeded with an unusable answer
            Err(_) => Err(FailReason::MpcBadResponse),
        };
        let mut map = attempts();
        let Some(mut attempt) = map.get(&request_id).cloned() else {
            return;
        };
        attempt.in_flight = false;
        match outcome {
            Ok(signature) if env::ed25519_verify(&signature, &attempt.message, &attempt.sender) => {
                let executing = self
                    .records
                    .get(&request_id)
                    .cloned()
                    .filter(|r| r.state == RequestState::Executing);
                if let Some(mut rec) = executing {
                    let message_hex = hex::encode(&attempt.message);
                    let signature_hex = hex::encode(signature);
                    attempt.signature = Some(signature);
                    rec.state = RequestState::Executed;
                    rec.exec = Some(ExecInfo {
                        unsigned_hex: Some(message_hex.clone()),
                        ..ExecInfo::default()
                    });
                    self.records.insert(request_id.clone(), rec);
                    SolEvent::SolSigned {
                        request_id: &request_id,
                        message_hex: &message_hex,
                        signature: &signature_hex,
                    }
                    .emit();
                }
            }
            Ok(_) => self.fail_kept_charged(&request_id, FailReason::MpcBadResponse),
            Err(reason) => self.fail_request(&request_id, reason),
        }
        map.insert(request_id, attempt);
        map.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::{Labels, RequestRecord, request_id};
    use crate::testutil::{OWNER, POLICY, ctx, fresh};
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::get_logs;
    use near_sdk::{PromiseResult, testing_env};

    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/sol-vectors.json"
    ));
    const AGENT: &str = "agent.test.near";
    const ASSET: &str = "sol:devnet";
    const PAYEE_B58: &str = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
    const BLOCKHASH: &str = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
    /// The seed of the test sender: 32 bytes of 02 (a published throwaway, tests only).
    const SENDER_SEED: [u8; 32] = [2; 32];

    fn vectors() -> serde_json::Value {
        serde_json::from_str(VECTORS).unwrap()
    }

    fn b58(text: &str) -> [u8; 32] {
        sol_bytes(text).unwrap_or_else(|| panic!("{text} is not 32 bytes of base58"))
    }

    /// Every message of fixtures/sol-vectors.json (written by @solana/web3.js 1.99.0) is what `build_sol_transfer` builds, byte for byte.
    #[test]
    fn sol_message_matches_web3js() {
        let doc = vectors();
        let messages = doc["messages"].as_array().unwrap();
        assert!(messages.len() >= 4);
        for m in messages {
            let lamports: u64 = m["lamports"].as_str().unwrap().parse().unwrap();
            let bytes = build_sol_transfer(
                &b58(m["from"].as_str().unwrap()),
                &b58(m["to"].as_str().unwrap()),
                lamports,
                &b58(m["blockhash"].as_str().unwrap()),
            );
            assert_eq!(hex::encode(&bytes), m["message_hex"].as_str().unwrap(), "{m}");
            // the fixed shape the relayer relies on: 150 bytes, one signer, three keys, the payer first
            assert_eq!(bytes.len(), 150);
            assert_eq!(&bytes[..4], &[1, 0, 1, 3]);
            assert_eq!(&bytes[4..36], &b58(m["from"].as_str().unwrap()));
        }
    }

    /// The Ed25519 child key of the testnet MPC root for (predecessor, path) is root + G * (sha3_256("near-mpc-recovery v0.1.0 epsilon
    /// derivation:" + predecessor + "," + path) mod l) (near/mpc crates/contract/src/crypto_shared/kdf.rs), and it equals what chainsig.js
    /// 1.1.16 derives (fixtures/sol-vectors.json `derivations`). The owner registers this key with `sol_sender_set`.
    #[test]
    fn derivation_matches_chainsig() {
        use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
        use curve25519_dalek::edwards::CompressedEdwardsY;
        use curve25519_dalek::scalar::Scalar;
        use sha3::{Digest, Sha3_256};
        let doc = vectors();
        let derivations = doc["derivations"].as_array().unwrap();
        assert!(derivations.len() >= 3);
        for d in derivations {
            let root = b58(d["root"].as_str().unwrap().strip_prefix("ed25519:").unwrap());
            let want = d["public_key"].as_str().unwrap().strip_prefix("ed25519:").unwrap();
            let text = format!(
                "near-mpc-recovery v0.1.0 epsilon derivation:{},{}",
                d["predecessor"].as_str().unwrap(),
                d["path"].as_str().unwrap()
            );
            let tweak: [u8; 32] = Sha3_256::digest(text.as_bytes()).into();
            let point = CompressedEdwardsY(root).decompress().expect("the root is a point")
                + ED25519_BASEPOINT_POINT * Scalar::from_bytes_mod_order(tweak);
            assert_eq!(sol_base58(&point.compress().to_bytes()), want, "{d}");
        }
    }

    /// The verdict crate's decoder and bs58 (through omni-transaction) agree on every accepted key of the fixture.
    #[test]
    fn sol_bytes_agrees_with_bs58() {
        let doc = vectors();
        for entry in doc["payee_keys"]["accept"].as_array().unwrap() {
            let key = entry["key"].as_str().unwrap();
            let addr = key.rsplit(':').next().unwrap();
            let ours = b58(addr);
            assert_eq!(SolanaAddress::from_base58(addr).unwrap().0, ours, "{key}");
            assert_eq!(sol_base58(&ours), addr);
            assert_eq!(sol_payee_bytes(key), ours);
        }
        assert!(sol_bytes("0").is_none());
        assert!(sol_bytes(&"1".repeat(33)).is_none());
    }

    #[test]
    fn sol_asset_ids() {
        for id in ["sol:devnet", "sol:testnet", "sol:mainnet"] {
            assert!(is_sol_asset(id), "{id}");
            assert!(crate::policy::valid_asset_id(id), "{id}");
        }
        for id in ["sol", "sol:", "sol:Devnet", "sol:devnet:native", "sol:localnet", "SOL:devnet"] {
            assert!(!is_sol_asset(id), "{id}");
            assert!(!crate::policy::valid_asset_id(id), "{id}");
        }
        assert_eq!(
            crate::keys::asset_for_payee_key(&format!("sol:devnet:{PAYEE_B58}")),
            "sol:devnet"
        );
        assert_eq!(
            crate::keys::asset_for_payee_key(&format!("sol:mainnet:{PAYEE_B58}")),
            "sol:mainnet"
        );
    }

    #[test]
    fn sol_response_parsing() {
        let sig: Vec<u8> = (0u8..64).collect();
        let ok = serde_json::json!({ "scheme": "Ed25519", "signature": sig }).to_string();
        assert_eq!(parse_ed25519_signature(ok.as_bytes()).unwrap().to_vec(), sig);
        // extra fields are ignored
        let extra = serde_json::json!({ "scheme": "Ed25519", "signature": sig, "x": 1 }).to_string();
        assert!(parse_ed25519_signature(extra.as_bytes()).is_ok());
        let long: Vec<u8> = (0u8..65).collect();
        for bad in [
            serde_json::json!({ "scheme": "Secp256k1", "signature": sig }).to_string(),
            serde_json::json!({ "scheme": "Ed25519", "signature": &sig[..63] }).to_string(),
            serde_json::json!({ "scheme": "Ed25519", "signature": long }).to_string(),
            serde_json::json!({ "scheme": "Ed25519", "signature": [256] }).to_string(),
            serde_json::json!({ "scheme": "Ed25519" }).to_string(),
            serde_json::json!({ "scheme": "Secp256k1", "big_r": { "affine_point": "02" }, "s": { "scalar": "01" }, "recovery_id": 0 }).to_string(),
            "not json".to_string(),
            r#"{"scheme":"Ed25519","scheme":"Ed25519","signature":[]}"#.to_string(),
        ] {
            assert!(parse_ed25519_signature(bad.as_bytes()).is_err(), "{bad}");
        }
    }

    // ---- the callback, in process ------------------------------------------------------------------------------------------------

    fn sender_key() -> SigningKey {
        SigningKey::from_bytes(&SENDER_SEED)
    }

    fn record(state: RequestState) -> RequestRecord {
        RequestRecord {
            agent: AGENT.parse().unwrap(),
            task_hash: [3; 32],
            task_id: "task-1".to_string(),
            index: 0,
            asset: ASSET.to_string(),
            payee: format!("sol:devnet:{PAYEE_B58}"),
            amount: 42,
            labels: Labels {
                recipient: 2,
                amount: 1,
                pc: 1,
            },
            evm: None,
            reason: None,
            state,
            retried: false,
            applied_charge: None,
            charge_day: 0,
            created_ms: 1_000,
            pending: None,
            exec: None,
        }
    }

    /// A contract with one stored record and the attempt `sign_sol` would have written (in flight).
    fn with_attempt(state: RequestState) -> (Contract, String, SolAttempt) {
        let mut c = fresh();
        let rec = record(state);
        let id = request_id(&rec.task_hash, rec.index);
        c.records.insert(id.clone(), rec);
        let sender = sender_key().verifying_key().to_bytes();
        let attempt = SolAttempt {
            sender,
            blockhash: b58(BLOCKHASH),
            message: build_sol_transfer(&sender, &b58(PAYEE_B58), 42, &b58(BLOCKHASH)),
            in_flight: true,
            signature: None,
        };
        let mut map = attempts();
        map.insert(id.clone(), attempt.clone());
        map.flush();
        (c, id, attempt)
    }

    fn callback(c: &mut Contract, id: &str, result: PromiseResult) {
        testing_env!(
            ctx(POLICY, 2_000, 0).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
        c.on_sol_signed(id.to_string());
    }

    fn response(signature: &[u8]) -> PromiseResult {
        PromiseResult::Successful(
            serde_json::json!({ "scheme": "Ed25519", "signature": signature })
                .to_string()
                .into_bytes(),
        )
    }

    fn event_names() -> Vec<String> {
        get_logs()
            .iter()
            .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
            .map(|json| {
                let v: serde_json::Value = serde_json::from_str(json).expect("an event parses");
                v["event"].as_str().expect("a name").to_string()
            })
            .collect()
    }

    #[test]
    fn sol_callback_stores_a_verifying_signature() {
        let (mut c, id, attempt) = with_attempt(RequestState::Executing);
        let sig = sender_key().sign(&attempt.message).to_bytes();
        callback(&mut c, &id, response(&sig));
        assert_eq!(c.records.get(&id).unwrap().state, RequestState::Executed);
        let stored = attempts().get(&id).cloned().unwrap();
        assert_eq!(stored.signature, Some(sig));
        assert!(!stored.in_flight);
        assert_eq!(event_names(), vec!["sol_signed"]);
        let line = get_logs().pop().unwrap();
        let v: serde_json::Value =
            serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(v["standard"], "airlock");
        assert_eq!(v["version"], "1.0.0");
        let data = &v["data"][0];
        assert_eq!(data["request_id"], id.as_str());
        assert_eq!(data["message_hex"], hex::encode(&attempt.message));
        assert_eq!(data["signature"], hex::encode(sig));
        assert_eq!(data.as_object().unwrap().len(), 3);
        // the view answers the same values
        let view = c.get_sol_attempt(id.clone()).unwrap();
        assert_eq!(view.signature_hex, Some(hex::encode(sig)));
        assert_eq!(view.blockhash, BLOCKHASH);
    }

    /// A signature by any other key, or over other bytes, does not verify: the request keeps its charges and is Failed, never Executed.
    #[test]
    fn sol_callback_refuses_a_signature_that_does_not_verify() {
        for wrong in [
            SigningKey::from_bytes(&[9; 32]).sign(b"x").to_bytes(),
            {
                let (_, _, attempt) = with_attempt(RequestState::Executing);
                SigningKey::from_bytes(&[9; 32]).sign(&attempt.message).to_bytes()
            },
            sender_key().sign(b"other bytes").to_bytes(),
            [0u8; 64],
        ] {
            let (mut c, id, _) = with_attempt(RequestState::Executing);
            callback(&mut c, &id, response(&wrong));
            let rec = c.records.get(&id).unwrap();
            assert_eq!(rec.state, RequestState::Failed);
            assert_eq!(rec.reason.as_deref(), Some("MpcBadResponse"));
            assert_eq!(event_names(), vec!["failed"]);
            let stored = attempts().get(&id).cloned().unwrap();
            assert_eq!(stored.signature, None);
            assert!(!stored.in_flight);
        }
    }

    #[test]
    fn sol_callback_failed_receipt_is_retryable() {
        let (mut c, id, _) = with_attempt(RequestState::Executing);
        callback(&mut c, &id, PromiseResult::Failed);
        let rec = c.records.get(&id).unwrap();
        assert_eq!(rec.state, RequestState::Retryable);
        assert_eq!(rec.reason.as_deref(), Some("MpcFailed"));
        assert_eq!(event_names(), vec!["failed"]);
        assert!(!attempts().get(&id).unwrap().in_flight);
    }

    #[test]
    fn sol_callback_garbage_keeps_charges() {
        let (mut c, id, _) = with_attempt(RequestState::Executing);
        callback(
            &mut c,
            &id,
            PromiseResult::Successful(b"{\"unexpected\":true}".to_vec()),
        );
        let rec = c.records.get(&id).unwrap();
        assert_eq!(rec.state, RequestState::Failed);
        assert_eq!(rec.reason.as_deref(), Some("MpcBadResponse"));
    }

    /// A duplicated or late callback on a record that is not Executing changes nothing and emits nothing.
    #[test]
    fn sol_callback_on_a_final_record_is_a_noop() {
        for state in [
            RequestState::Executed,
            RequestState::Failed,
            RequestState::Retryable,
            RequestState::Pending,
        ] {
            let (mut c, id, attempt) = with_attempt(state);
            let sig = sender_key().sign(&attempt.message).to_bytes();
            callback(&mut c, &id, response(&sig));
            assert_eq!(c.records.get(&id).unwrap().state, state);
            assert!(event_names().is_empty(), "{state:?}");
            assert_eq!(attempts().get(&id).unwrap().signature, None);
        }
        // an unknown id is a no-op too
        let mut c = fresh();
        callback(&mut c, "missing", PromiseResult::Failed);
        assert!(event_names().is_empty());
    }

    // ---- sign_sol refusals, in process ---------------------------------------------------------------------------------------------

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

    /// A contract with the Solana asset, its sender and one Executing record, called as the owner.
    fn ready() -> (Contract, String) {
        let mut c = fresh();
        c.asset_set(
            ASSET.to_string(),
            serde_json::from_value(serde_json::json!({
                "symbol": "SOL", "decimals": 9, "hard_cap": "1000000000", "daily_cap": "5000000000",
                "max_fee_per_gas": "0", "max_gas": "0", "quick_task_cap": "5000000000", "path": "sol-devnet-1"
            }))
            .unwrap(),
        );
        c.sol_sender_set(
            ASSET.to_string(),
            sol_base58(&sender_key().verifying_key().to_bytes()),
        );
        let rec = record(RequestState::Executing);
        let id = request_id(&rec.task_hash, rec.index);
        c.records.insert(id.clone(), rec);
        testing_env!(ctx(OWNER, 2_000, 0).build());
        (c, id)
    }

    #[test]
    fn sign_sol_records_one_message_and_refuses_a_second_call_in_flight() {
        let (mut c, id) = ready();
        let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
        let stored = attempts().get(&id).cloned().unwrap();
        let sender = sender_key().verifying_key().to_bytes();
        assert_eq!(
            stored.message,
            build_sol_transfer(&sender, &b58(PAYEE_B58), 42, &b58(BLOCKHASH))
        );
        assert!(stored.in_flight);
        assert_eq!(event_names(), vec!["sol_unsigned"]);
        let text = panic_text(|| {
            let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
        });
        assert!(text.contains("signing in flight"), "{text}");
    }

    /// After a failed signing the same message is signed again, whatever blockhash the second call names.
    #[test]
    fn sign_sol_retry_signs_the_stored_message() {
        let (mut c, id) = ready();
        let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
        let first = attempts().get(&id).cloned().unwrap();
        // the signer failed; the gate's retry made the record Executing again
        let mut map = attempts();
        let mut a = first.clone();
        a.in_flight = false;
        map.insert(id.clone(), a);
        map.flush();
        testing_env!(ctx(OWNER, 3_000, 0).build());
        let _ = c.sign_sol(id.clone(), "11111111111111111111111111111111".to_string());
        let second = attempts().get(&id).cloned().unwrap();
        assert_eq!(second.message, first.message);
        assert_eq!(second.blockhash, b58(BLOCKHASH));
    }

    #[test]
    fn sign_sol_refusals() {
        // a stranger
        let (mut c, id) = ready();
        testing_env!(ctx("stranger.test.near", 2_000, 0).build());
        let text = panic_text(|| {
            let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
        });
        assert!(text.contains("Agent not registered"), "{text}");
        // an unknown id
        let (mut c, _) = ready();
        let text = panic_text(|| {
            let _ = c.sign_sol("nope".to_string(), BLOCKHASH.to_string());
        });
        assert!(text.contains("unknown request"), "{text}");
        // a bad blockhash
        let (mut c, id) = ready();
        let text = panic_text(|| {
            let _ = c.sign_sol(id.clone(), "0".repeat(44));
        });
        assert!(text.contains("bad blockhash"), "{text}");
        // a record that is not Executing
        for state in [RequestState::Pending, RequestState::Blocked, RequestState::Executed] {
            let (mut c, id) = ready();
            let mut rec = c.records.get(&id).cloned().unwrap();
            rec.state = state;
            c.records.insert(id.clone(), rec);
            let text = panic_text(|| {
                let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
            });
            assert!(text.contains("request is not executing"), "{state:?}: {text}");
        }
        // an EVM or NEAR record
        let (mut c, id) = ready();
        let mut rec = c.records.get(&id).cloned().unwrap();
        rec.asset = "near".to_string();
        c.records.insert(id.clone(), rec);
        let text = panic_text(|| {
            let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
        });
        assert!(text.contains("not a solana request"), "{text}");
        // paused
        let (mut c, id) = ready();
        c.paused = true;
        let text = panic_text(|| {
            let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
        });
        assert!(text.contains("paused"), "{text}");
        // the payee is the sender, or the System program
        for payee in [
            sol_base58(&sender_key().verifying_key().to_bytes()),
            "11111111111111111111111111111111".to_string(),
        ] {
            let (mut c, id) = ready();
            let mut rec = c.records.get(&id).cloned().unwrap();
            rec.payee = format!("sol:devnet:{payee}");
            c.records.insert(id.clone(), rec);
            let text = panic_text(|| {
                let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
            });
            assert!(text.contains("payee is the"), "{text}");
        }
        // an amount above u64
        let (mut c, id) = ready();
        let mut rec = c.records.get(&id).cloned().unwrap();
        rec.amount = MAX_SOL_LAMPORTS + 1;
        c.records.insert(id.clone(), rec);
        let text = panic_text(|| {
            let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
        });
        assert!(text.contains("amount above u64"), "{text}");
        // no sender registered (another asset: the mocked storage of this thread keeps the sender of `sol:devnet` across `fresh()`)
        let mut c = fresh();
        c.asset_set(
            "sol:testnet".to_string(),
            serde_json::from_value(serde_json::json!({
                "symbol": "SOLT", "decimals": 9, "hard_cap": "1000000000", "daily_cap": "5000000000",
                "max_fee_per_gas": "0", "max_gas": "0", "quick_task_cap": "5000000000", "path": "sol-testnet-1"
            }))
            .unwrap(),
        );
        let mut rec = record(RequestState::Executing);
        rec.asset = "sol:testnet".to_string();
        rec.payee = format!("sol:testnet:{PAYEE_B58}");
        let id = request_id(&rec.task_hash, rec.index);
        c.records.insert(id.clone(), rec);
        testing_env!(ctx(OWNER, 2_000, 0).build());
        let text = panic_text(|| {
            let _ = c.sign_sol(id.clone(), BLOCKHASH.to_string());
        });
        assert!(text.contains("sol sender not set"), "{text}");
    }

    #[test]
    fn sol_asset_set_rules() {
        let entry = |hard: &str, path: serde_json::Value, fee: &str| {
            serde_json::from_value::<crate::policy::AssetEntryJson>(serde_json::json!({
                "symbol": "SOL", "decimals": 9, "hard_cap": hard, "daily_cap": u128::MAX.to_string(),
                "max_fee_per_gas": fee, "max_gas": "0", "quick_task_cap": "5000000000", "path": path
            }))
            .unwrap()
        };
        let cases: [(serde_json::Value, &str, &str, &str); 4] = [
            (serde_json::Value::Null, "1000", "0", "sol path required"),
            (serde_json::json!("Bad Path"), "1000", "0", "sol path invalid"),
            (serde_json::json!("sol-devnet-1"), "1000", "1", "fee and gas caps only for evm"),
            (
                serde_json::json!("sol-devnet-1"),
                "18446744073709551616",
                "0",
                "sol caps above u64",
            ),
        ];
        for (path, hard, fee, want) in cases {
            let mut c = fresh();
            let text = panic_text(|| c.asset_set(ASSET.to_string(), entry(hard, path.clone(), fee)));
            assert!(text.contains(want), "{want}: {text}");
        }
        // the largest u64 is allowed
        let mut c = fresh();
        c.asset_set(
            ASSET.to_string(),
            entry(&u64::MAX.to_string(), serde_json::json!("sol-devnet-1"), "0"),
        );
        // a second Solana asset, or an EVM asset, cannot take the same path
        let text = panic_text(|| {
            c.asset_set(
                "sol:mainnet".to_string(),
                serde_json::from_value(serde_json::json!({
                    "symbol": "SOLM", "decimals": 9, "hard_cap": "1000", "daily_cap": "1000",
                    "max_fee_per_gas": "0", "max_gas": "0", "quick_task_cap": "1000", "path": "sol-devnet-1"
                }))
                .unwrap(),
            )
        });
        assert!(text.contains("sol path already used"), "{text}");
        // the sender: only for a registered Solana asset, only 32 bytes of base58
        let text = panic_text(|| c.sol_sender_set("sol:mainnet".to_string(), PAYEE_B58.to_string()));
        assert!(text.contains("unknown sol asset"), "{text}");
        let text = panic_text(|| c.sol_sender_set(ASSET.to_string(), "1".repeat(31)));
        assert!(text.contains("bad sol sender"), "{text}");
        c.sol_sender_set(ASSET.to_string(), PAYEE_B58.to_string());
        assert_eq!(c.get_sol_sender(ASSET.to_string()).as_deref(), Some(PAYEE_B58));
        testing_env!(ctx(AGENT, 2_000, 1).build());
        let text = panic_text(|| c.sol_sender_set(ASSET.to_string(), PAYEE_B58.to_string()));
        assert!(text.contains("Caller is not the owner"), "{text}");
    }
}

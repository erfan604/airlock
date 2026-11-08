//! Mock of the Chain Signatures signer (`v1.signer-prod.testnet`, near/mpc 3.17.0) for sandbox tests. Test only, never deployed to a network.
//!
//! The interface (`sign({request: {path, payload_v2: {Ecdsa: <64 hex>}, domain_id: 0}})`, at least 1 yocto, at least 15 Tgas, the response
//! shape and the `Request has timed out.` text) follows near/mpc 3.17.0 `crates/contract/src/api/sign.rs` (MIT); the yield and resume
//! pattern follows near-sdk 5.26.1 `examples/mpc-contract` (MIT OR Apache-2.0). Modes: `ok`, `fail`, `garbage` (an unexpected object) and
//! `yield` (parks the request until `resume()`, or fails after 200 blocks).
//!
//! AIR-325: `Eddsa` payloads with domain 1 (hex, 1 to 1232 bytes, as the real signer) answer `{"scheme":"Ed25519","signature":[64 numbers]}`
//! in `ok` mode. The mock holds no key: the test computes the signature over the bytes it expects and hands it over first with
//! `set_ed25519_signature`; without one the answer is 64 bytes of 0x33, which verifies against no key. `fail` and `garbage` work as for
//! Ecdsa; `yield` is Ecdsa only.
use near_sdk::{
    Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, YieldId, env,
    near, require, serde_json,
};

const MIN_SIGN_GAS: Gas = Gas::from_tgas(15);
/// The longest Eddsa payload the real signer takes, in bytes (the Solana packet size).
const MAX_EDDSA_BYTES: usize = 1232;
const YIELD_CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
pub struct LastRequest {
    pub path: String,
    pub payload_hex: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    mode: String,
    last: Option<(String, String)>,
    calls: u64,
    pending: Vec<YieldId>,
    ed25519_signature: Option<Vec<u8>>,
}

fn ed25519_response(signature: &[u8]) -> serde_json::Value {
    serde_json::json!({ "scheme": "Ed25519", "signature": signature })
}

fn ok_response() -> serde_json::Value {
    let r = format!("02{}", "11".repeat(32));
    let s = "22".repeat(32);
    serde_json::json!({ "scheme": "Secp256k1", "big_r": { "affine_point": r }, "s": { "scalar": s }, "recovery_id": 0 })
}

#[near]
impl MockMpc {
    #[init]
    pub fn new() -> Self {
        Self {
            mode: "ok".to_string(),
            last: None,
            calls: 0,
            pending: Vec::new(),
            ed25519_signature: None,
        }
    }

    /// Test only, no access control: the 64-byte signature (128 hex characters) the next Eddsa `sign` answers in `ok` mode.
    pub fn set_ed25519_signature(&mut self, signature_hex: String) {
        let ok = signature_hex.len() == 128 && signature_hex.bytes().all(|b| b.is_ascii_hexdigit());
        require!(ok, "signature must be 64 bytes of hex");
        let bytes = (0..64)
            .map(|i| u8::from_str_radix(&signature_hex[2 * i..2 * i + 2], 16).unwrap_or(0))
            .collect();
        self.ed25519_signature = Some(bytes);
    }

    /// Test only, no access control.
    pub fn set_mode(&mut self, mode: String) {
        require!(
            ["ok", "fail", "garbage", "yield"].contains(&mode.as_str()),
            "unknown mode"
        );
        self.mode = mode;
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> PromiseOrValue<serde_json::Value> {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "Attached deposit is lower than required"
        );
        require!(
            env::prepaid_gas() >= MIN_SIGN_GAS,
            "Require at least 15 Tgas"
        );
        let payload_hex = match &request.payload_v2 {
            Payload::Ecdsa(h) => {
                require!(request.domain_id == 0, "Unknown domain");
                let ok = h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit());
                require!(ok, "Ecdsa payload must be exactly 32 bytes");
                h.clone()
            }
            Payload::Eddsa(h) => {
                require!(request.domain_id == 1, "Unknown domain");
                let ok = !h.is_empty()
                    && h.len() % 2 == 0
                    && h.len() <= 2 * MAX_EDDSA_BYTES
                    && h.bytes().all(|b| b.is_ascii_hexdigit());
                require!(ok, "Eddsa payload must be 1 to 1232 bytes of hex");
                h.clone()
            }
        };
        let eddsa = matches!(request.payload_v2, Payload::Eddsa(_));
        self.last = Some((request.path.clone(), payload_hex));
        self.calls += 1;
        match self.mode.as_str() {
            // the failure is a child receipt, not a panic of `sign`: a panic would roll back the count and the last request, and a
            // real signer that fails after receiving a request has still seen it (AIR-109: a retry must be shown to re-sign the same digest)
            "fail" => {
                PromiseOrValue::Promise(Promise::new(env::current_account_id()).function_call(
                    "fail_now",
                    Vec::new(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(2),
                ))
            }
            "garbage" => PromiseOrValue::Value(serde_json::json!({ "unexpected": true })),
            "yield" if eddsa => env::panic_str("yield mode is Ecdsa only"),
            "yield" => {
                let (promise, id) = Promise::new_yield(
                    "sign_on_finish",
                    Vec::<u8>::new(),
                    YIELD_CALLBACK_GAS,
                    GasWeight(0),
                );
                self.pending.push(id);
                PromiseOrValue::Promise(promise)
            }
            _ if eddsa => {
                let signature = self.ed25519_signature.clone().unwrap_or_else(|| vec![0x33; 64]);
                PromiseOrValue::Value(ed25519_response(&signature))
            }
            _ => PromiseOrValue::Value(ok_response()),
        }
    }

    /// Test only: the failing child receipt of `fail` mode.
    #[private]
    pub fn fail_now(&mut self) {
        env::panic_str("mock mpc failure")
    }

    /// Test only: answers the oldest parked `sign` that is still waiting (yield mode) with the `ok` response. A request that
    /// timed out keeps its id in `pending` (its timeout callback panics, which rolls back any cleanup), so skip dead ids.
    pub fn resume(&mut self) {
        require!(!self.pending.is_empty(), "no parked request");
        while !self.pending.is_empty() {
            let id = self.pending.remove(0);
            if id
                .resume(serde_json::to_vec(&ok_response()).unwrap_or_default())
                .is_ok()
            {
                return;
            }
        }
        env::panic_str("yield not found");
    }

    #[private]
    pub fn sign_on_finish(&mut self) -> serde_json::Value {
        match env::promise_result_checked(0, 1024) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| env::panic_str("bad resume payload")),
            Err(PromiseError::Failed) | Err(_) => env::panic_str("Request has timed out."),
        }
    }

    pub fn last_request(&self) -> Option<LastRequest> {
        self.last.as_ref().map(|(p, h)| LastRequest {
            path: p.clone(),
            payload_hex: h.clone(),
        })
    }

    pub fn call_count(&self) -> u64 {
        self.calls
    }

    pub fn mode(&self) -> String {
        self.mode.clone()
    }

    pub fn version(&self) -> String {
        "mock-3.17.0".to_string()
    }

    /// counts timed-out ids too, until a resume() skips them
    pub fn parked(&self) -> u64 {
        self.pending.len() as u64
    }
}

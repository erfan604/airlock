// AIR-100: the EVM lane. An Executing record (an Allow, or an approved escalation) becomes an EIP-1559 transaction built inside the
// contract from the stored request and the registry, its keccak256 hash goes to the MPC signer, and `on_signed` (AIR-105) stores and
// announces the signature. Nothing the agent sent selects the path, the chain or the nonce, and one request id maps to at most one
// (path, nonce, bytes) triple (`evm_attempts`, AIR-104), so a retry re-signs the identical bytes and never makes a second transaction.
//
// Placement (security): `start_execution` and `start_evm` live in a plain `impl Contract`, so neither is an exported method
// (`tests/exec_evm.rs::exec_helpers_not_exported`). The module is `pub` and every helper is `pub` (see lib.rs).
// AIR-101 adds the NEAR lane in the same module (`start_near`, `near_payment_fits`, `on_transfer`): the reserve is checked before the
// transfer promise exists, a payment that does not fit is a refunded `InsufficientBalance` failure, and `on_transfer` marks the record
// `Executed` and emits `paid`, or refunds through `fail_request` (`TransferFailed`). `env::storage_usage()` does not count buffered
// writes, so the one NEAR margin covers the batch's own growth (`tests/exec_near.rs::reserve_margin_covers_batch_storage_growth`).
use crate::callback::FailReason;
use crate::nonces::EvmAttempt;
use crate::request::{ExecInfo, RequestState};
use crate::*;
use near_sdk::ext_contract;
use omni_transaction::{
    TxBuilder,
    evm::{EVMTransaction, EVMTransactionBuilder},
};
use std::str::FromStr;

/// The signer requires at least 15 Tgas prepaid (live config); the template uses exactly 15.
pub const GAS_MPC_SIGN: Gas = Gas::from_tgas(15);
pub const GAS_ON_SIGNED: Gas = Gas::from_tgas(20);
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

/// Wire shape of the signer's argument: `{"request":{"path","payload_v2":{"Ecdsa":"<64 hex>"},"domain_id":0}}`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

/// The signer's interface; the parameter name `request` is the JSON key.
#[ext_contract(mpc)]
pub trait Mpc {
    fn sign(&mut self, request: SignRequest);
}

/// The unsigned EIP-1559 payload: `0x02` followed by the RLP list (empty data, empty access list). omni-transaction 0.5.0 takes the value,
/// the gas and the fees as `u128` and `to` as 20 bytes.
pub fn build_evm_unsigned(
    chain_id: u64,
    nonce: u64,
    to: [u8; 20],
    value: u128,
    gas_limit: u128,
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
) -> Vec<u8> {
    let tx: EVMTransaction = EVMTransactionBuilder::new()
        .chain_id(chain_id)
        .nonce(nonce)
        .to(to)
        .value(value)
        .input(vec![])
        .gas_limit(gas_limit)
        .max_fee_per_gas(max_fee_per_gas)
        .max_priority_fee_per_gas(max_priority_fee_per_gas)
        .build();
    tx.build_for_signing()
}

/// The decimal chain id of `evm:<chain_id>:native` (the registry grammar guarantees it parses).
pub fn evm_chain_id(asset_id: &str) -> u64 {
    asset_id
        .split(':')
        .nth(1)
        .and_then(|part| part.parse().ok())
        .unwrap_or_else(|| env::panic_str("bad evm asset id"))
}

/// The 20 bytes of `evm:<chain_id>:0x<40 lowercase hex>`: its last 40 hex digits.
pub fn evm_to_address(payee_key: &str) -> [u8; 20] {
    let digits = payee_key
        .len()
        .checked_sub(40)
        .and_then(|from| payee_key.get(from..))
        .unwrap_or_else(|| env::panic_str("bad evm payee key"));
    let mut to = [0u8; 20];
    hex::decode_to_slice(digits, &mut to).unwrap_or_else(|_| env::panic_str("bad evm payee key"));
    to
}

impl Contract {
    /// The seam to the execution lanes (AIR-061): turns an `Executing` record into signing (EVM) or a transfer (NEAR, AIR-101) and
    /// returns the promise, which the caller detaches after every charge of its call is made. `evm:` assets go to `start_evm`, `near:`
    /// payees to `start_near`; any other key gets no promise. Plain `impl`: never exported.
    pub fn start_execution(&mut self, id: &str) -> Option<Promise> {
        let Some((asset, payee)) = self
            .records
            .get(id)
            .filter(|rec| rec.state == RequestState::Executing)
            .map(|rec| (rec.asset.clone(), rec.payee.clone()))
        else {
            env::panic_str("request is not executing")
        };
        if asset.starts_with("evm:") {
            return Some(self.start_evm(id));
        }
        match payee.split_once(':').map(|(lane, _)| lane) {
            Some("near") => self.start_near(id),
            _ => None,
        }
    }

    /// Builds (or, on a retry, rebuilds and checks) the transaction of an Executing EVM request, records and announces its bytes, and
    /// asks the signer to sign their hash, with `on_signed` as the callback. Everything comes from the stored record and the registry.
    /// A panic reverts the whole `submit_batch` (charges included) or leaves the escalation Pending (`approve`).
    pub fn start_evm(&mut self, id: &str) -> Promise {
        let mut rec = match self.records.get(id) {
            Some(rec) if rec.state == RequestState::Executing => rec.clone(),
            _ => env::panic_str("unexpected state"),
        };
        let asset = self
            .asset(&rec.asset)
            .unwrap_or_else(|| env::panic_str("unknown asset"));
        let path = asset
            .path
            .unwrap_or_else(|| env::panic_str("evm path missing"));
        let evm = rec
            .evm
            .unwrap_or_else(|| env::panic_str("evm params missing"));
        let build = |nonce: u64| {
            build_evm_unsigned(
                evm_chain_id(&rec.asset),
                nonce,
                evm_to_address(&rec.payee),
                rec.amount,
                evm.gas_limit.0,
                evm.max_fee_per_gas.0,
                evm.max_priority_fee_per_gas.0,
            )
        };
        let (bytes, unsigned_hex) = match self.attempt_of(id) {
            Some(attempt) => {
                // a retry: the first attempt's bytes are signed again, no new nonce is taken
                require!(attempt.path == path, "signing path changed");
                let rebuilt = build(attempt.nonce);
                require!(
                    hex::decode(&attempt.unsigned_hex).is_ok_and(|stored| stored == rebuilt),
                    "stored attempt does not match request"
                );
                (rebuilt, attempt.unsigned_hex)
            }
            None => {
                let nonce = self.next_nonce(&path);
                let bytes = build(nonce);
                let unsigned_hex = hex::encode(&bytes);
                self.record_attempt(
                    id,
                    EvmAttempt {
                        path: path.clone(),
                        nonce,
                        unsigned_hex: unsigned_hex.clone(),
                    },
                );
                (bytes, unsigned_hex)
            }
        };
        rec.exec = Some(ExecInfo {
            unsigned_hex: Some(unsigned_hex.clone()),
            ..ExecInfo::default()
        });
        self.records.insert(id.to_string(), rec);
        Event::EvmUnsigned {
            request_id: id,
            unsigned_hex: &unsigned_hex,
        }
        .emit();
        let hash: [u8; 32] = env::keccak256_array(&bytes);
        // `with_unused_gas_weight(0)`: the signer receives exactly GAS_MPC_SIGN, so AIR-107's reserved figure is exact
        mpc::ext(self.mpc_contract_id.clone())
            .with_static_gas(GAS_MPC_SIGN)
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_unused_gas_weight(0)
            .sign(SignRequest {
                path,
                payload_v2: Payload::Ecdsa(hex::encode(hash)),
                domain_id: 0,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SIGNED)
                    .on_signed(id.to_string(), unsigned_hex),
            )
    }
}

/// Gas reserved for `on_transfer` (it reads one promise result, rewrites one record and logs one event).
pub const GAS_ON_TRANSFER: Gas = Gas::from_tgas(5);

/// What must stay on the account after a payment, on top of its storage stake: one NEAR, in yocto. Written with the typed constant:
/// `10^24` in Rust is XOR (18), which default clippy does not flag (`#![deny(clippy::suspicious_xor_used_as_pow)]` in lib.rs does).
pub const NEAR_RESERVE_MARGIN: u128 = NearToken::from_near(1).as_yoctonear();

/// The longest promise result `on_transfer` reads. A successful transfer returns an empty value (measured).
const MAX_TRANSFER_RESULT: usize = 16;

/// Whether the account can pay `amount` and still hold its storage stake plus `NEAR_RESERVE_MARGIN`: `balance - amount` must exist and be
/// at least `storage_usage * byte_cost + NEAR_RESERVE_MARGIN`. All arithmetic is checked, an overflow is `false`. A pure function so the
/// reserve rule has table tests.
pub fn near_payment_fits(balance: u128, amount: u128, storage_usage: u64, byte_cost: u128) -> bool {
    let Some(left) = balance.checked_sub(amount) else {
        return false;
    };
    let Some(stake) = u128::from(storage_usage).checked_mul(byte_cost) else {
        return false;
    };
    let Some(needed) = stake.checked_add(NEAR_RESERVE_MARGIN) else {
        return false;
    };
    left >= needed
}

impl Contract {
    /// The NEAR lane of `start_execution`: the transfer of an `Executing` record's amount to its payee, with `on_transfer` as the
    /// callback. When the payment does not fit (`near_payment_fits` on the live balance) the request fails with `InsufficientBalance`
    /// (refund, `Retryable` once, then `Failed`; event `failed`) and no promise is returned. Plain `impl`: never exported.
    pub fn start_near(&mut self, id: &str) -> Option<Promise> {
        let rec = self.records.get(id).cloned();
        let Some(rec) = rec.filter(|r| r.state == RequestState::Executing) else {
            env::panic_str("unexpected state");
        };
        let account = rec
            .payee
            .strip_prefix("near:")
            .and_then(|name| AccountId::from_str(name).ok())
            .unwrap_or_else(|| env::panic_str("unexpected payee"));
        if !near_payment_fits(
            env::account_balance().as_yoctonear(),
            rec.amount,
            env::storage_usage(),
            env::storage_byte_cost().as_yoctonear(),
        ) {
            self.fail_request(id, FailReason::InsufficientBalance);
            return None;
        }
        Some(
            Promise::new(account)
                .transfer(NearToken::from_yoctonear(rec.amount))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_TRANSFER)
                        .on_transfer(id.to_string()),
                ),
        )
    }
}

#[near]
impl Contract {
    /// The callback of the NEAR transfer. A successful receipt on an `Executing` record makes it `Executed` and emits `paid`; a failed
    /// receipt (for example `AccountDoesNotExist`, the amount went back to the contract) is `TransferFailed` through `fail_request`,
    /// which refunds. A record that is not `Executing` (a duplicated or late callback) is left alone and emits nothing. Never panics on
    /// the result: a panic here would roll the state back.
    #[private]
    pub fn on_transfer(&mut self, request_id: String) {
        match env::promise_result_checked(0, MAX_TRANSFER_RESULT) {
            Ok(_) => {
                let Some(mut rec) = self.records.get(&request_id).cloned() else {
                    return;
                };
                if rec.state != RequestState::Executing {
                    return;
                }
                rec.state = RequestState::Executed;
                let (payee, amount) = (rec.payee.clone(), rec.amount);
                self.records.insert(request_id.clone(), rec);
                Event::Paid {
                    request_id: &request_id,
                    payee: &payee,
                    amount: amount.to_string(),
                }
                .emit();
            }
            Err(_) => self.fail_request(&request_id, FailReason::TransferFailed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY1: &str = "02f183014a3480843b9aca00847735940082520894d8da6bf26964af9d7eed9e03e53415d37aa96045872386f26fc1000080c0";

    fn addr(byte: u8) -> [u8; 20] {
        [byte; 20]
    }

    #[test]
    fn exec_preimage_vector_day1() {
        let to = evm_to_address("evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
        let bytes = build_evm_unsigned(
            84532,
            0,
            to,
            10u128.pow(16),
            21_000,
            2_000_000_000,
            1_000_000_000,
        );
        assert_eq!(hex::encode(bytes), DAY1);
    }

    #[test]
    fn exec_preimage_vector_small() {
        let bytes = build_evm_unsigned(
            84532,
            7,
            addr(0x11),
            10u128.pow(13),
            21_000,
            1_000_000_000,
            1_000_000,
        );
        assert_eq!(
            hex::encode(bytes),
            "02ef83014a3407830f4240843b9aca008252089411111111111111111111111111111111111111118609184e72a00080c0"
        );
        let bytes = build_evm_unsigned(1, 0, addr(0xab), 0, 21_000, 1, 0);
        assert_eq!(
            hex::encode(bytes),
            "02df0180800182520894abababababababababababababababababababab8080c0"
        );
    }

    #[test]
    fn exec_preimage_extremes() {
        let bytes = build_evm_unsigned(
            u64::MAX,
            u64::MAX,
            [0; 20],
            u128::MAX,
            u128::MAX,
            u128::MAX,
            u128::MAX,
        );
        assert_eq!(
            hex::encode(bytes),
            "02f86d88ffffffffffffffff88ffffffffffffffff90ffffffffffffffffffffffffffffffff90ffffffffffffffffffffffffffffffff90ffffffffffffffffffffffffffffffff94000000000000000000000000000000000000000090ffffffffffffffffffffffffffffffff80c0"
        );
    }

    #[test]
    fn exec_evm_chain_id() {
        assert_eq!(evm_chain_id("evm:84532:native"), 84532);
        assert_eq!(evm_chain_id("evm:1:native"), 1);
    }

    #[test]
    fn exec_evm_to_address() {
        let to = evm_to_address("evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
        assert_eq!(hex::encode(to), "d8da6bf26964af9d7eed9e03e53415d37aa96045");
        let to = evm_to_address("evm:1:0xabababababababababababababababababababab");
        assert_eq!(to, addr(0xab));
    }
}

#[cfg(test)]
mod near_tests {
    use super::*;
    use crate::request::{Labels, RequestRecord, request_id};
    use crate::testutil::{POLICY, ctx, fresh};
    use near_sdk::test_utils::get_logs;
    use near_sdk::{PromiseResult, testing_env};

    const ONE: u128 = 1_000_000_000_000_000_000_000_000;
    const BYTE: u128 = 10_000_000_000_000_000_000;
    const PAYEE: &str = "near:alice.test.near";

    #[test]
    fn exec_near_reserve_table() {
        let usage = 100_000u64;
        let stake = u128::from(usage) * BYTE;
        let amount = 5 * ONE;
        let exact = amount + stake + NEAR_RESERVE_MARGIN;
        assert!(near_payment_fits(exact, amount, usage, BYTE));
        assert!(!near_payment_fits(exact - 1, amount, usage, BYTE));
        assert!(near_payment_fits(exact + 1, amount, usage, BYTE));
        assert!(!near_payment_fits(amount - 1, amount, usage, BYTE));
        assert!(!near_payment_fits(100 * ONE, u128::MAX, usage, BYTE));
        assert!(!near_payment_fits(u128::MAX, u128::MAX, usage, BYTE));
        // storage_usage times byte_cost overflows u128: false, never wrapped into a small stake
        assert!(!near_payment_fits(u128::MAX, 0, u64::MAX, u128::MAX));
        // the stake plus the margin overflows u128
        assert!(!near_payment_fits(u128::MAX, 0, 1, u128::MAX));
        assert!(near_payment_fits(
            stake + NEAR_RESERVE_MARGIN,
            0,
            usage,
            BYTE
        ));
    }

    #[test]
    fn exec_near_reserve_margin_is_one_near() {
        assert_eq!(NEAR_RESERVE_MARGIN, 1_000_000_000_000_000_000_000_000);
        assert_eq!(
            NearToken::from_yoctonear(NEAR_RESERVE_MARGIN),
            NearToken::from_near(1)
        );
        assert_ne!(NEAR_RESERVE_MARGIN, 18);
    }

    fn record(state: RequestState, retried: bool) -> RequestRecord {
        RequestRecord {
            agent: "agent.test.near".parse().unwrap(),
            task_hash: [1; 32],
            task_id: "task-1".to_string(),
            index: 0,
            asset: "near".to_string(),
            payee: PAYEE.to_string(),
            amount: 7 * ONE,
            labels: Labels {
                recipient: 2,
                amount: 1,
                pc: 1,
            },
            evm: None,
            reason: None,
            state,
            retried,
            applied_charge: None,
            charge_day: 0,
            created_ms: 1_000,
            pending: None,
            exec: None,
        }
    }

    fn stored(c: &mut Contract, rec: RequestRecord) -> String {
        let id = request_id(&rec.task_hash, rec.index);
        c.records.insert(id.clone(), rec);
        id
    }

    fn callback(c: &mut Contract, id: &str, result: PromiseResult) {
        testing_env!(
            ctx(POLICY, 2_000, 0).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
        c.on_transfer(id.to_string());
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
    fn exec_near_on_transfer_success_marks_executed_and_emits_paid() {
        let mut c = fresh();
        let id = stored(&mut c, record(RequestState::Executing, false));
        callback(&mut c, &id, PromiseResult::Successful(vec![]));
        assert_eq!(c.records.get(&id).unwrap().state, RequestState::Executed);
        assert_eq!(event_names(), vec!["paid"]);
        let line = get_logs().pop().unwrap();
        let v: serde_json::Value =
            serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        let data = &v["data"][0];
        assert_eq!(data["request_id"], id.as_str());
        assert_eq!(data["payee"], PAYEE);
        assert_eq!(data["amount"], (7 * ONE).to_string());
        assert_eq!(data.as_object().unwrap().len(), 3);
    }

    #[test]
    fn exec_near_on_transfer_duplicate_is_noop() {
        let mut c = fresh();
        let id = stored(&mut c, record(RequestState::Executing, false));
        callback(&mut c, &id, PromiseResult::Successful(vec![]));
        callback(&mut c, &id, PromiseResult::Successful(vec![]));
        assert_eq!(c.records.get(&id).unwrap().state, RequestState::Executed);
        assert!(event_names().is_empty());
        callback(&mut c, &id, PromiseResult::Failed);
        assert_eq!(c.records.get(&id).unwrap().state, RequestState::Executed);
        assert!(event_names().is_empty());
    }

    #[test]
    fn exec_near_on_transfer_non_executing_is_noop() {
        for state in [
            RequestState::Executed,
            RequestState::Failed,
            RequestState::Retryable,
            RequestState::Pending,
        ] {
            for result in [PromiseResult::Successful(vec![]), PromiseResult::Failed] {
                let mut c = fresh();
                let id = stored(&mut c, record(state, false));
                callback(&mut c, &id, result);
                assert_eq!(c.records.get(&id).unwrap().state, state);
                assert!(event_names().is_empty(), "{state:?}");
            }
        }
        // an unknown id is a no-op too
        let mut c = fresh();
        callback(&mut c, "missing", PromiseResult::Successful(vec![]));
        assert!(event_names().is_empty());
    }

    #[test]
    fn exec_near_on_transfer_failed_calls_fail_request() {
        let mut c = fresh();
        let id = stored(&mut c, record(RequestState::Executing, false));
        callback(&mut c, &id, PromiseResult::Failed);
        let rec = c.records.get(&id).unwrap();
        assert_eq!(rec.state, RequestState::Retryable);
        assert_eq!(rec.reason.as_deref(), Some("TransferFailed"));
        assert_eq!(event_names(), vec!["failed"]);
        // a retried request ends Failed
        let mut c = fresh();
        let id = stored(&mut c, record(RequestState::Executing, true));
        callback(&mut c, &id, PromiseResult::Failed);
        assert_eq!(c.records.get(&id).unwrap().state, RequestState::Failed);
    }
}

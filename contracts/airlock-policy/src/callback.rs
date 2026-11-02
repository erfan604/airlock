//! AIR-105: what happens when the MPC answers, and the two ways an execution fails. `on_signed` stores and announces a signature. When
//! the signer's receipt failed, no signature can exist, so `fail_request` refunds exactly what the request charged and marks it
//! `Retryable` (once) or `Failed`. When the signer's receipt succeeded but its answer is unusable, a signature may still exist (the value
//! of a successful receipt is public in the transaction outcome and can be broadcast), so `fail_kept_charged` keeps every charge and marks
//! the request `Failed`, never `Retryable` (a retry would ask for a second signature). `fail_request` is the only refunding path for both
//! lanes: AIR-101's `on_transfer` calls it too, for `TransferFailed` and `InsufficientBalance`.
//!
//! Pinned behaviour (SPEC R5-07, F05 L4, F06 section 3.1; verified on near-sdk 5.26.1):
//!  - money fails closed: the ledgers are released only when no signature and no payment can exist (`FailReason::refunds`). A signer
//!    interface change that made every answer unparseable must cost a request its budget, never let its signature be spent twice;
//!  - the response is read with `env::promise_result_checked(0, MAX_MPC_RESPONSE)` and parsed by hand, never with `#[callback_result]` and
//!    a typed result: a payload that fails to deserialize would panic the callback and roll the state back. `env::promise_result`
//!    is `#[deprecated]` and `clippy -D warnings` rejects it;
//!  - the record is the idempotency guard: only a record in state `Executing` is ever changed, so a duplicated or late callback, and a
//!    callback for a record that is already final, do nothing and emit nothing (a second refund is impossible);
//!  - the refund runs before the state changes (`refund` is a no-op unless the state is still `Executing`);
//!  - the EVM nonce is not given back: a retry of an EVM request re-signs the first attempt's identical bytes (AIR-100), so no second
//!    transaction can come out of one request id;
//!  - if a callback ever runs out of gas the record stays `Executing` and charged: no owner method clears it in this version (see
//!    docs/KNOWN_LIMITATIONS.md; AIR-107 measures the real burn).
use crate::request::{ExecInfo, RequestState};
use crate::*;
use near_sdk::PromiseError;

/// The longest MPC response `on_signed` reads, in bytes. A real response is about 215 bytes; a longer one is `MpcBadResponse` (the
/// request keeps its charges and is `Failed`).
pub const MAX_MPC_RESPONSE: usize = 1024;

/// The highest `recovery_id` of an EVM signature: EIP-1559 `yParity` is 0 or 1, while nearcore's `ecrecover` (and the signer) accept 0 to 3.
pub const MAX_EVM_RECOVERY_ID: u8 = 1;

/// Why an execution failed: the strings of the `failed` event and of `RequestRecord.reason` (GLOSSARY).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailReason {
    /// The signer's receipt failed (a rejection, a missing domain, too little gas, or the 200 block timeout).
    MpcFailed,
    /// The signer's receipt succeeded, but its answer is not a usable secp256k1 signature (it does not parse, it is too long, or an EVM
    /// `recovery_id` is above `MAX_EVM_RECOVERY_ID`). A signature may still exist, so this reason never refunds.
    MpcBadResponse,
    /// The NEAR transfer failed (AIR-101).
    TransferFailed,
    /// The contract could not cover the payment (AIR-101).
    InsufficientBalance,
}

impl FailReason {
    /// The variant name.
    pub fn as_str(&self) -> &'static str {
        match self {
            FailReason::MpcFailed => "MpcFailed",
            FailReason::MpcBadResponse => "MpcBadResponse",
            FailReason::TransferFailed => "TransferFailed",
            FailReason::InsufficientBalance => "InsufficientBalance",
        }
    }

    /// Whether the failure may release the request's ledger charges: only when no signature and no payment can exist. `MpcBadResponse`
    /// does not: the signer's receipt succeeded, so whatever signature it holds is public and may still be broadcast. The match has no
    /// wildcard, so a new reason must decide.
    pub fn refunds(&self) -> bool {
        match self {
            FailReason::MpcFailed
            | FailReason::TransferFailed
            | FailReason::InsufficientBalance => true,
            FailReason::MpcBadResponse => false,
        }
    }
}

#[near(serializers = [json])]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

/// The signer's answer, `{"scheme":"Secp256k1","big_r":{"affine_point":"02.."},"s":{"scalar":".."},"recovery_id":0}` (near/mpc 3.17.0). serde
/// ignores unknown extra fields and rejects a duplicate key, a missing field and a `recovery_id` above 255. An `Ed25519` answer has no
/// `big_r`, so it does not parse.
#[near(serializers = [json])]
pub struct SignatureResponse {
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

/// A checked signature: `big_r` is 66 lowercase hex characters (a compressed point), `s` 64, `recovery_id` 0 to 3.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSignature {
    pub big_r: String,
    pub s: String,
    pub recovery_id: u8,
}

/// Exactly `len` hex digits, either case.
fn is_hex_of(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parses and checks the signer's answer; the error is the text of the first check that fails (`bad scheme`, `bad big_r`, `bad s`,
/// `bad recovery_id`, or the serde error). Fails closed: the caller turns any error into `fail_kept_charged` (the request keeps its
/// charges and is `Failed`).
pub fn parse_signature(bytes: &[u8]) -> Result<ParsedSignature, String> {
    let response: SignatureResponse =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if response.scheme != "Secp256k1" {
        return Err("bad scheme".to_string());
    }
    let big_r = response.big_r.affine_point.to_ascii_lowercase();
    if !is_hex_of(&big_r, 66) || !(big_r.starts_with("02") || big_r.starts_with("03")) {
        return Err("bad big_r".to_string());
    }
    let s = response.s.scalar.to_ascii_lowercase();
    if !is_hex_of(&s, 64) || s.bytes().all(|b| b == b'0') {
        return Err("bad s".to_string());
    }
    if response.recovery_id > 3 {
        return Err("bad recovery_id".to_string());
    }
    Ok(ParsedSignature {
        big_r,
        s,
        recovery_id: response.recovery_id,
    })
}

impl Contract {
    /// The one refunding path of both lanes, for a failure after which no signature and no payment can exist: `MpcFailed` (the signer's
    /// receipt failed), `TransferFailed` and `InsufficientBalance`. A missing record, or one whose state is not `Executing`, is left
    /// alone and emits nothing, so a duplicated or late callback cannot refund twice. Otherwise: refund what the request charged
    /// (`refund`, which must run before the state changes), then `Retryable` when the request has not been retried (`retried` is false)
    /// and `Failed` when it has, with `reason` replacing the record's reason (the escalation reason of an approved request survives in the
    /// `approved` event and in the stored digest), then the `failed` event. A reason that does not refund (`MpcBadResponse`) is sent to
    /// `fail_kept_charged`, so no caller can reopen the double spend by passing the wrong reason. Plain `impl`: never exported.
    pub fn fail_request(&mut self, id: &str, reason: FailReason) {
        if !reason.refunds() {
            self.fail_kept_charged(id, reason);
            return;
        }
        let Some(mut rec) = self.records.get(id).cloned() else {
            return;
        };
        if rec.state != RequestState::Executing {
            return;
        }
        self.refund(&rec);
        let retryable = !rec.retried;
        rec.state = if retryable {
            RequestState::Retryable
        } else {
            RequestState::Failed
        };
        rec.reason = Some(reason.as_str().to_string());
        self.records.insert(id.to_string(), rec);
        Event::Failed {
            request_id: id,
            reason: reason.as_str(),
            retryable,
        }
        .emit();
    }

    /// The failure after which a signature may still exist: the signer's receipt succeeded, but its answer is unusable. Every ledger keeps
    /// its charge (nothing is refunded: the answer is public in the transaction outcome, so any signature in it can still be broadcast),
    /// the record becomes `Failed`, never `Retryable` (a retry would ask for a second signature), `reason` replaces the record's reason,
    /// and `failed` is emitted with `retryable` false, so the owner can see it. The same idempotency guard as `fail_request`: a missing
    /// record, or one whose state is not `Executing`, is left alone and emits nothing. Plain `impl`: never exported.
    pub fn fail_kept_charged(&mut self, id: &str, reason: FailReason) {
        let Some(mut rec) = self.records.get(id).cloned() else {
            return;
        };
        if rec.state != RequestState::Executing {
            return;
        }
        rec.state = RequestState::Failed;
        rec.reason = Some(reason.as_str().to_string());
        self.records.insert(id.to_string(), rec);
        Event::Failed {
            request_id: id,
            reason: reason.as_str(),
            retryable: false,
        }
        .emit();
    }

    /// Stores a checked signature on an `Executing` record (state `Executed`, `exec` with the unsigned transaction and the signature) and
    /// emits `signed`; on any other state it does nothing. In the EVM lane (`rec.evm` is `Some`) a `recovery_id` above
    /// `MAX_EVM_RECOVERY_ID` cannot be assembled into a transaction by the runtime, but the signature is public in the signer's outcome
    /// and may still be used, so the request keeps its charges and is `Failed` with `MpcBadResponse` (`fail_kept_charged`). Plain
    /// `impl`: never exported.
    pub fn store_signature(&mut self, id: &str, unsigned_hex: String, sig: ParsedSignature) {
        let Some(mut rec) = self.records.get(id).cloned() else {
            return;
        };
        if rec.state != RequestState::Executing {
            return;
        }
        if rec.evm.is_some() && sig.recovery_id > MAX_EVM_RECOVERY_ID {
            self.fail_kept_charged(id, FailReason::MpcBadResponse);
            return;
        }
        Event::Signed {
            request_id: id,
            unsigned_hex: &unsigned_hex,
            big_r: &sig.big_r,
            s: &sig.s,
            recovery_id: sig.recovery_id,
        }
        .emit();
        rec.exec = Some(ExecInfo {
            unsigned_hex: Some(unsigned_hex),
            big_r: Some(sig.big_r),
            s: Some(sig.s),
            recovery_id: Some(sig.recovery_id),
        });
        rec.state = RequestState::Executed;
        self.records.insert(id.to_string(), rec);
    }
}

#[near]
impl Contract {
    /// The callback of the MPC `sign` call (AIR-100 attaches it with the request id and the hex of the unsigned transaction).
    /// - A failed receipt (`PromiseError::Failed`: a rejection, or the 200 block timeout) means no signature can exist: `MpcFailed`
    ///   through `fail_request`, which refunds and marks the request `Retryable` (once) or `Failed`.
    /// - A receipt that succeeded with an answer the contract cannot use (bytes that do not parse, `PromiseError::TooLong`, any other
    ///   promise error) may still hold a signature, which is public in the transaction outcome: `MpcBadResponse` through
    ///   `fail_kept_charged`, which keeps every charge and marks the request `Failed`.
    /// - A good signature on an `Executing` record is stored (`store_signature`).
    ///
    /// Never panics on a payload: a panic here would roll the state back.
    #[private]
    pub fn on_signed(&mut self, request_id: String, unsigned_hex: String) {
        let outcome = match env::promise_result_checked(0, MAX_MPC_RESPONSE) {
            Ok(bytes) => parse_signature(&bytes).map_err(|_| FailReason::MpcBadResponse),
            Err(PromiseError::Failed) => Err(FailReason::MpcFailed),
            Err(PromiseError::TooLong(_)) => Err(FailReason::MpcBadResponse),
            // `PromiseError` is `#[non_exhaustive]`: a match without a final arm does not compile
            Err(_) => Err(FailReason::MpcBadResponse),
        };
        match outcome {
            Ok(sig) => self.store_signature(&request_id, unsigned_hex, sig),
            Err(reason) if reason.refunds() => self.fail_request(&request_id, reason),
            Err(reason) => self.fail_kept_charged(&request_id, reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledgers::{DayValue, LedgerKey, approval_caps, caps_for};
    use crate::policy::{AssetEntry, BookEntry};
    use crate::request::{
        ChargeRec, EvmParams, Hex32, Labels, PendingInfo, RequestRecord, RequestState, request_id,
    };
    use crate::testutil::{POLICY, ctx, fresh};
    use crate::time::{MS_PER_DAY, utc_day};
    use airlock_verdict::ledger::{Caps, Spent};
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::get_logs;
    use near_sdk::{PromiseResult, testing_env};
    use serde_json::Value;

    const PAYEE: &str = "near:alice.test.near";
    /// UTC day 10, one hour in: every charge below is made here unless a test says otherwise.
    const T0: u64 = 10 * MS_PER_DAY + 3_600_000;
    /// The `unsigned_hex` the lane passes to the callback (the real value is a type 2 transaction).
    const UNSIGNED: &str =
        "02f86a83014a3401843b9aca00843b9aca0082520894d8da6bf26964af9d7eed9e03e53415d3";
    /// The real response of the live signer (AIR-272), copied into tests/fixtures.
    const REAL: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mpc_sig_real.json"
    ));

    fn asset_entry() -> AssetEntry {
        AssetEntry {
            symbol: "NEAR".to_string(),
            decimals: 24,
            hard_cap: 10_000,
            daily_cap: 100_000,
            max_fee_per_gas: 0,
            max_gas: 0,
            quick_task_cap: 100_000,
            path: None,
        }
    }

    fn book_entry() -> BookEntry {
        BookEntry {
            cap: Some(100),
            daily_untrusted_budget: 1_000,
            daily_limit: 5_000,
            label: "Alice".to_string(),
        }
    }

    /// A contract with asset `near` and book payee `PAYEE`.
    fn setup() -> Contract {
        let mut c = fresh();
        c.assets.insert("near".to_string(), asset_entry());
        c.book.insert(PAYEE.to_string(), book_entry());
        c
    }

    fn key(task: u8) -> LedgerKey {
        LedgerKey {
            asset: "near".to_string(),
            payee: PAYEE.to_string(),
            task_hash: [task; 32],
        }
    }

    fn caps() -> Caps {
        caps_for(&asset_entry(), &book_entry(), 5_000)
    }

    fn zero() -> Spent {
        Spent {
            asset_day: 0,
            payee_day: 0,
            payee_untrusted_day: 0,
            task: 0,
        }
    }

    /// A record of task `task` and action `index` in `state`, with the given charge and the UTC day it was made on.
    fn record(
        task: u8,
        index: u8,
        state: RequestState,
        charge: Option<ChargeRec>,
        charge_day: u64,
    ) -> RequestRecord {
        RequestRecord {
            agent: "agent.test.near".parse().unwrap(),
            task_hash: [task; 32],
            task_id: "task-1".to_string(),
            index,
            asset: "near".to_string(),
            payee: PAYEE.to_string(),
            amount: 0,
            labels: Labels {
                recipient: 2,
                amount: 1,
                pc: 1,
            },
            evm: None,
            reason: None,
            state,
            retried: false,
            applied_charge: charge,
            charge_day,
            created_ms: T0,
            pending: None,
            exec: None,
        }
    }

    /// Stores `rec` under its derived id and returns the id.
    fn store(c: &mut Contract, rec: RequestRecord) -> String {
        let id = request_id(&rec.task_hash, rec.index);
        c.records.insert(id.clone(), rec);
        id
    }

    fn stored(c: &Contract, id: &str) -> RequestRecord {
        c.records.get(id).cloned().expect("the record is stored")
    }

    /// An `Executing` record of `amount`, charged to the four ledgers at `now_ms` the way `store_allowed` charges an Allow.
    fn executing_at(c: &mut Contract, task: u8, index: u8, amount: u128, now_ms: u64) -> String {
        let applied = c.charge_allow(&key(task), &caps(), amount, false, now_ms);
        let mut rec = record(
            task,
            index,
            RequestState::Executing,
            Some(applied),
            utc_day(now_ms),
        );
        rec.amount = amount;
        store(c, rec)
    }

    fn executing(c: &mut Contract, task: u8, index: u8, amount: u128) -> String {
        executing_at(c, task, index, amount, T0)
    }

    fn events() -> Vec<Value> {
        get_logs()
            .iter()
            .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
            .map(|json| serde_json::from_str(json).expect("an event parses"))
            .collect()
    }

    /// Runs `on_signed` the way the VM does: the contract itself calls, with one promise result. Returns the events it logged.
    fn callback(c: &mut Contract, id: &str, result: PromiseResult, now_ms: u64) -> Vec<Value> {
        testing_env!(
            ctx(POLICY, now_ms, 0).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
        c.on_signed(id.to_string(), UNSIGNED.to_string());
        events()
    }

    fn ok(body: &str) -> PromiseResult {
        PromiseResult::Successful(body.as_bytes().to_vec())
    }

    fn sig_json(scheme: &str, r: &str, s: &str, recovery_id: &str) -> String {
        format!(
            r#"{{"scheme":"{scheme}","big_r":{{"affine_point":"{r}"}},"s":{{"scalar":"{s}"}},"recovery_id":{recovery_id}}}"#
        )
    }

    fn good_r() -> String {
        format!("02{}", "11".repeat(32))
    }

    fn good_s() -> String {
        "22".repeat(32)
    }

    fn good() -> String {
        sig_json("Secp256k1", &good_r(), &good_s(), "0")
    }

    fn good_with_recovery_id(recovery_id: u8) -> String {
        sig_json("Secp256k1", &good_r(), &good_s(), &recovery_id.to_string())
    }

    /// The names of the events in `logs`.
    fn names(logs: &[Value]) -> Vec<String> {
        logs.iter()
            .map(|e| e["event"].as_str().expect("an event name").to_string())
            .collect()
    }

    /// The one `failed` event of a callback, checked for its request id, reason and `retryable`.
    fn assert_failed_event(logs: &[Value], id: &str, reason: &str, retryable: bool) {
        assert_eq!(names(logs), vec!["failed"], "{logs:?}");
        let data = &logs[0]["data"][0];
        assert_eq!(data["request_id"], id, "{data}");
        assert_eq!(data["reason"], reason, "{data}");
        assert_eq!(data["retryable"], retryable, "{data}");
        assert_eq!(data.as_object().expect("an object").len(), 3, "{data}");
    }

    /// A record that failed and was refunded: `Retryable` with `reason`, the ledgers back at zero.
    fn assert_refunded_retryable(c: &Contract, id: &str, reason: &str, now_ms: u64) {
        let rec = stored(c, id);
        assert_eq!(rec.state, RequestState::Retryable, "{id}");
        assert_eq!(rec.reason.as_deref(), Some(reason), "{id}");
        assert_eq!(c.spent_now(&key(1), now_ms), zero(), "{id}");
    }

    /// A request whose signer receipt succeeded but whose answer the contract could not use: the signature may still exist and be
    /// broadcast, so every ledger keeps the value it had when the callback started (`charged`), the record is `Failed` (never
    /// `Retryable`: a retry would ask for a second signature) with `MpcBadResponse` and no stored signature, the one `failed` event says
    /// `retryable` false, and a second callback of any kind changes nothing and emits nothing.
    fn assert_failed_kept_charged(
        c: &mut Contract,
        id: &str,
        charged: &Spent,
        logs: &[Value],
        now_ms: u64,
    ) {
        let rec = stored(c, id);
        assert_eq!(rec.state, RequestState::Failed, "{id}");
        assert_eq!(rec.reason.as_deref(), Some("MpcBadResponse"), "{id}");
        assert!(rec.exec.is_none(), "{id}: no signature is stored");
        assert_eq!(&c.spent_now(&key(1), now_ms), charged, "{id}: charges kept");
        assert_failed_event(logs, id, "MpcBadResponse", false);
        for result in [PromiseResult::Failed, ok(&good()), ok("garbage")] {
            let again = callback(c, id, result, now_ms + 1_000);
            assert!(again.is_empty(), "{id}: {again:?}");
            assert_eq!(stored(c, id), rec, "{id}: the second callback changed it");
            assert_eq!(&c.spent_now(&key(1), now_ms + 1_000), charged, "{id}");
        }
    }

    #[test]
    fn callback_ok_stores_signature() {
        let mut c = setup();
        let id = executing(&mut c, 1, 0, 500);
        let charged = c.spent_now(&key(1), T0);
        assert_eq!(charged.task, 500);
        let logs = callback(&mut c, &id, ok(&good()), T0 + 5_000);
        let rec = stored(&c, &id);
        assert_eq!(rec.state, RequestState::Executed);
        let exec = rec.exec.expect("the signature is stored");
        assert_eq!(exec.unsigned_hex.as_deref(), Some(UNSIGNED));
        assert_eq!(exec.big_r.as_deref(), Some(good_r().as_str()));
        assert_eq!(exec.big_r.as_ref().map(String::len), Some(66));
        assert_eq!(exec.s.as_deref(), Some(good_s().as_str()));
        assert_eq!(exec.s.as_ref().map(String::len), Some(64));
        assert_eq!(exec.recovery_id, Some(0));
        // exactly one `signed` event, with the stored values
        assert_eq!(names(&logs), vec!["signed"], "{logs:?}");
        let data = &logs[0]["data"][0];
        assert_eq!(data["request_id"], id.as_str(), "{data}");
        assert_eq!(data["unsigned_hex"], UNSIGNED, "{data}");
        assert_eq!(data["big_r"], good_r().as_str(), "{data}");
        assert_eq!(data["s"], good_s().as_str(), "{data}");
        assert_eq!(data["recovery_id"], 0, "{data}");
        assert_eq!(data.as_object().expect("an object").len(), 5, "{data}");
        // a signature keeps the charge: the money is only released by a failure
        assert_eq!(c.spent_now(&key(1), T0 + 5_000), charged);
    }

    #[test]
    fn callback_failed_refunds_and_is_retryable() {
        let mut c = setup();
        let before = c.spent_now(&key(1), T0);
        assert_eq!(before, zero());
        let id = executing(&mut c, 1, 0, 500);
        assert_eq!(c.spent_now(&key(1), T0).task, 500);
        let logs = callback(&mut c, &id, PromiseResult::Failed, T0 + 5_000);
        assert_refunded_retryable(&c, &id, "MpcFailed", T0 + 5_000);
        assert_eq!(c.spent_now(&key(1), T0 + 5_000), before);
        assert!(
            !stored(&c, &id).retried,
            "the gate sets `retried`, not the refund"
        );
        assert_failed_event(&logs, &id, "MpcFailed", true);
    }

    #[test]
    fn callback_second_failure_is_failed() {
        let mut c = setup();
        let id = executing(&mut c, 1, 0, 500);
        let mut rec = stored(&c, &id);
        rec.retried = true;
        store(&mut c, rec);
        let logs = callback(&mut c, &id, PromiseResult::Failed, T0 + 5_000);
        let rec = stored(&c, &id);
        assert_eq!(rec.state, RequestState::Failed);
        assert_eq!(rec.reason.as_deref(), Some("MpcFailed"));
        assert_eq!(c.spent_now(&key(1), T0 + 5_000), zero());
        assert_failed_event(&logs, &id, "MpcFailed", false);
    }

    /// A signer receipt that succeeded with bytes that are not a well formed signature keeps every charge and ends `Failed`: the bytes are
    /// public in the transaction outcome, so a signature may still be usable, and refunding would let the caps be spent twice.
    #[test]
    fn callback_bad_response_keeps_charges() {
        let mut c = setup();
        let ed25519 = r#"{"scheme":"Ed25519","signature":[1,2,3]}"#.to_string();
        let bodies: Vec<(&str, Vec<u8>)> = vec![
            ("unexpected object", br#"{"unexpected":true}"#.to_vec()),
            ("array", b"[]".to_vec()),
            ("empty body", Vec::new()),
            ("Ed25519 response", ed25519.into_bytes()),
            ("2048 bytes", vec![b'x'; 2_048]),
        ];
        for (i, (name, body)) in bodies.into_iter().enumerate() {
            let index = u8::try_from(i).unwrap();
            let id = executing(&mut c, 1, index, 500);
            let charged = c.spent_now(&key(1), T0 + 5_000);
            assert!(charged.task >= 500, "{name}: the request is charged");
            let logs = callback(&mut c, &id, PromiseResult::Successful(body), T0 + 5_000);
            assert_failed_kept_charged(&mut c, &id, &charged, &logs, T0 + 5_000);
        }
    }

    /// The parser's rows. `None` is accepted; `Some(text)` is an error containing `text` (an empty text accepts any error).
    #[test]
    fn callback_parser_table() {
        let r = good_r();
        let s = good_s();
        let base = good();
        let dup = format!("{},\"recovery_id\":1}}", &base[..base.len() - 1]);
        let extra = format!("{},\"extra\":{{\"a\":[1,2]}}}}", &base[..base.len() - 1]);
        let no_scheme = format!(
            r#"{{"big_r":{{"affine_point":"{r}"}},"s":{{"scalar":"{s}"}},"recovery_id":0}}"#
        );
        let rows: Vec<(&str, String, Option<&str>)> = vec![
            (
                "Ed25519 scheme",
                sig_json("Ed25519", &r, &s, "0"),
                Some("bad scheme"),
            ),
            (
                "lowercase scheme",
                sig_json("secp256k1", &r, &s, "0"),
                Some("bad scheme"),
            ),
            (
                "affine_point of 64 digits",
                sig_json("Secp256k1", &format!("02{}", "11".repeat(31)), &s, "0"),
                Some("bad big_r"),
            ),
            (
                "affine_point of 68 digits",
                sig_json("Secp256k1", &format!("02{}", "11".repeat(33)), &s, "0"),
                Some("bad big_r"),
            ),
            (
                "prefix 04",
                sig_json("Secp256k1", &format!("04{}", "11".repeat(32)), &s, "0"),
                Some("bad big_r"),
            ),
            (
                "prefix 00",
                sig_json("Secp256k1", &format!("00{}", "11".repeat(32)), &s, "0"),
                Some("bad big_r"),
            ),
            (
                "non hex digit in big_r",
                sig_json("Secp256k1", &format!("02{}g1", "11".repeat(31)), &s, "0"),
                Some("bad big_r"),
            ),
            (
                "scalar of all zeros",
                sig_json("Secp256k1", &r, &"0".repeat(64), "0"),
                Some("bad s"),
            ),
            (
                "scalar of 63 digits",
                sig_json("Secp256k1", &r, &"2".repeat(63), "0"),
                Some("bad s"),
            ),
            (
                "scalar of 65 digits",
                sig_json("Secp256k1", &r, &"2".repeat(65), "0"),
                Some("bad s"),
            ),
            (
                "non hex digit in s",
                sig_json("Secp256k1", &r, &format!("{}zz", "22".repeat(31)), "0"),
                Some("bad s"),
            ),
            (
                "recovery_id 4",
                sig_json("Secp256k1", &r, &s, "4"),
                Some("bad recovery_id"),
            ),
            (
                "recovery_id 256",
                sig_json("Secp256k1", &r, &s, "256"),
                Some("expected u8"),
            ),
            (
                "recovery_id negative",
                sig_json("Secp256k1", &r, &s, "-1"),
                Some(""),
            ),
            (
                "duplicate recovery_id",
                dup,
                Some("duplicate field `recovery_id`"),
            ),
            ("missing scheme", no_scheme, Some("missing field `scheme`")),
            ("empty body", String::new(), Some("")),
            ("accepted: extra unknown field", extra, None),
            (
                "accepted: 03 prefix",
                sig_json("Secp256k1", &format!("03{}", "11".repeat(32)), &s, "1"),
                None,
            ),
            (
                "accepted: recovery_id 3",
                sig_json("Secp256k1", &r, &s, "3"),
                None,
            ),
            (
                "accepted: uppercase hex",
                sig_json(
                    "Secp256k1",
                    &r.replace("11", "AB"),
                    &s.replace("22", "CD"),
                    "2",
                ),
                None,
            ),
        ];
        for (name, body, want) in rows {
            let got = parse_signature(body.as_bytes());
            match want {
                Some(text) => {
                    let err = got.expect_err(name);
                    assert!(err.contains(text), "{name}: `{err}` lacks `{text}`");
                }
                None => {
                    let sig = got.unwrap_or_else(|e| panic!("{name}: {e}"));
                    // the output is lowercase hex of the right lengths
                    assert_eq!(sig.big_r.len(), 66, "{name}");
                    assert_eq!(sig.s.len(), 64, "{name}");
                    assert_eq!(sig.big_r, sig.big_r.to_lowercase(), "{name}");
                    assert_eq!(sig.s, sig.s.to_lowercase(), "{name}");
                }
            }
        }
        // the uppercase row, exactly: lowercased on the way out
        let upper = sig_json(
            "Secp256k1",
            &r.replace("11", "AB"),
            &s.replace("22", "CD"),
            "2",
        );
        assert_eq!(
            parse_signature(upper.as_bytes()),
            Ok(ParsedSignature {
                big_r: format!("02{}", "ab".repeat(32)),
                s: "cd".repeat(32),
                recovery_id: 2,
            })
        );
    }

    #[test]
    fn callback_duplicate_is_noop() {
        // two records under one task, so a second refund of the first would show in the ledgers
        let mut c = setup();
        let first = executing(&mut c, 1, 0, 500);
        let _second = executing(&mut c, 1, 1, 300);
        let both = c.spent_now(&key(1), T0);
        assert_eq!(both.task, 800);
        // a duplicated success: one `signed`, then nothing
        let once = callback(&mut c, &first, ok(&good()), T0 + 1_000);
        assert_eq!(names(&once), vec!["signed"]);
        let rec = stored(&c, &first);
        let twice = callback(&mut c, &first, ok(&good_with_recovery_id(1)), T0 + 2_000);
        assert!(twice.is_empty(), "{twice:?}");
        assert_eq!(
            stored(&c, &first),
            rec,
            "the second callback changed the record"
        );
        let twice = callback(&mut c, &first, PromiseResult::Failed, T0 + 3_000);
        assert!(twice.is_empty(), "{twice:?}");
        assert_eq!(stored(&c, &first), rec);
        assert_eq!(
            c.spent_now(&key(1), T0 + 3_000),
            both,
            "a signed request keeps its charge"
        );
        // a duplicated failure: one `failed`, the refund once
        let third = executing(&mut c, 1, 2, 100);
        assert_eq!(c.spent_now(&key(1), T0).task, 900);
        let once = callback(&mut c, &third, PromiseResult::Failed, T0 + 4_000);
        assert_eq!(names(&once), vec!["failed"]);
        let rec = stored(&c, &third);
        assert_eq!(rec.state, RequestState::Retryable);
        let after = c.spent_now(&key(1), T0 + 4_000);
        assert_eq!(after.task, 800);
        let twice = callback(&mut c, &third, PromiseResult::Failed, T0 + 5_000);
        assert!(twice.is_empty(), "{twice:?}");
        let twice = callback(&mut c, &third, ok(&good()), T0 + 6_000);
        assert!(twice.is_empty(), "{twice:?}");
        assert_eq!(stored(&c, &third), rec);
        assert_eq!(c.spent_now(&key(1), T0 + 6_000), after, "refunded once");
    }

    #[test]
    fn callback_on_non_executing_record_is_noop() {
        let mut c = setup();
        let states = [
            RequestState::Pending,
            RequestState::Blocked,
            RequestState::Executed,
            RequestState::Retryable,
            RequestState::Failed,
            RequestState::Rejected,
            RequestState::Expired,
        ];
        for (i, state) in states.into_iter().enumerate() {
            // the record carries a charge and the ledgers hold it, so a stray refund would show
            let index = u8::try_from(i).unwrap();
            let applied = c.charge_allow(&key(1), &caps(), 100, false, T0);
            let rec = record(1, index, state, Some(applied), utc_day(T0));
            let id = store(&mut c, rec.clone());
            let ledgers = c.spent_now(&key(1), T0);
            for result in [
                PromiseResult::Failed,
                ok(&good()),
                ok("garbage"),
                PromiseResult::Successful(vec![b'x'; 2_000]),
            ] {
                let logs = callback(&mut c, &id, result, T0 + 5_000);
                assert!(logs.is_empty(), "{state:?}: {logs:?}");
                assert_eq!(stored(&c, &id), rec, "{state:?} changed");
                assert_eq!(c.spent_now(&key(1), T0 + 5_000), ledgers, "{state:?}");
            }
        }
        // an unknown id: nothing happens and nothing panics
        let unknown = request_id(&[9; 32], 0);
        for result in [PromiseResult::Failed, ok(&good()), ok("garbage")] {
            let logs = callback(&mut c, &unknown, result, T0 + 5_000);
            assert!(logs.is_empty(), "{logs:?}");
            assert!(c.records.get(&unknown).is_none());
        }
    }

    /// Charge at UTC day D, a later request charges at D+1 (which overwrites the day buckets with its own), then the first request's
    /// callback fails at D+1: the day ledgers are not touched (the refund finds buckets of another day than the charge's), the task
    /// ledger of the first request is restored and the other task's ledger is untouched.
    #[test]
    fn callback_refund_after_day_change() {
        let mut c = setup();
        let first = executing(&mut c, 1, 0, 500);
        let day = utc_day(T0);
        let next_day_ms = (day + 1) * MS_PER_DAY + 1;
        let _second = executing_at(&mut c, 2, 0, 300, next_day_ms);
        let bucket = Some(DayValue {
            day: day + 1,
            spent: 300,
        });
        assert_eq!(c.asset_spent.get("near").copied(), bucket);
        let logs = callback(&mut c, &first, PromiseResult::Failed, next_day_ms + 1_000);
        // the new day's buckets are exactly what the second request left
        assert_eq!(c.asset_spent.get("near").copied(), bucket);
        assert_eq!(c.payee_spent.get(PAYEE).copied(), bucket);
        assert_eq!(
            c.payee_untrusted_spent.get(PAYEE).copied(),
            Some(DayValue {
                day: day + 1,
                spent: 0
            })
        );
        // the first task's ledger is restored, the second task's is not touched
        assert_eq!(
            c.task_spent.get(&([1; 32], PAYEE.to_string())).copied(),
            Some(0)
        );
        assert_eq!(
            c.task_spent.get(&([2; 32], PAYEE.to_string())).copied(),
            Some(300)
        );
        let now = c.spent_now(&key(1), next_day_ms + 1_000);
        assert_eq!((now.asset_day, now.payee_day, now.task), (300, 300, 0));
        assert_eq!(stored(&c, &first).state, RequestState::Retryable);
        assert_failed_event(&logs, &first, "MpcFailed", true);
    }

    /// The same callback with no write on the new day in between: the buckets are still the first day's (a day ledger is reset by the
    /// next write, not by the clock), so the refund restores them, and every ledger reads zero on the new day either way.
    #[test]
    fn callback_refund_after_day_change_reads_zero() {
        let mut c = setup();
        let id = executing(&mut c, 1, 0, 500);
        let next_day_ms = (utc_day(T0) + 1) * MS_PER_DAY + 1;
        assert_eq!(c.spent_now(&key(1), next_day_ms).task, 500);
        let logs = callback(&mut c, &id, PromiseResult::Failed, next_day_ms);
        assert_eq!(c.spent_now(&key(1), next_day_ms), zero());
        assert_eq!(c.spent_now(&key(1), T0), zero());
        assert_eq!(
            c.task_spent.get(&([1; 32], PAYEE.to_string())).copied(),
            Some(0)
        );
        assert_eq!(stored(&c, &id).state, RequestState::Retryable);
        assert_failed_event(&logs, &id, "MpcFailed", true);
    }

    #[test]
    fn callback_real_response_fixture_parses() {
        let sig = parse_signature(REAL.as_bytes()).expect("the real response parses");
        assert_eq!(sig.big_r.len(), 66);
        assert!(sig.big_r.starts_with("02") || sig.big_r.starts_with("03"));
        assert_eq!(sig.s.len(), 64);
        assert!(sig.recovery_id <= 3);
        // uppercase hex lowercases to the same value
        let upper = REAL
            .replace(&sig.big_r, &sig.big_r.to_uppercase())
            .replace(&sig.s, &sig.s.to_uppercase());
        assert_ne!(upper, REAL);
        assert_eq!(parse_signature(upper.as_bytes()), Ok(sig.clone()));
        // a mutated copy does not parse
        let mutated = REAL.replace("Secp256k1", "Ed25519");
        assert_ne!(mutated, REAL);
        assert_eq!(
            parse_signature(mutated.as_bytes()),
            Err("bad scheme".to_string())
        );
        // the whole callback accepts it
        let mut c = setup();
        let id = executing(&mut c, 1, 0, 500);
        let logs = callback(&mut c, &id, ok(REAL), T0 + 5_000);
        assert_eq!(names(&logs), vec!["signed"], "{logs:?}");
        let exec = stored(&c, &id).exec.expect("the signature is stored");
        assert_eq!(exec.big_r, Some(sig.big_r));
        assert_eq!(exec.s, Some(sig.s));
        assert_eq!(exec.recovery_id, Some(sig.recovery_id));
    }

    /// A record in the state `approve` leaves (AIR-080): `Executing`, the charge of `charge_approval`, its day, the escalation reason and
    /// `pending` with the digest the owner approved. A failure refunds that charge and keeps the digest and the pending number.
    #[test]
    fn callback_approved_request_failure_keeps_digest_and_refunds_approval_charge() {
        let mut c = setup();
        let approval = approval_caps(&asset_entry(), Some(&book_entry()), 700);
        let applied = c.charge_approval(&key(1), &approval, 600, T0);
        assert_eq!(c.spent_now(&key(1), T0).asset_day, 600);
        let mut rec = record(1, 0, RequestState::Executing, Some(applied), utc_day(T0));
        rec.amount = 600;
        rec.reason = Some("NewRecipient".to_string());
        rec.pending = Some(PendingInfo {
            no: 7,
            expires_ms: T0 + 3_600_000,
            book_in: true,
            task_bound: 700,
            display_symbol: "NEAR".to_string(),
            display_amount: "0.0006".to_string(),
            digest: Hex32([0xab; 32]),
        });
        let pending = rec.pending.clone();
        let id = store(&mut c, rec);
        let logs = callback(&mut c, &id, PromiseResult::Failed, T0 + 5_000);
        let rec = stored(&c, &id);
        assert_eq!(rec.state, RequestState::Retryable);
        assert_eq!(rec.reason.as_deref(), Some("MpcFailed"));
        assert_eq!(
            rec.pending, pending,
            "the digest the owner approved is kept"
        );
        assert_eq!(c.spent_now(&key(1), T0 + 5_000), zero());
        assert_failed_event(&logs, &id, "MpcFailed", true);
    }

    #[test]
    fn callback_fail_request_reason_overwrites_reason() {
        let mut c = setup();
        // the reasons for which no signature can exist: the failure refunds
        let reasons = [
            FailReason::MpcFailed,
            FailReason::TransferFailed,
            FailReason::InsufficientBalance,
        ];
        for (i, reason) in reasons.into_iter().enumerate() {
            let index = u8::try_from(i).unwrap();
            let id = executing(&mut c, 1, index, 100);
            let mut rec = stored(&c, &id);
            rec.reason = Some("NewRecipient".to_string());
            store(&mut c, rec);
            testing_env!(ctx(POLICY, T0 + 5_000, 0).build());
            c.fail_request(&id, reason);
            let rec = stored(&c, &id);
            assert_eq!(rec.reason.as_deref(), Some(reason.as_str()));
            assert_eq!(rec.state, RequestState::Retryable);
            assert_failed_event(&events(), &id, reason.as_str(), true);
            assert_eq!(c.spent_now(&key(1), T0 + 5_000), zero());
        }
    }

    /// `fail_request` is the refunding path, and a bad response must never take it: given `MpcBadResponse` it keeps the charges and ends
    /// `Failed`, exactly like `fail_kept_charged`, so no caller can reopen the bypass by passing the wrong reason.
    #[test]
    fn callback_fail_request_never_refunds_a_bad_response() {
        let mut c = setup();
        let id = executing(&mut c, 1, 0, 500);
        let charged = c.spent_now(&key(1), T0 + 5_000);
        testing_env!(ctx(POLICY, T0 + 5_000, 0).build());
        c.fail_request(&id, FailReason::MpcBadResponse);
        let logs = events();
        assert_failed_kept_charged(&mut c, &id, &charged, &logs, T0 + 5_000);
    }

    #[test]
    fn callback_fail_reason_names_are_the_variant_names() {
        assert_eq!(FailReason::MpcFailed.as_str(), "MpcFailed");
        assert_eq!(FailReason::MpcBadResponse.as_str(), "MpcBadResponse");
        assert_eq!(FailReason::TransferFailed.as_str(), "TransferFailed");
        assert_eq!(
            FailReason::InsufficientBalance.as_str(),
            "InsufficientBalance"
        );
    }

    /// Only the reasons for which no signature can exist refund.
    #[test]
    fn callback_only_no_signature_reasons_refund() {
        assert!(FailReason::MpcFailed.refunds());
        assert!(FailReason::TransferFailed.refunds());
        assert!(FailReason::InsufficientBalance.refunds());
        assert!(!FailReason::MpcBadResponse.refunds());
    }

    /// A success body of exactly `len` bytes: the good response plus an unknown field that serde ignores.
    fn padded(len: usize) -> String {
        let base = good();
        let head = &base[..base.len() - 1];
        let fixed = r#","pad":""}"#.len();
        let body = format!(
            "{head},\"pad\":\"{}\"}}",
            "x".repeat(len - head.len() - fixed)
        );
        assert_eq!(body.len(), len);
        body
    }

    /// One byte over the bound is `PromiseError::TooLong` although the body is a valid response: the signer's receipt succeeded, so the
    /// signature in it may still be broadcast, and the request keeps its charges and ends `Failed`.
    #[test]
    fn callback_too_long_keeps_charges() {
        let mut c = setup();
        let long = executing(&mut c, 1, 0, 500);
        let charged = c.spent_now(&key(1), T0 + 5_000);
        assert_eq!(charged.task, 500);
        let logs = callback(&mut c, &long, ok(&padded(MAX_MPC_RESPONSE + 1)), T0 + 5_000);
        assert_failed_kept_charged(&mut c, &long, &charged, &logs, T0 + 5_000);
        // exactly at the bound the same body is accepted
        let at_bound = executing(&mut c, 1, 1, 500);
        let logs = callback(&mut c, &at_bound, ok(&padded(MAX_MPC_RESPONSE)), T0 + 6_000);
        assert_eq!(names(&logs), vec!["signed"], "{logs:?}");
        assert_eq!(stored(&c, &at_bound).state, RequestState::Executed);
    }

    /// The EVM lane (`rec.evm` is `Some`): nearcore's `ecrecover` takes 0 to 3, an EIP-1559 `yParity` only 0 or 1, so a stored id of 2
    /// or 3 could never be assembled into a transaction by the runtime. The signer's receipt still succeeded and the signature is public
    /// in its outcome, so the request keeps its charges and ends `Failed` with `MpcBadResponse`. The NEAR lane keeps 0 to 3.
    #[test]
    fn callback_evm_recovery_id_2_keeps_charges() {
        let mut c = setup();
        let evm = Some(EvmParams {
            gas_limit: U128(21_000),
            max_fee_per_gas: U128(2_000_000_000),
            max_priority_fee_per_gas: U128(1_000_000_000),
        });
        let mut index = 0u8;
        // the callback's id, its events and what the ledgers held just before it
        let mut run = |c: &mut Contract, evm: Option<EvmParams>, recovery_id: u8| {
            let id = executing(c, 1, index, 100);
            index += 1;
            let mut rec = stored(c, &id);
            rec.evm = evm;
            store(c, rec);
            let charged = c.spent_now(&key(1), T0 + 5_000);
            let logs = callback(c, &id, ok(&good_with_recovery_id(recovery_id)), T0 + 5_000);
            (id, logs, charged)
        };
        for recovery_id in [2u8, 3] {
            let (id, logs, charged) = run(&mut c, evm, recovery_id);
            assert_failed_kept_charged(&mut c, &id, &charged, &logs, T0 + 5_000);
        }
        for recovery_id in [0u8, 1] {
            let (id, logs, _) = run(&mut c, evm, recovery_id);
            assert_eq!(names(&logs), vec!["signed"], "{logs:?}");
            assert_eq!(stored(&c, &id).state, RequestState::Executed);
            assert_eq!(
                stored(&c, &id).exec.and_then(|e| e.recovery_id),
                Some(recovery_id)
            );
        }
        for recovery_id in [0u8, 1, 2, 3] {
            let (id, logs, _) = run(&mut c, None, recovery_id);
            assert_eq!(names(&logs), vec!["signed"], "{logs:?}");
            assert_eq!(
                stored(&c, &id).exec.and_then(|e| e.recovery_id),
                Some(recovery_id)
            );
        }
    }
}

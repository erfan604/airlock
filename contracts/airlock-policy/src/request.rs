// AIR-063: the wire types of a payment request, the contract-derived request id, the label mask check, the stored record and the
// `get_request` view. `submit_batch` (AIR-061) is the first user; ledgers (AIR-062) fill `applied_charge`, escalations (AIR-080) fill
// `pending`, the lanes (AIR-100 to AIR-105) fill `exec`.
//
// Pinned behaviour (verified on near-sdk 5.26.1, plan/solutions/F01 3.1 and 3.2):
//  - duplicate JSON keys revert at deserialization (AB1, serde's `duplicate field`), unknown extra fields are ignored (AB2): do not add
//    `deny_unknown_fields`; a JSON number for a `U128` field reverts;
//  - an agent can never choose an id, a nonce, a path or a recipient address: there is no such field, so an extra one is dropped;
//  - labels are three u16 masks on the wire, bit 15 is never set (`check_labels`), a mask of 0 is allowed here and blocked by the
//    verdict (`MissingProvenance`);
//  - no free text is stored: `hints` are read from the wire and not kept.
use crate::escalation::book_status;
use crate::*;
use airlock_verdict::labels::is_valid_mask;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Deserializer, Serializer, de};

/// 32 bytes. JSON: exactly 64 lowercase hex characters, anything else is refused. Borsh: the 32 raw bytes.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hex32(pub [u8; 32]);

impl Hex32 {
    /// 64 lowercase hex characters (digits and a to f) and nothing else.
    pub fn parse(s: &str) -> Result<Self, String> {
        if s.len() != 64 {
            return Err(format!(
                "expected 64 lowercase hex characters, got {} bytes",
                s.len()
            ));
        }
        if !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("expected lowercase hex characters only".to_string());
        }
        let mut out = [0u8; 32];
        hex::decode_to_slice(s, &mut out).map_err(|e| e.to_string())?;
        Ok(Self(out))
    }

    /// The 64 lowercase hex characters.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl Serialize for Hex32 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Hex32 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).map_err(de::Error::custom)
    }
}

/// Origin labels of the three authority-bearing values of a request, as u16 masks (bit layout: GLOSSARY, `airlock_verdict::labels`).
/// There is no trigger mask (SPEC R5-02): the contract passes the three masks to the verdict as sent.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Labels {
    pub recipient: u16,
    pub amount: u16,
    pub pc: u16,
}

/// The EVM lane parameters the verdict's rule 3 needs. `Some` exactly for EVM assets.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvmParams {
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

/// Audit only, never trusted and never stored.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hints {
    pub plan_hash: Hex32,
    pub trace_digest: Hex32,
    /// AIR-315: the flood-control origin the runtime names for an escalation (`owner`, or `<kind>:<16 lowercase hex>`, a hash of the
    /// untrusted source such as a mail sender). Absent for a runtime that names none. Keys the flood counters only; never trusted for
    /// a verdict, never stored in a record, never put in an event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// What an agent submits (`submit_batch`, at most 3 per call). The TypeScript side calls it `ActionRequest`.
/// There is no request id, nonce, path or recipient address: the id is `<task hash>:<action_index>`, derived by the contract
/// (`request_id`); `action_index` is unique within the task and below the task's `max_actions`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmitRequest {
    pub task_id: String,
    pub action_index: u8,
    pub asset: String,
    pub payee: String,
    pub amount: U128,
    pub labels: Labels,
    pub evm: Option<EvmParams>,
    pub hints: Hints,
}

/// Reverts `unknown label bit` when any of the three masks has bit 15 set (I9). A mask of 0 is allowed here: the verdict blocks
/// it with `MissingProvenance`.
pub fn check_labels(l: &Labels) {
    require!(
        is_valid_mask(l.recipient) && is_valid_mask(l.amount) && is_valid_mask(l.pc),
        "unknown label bit"
    );
}

/// The id the contract derives for action `index` of the task with this hash: the lowercase hex of the hash, `:`, the decimal
/// index (66 characters for indexes 0 to 9, 67 for 10 to 99; `set_flags` caps `max_task_actions` at 99).
pub fn request_id(task_hash: &[u8; 32], index: u8) -> String {
    format!("{}:{}", hex::encode(task_hash), index)
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestState {
    Pending,
    Rejected,
    Expired,
    Blocked,
    Executing,
    Executed,
    Retryable,
    Failed,
}

/// What a request charged to the four ledgers: the stored mirror of the verdict crate's `Charge`, which has no Borsh because that
/// crate is dependency free. AIR-062 adds the `From` conversions.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChargeRec {
    pub asset_day: u128,
    pub payee_day: u128,
    pub payee_untrusted_day: u128,
    pub task: u128,
}

/// The escalation part of a record (AIR-061 `store_pending`, AIR-080). `task_bound` is the bound for the request's payee in the
/// verified task, 0 when the payee had none (AIR-080 builds the approval's ledger caps from it).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingInfo {
    pub no: u32,
    pub expires_ms: u64,
    pub book_in: bool,
    pub task_bound: u128,
    pub display_symbol: String,
    pub display_amount: String,
    pub digest: Hex32,
}

/// What the execution lanes leave on a record (AIR-080 and AIR-105 fill the optional parts).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExecInfo {
    pub unsigned_hex: Option<String>,
    pub big_r: Option<String>,
    pub s: Option<String>,
    pub recovery_id: Option<u8>,
    /// AIR-109: set by the x402 lane (an EIP-3009 authorization instead of a transaction).
    pub x402: Option<X402Exec>,
}

/// AIR-109: what the x402 lane signed: the payer address, the end of the authorization window (Unix seconds) and the random nonce.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct X402Exec {
    pub from: String,
    pub valid_before: u64,
    pub nonce: Hex32,
}

/// One stored request, keyed by its derived id in `Contract::records`. The record (or the tombstone `expire` leaves in its place,
/// AIR-081) is the used marker of the id: an id is never reusable. `Retryable` is set by the refund path of AIR-105 after a failed
/// signing or transfer; `retried` becomes true when the gate runs a Retryable id a second time, and a second failure moves it to
/// `Failed`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestRecord {
    pub agent: AccountId,
    pub task_hash: [u8; 32],
    pub task_id: String,
    pub index: u8,
    pub asset: String,
    pub payee: String,
    pub amount: u128,
    pub labels: Labels,
    pub evm: Option<EvmParams>,
    pub reason: Option<String>,
    pub state: RequestState,
    pub retried: bool,
    pub applied_charge: Option<ChargeRec>,
    pub charge_day: u64,
    pub created_ms: u64,
    pub pending: Option<PendingInfo>,
    pub exec: Option<ExecInfo>,
}

/// The verdict request of the given amount, EVM parameters and masks: one mapping for the gate and for `approve` (AIR-080).
fn verdict_request(
    amount: u128,
    evm: Option<&EvmParams>,
    labels: &Labels,
) -> airlock_verdict::Request {
    airlock_verdict::Request {
        amount,
        fee_per_gas: evm.map(|e| e.max_fee_per_gas.0),
        gas: evm.map(|e| e.gas_limit.0),
        labels: airlock_verdict::Labels {
            recipient: labels.recipient,
            amount: labels.amount,
            pc: labels.pc,
        },
    }
}

impl SubmitRequest {
    /// The request the verdict function reads: the amount, the three masks as sent, and `fee_per_gas` and `gas` from `evm`
    /// (`None` on the NEAR lane).
    pub fn to_verdict(&self) -> airlock_verdict::Request {
        verdict_request(self.amount.0, self.evm.as_ref(), &self.labels)
    }
}

impl RequestRecord {
    /// The same mapping as `SubmitRequest::to_verdict`, from the stored fields.
    pub fn to_verdict(&self) -> airlock_verdict::Request {
        verdict_request(self.amount, self.evm.as_ref(), &self.labels)
    }
}

/// True when `asset`, `payee`, `amount`, `labels` and `evm` are equal (the gate reverts `request mismatch` on a replay where this is
/// false).
pub fn same_content(rec: &RequestRecord, req: &SubmitRequest) -> bool {
    rec.asset == req.asset
        && rec.payee == req.payee
        && rec.amount == req.amount.0
        && rec.labels == req.labels
        && rec.evm == req.evm
}

impl Contract {
    /// A guard that writes nothing: reverts when the id already has a record (or a tombstone). The gate calls it only for ids it has
    /// checked are absent from its replay table, so this revert is a guard and not the replay path; the gate stores the record right
    /// after it.
    pub fn mark_used(&mut self, id: &str) {
        require!(
            !self.records.contains_key(id),
            "request_id already used (UsedRequestId)"
        );
    }
}

/// What `submit_batch` answers for one request: `outcome` is `allowed`, `escalated` or `blocked`; `pending_id` is the short decimal
/// id of an escalation.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmitOutcome {
    pub request_id: String,
    pub outcome: String,
    pub reason: Option<String>,
    pub pending_id: Option<String>,
}

/// The readable form of the escalation display strings (AIR-080 fills it at store time).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestDisplay {
    pub asset_symbol: String,
    pub amount_decimal: String,
}

/// What `get_request` returns (mirrors F02 3.1 `PendingRequest`). `request_id` is the long derived id; `id` is the short decimal
/// pending number, present only for escalations (the value `approve` and `reject` take). `state` is the variant name, `digest` is
/// 64 lowercase hex.
///
/// A tombstone (an `Expired` record, AIR-081) answers `request_id`, `id` and `state` only: the other keys are
/// absent from its JSON, which is why the fields below that a record always has are `Option` here.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestView {
    pub request_id: String,
    pub id: Option<String>,
    pub state: RequestState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AccountId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payee: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Labels>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<RequestDisplay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_ms: Option<U64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_ms: Option<U64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exec: Option<ExecInfo>,
}

impl RequestView {
    /// Whether this record is the tombstone `expire` leaves: an `Expired` record (`expire` is the only writer of that state; it keeps the
    /// number in `pending` and frees the display strings and the digest).
    pub fn is_tombstone(rec: &RequestRecord) -> bool {
        rec.state == RequestState::Expired
    }

    /// The view of a stored record. `book_status`, `display`, `expires_ms` and `digest` are filled for every record that has `pending`
    /// and is not `Expired` (AIR-080): after `approve` the record is `Executing`, later `Executed`, `Retryable` or `Failed`, and
    /// still shows the card, because AIR-085 reads it at the approval block. AIR-105 reads `exec`.
    pub fn from_record(rec: &RequestRecord) -> Self {
        let request_id = request_id(&rec.task_hash, rec.index);
        let id = rec.pending.as_ref().map(|p| p.no.to_string());
        if Self::is_tombstone(rec) {
            return Self {
                request_id,
                id,
                state: rec.state,
                agent: None,
                task_id: None,
                asset: None,
                payee: None,
                amount: None,
                labels: None,
                reason: None,
                book_status: None,
                display: None,
                created_ms: None,
                expires_ms: None,
                digest: None,
                exec: None,
            };
        }
        // the card of an escalation: absent for a request that was never escalated, and for an `Expired` record
        let card = rec
            .pending
            .as_ref()
            .filter(|_| rec.state != RequestState::Expired);
        Self {
            request_id,
            id,
            state: rec.state,
            agent: Some(rec.agent.clone()),
            task_id: Some(rec.task_id.clone()),
            asset: Some(rec.asset.clone()),
            payee: Some(rec.payee.clone()),
            amount: Some(U128(rec.amount)),
            labels: Some(rec.labels),
            reason: rec.reason.clone(),
            book_status: card.map(|p| book_status(p.book_in).to_string()),
            display: card.map(|p| RequestDisplay {
                asset_symbol: p.display_symbol.clone(),
                amount_decimal: p.display_amount.clone(),
            }),
            created_ms: Some(U64(rec.created_ms)),
            expires_ms: card.map(|p| U64(p.expires_ms)),
            digest: card.map(|p| p.digest.to_hex()),
            exec: rec.exec.clone(),
        }
    }
}

#[near]
impl Contract {
    /// The record of a request. `id` is either the derived request id (it contains `:`) or the short pending number of an
    /// escalation, which is looked up through `pending_by_no` (AIR-080) and keeps answering after the approval, because the index is
    /// never removed from. A number must be the canonical decimal of a `u32` (`+7` and `007` answer `None`). An unknown id answers
    /// `None`.
    pub fn get_request(&self, id: String) -> Option<RequestView> {
        if id.contains(':') {
            return self.records.get(&id).map(RequestView::from_record);
        }
        let no = crate::escalation::canonical_no(&id)?;
        let (_, rec) = self.pending_record(no)?;
        Some(RequestView::from_record(&rec))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::fresh;
    use near_sdk::borsh;
    use serde_json::{Value, json};

    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/verdict-vectors.json"
    ));

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).expect("fixtures/verdict-vectors.json parses")
    }

    fn base_json() -> Value {
        json!({
            "task_id": "task-1",
            "action_index": 0,
            "asset": "near",
            "payee": "near:accountant.test.near",
            "amount": "10",
            "labels": { "recipient": 2, "amount": 1, "pc": 1 },
            "evm": null,
            "hints": {
                "plan_hash": "d234a5a691369635b963e8287a1bc47f53e70f36c1f81c49fed352892098cbbd",
                "trace_digest": "2972efd328e974ec07f0bd1b4d2960a129fd048e12400b2b11da5d305b3bfe05"
            }
        })
    }

    fn evm_json() -> Value {
        let mut v = base_json();
        v["asset"] = json!("evm:84532:native");
        v["payee"] = json!("evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
        v["evm"] = json!({
            "gas_limit": "21000",
            "max_fee_per_gas": "2000000000",
            "max_priority_fee_per_gas": "1000000000"
        });
        v
    }

    fn parse(v: &Value) -> SubmitRequest {
        serde_json::from_value(v.clone()).expect("a well formed request parses")
    }

    fn record_of(req: &SubmitRequest) -> RequestRecord {
        RequestRecord {
            agent: "agent.test.near".parse().unwrap(),
            task_hash: [7; 32],
            task_id: req.task_id.clone(),
            index: req.action_index,
            asset: req.asset.clone(),
            payee: req.payee.clone(),
            amount: req.amount.0,
            labels: req.labels,
            evm: req.evm,
            reason: None,
            state: RequestState::Blocked,
            retried: false,
            applied_charge: None,
            charge_day: 0,
            created_ms: 1_000,
            pending: None,
            exec: None,
        }
    }

    fn pending_info() -> PendingInfo {
        PendingInfo {
            no: 7,
            expires_ms: 3_601_000,
            book_in: true,
            task_bound: 500,
            display_symbol: "NEAR".to_string(),
            display_amount: "10".to_string(),
            digest: Hex32([9; 32]),
        }
    }

    /// The text of a panic payload.
    fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default()
    }

    // ---- Hex32 -------------------------------------------------------------------------------------------------------------

    #[test]
    fn hex32_rejects_uppercase() {
        let upper = "D234A5A691369635B963E8287A1BC47F53E70F36C1F81C49FED352892098CBBD";
        assert!(Hex32::parse(upper).is_err());
        let mixed = "d234a5a691369635b963e8287a1bc47f53e70f36c1f81c49fed352892098cbbD";
        assert!(Hex32::parse(mixed).is_err());
        assert!(serde_json::from_value::<Hex32>(json!(upper)).is_err());
    }

    #[test]
    fn hex32_rejects_63_and_65_characters() {
        let ok = "d234a5a691369635b963e8287a1bc47f53e70f36c1f81c49fed352892098cbbd";
        assert!(Hex32::parse(&ok[..63]).is_err());
        assert!(Hex32::parse(&format!("{ok}0")).is_err());
        assert!(Hex32::parse("").is_err());
        // not hex at all, and a multi byte character that makes the byte length 64
        assert!(Hex32::parse(&"g".repeat(64)).is_err());
        assert!(Hex32::parse(&format!("{}\u{e9}", "a".repeat(62))).is_err());
        assert!(serde_json::from_value::<Hex32>(json!(&ok[..63])).is_err());
        // a JSON array of numbers is not a hash either
        assert!(serde_json::from_value::<Hex32>(json!(vec![0u8; 32])).is_err());
    }

    #[test]
    fn hex32_accepts_vector_hashes() {
        let v = vectors();
        let hashes = [
            v["owner_task"]["sha256_hex"].as_str().unwrap(),
            v["owner_task"]["plan_sha256"].as_str().unwrap(),
            v["verdicts"][0]["request"]["hints"]["trace_digest"]
                .as_str()
                .unwrap(),
        ];
        for h in hashes {
            let parsed = Hex32::parse(h).unwrap_or_else(|e| panic!("{h}: {e}"));
            assert_eq!(parsed.to_hex(), h, "the text round trips");
            let json = serde_json::to_string(&parsed).unwrap();
            assert_eq!(json, format!("\"{h}\""));
            assert_eq!(serde_json::from_str::<Hex32>(&json).unwrap(), parsed);
        }
    }

    #[test]
    fn hex32_borsh_is_32_raw_bytes() {
        let h = Hex32([0xab; 32]);
        let bytes = borsh::to_vec(&h).unwrap();
        assert_eq!(bytes, vec![0xab; 32]);
        assert_eq!(borsh::from_slice::<Hex32>(&bytes).unwrap(), h);
    }

    // ---- the wire types ----------------------------------------------------------------------------------------------------

    #[test]
    fn extra_field_to_address_is_ignored() {
        let base = parse(&base_json());
        let mut v = base_json();
        v["to"] = json!("near:attacker.near");
        v["address"] = json!("0x0000000000000000000000000000000000000001");
        v["request_id"] = json!("chosen-by-the-agent");
        v["nonce"] = json!(5);
        v["path"] = json!("another-path");
        v["labels"]["trigger"] = json!(1);
        let with_extras = parse(&v);
        assert_eq!(with_extras, base, "unknown fields are dropped, not read");
        // the same through the raw text a client sends
        let raw = r#"{"task_id":"task-1","action_index":0,"asset":"near","payee":"near:accountant.test.near","amount":"10","labels":{"recipient":2,"amount":1,"pc":1},"evm":null,"hints":{"plan_hash":"d234a5a691369635b963e8287a1bc47f53e70f36c1f81c49fed352892098cbbd","trace_digest":"2972efd328e974ec07f0bd1b4d2960a129fd048e12400b2b11da5d305b3bfe05"},"to":"near:attacker.near"}"#;
        assert_eq!(serde_json::from_str::<SubmitRequest>(raw).unwrap(), base);
    }

    #[test]
    fn duplicate_key_reverts() {
        let raw = r#"{"task_id":"t","action_index":0,"asset":"near","payee":"near:a.near","amount":"10","amount":"11","labels":{"recipient":2,"amount":1,"pc":1},"evm":null,"hints":{"plan_hash":"d234a5a691369635b963e8287a1bc47f53e70f36c1f81c49fed352892098cbbd","trace_digest":"2972efd328e974ec07f0bd1b4d2960a129fd048e12400b2b11da5d305b3bfe05"}}"#;
        let err = serde_json::from_str::<SubmitRequest>(raw).unwrap_err();
        assert!(err.to_string().contains("duplicate field"), "{err}");
        // a duplicate inside a nested object reverts too
        let nested = r#"{"task_id":"t","action_index":0,"asset":"near","payee":"near:a.near","amount":"10","labels":{"recipient":2,"recipient":1,"amount":1,"pc":1},"evm":null,"hints":{"plan_hash":"d234a5a691369635b963e8287a1bc47f53e70f36c1f81c49fed352892098cbbd","trace_digest":"2972efd328e974ec07f0bd1b4d2960a129fd048e12400b2b11da5d305b3bfe05"}}"#;
        let err = serde_json::from_str::<SubmitRequest>(nested).unwrap_err();
        assert!(err.to_string().contains("duplicate field"), "{err}");
    }

    #[test]
    fn numeric_amount_reverts() {
        let mut v = base_json();
        v["amount"] = json!(10);
        let err = serde_json::from_value::<SubmitRequest>(v).unwrap_err();
        assert!(err.to_string().contains("invalid type"), "{err}");
        // the three EVM numbers are strings as well
        let mut e = evm_json();
        e["evm"]["gas_limit"] = json!(21000);
        assert!(serde_json::from_value::<SubmitRequest>(e).is_err());
    }

    #[test]
    fn missing_fields_revert_and_evm_may_be_absent() {
        let mut v = base_json();
        v.as_object_mut().unwrap().remove("hints");
        assert!(serde_json::from_value::<SubmitRequest>(v).is_err());
        let mut v = base_json();
        v.as_object_mut().unwrap().remove("action_index");
        assert!(serde_json::from_value::<SubmitRequest>(v).is_err());
        let mut v = base_json();
        v.as_object_mut().unwrap().remove("evm");
        assert_eq!(
            parse(&v).evm,
            None,
            "a request without `evm` is a NEAR request"
        );
        assert!(parse(&evm_json()).evm.is_some());
    }

    #[test]
    fn check_labels_rejects_32768() {
        for bad in [
            Labels {
                recipient: 32768,
                amount: 1,
                pc: 1,
            },
            Labels {
                recipient: 2,
                amount: 32768,
                pc: 1,
            },
            Labels {
                recipient: 2,
                amount: 1,
                pc: 32768,
            },
            Labels {
                recipient: 2,
                amount: 1,
                pc: u16::MAX,
            },
        ] {
            let hit = std::panic::catch_unwind(|| check_labels(&bad));
            let text = panic_text(hit.expect_err("a mask with bit 15 must revert"));
            assert!(text.contains("unknown label bit"), "{text}");
        }
    }

    #[test]
    fn check_labels_accepts_zero_and_every_valid_mask() {
        check_labels(&Labels {
            recipient: 0,
            amount: 0,
            pc: 0,
        });
        check_labels(&Labels {
            recipient: 1,
            amount: 0x7fff,
            pc: 0x7fff,
        });
        check_labels(&Labels {
            recipient: 2,
            amount: 1,
            pc: 1,
        });
    }

    #[test]
    fn request_id_formats_the_index() {
        let hash = [0xab; 32];
        let first = request_id(&hash, 0);
        assert_eq!(first, format!("{}:0", "ab".repeat(32)));
        assert_eq!(first.len(), 66);
        assert_eq!(request_id(&hash, 9).len(), 66);
        assert_eq!(request_id(&hash, 10).len(), 67);
        assert_eq!(request_id(&hash, 98).len(), 67);
        assert_eq!(request_id(&hash, 99), format!("{}:99", "ab".repeat(32)));
    }

    #[test]
    fn request_ids_match_vector() {
        let v = vectors();
        let hash = Hex32::parse(v["owner_task"]["sha256_hex"].as_str().unwrap()).unwrap();
        let ids = v["owner_task"]["request_ids"].as_array().unwrap();
        assert_eq!(ids.len(), 3);
        for (index, expected) in ids.iter().enumerate() {
            assert_eq!(
                request_id(&hash.0, u8::try_from(index).unwrap()),
                expected.as_str().unwrap()
            );
        }
    }

    // ---- the mapping to the verdict ----------------------------------------------------------------------------------------

    #[test]
    fn to_verdict_equal_for_same_content() {
        for v in [base_json(), evm_json()] {
            let req = parse(&v);
            let rec = record_of(&req);
            assert_eq!(req.to_verdict(), rec.to_verdict());
        }
        let near = parse(&base_json()).to_verdict();
        assert_eq!(near.amount, 10);
        assert_eq!((near.fee_per_gas, near.gas), (None, None));
        assert_eq!(
            (near.labels.recipient, near.labels.amount, near.labels.pc),
            (2, 1, 1)
        );
        let evm = parse(&evm_json()).to_verdict();
        assert_eq!(evm.fee_per_gas, Some(2_000_000_000));
        assert_eq!(evm.gas, Some(21_000));
    }

    #[test]
    fn same_content_ignores_the_rest() {
        let req = parse(&base_json());
        let mut rec = record_of(&req);
        assert!(same_content(&rec, &req));
        // identity, time and state do not matter, only what was asked for
        rec.agent = "other.test.near".parse().unwrap();
        rec.state = RequestState::Executed;
        rec.created_ms = 5;
        rec.task_id = "other".to_string();
        assert!(same_content(&rec, &req));
    }

    // ---- the used marker ---------------------------------------------------------------------------------------------------

    #[test]
    fn mark_used_reverts_on_existing_record() {
        let mut c = fresh();
        let req = parse(&base_json());
        let id = request_id(&[7; 32], 0);
        c.records.insert(id.clone(), record_of(&req));
        let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.mark_used(&id)));
        let text = panic_text(hit.expect_err("a used id must revert"));
        assert!(
            text.contains("request_id already used (UsedRequestId)"),
            "{text}"
        );
    }

    #[test]
    fn mark_used_reverts_on_a_tombstone_and_allows_a_new_id() {
        let mut c = fresh();
        let req = parse(&base_json());
        let id = request_id(&[7; 32], 0);
        let mut tombstone = record_of(&req);
        tombstone.state = RequestState::Expired;
        c.records.insert(id.clone(), tombstone);
        let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.mark_used(&id)));
        assert!(hit.is_err(), "the id of a tombstone stays used");
        // another id passes and the guard writes nothing
        let other = request_id(&[7; 32], 1);
        c.mark_used(&other);
        assert!(!c.records.contains_key(other.as_str()));
    }

    // ---- state shape -------------------------------------------------------------------------------------------------------

    #[test]
    fn request_state_json_is_the_variant_name() {
        let all = [
            (RequestState::Pending, "Pending"),
            (RequestState::Rejected, "Rejected"),
            (RequestState::Expired, "Expired"),
            (RequestState::Blocked, "Blocked"),
            (RequestState::Executing, "Executing"),
            (RequestState::Executed, "Executed"),
            (RequestState::Retryable, "Retryable"),
            (RequestState::Failed, "Failed"),
        ];
        for (state, name) in all {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<RequestState>(json!(name)).unwrap(),
                state
            );
        }
    }

    #[test]
    fn request_record_borsh_round_trip() {
        let req = parse(&evm_json());
        let mut rec = record_of(&req);
        rec.reason = Some("OverPayeeLimit".to_string());
        rec.applied_charge = Some(ChargeRec {
            asset_day: 1,
            payee_day: 2,
            payee_untrusted_day: 3,
            task: 4,
        });
        rec.pending = Some(pending_info());
        rec.exec = Some(ExecInfo {
            unsigned_hex: Some("02aa".to_string()),
            big_r: None,
            s: None,
            recovery_id: Some(1),
            x402: Some(X402Exec {
                from: "0x".to_string() + &"11".repeat(20),
                valid_before: 1_700_000_300,
                nonce: Hex32([5; 32]),
            }),
        });
        let bytes = borsh::to_vec(&rec).unwrap();
        assert_eq!(borsh::from_slice::<RequestRecord>(&bytes).unwrap(), rec);
    }

    #[test]
    fn submit_outcome_json_shape() {
        let out = SubmitOutcome {
            request_id: request_id(&[7; 32], 1),
            outcome: "escalated".to_string(),
            reason: Some("OverPayeeLimit".to_string()),
            pending_id: Some("3".to_string()),
        };
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["outcome"], "escalated");
        assert_eq!(v["pending_id"], "3");
        assert_eq!(
            v.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
            ["request_id", "outcome", "reason", "pending_id"]
        );
    }

    // ---- the shared vectors ------------------------------------------------------------------------------------------------

    /// Every `submit_rejections` entry must be refused: at deserialization or in `check_labels` (printed `WIRE_REJECTIONS`), or be
    /// one of the two the gate refuses (AIR-061 test 6; printed `GATE_REJECTIONS`): a payee with an ASCII uppercase letter, and an
    /// asset whose kind disagrees with the payee scheme. The vectors carry no `action_index` (AIR-024), so the test inserts one.
    #[test]
    fn submit_rejections_all_refused() {
        let v = vectors();
        let entries = v["submit_rejections"].as_array().unwrap();
        assert!(!entries.is_empty());
        let (mut wire, mut gate) = (0, 0);
        for entry in entries {
            let name = entry["name"].as_str().unwrap();
            let want = entry["error"].as_str().unwrap();
            let mut raw = entry["raw"].as_str().unwrap().to_string();
            if !raw.contains("\"action_index\"") {
                raw = raw.replacen('{', "{\"action_index\":0,", 1);
            }
            match serde_json::from_str::<SubmitRequest>(&raw) {
                Err(e) => {
                    wire += 1;
                    let text = e.to_string();
                    // the vector names the error where serde words it the same way
                    if want == "duplicate field" || want == "invalid type" {
                        assert!(text.contains(want), "{name}: expected `{want}` in `{text}`");
                    }
                }
                Ok(req) => {
                    let labels = req.labels;
                    match std::panic::catch_unwind(|| check_labels(&labels)) {
                        Err(payload) => {
                            wire += 1;
                            let text = panic_text(payload);
                            assert!(text.contains(want), "{name}: expected `{want}` in `{text}`");
                        }
                        Ok(()) => {
                            let upper = req.payee.chars().any(|c| c.is_ascii_uppercase());
                            let asset_kind = if req.asset == "near" {
                                "near"
                            } else if req.asset.starts_with("evm:") {
                                "evm"
                            } else {
                                "other"
                            };
                            let payee_kind = req.payee.split(':').next().unwrap_or("");
                            let disagree = asset_kind != payee_kind;
                            assert!(
                                upper || disagree,
                                "{name}: parsed, passed check_labels and is not one of the two gate rejections"
                            );
                            gate += 1;
                        }
                    }
                }
            }
        }
        println!("WIRE_REJECTIONS {wire}");
        println!("GATE_REJECTIONS {gate}");
        assert_eq!(wire + gate, entries.len());
    }

    /// Every `verdicts[n].request` of the vector file is a `SubmitRequest`. The vectors carry no `action_index` (AIR-024), so the
    /// test sets it to 0 (a no-op once AIR-024 includes it).
    #[test]
    fn verdict_vectors_deserialize() {
        let v = vectors();
        let verdicts = v["verdicts"].as_array().unwrap();
        let mut n = 0;
        for entry in verdicts {
            let mut request = entry["request"].clone();
            request
                .as_object_mut()
                .unwrap()
                .entry("action_index")
                .or_insert(json!(0));
            let req: SubmitRequest = serde_json::from_value(request)
                .unwrap_or_else(|e| panic!("{}: {e}", entry["name"]));
            check_labels(&req.labels);
            // the mapping the gate uses reads the vector's own numbers
            let verdict = req.to_verdict();
            assert_eq!(
                verdict.amount.to_string(),
                entry["request"]["amount"].as_str().unwrap()
            );
            assert_eq!(
                verdict.fee_per_gas.is_some(),
                !entry["request"]["evm"].is_null()
            );
            n += 1;
        }
        println!("VERDICT_REQUESTS {n}");
        assert_eq!(n, 200);
    }

    // ---- get_request -------------------------------------------------------------------------------------------------------

    #[test]
    fn request_view_unknown_id_is_none() {
        let c = fresh();
        assert_eq!(c.get_request(request_id(&[1; 32], 0)), None);
        // a pending number nobody was given answers None
        assert_eq!(c.get_request("1".to_string()), None);
        assert_eq!(c.get_request(String::new()), None);
    }

    #[test]
    fn request_view_round_trips_a_stored_record() {
        let mut c = fresh();
        let req = parse(&evm_json());
        let rec = record_of(&req);
        let id = request_id(&rec.task_hash, rec.index);
        c.records.insert(id.clone(), rec);
        let view = c
            .get_request(id.clone())
            .expect("the stored record answers");
        assert_eq!(view.request_id, id);
        assert_eq!(
            view.id, None,
            "a request that was not escalated has no pending number"
        );
        assert_eq!(view.state, RequestState::Blocked);
        assert_eq!(view.amount, Some(U128(10)));
        assert_eq!(view.labels, Some(req.labels));
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["id"], Value::Null);
        assert_eq!(json["state"], "Blocked");
        assert_eq!(json["amount"], "10");
        assert_eq!(json["created_ms"], "1000");
        assert_eq!(json["agent"], "agent.test.near");
        assert_eq!(
            json["labels"],
            json!({ "recipient": 2, "amount": 1, "pc": 1 })
        );
        assert_eq!(json["asset"], "evm:84532:native");
        // an escalation carries its short pending number as a decimal string
        let mut escalated = record_of(&req);
        escalated.state = RequestState::Pending;
        escalated.index = 1;
        escalated.pending = Some(pending_info());
        let id1 = request_id(&escalated.task_hash, 1);
        c.records.insert(id1.clone(), escalated);
        let view = c.get_request(id1).unwrap();
        assert_eq!(view.id.as_deref(), Some("7"));
        assert_eq!(view.state, RequestState::Pending);
    }

    #[test]
    fn request_view_expired_without_pending_is_a_tombstone() {
        let mut c = fresh();
        let req = parse(&base_json());
        let mut rec = record_of(&req);
        rec.state = RequestState::Expired;
        let id = request_id(&rec.task_hash, rec.index);
        c.records.insert(id.clone(), rec);
        let json = serde_json::to_value(c.get_request(id.clone()).unwrap()).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["request_id", "id", "state"]);
        assert_eq!(json["state"], "Expired");
        assert_eq!(json["request_id"], id.as_str());
    }

    #[test]
    fn request_view_same_content_false_for_each_field() {
        let req = parse(&evm_json());
        let rec = record_of(&req);
        assert!(same_content(&rec, &req));
        let mut changed = req.clone();
        changed.asset = "near".to_string();
        assert!(!same_content(&rec, &changed), "asset");
        let mut changed = req.clone();
        changed.payee = "evm:84532:0x0000000000000000000000000000000000000001".to_string();
        assert!(!same_content(&rec, &changed), "payee");
        let mut changed = req.clone();
        changed.amount = U128(11);
        assert!(!same_content(&rec, &changed), "amount");
        let mut changed = req.clone();
        changed.labels.pc = 32;
        assert!(!same_content(&rec, &changed), "labels");
        let mut changed = req.clone();
        changed.evm = None;
        assert!(!same_content(&rec, &changed), "evm");
        let mut changed = req;
        changed.evm.as_mut().unwrap().max_fee_per_gas = U128(1);
        assert!(!same_content(&rec, &changed), "evm fee");
    }
}

use crate::*;
use near_sdk::json_types::U128;

// One NEP-297 standard for every event of the contract (the template used "shade-contract-template"). Each log line is
// EVENT_JSON:{"standard":"airlock","version":"1.0.0","event":"<snake_case name>","data":[{...}]}
// with `data` a one-element array holding the event object (the template's shape; AIR-061 and AIR-064 use it too).
const EVENT_STANDARD: &str = "airlock";
const EVENT_STANDARD_VERSION: &str = "1.0.0";

/// Maximum number of advisory IDs surfaced in an event; the full count is reported
/// separately via `number_of_advisory_ids` to keep event/log size bounded.
pub const MAX_ADVISORY_IDS: usize = 8;

/// Caps advisory IDs to at most [`MAX_ADVISORY_IDS`] for [`Event::AgentRegistered`],
/// returning the capped list together with the true total.
pub fn summarize_advisory_ids(advisory_ids: &[String]) -> (Vec<String>, u16) {
    let number_of_advisory_ids = u16::try_from(advisory_ids.len()).unwrap_or(u16::MAX);
    let advisory_ids_truncated = advisory_ids
        .iter()
        .take(MAX_ADVISORY_IDS)
        .cloned()
        .collect();
    (advisory_ids_truncated, number_of_advisory_ids)
}

#[derive(Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
#[serde(tag = "event", content = "data")]
#[serde(rename_all = "snake_case")]
#[must_use = "Don't forget to `.emit()` this event"]
pub enum Event<'a> {
    AgentRegistered {
        account_id: &'a AccountId,
        measurements: &'a FullMeasurementsHex,
        ppid: &'a Ppid,
        advisory_ids_truncated: Vec<String>,
        number_of_advisory_ids: u16,
        current_time_ms: U64,
        valid_until_ms: U64,
        // Cannot log attestation, it's too large
    },
    AgentRemoved {
        account_id: &'a AccountId,
        reasons: Vec<AgentRemovalReason>,
    },
    // AIR-040
    Paused {
        paused: bool,
    },
    FlagsSet {
        flags: FlagsJson,
    },
    // AIR-045
    TaskKeySet {
        public_key: String,
    },
    TaskRevoked {
        task_hash: String,
    },
    // AIR-046
    AgentAllowed {
        account_id: &'a AccountId,
        fingerprint: &'a str,
    },
    AgentRevoked {
        account_id: &'a AccountId,
    },
    // AIR-042: u128 values are decimal strings
    AssetSet {
        asset: &'a str,
        symbol: &'a str,
        decimals: u8,
        hard_cap: U128,
        daily_cap: U128,
        quick_task_cap: U128,
        path: Option<&'a str>,
    },
    AssetRemoved {
        asset: &'a str,
    },
    // AIR-043: `cap` is a decimal string or null
    BookAdded {
        key: &'a str,
        label: &'a str,
        cap: Option<U128>,
        daily_untrusted_budget: U128,
        daily_limit: U128,
    },
    BookRemoved {
        key: &'a str,
    },
    // AIR-061, the events of `submit_batch`. No agent free text: every string here is a canonical key, a registry id, a reason name
    // or a number the contract derived. u128 values are decimal strings.
    /// One per call, after the task verified: the task hash (64 hex), how many requests the call carries and who sent it.
    Submitted {
        task_hash: String,
        count: u8,
        agent: &'a AccountId,
    },
    /// One per new Allow, with what is left of the three ledgers after its own charge.
    Allowed {
        request_id: &'a str,
        asset: &'a str,
        payee: &'a str,
        amount: U128,
        asset_day_remaining: U128,
        payee_day_remaining: U128,
        task_remaining: Option<U128>,
    },
    /// One per new escalation. `id` is the decimal pending number (the value `approve` takes).
    Escalated {
        request_id: &'a str,
        id: String,
        reason: &'a str,
    },
    /// One per approval (AIR-080): `digest` is the 64 lowercase hex characters of the stored escalation digest, `approver` the owner
    /// account and `block_height` the block of the approval as a decimal string. `id` is the decimal pending number.
    Approved {
        request_id: &'a str,
        id: String,
        digest: String,
        approver: &'a AccountId,
        block_height: U64,
    },
    /// One per new Block, with the `Reason::as_str()` name.
    Blocked {
        request_id: &'a str,
        reason: &'a str,
    },
    // AIR-104: the owner set the next EVM nonce of a derivation path; `nonce` is a decimal string
    NonceSet {
        path: &'a str,
        nonce: U64,
    },
    // AIR-105, the events of the signing callback. Lane events name the request `request_id`, never `id` (`id` is the pending number).
    /// `on_signed` stored a signature. `unsigned_hex` is lowercase hex without `0x`, first byte `02`; `big_r` is 66 characters, `s` 64.
    Signed {
        request_id: &'a str,
        unsigned_hex: &'a str,
        big_r: &'a str,
        s: &'a str,
        recovery_id: u8,
    },
    /// The failure path: `reason` is a `FailReason` name, `retryable` is true when the request may run once more. `fail_request` refunds
    /// the charges (`MpcFailed`, `TransferFailed`, `InsufficientBalance`); `fail_kept_charged` keeps them and always says `retryable`
    /// false (`MpcBadResponse`: the signer answered, so a signature may still exist).
    Failed {
        request_id: &'a str,
        reason: &'a str,
        retryable: bool,
    },
}

impl Event<'_> {
    pub fn emit(&self) {
        let data = serde_json::json!(self);
        let event_json = serde_json::json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_STANDARD_VERSION,
            "event": data["event"],
            "data": [data["data"]]
        })
        .to_string();
        log!("EVENT_JSON:{}", event_json);
    }
}

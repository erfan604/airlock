// AIR-080: escalation storage and the readable `approve`. `store_pending` (AIR-061) calls `pending_info` here, so an escalated request is
// stored with the strings the owner's wallet shows (`display_symbol`, `display_amount`) and a digest of everything the stored request
// will execute with. The owner's call `approve(id, to, asset, amount, why, book)` is compared field by field with that stored card
// (`airlock_verdict::approve::approve_check`, the function Kani checks: the arguments are compared byte for byte and never read for
// anything else), then the contract charges the ledgers, emits `approved` and starts the lane for the stored request.
//
// Pinned decisions (plan/tickets/AIR-080): the arguments never drive execution, the stored record does; `id` is the canonical decimal
// of a u32 (`+7` and `007` are `unknown id`); `pending_by_no` is never removed from, so `get_request(no)` works after the approval and a
// second approve says `NotPending`; the approval charge uses the task bound stored at escalation and saturates at it, and its applied
// charge and day are stored for the refund (AIR-105); `agent_allowed` is the owner's allowlist; task expiry does not block an approval
// (only revocation does); `get_pending` clamps `limit` to 20.
//
// Placement (security): `approve` and `get_pending` are the only `pub fn`s in a `#[near]` impl here. Every other item is a free function
// or lives in a plain `impl Contract`, so none is an exported method: `approve` reaches the execution lanes through `start_execution`.
use crate::gate::EvalCtx;
use crate::ledgers::{LedgerKey, approval_caps, verdict_inputs};
use crate::request::{Hex32, PendingInfo, RequestRecord, RequestState, RequestView, request_id};
use crate::time::utc_day;
use crate::*;
use airlock_verdict::approve::{ApproveArgs, ApproveError, Live, StoredView, approve_check};
use airlock_verdict::{Reason, decimal};

/// The most items `get_pending` returns in one call.
pub const MAX_PENDING_PAGE: u32 = 20;

/// The ordered `(name, borsh type)` list of `DigestPreimage`, as `fixtures/digest-vector.json` carries it in `preimage_layout` and as
/// AIR-085's verifier reads it. A test compares it with the vector file.
pub const PREIMAGE_LAYOUT: [(&str, &str); 11] = [
    ("request_id", "String"),
    ("no", "u32"),
    ("agent", "String"),
    ("task_hash", "[u8; 32]"),
    ("asset", "String"),
    ("payee", "String"),
    ("amount", "u128"),
    ("labels", "[u16; 3]"),
    ("reason", "String"),
    ("book_status", "String"),
    ("evm", "Option<[u128; 3]>"),
];

/// What the digest covers: every field the stored request executes with. The digest of an escalation is `sha256(borsh(DigestPreimage))`
/// (`digest_of`), stored in `PendingInfo.digest` and emitted by `approve`. The borsh bytes are: a `String` as a u32 little-endian
/// length and the UTF-8 bytes; `no` as 4 bytes little-endian; `agent` as the String of the account id; `task_hash` as 32 raw bytes;
/// `amount` as 16 bytes little-endian; `labels` as three u16 little-endian (recipient, amount, pc; SPEC R5-02) with no length;
/// `evm` as a 0 byte, or a 1 byte and then gas limit, max fee per gas and max priority fee per gas as 16 bytes little-endian each.
/// `scripts/gen_digest_vector.mjs` writes the same bytes by hand. There is no `ledger_displayable` field (ticket notes).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DigestPreimage {
    /// The derived `<task hash hex>:<action index>`.
    pub request_id: String,
    /// The short pending number.
    pub no: u32,
    pub agent: AccountId,
    pub task_hash: [u8; 32],
    /// The registry asset id.
    pub asset: String,
    /// The canonical payee key.
    pub payee: String,
    pub amount: u128,
    pub labels: [u16; 3],
    /// `Reason::as_str()`.
    pub reason: String,
    /// `in_book` or `new`.
    pub book_status: String,
    pub evm: Option<[u128; 3]>,
}

/// `sha256(borsh(p))`.
pub fn digest_of(p: &DigestPreimage) -> [u8; 32] {
    let bytes = near_sdk::borsh::to_vec(p)
        .unwrap_or_else(|_| env::panic_str("digest preimage does not serialize"));
    env::sha256_array(&bytes)
}

/// The book status text the owner's screen shows and `approve` compares: `in_book` or `new`.
pub fn book_status(book_in: bool) -> &'static str {
    if book_in { "in_book" } else { "new" }
}

/// The preimage of the escalation `rec` with pending number `no`. `rec.reason` must already hold the verdict reason.
pub fn preimage_of(rec: &RequestRecord, no: u32, book_in: bool) -> DigestPreimage {
    DigestPreimage {
        request_id: request_id(&rec.task_hash, rec.index),
        no,
        agent: rec.agent.clone(),
        task_hash: rec.task_hash,
        asset: rec.asset.clone(),
        payee: rec.payee.clone(),
        amount: rec.amount,
        labels: [rec.labels.recipient, rec.labels.amount, rec.labels.pc],
        reason: rec
            .reason
            .clone()
            .unwrap_or_else(|| env::panic_str("escalation without a reason")),
        book_status: book_status(book_in).to_string(),
        evm: rec.evm.map(|e| {
            [
                e.gas_limit.0,
                e.max_fee_per_gas.0,
                e.max_priority_fee_per_gas.0,
            ]
        }),
    }
}

/// The canonical decimal text of `amount` base units at `decimals` places (`airlock_verdict::decimal::format`, the text `approve`
/// compares). `decimals` above 38 revert; the registry never stores one.
pub fn amount_text(amount: u128, decimals: u8) -> String {
    let (buf, len) =
        decimal::format(amount, decimals).unwrap_or_else(|| env::panic_str("decimals above 38"));
    String::from_utf8(buf[..len].to_vec()).unwrap_or_else(|_| env::panic_str("amount text"))
}

/// The `PendingInfo` of a new escalation, called by `store_pending` once the number and the expiry are known and `rec.reason` is set:
/// the display symbol and amount from the registry as it is now, whether the payee is in the book, the task bound, and the digest.
/// An escalation always has a registered asset (an unregistered one blocks `UnknownAsset` first), so a missing one reverts.
pub fn pending_info(rec: &RequestRecord, ctx: &EvalCtx, no: u32, expires_ms: u64) -> PendingInfo {
    let asset = ctx
        .asset
        .as_ref()
        .unwrap_or_else(|| env::panic_str("escalation without a registered asset"));
    let book_in = ctx.payee.is_some();
    PendingInfo {
        no,
        expires_ms,
        book_in,
        task_bound: ctx.bound.unwrap_or(0),
        display_symbol: asset.symbol.clone(),
        display_amount: amount_text(rec.amount, asset.decimals),
        digest: Hex32(digest_of(&preimage_of(rec, no, book_in))),
    }
}

/// The pending number in `id`, only when `id` is the canonical decimal of a `u32`: ASCII digits only, at most 10, no leading zero. `+7`
/// and `007` both parse to 7 as a `u32`, so the text is formatted back and compared.
pub fn parse_pending_no(id: &str) -> Option<u32> {
    if id.is_empty() || id.len() > 10 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let no: u32 = id.parse().ok()?;
    (no.to_string() == id).then_some(no)
}

/// The verdict reason named `s`, for the seven reasons that escalate (GLOSSARY). The contract-added reasons (`PendingFull`,
/// `EscalationsLocked`, `EscalationBudget`) and the Block reasons only produce Blocked records, never Pending ones, so they answer
/// `None`.
pub fn escalate_reason_from_name(s: &str) -> Option<Reason> {
    Some(match s {
        "OutsideTask" => Reason::OutsideTask,
        "OverTaskBound" => Reason::OverTaskBound,
        "UntrustedTrigger" => Reason::UntrustedTrigger,
        "UntrustedRecipient" => Reason::UntrustedRecipient,
        "NewRecipient" => Reason::NewRecipient,
        "OverPayeeLimit" => Reason::OverPayeeLimit,
        "UntrustedAmount" => Reason::UntrustedAmount,
        _ => return None,
    })
}

/// The revert of a refused approve: `approve rejected: <as_str>`.
fn reject(e: ApproveError) -> ! {
    env::panic_str(&format!("approve rejected: {}", e.as_str()))
}

impl Contract {
    /// Records the number of a new escalation in both indexes (`store_pending` calls it). `pending_by_no` is never removed from.
    pub fn index_pending(&mut self, no: u32, id: &str) {
        self.pending_by_no.insert(no, id.to_string());
        self.pending_nos.insert(no);
    }

    /// The request id and the record of the escalation with this number, whatever its state; `None` for a number nobody was given.
    pub fn pending_record(&self, no: u32) -> Option<(String, RequestRecord)> {
        let id = self.pending_by_no.get(&no)?;
        let rec = self.records.get(id)?;
        Some((id.clone(), rec.clone()))
    }
}

#[near]
impl Contract {
    /// Owner: approve the escalation with short number `id`, naming the five readable values of its card. `#[payable]`, exactly 1
    /// yoctoNEAR from the owner (`owner_call`, the first statement). In this order, each failure a revert:
    ///  1. `id` is the canonical decimal of a `u32` and names an escalation, otherwise `unknown id`;
    ///  2. `approve_check` (AIR-026) compares `to`, `asset`, `amount`, `why` and `book` byte for byte with the stored card, built from the
    ///     stored record and the registry decimals read now, and rechecks pending, expiry, the agent's allowance, task revocation, the
    ///     pause and the asset limits: the revert text is `approve rejected: <error>`;
    ///  3. the ledgers are charged with `charge_approval` (the task part saturates at the bound stored at escalation), the applied
    ///     charge and the day are stored on the record, the state becomes `Executing` and the number leaves `pending_nos`;
    ///  4. `approved` is emitted and `start_execution` runs the lane for the stored request (its promise is detached).
    ///
    /// The arguments are only compared: the stored request executes, never the arguments.
    #[payable]
    pub fn approve(
        &mut self,
        id: String,
        to: String,
        asset: String,
        amount: String,
        why: String,
        book: String,
    ) {
        self.owner_call();
        let no = parse_pending_no(&id).unwrap_or_else(|| env::panic_str("unknown id"));
        let (request_key, mut rec) = self
            .pending_record(no)
            .unwrap_or_else(|| env::panic_str("unknown id"));
        let now_ms = block_timestamp_ms();
        // a record whose escalation data was freed (the `Expired` tombstone of AIR-081) is not pending
        let pending = rec
            .pending
            .clone()
            .unwrap_or_else(|| reject(ApproveError::NotPending));
        let is_pending = rec.state == RequestState::Pending;
        let Some(asset_entry) = self.asset(&rec.asset) else {
            // the amount text needs the registry decimals, which a removed asset no longer has: answer the checks that need none in
            // the order of `approve_check`, and otherwise the recheck's verdict, `Limit:UnknownAsset`
            reject(if !is_pending {
                ApproveError::NotPending
            } else if now_ms >= pending.expires_ms {
                ApproveError::Expired
            } else {
                ApproveError::Limit(Reason::UnknownAsset)
            })
        };
        let key = LedgerKey {
            asset: rec.asset.clone(),
            payee: rec.payee.clone(),
            task_hash: rec.task_hash,
        };
        let reason = escalate_reason_from_name(rec.reason.as_deref().unwrap_or_default())
            .unwrap_or_else(|| env::panic_str("stored reason is not an escalation reason"));
        let stored = StoredView {
            payee_key: rec.payee.as_bytes(),
            asset_symbol: pending.display_symbol.as_bytes(),
            amount: rec.amount,
            decimals: asset_entry.decimals,
            reason,
            in_book: pending.book_in,
            expires_ms: pending.expires_ms,
            pending: is_pending,
        };
        let args = ApproveArgs {
            to: to.as_bytes(),
            asset: asset.as_bytes(),
            amount: amount.as_bytes(),
            why: why.as_bytes(),
            book: book.as_bytes(),
        };
        // `remaining_daily` is the asset's daily cap minus today's asset spend; the payee and the task are not part of the recheck
        let limits = verdict_inputs(
            Some(&asset_entry),
            None,
            None,
            &self.spent_now(&key, now_ms),
        )
        .asset;
        let live = Live {
            now_ms,
            agent_allowed: self.is_agent_allowed(rec.agent.clone()),
            task_revoked: self.is_task_revoked(&rec.task_hash),
            paused: self.paused,
        };
        if let Err(e) = approve_check(&stored, &args, &rec.to_verdict(), limits, &live) {
            reject(e);
        }
        // the escalation leaves the agent's pending count and the consecutive reject streak ends (AIR-083); a revert after this point
        // reverts the counters with the call
        self.flood_after_approve(&rec.agent);
        // charge: the payee is read now (a payee that left the book has no limit, and its day ledger still records the payment)
        let payee = self.payee(&rec.payee);
        let caps = approval_caps(&asset_entry, payee.as_ref(), pending.task_bound);
        let charge = self.charge_approval(&key, &caps, rec.amount, now_ms);
        rec.applied_charge = Some(charge);
        rec.charge_day = utc_day(now_ms);
        rec.state = RequestState::Executing;
        self.pending_nos.remove(&no);
        self.records.insert(request_key.clone(), rec);
        Event::Approved {
            request_id: &request_key,
            id: no.to_string(),
            digest: pending.digest.to_hex(),
            approver: &env::predecessor_account_id(),
            block_height: U64(env::block_height()),
        }
        .emit();
        if let Some(promise) = self.start_execution(&request_key) {
            promise.detach();
        }
    }

    /// The escalations still Pending, by ascending number: `from_index` of them are skipped and at most `limit` returned, `limit`
    /// clamped to 20 (the default). Never reverts. The set is sorted on every call because removing a number reorders it; it is
    /// bounded by (allowed agents) times `max_pending_per_agent`. The items are the `get_request` views, so the console card prints
    /// `id`, `payee`, `display`, `reason`, `book_status`, `expires_ms` and `digest` from them.
    pub fn get_pending(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<RequestView> {
        let mut numbers: Vec<u32> = self.pending_nos.iter().copied().collect();
        numbers.sort_unstable();
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_PENDING_PAGE).min(MAX_PENDING_PAGE) as usize;
        numbers
            .into_iter()
            .skip(from)
            .take(limit)
            .filter_map(|no| self.pending_record(no))
            .map(|(_, rec)| RequestView::from_record(&rec))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{AllowedAgent, fingerprint};
    use crate::policy::AssetEntry;
    use crate::request::{ChargeRec, EvmParams, Labels};
    use crate::testutil::{OWNER, ctx, fresh};
    use airlock_verdict::ALL_REASONS;
    use airlock_verdict::ledger::{Spent, apply_approval, charge_for_approval};
    use near_sdk::borsh;
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::get_logs;
    use near_sdk::testing_env;
    use serde_json::{Value, json};

    const AGENT: &str = "agent.test.near";
    const BOB: &str = "near:bob.test.near";
    const DAY_MS: u64 = 86_400_000;
    /// Day 3 of the epoch, so the stored `charge_day` is not the default 0.
    const NOW: u64 = 3 * DAY_MS + 5_000;
    const TTL_MS: u64 = 3_600_000;

    const VECTOR: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/digest-vector.json"
    ));

    fn near(n: u128) -> u128 {
        n * 1_000_000_000_000_000_000_000_000
    }

    fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default()
    }

    fn panics<R>(f: impl FnOnce() -> R) -> String {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(_) => panic!("expected a revert, the call succeeded"),
            Err(payload) => panic_text(payload),
        }
    }

    fn asset_entry() -> AssetEntry {
        AssetEntry {
            symbol: "NEAR".to_string(),
            decimals: 24,
            hard_cap: near(10_000),
            daily_cap: near(100_000),
            max_fee_per_gas: 0,
            max_gas: 0,
            quick_task_cap: near(100_000),
            path: None,
        }
    }

    /// A contract with asset `near` and `AGENT` allowed, at block time `NOW` as the owner with 1 yocto.
    fn setup() -> Contract {
        let mut c = fresh();
        c.assets.insert("near".to_string(), asset_entry());
        c.allowed_agents.insert(
            AGENT.parse().unwrap(),
            AllowedAgent {
                fingerprint: fingerprint(AGENT),
                allowed_ms: 0,
            },
        );
        testing_env!(ctx(OWNER, NOW, 1).build());
        c
    }

    /// A Pending escalation built by hand through the `pub` fields (index 0 of the task with hash `[task; 32]`), registered in both
    /// pending indexes the way `store_pending` registers it. Returns its request id.
    fn put_pending(
        c: &mut Contract,
        no: u32,
        task: u8,
        payee: &str,
        amount: u128,
        reason: Reason,
        task_bound: u128,
    ) -> String {
        put_pending_in(c, no, task, "near", payee, amount, reason, task_bound, None)
    }

    /// `put_pending` for any registered asset, with the EVM parameters of an EVM request.
    #[allow(clippy::too_many_arguments)]
    fn put_pending_in(
        c: &mut Contract,
        no: u32,
        task: u8,
        asset: &str,
        payee: &str,
        amount: u128,
        reason: Reason,
        task_bound: u128,
        evm: Option<EvmParams>,
    ) -> String {
        let entry = c.asset(asset).expect("a registered asset");
        let mut rec = RequestRecord {
            agent: AGENT.parse().unwrap(),
            task_hash: [task; 32],
            task_id: "task-1".to_string(),
            index: 0,
            asset: asset.to_string(),
            payee: payee.to_string(),
            amount,
            labels: Labels {
                recipient: 1,
                amount: 1,
                pc: 1,
            },
            evm,
            reason: Some(reason.as_str().to_string()),
            state: RequestState::Pending,
            retried: false,
            applied_charge: None,
            charge_day: 0,
            created_ms: NOW,
            pending: None,
            exec: None,
        };
        let book_in = c.payee(payee).is_some();
        rec.pending = Some(PendingInfo {
            no,
            expires_ms: NOW + TTL_MS,
            book_in,
            task_bound,
            display_symbol: entry.symbol.clone(),
            display_amount: amount_text(amount, entry.decimals),
            digest: Hex32(digest_of(&preimage_of(&rec, no, book_in))),
        });
        let id = request_id(&rec.task_hash, rec.index);
        c.records.insert(id.clone(), rec);
        c.index_pending(no, &id);
        id
    }

    /// The six strings of the card of a pending record, as the console sends them.
    fn card(c: &Contract, no: u32) -> [String; 6] {
        let (_, rec) = c.pending_record(no).expect("a record");
        let p = rec.pending.expect("pending");
        [
            no.to_string(),
            rec.payee,
            p.display_symbol,
            p.display_amount,
            rec.reason.expect("a reason"),
            book_status(p.book_in).to_string(),
        ]
    }

    fn approve_card(c: &mut Contract, card: &[String; 6]) {
        c.approve(
            card[0].clone(),
            card[1].clone(),
            card[2].clone(),
            card[3].clone(),
            card[4].clone(),
            card[5].clone(),
        );
    }

    // ---- names, ids, text ----------------------------------------------------------------------------------------------------

    /// The seven reasons that escalate round trip through `Reason::as_str`; every other reason, including the three the contract adds
    /// for Blocked records, answers `None`.
    #[test]
    fn escalate_reason_from_name_round_trips_through_as_str() {
        let escalating = [
            Reason::OutsideTask,
            Reason::OverTaskBound,
            Reason::UntrustedTrigger,
            Reason::UntrustedRecipient,
            Reason::NewRecipient,
            Reason::OverPayeeLimit,
            Reason::UntrustedAmount,
        ];
        for r in escalating {
            assert_eq!(escalate_reason_from_name(r.as_str()), Some(r), "{r:?}");
        }
        let mut others = 0;
        for r in ALL_REASONS {
            if !escalating.contains(&r) {
                assert_eq!(escalate_reason_from_name(r.as_str()), None, "{r:?}");
                others += 1;
            }
        }
        assert_eq!(others, 10);
        for text in ["", "outsidetask", "OutsideTask ", "Allow"] {
            assert_eq!(escalate_reason_from_name(text), None, "{text:?}");
        }
    }

    #[test]
    fn parse_pending_no_accepts_only_the_canonical_decimal() {
        assert_eq!(parse_pending_no("1"), Some(1));
        assert_eq!(parse_pending_no("0"), Some(0));
        assert_eq!(parse_pending_no("4294967295"), Some(u32::MAX));
        for bad in [
            "",
            "+7",
            "007",
            "01",
            "-1",
            " 1",
            "1 ",
            "0x1",
            "1.0",
            "4294967296",
            "00000000001",
            "99999999999",
            "\u{0661}",
            "1e3",
        ] {
            assert_eq!(parse_pending_no(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn amount_text_is_the_canonical_decimal() {
        assert_eq!(amount_text(near(1), 24), "1");
        assert_eq!(amount_text(near(9) + near(4) / 10, 24), "9.4");
        assert_eq!(amount_text(1, 24), "0.000000000000000000000001");
        assert_eq!(amount_text(0, 24), "0");
        assert_eq!(amount_text(1_500_000, 6), "1.5");
        assert_eq!(amount_text(7, 0), "7");
        assert!(panics(|| amount_text(1, 39)).contains("decimals above 38"));
    }

    // ---- the digest ----------------------------------------------------------------------------------------------------------

    fn preimage(evm: Option<[u128; 3]>) -> DigestPreimage {
        DigestPreimage {
            request_id: "ab:0".to_string(),
            no: 7,
            agent: AGENT.parse().unwrap(),
            task_hash: [0xcd; 32],
            asset: "near".to_string(),
            payee: BOB.to_string(),
            amount: (1u128 << 64) + 5,
            labels: [2, 1, 4],
            reason: "NewRecipient".to_string(),
            book_status: "new".to_string(),
            evm,
        }
    }

    fn le_string(s: &str) -> Vec<u8> {
        let mut out = u32::try_from(s.len()).unwrap().to_le_bytes().to_vec();
        out.extend_from_slice(s.as_bytes());
        out
    }

    /// The borsh bytes are the ones written down in the doc of `DigestPreimage`, field by field, for the NEAR shape (`evm` absent:
    /// one 0 byte) and the EVM shape (a 1 byte and three 16 byte numbers).
    #[test]
    fn digest_preimage_borsh_is_the_documented_layout() {
        let mut want = Vec::new();
        want.extend(le_string("ab:0"));
        want.extend(7u32.to_le_bytes());
        want.extend(le_string(AGENT));
        want.extend([0xcd; 32]);
        want.extend(le_string("near"));
        want.extend(le_string(BOB));
        want.extend(((1u128 << 64) + 5).to_le_bytes());
        want.extend([2, 0, 1, 0, 4, 0]);
        want.extend(le_string("NewRecipient"));
        want.extend(le_string("new"));
        let near_shape = borsh::to_vec(&preimage(None)).unwrap();
        let mut with_none = want.clone();
        with_none.push(0);
        assert_eq!(near_shape, with_none);
        let evm = [21_000u128, 2_000_000_000, 1_000_000_000];
        let mut with_some = want;
        with_some.push(1);
        for n in evm {
            with_some.extend(n.to_le_bytes());
        }
        assert_eq!(borsh::to_vec(&preimage(Some(evm))).unwrap(), with_some);
        assert_eq!(with_some.len(), with_none.len() + 48);
        // an account id is written as its String
        let agent: AccountId = AGENT.parse().unwrap();
        assert_eq!(
            borsh::to_vec(&agent).unwrap(),
            borsh::to_vec(&AGENT.to_string()).unwrap()
        );
    }

    /// The vector file `scripts/gen_digest_vector.mjs` writes gives the same bytes and digest through the contract's types, so the
    /// check runs in `scripts/check.sh quick` and not only in the sandbox suite.
    #[test]
    fn digest_vector_bytes_and_digest_match_the_contract() {
        let v: Value = serde_json::from_str(VECTOR).unwrap();
        let r = &v["record"];
        let text = |k: &str| r[k].as_str().unwrap().to_string();
        let big = |value: &Value| value.as_str().unwrap().parse::<u128>().unwrap();
        let labels: Vec<u16> = r["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| u16::try_from(n.as_u64().unwrap()).unwrap())
            .collect();
        let evm = r["evm"]
            .as_array()
            .map(|t| [big(&t[0]), big(&t[1]), big(&t[2])]);
        let p = DigestPreimage {
            request_id: text("request_id"),
            no: u32::try_from(r["no"].as_u64().unwrap()).unwrap(),
            agent: text("agent").parse().unwrap(),
            task_hash: hex::decode(text("task_hash")).unwrap().try_into().unwrap(),
            asset: text("asset"),
            payee: text("payee"),
            amount: big(&r["amount"]),
            labels: [labels[0], labels[1], labels[2]],
            reason: text("reason"),
            book_status: text("book_status"),
            evm,
        };
        assert_eq!(hex::encode(borsh::to_vec(&p).unwrap()), v["borsh_hex"]);
        assert_eq!(hex::encode(digest_of(&p)), v["digest"]);
        let layout: Vec<(String, String)> = v["preimage_layout"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["name"].as_str().unwrap().to_string(),
                    f["borsh_type"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let own: Vec<(String, String)> = PREIMAGE_LAYOUT
            .iter()
            .map(|(n, t)| ((*n).to_string(), (*t).to_string()))
            .collect();
        assert_eq!(layout, own);
    }

    // ---- store time ----------------------------------------------------------------------------------------------------------

    /// `store_pending` fills the display strings from the registry, the digest from the preimage, and records the number in both
    /// indexes; `get_request` by that number answers the same view.
    #[test]
    fn store_pending_fills_display_digest_and_indexes() {
        let mut c = setup();
        let rec = RequestRecord {
            agent: AGENT.parse().unwrap(),
            task_hash: [4; 32],
            task_id: "task-1".to_string(),
            index: 2,
            asset: "near".to_string(),
            payee: BOB.to_string(),
            amount: near(9) + near(4) / 10,
            labels: Labels {
                recipient: 1,
                amount: 1,
                pc: 1,
            },
            evm: Some(EvmParams {
                gas_limit: U128(21_000),
                max_fee_per_gas: U128(7),
                max_priority_fee_per_gas: U128(1),
            }),
            reason: None,
            state: RequestState::Blocked,
            retried: false,
            applied_charge: None,
            charge_day: 0,
            created_ms: NOW,
            pending: None,
            exec: None,
        };
        let key = LedgerKey {
            asset: "near".to_string(),
            payee: BOB.to_string(),
            task_hash: [4; 32],
        };
        let ectx = EvalCtx {
            asset_id: "near".to_string(),
            asset: Some(asset_entry()),
            payee_key: BOB.to_string(),
            payee: None,
            bound: Some(near(50)),
            key: key.clone(),
            spent: c.spent_now(&key, NOW),
            now_ms: NOW,
        };
        let no = c.store_pending(rec, &ectx, Reason::NewRecipient);
        assert_eq!(no, 1);
        let id = request_id(&[4; 32], 2);
        let stored = c.records.get(&id).cloned().expect("stored");
        let p = stored.pending.clone().expect("pending");
        assert_eq!(p.display_symbol, "NEAR");
        assert_eq!(p.display_amount, "9.4");
        assert!(!p.book_in);
        assert_eq!(p.task_bound, near(50));
        assert_eq!(p.expires_ms, NOW + TTL_MS);
        assert_eq!(p.digest, Hex32(digest_of(&preimage_of(&stored, 1, false))));
        assert_ne!(p.digest, Hex32([0; 32]));
        // the digest covers the EVM parameters the record keeps
        assert_eq!(preimage_of(&stored, 1, false).evm, Some([21_000, 7, 1]));
        assert_eq!(c.pending_by_no.get(&1), Some(&id));
        assert!(c.pending_nos.contains(&1));
        let by_number = c.get_request("1".to_string()).expect("a view");
        assert_eq!(by_number.request_id, id);
        assert_eq!(by_number.id.as_deref(), Some("1"));
        assert_eq!(by_number.book_status.as_deref(), Some("new"));
        let display = by_number.display.expect("a display");
        assert_eq!(display.asset_symbol, "NEAR");
        assert_eq!(display.amount_decimal, "9.4");
        assert_eq!(by_number.digest, Some(p.digest.to_hex()));
        assert_eq!(by_number.expires_ms, Some(U64(NOW + TTL_MS)));
    }

    // ---- approve -------------------------------------------------------------------------------------------------------------

    /// AIR-080 check 4: a Pending record built by hand, `approve` as the owner with 1 yocto. Afterwards `applied_charge` is the charge
    /// of `approval_caps` (the asset day takes the whole amount, the payee day and the task ledger saturate: the payee is not in the
    /// book and has no limit, and the stored task bound of 2 NEAR is below the amount of 3), `charge_day` is the UTC day of the
    /// approval, the record is `Executing`, the number left `pending_nos` and stayed in `pending_by_no`, and `approved` was emitted.
    #[test]
    fn approve_stores_applied_charge() {
        let mut c = setup();
        let id = put_pending(&mut c, 1, 9, BOB, near(3), Reason::NewRecipient, near(2));
        let card = card(&c, 1);
        let digest = c.records.get(&id).unwrap().pending.clone().unwrap().digest;
        approve_card(&mut c, &card);
        let rec = c.records.get(&id).cloned().expect("the record stays");
        assert_eq!(rec.state, RequestState::Executing);
        let charge = rec.applied_charge.clone().expect("a stored charge");
        // the charge the ledger model computes from the caps of an approval
        let caps = approval_caps(&asset_entry(), None, near(2));
        let (_, applied) = apply_approval(
            &Spent {
                asset_day: 0,
                payee_day: 0,
                payee_untrusted_day: 0,
                task: 0,
            },
            &charge_for_approval(near(3)),
            &caps,
        )
        .expect("the asset day has room");
        assert_eq!(charge, ChargeRec::from(applied));
        // and the numbers written out
        assert_eq!(
            charge,
            ChargeRec {
                asset_day: near(3),
                payee_day: near(3),
                payee_untrusted_day: 0,
                task: near(2),
            }
        );
        assert_eq!(rec.charge_day, NOW / DAY_MS);
        assert_eq!(rec.charge_day, 3);
        // the ledgers hold exactly that charge
        let key = LedgerKey {
            asset: "near".to_string(),
            payee: BOB.to_string(),
            task_hash: [9; 32],
        };
        let spent = c.spent_now(&key, NOW);
        assert_eq!(
            (
                spent.asset_day,
                spent.payee_day,
                spent.payee_untrusted_day,
                spent.task
            ),
            (near(3), near(3), 0, near(2))
        );
        assert!(!c.pending_nos.contains(&1));
        assert_eq!(c.pending_by_no.get(&1), Some(&id));
        // the digest on the record is untouched and is what the event carries
        assert_eq!(rec.pending.unwrap().digest, digest);
        let logs: Vec<Value> = get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| serde_json::from_str(j).unwrap())
            .collect();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert_eq!(logs[0]["event"], "approved");
        let data = &logs[0]["data"][0];
        assert_eq!(data["request_id"], id.as_str());
        assert_eq!(data["id"], "1");
        assert_eq!(data["digest"], digest.to_hex().as_str());
        assert_eq!(data["approver"], OWNER);
        assert_eq!(
            data,
            &json!({
                "request_id": id,
                "id": "1",
                "digest": digest.to_hex(),
                "approver": OWNER,
                "block_height": data["block_height"].clone()
            })
        );
        assert!(
            data["block_height"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .is_ok(),
            "{data}"
        );
        // a second approve says NotPending, not `unknown id`
        let text = panics(|| approve_card(&mut c, &card));
        assert!(text.contains("approve rejected: NotPending"), "{text}");
    }

    /// The check runs before any write: a wrong argument reverts and the record, both indexes and every ledger are as they were.
    #[test]
    fn approve_with_a_wrong_argument_changes_nothing() {
        let mut c = setup();
        let id = put_pending(&mut c, 1, 9, BOB, near(3), Reason::NewRecipient, near(50));
        let good = card(&c, 1);
        let before = c.records.get(&id).cloned().unwrap();
        let wrong = [
            (1usize, "near:other.test.near", "WrongRecipient"),
            (2, "near", "WrongAsset"),
            (3, "3.0", "WrongAmount"),
            (4, "OutsideTask", "WrongReason"),
            (5, "in_book", "WrongBook"),
        ];
        for (index, text, error) in wrong {
            let mut bad = good.clone();
            bad[index] = text.to_string();
            let got = panics(|| approve_card(&mut c, &bad));
            assert!(
                got.contains(&format!("approve rejected: {error}")),
                "{error}: {got}"
            );
        }
        assert_eq!(c.records.get(&id).cloned().unwrap(), before);
        assert!(c.pending_nos.contains(&1));
        let key = LedgerKey {
            asset: "near".to_string(),
            payee: BOB.to_string(),
            task_hash: [9; 32],
        };
        let spent = c.spent_now(&key, NOW);
        assert_eq!(
            (
                spent.asset_day,
                spent.payee_day,
                spent.payee_untrusted_day,
                spent.task
            ),
            (0, 0, 0, 0)
        );
        assert!(get_logs().is_empty());
    }

    /// `owner_call` is the first statement: a stranger, no deposit and two yocto each revert before the id is looked at.
    #[test]
    fn approve_starts_with_the_owner_guard() {
        let mut c = setup();
        put_pending(&mut c, 1, 9, BOB, near(3), Reason::NewRecipient, near(50));
        let good = card(&c, 1);
        testing_env!(ctx("stranger.test.near", NOW, 1).build());
        let text = panics(|| approve_card(&mut c, &good));
        assert!(text.contains("Caller is not the owner"), "{text}");
        for deposit in [0u128, 2] {
            testing_env!(ctx(OWNER, NOW, deposit).build());
            let text = panics(|| approve_card(&mut c, &good));
            assert!(
                text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
                "{text}"
            );
        }
        // a bad id is told after the guard, so a stranger learns nothing about ids
        testing_env!(ctx("stranger.test.near", NOW, 1).build());
        let mut bad_id = good.clone();
        bad_id[0] = "9".to_string();
        let text = panics(|| approve_card(&mut c, &bad_id));
        assert!(text.contains("Caller is not the owner"), "{text}");
        testing_env!(ctx(OWNER, NOW, 1).build());
        let text = panics(|| approve_card(&mut c, &bad_id));
        assert!(text.contains("unknown id"), "{text}");
    }

    /// The stored decimals can change under a card: the amount is compared with the registry decimals read now, so the approve fails
    /// closed with `WrongAmount`; and a removed asset fails with `Limit:UnknownAsset` after the checks that need no decimals.
    #[test]
    fn approve_reads_the_registry_now() {
        let mut c = setup();
        put_pending(&mut c, 1, 9, BOB, near(3), Reason::NewRecipient, near(50));
        let good = card(&c, 1);
        let mut entry = asset_entry();
        entry.decimals = 18;
        c.assets.insert("near".to_string(), entry);
        let text = panics(|| approve_card(&mut c, &good));
        assert!(text.contains("approve rejected: WrongAmount"), "{text}");
        c.assets.remove("near");
        let text = panics(|| approve_card(&mut c, &good));
        assert!(
            text.contains("approve rejected: Limit:UnknownAsset"),
            "{text}"
        );
        // an expired card says so before the asset is missed
        testing_env!(ctx(OWNER, NOW + TTL_MS, 1).build());
        let text = panics(|| approve_card(&mut c, &good));
        assert!(text.contains("approve rejected: Expired"), "{text}");
    }

    /// The recheck reads the stored EVM parameters against the registry as it is now: a fee cap lowered after the escalation fails the
    /// approve `Limit:FeeTooHigh` and changes nothing, and with the cap back the same card goes through.
    #[test]
    fn approve_rechecks_the_evm_fee_of_the_stored_request() {
        let mut c = setup();
        let evm_asset = |max_fee_per_gas: u128| AssetEntry {
            symbol: "ETH.base".to_string(),
            decimals: 18,
            hard_cap: 10_000_000_000_000_000_000,
            daily_cap: 100_000_000_000_000_000_000,
            max_fee_per_gas,
            max_gas: 100_000,
            quick_task_cap: 100_000_000_000_000_000_000,
            path: Some("base-sepolia-1".to_string()),
        };
        c.assets
            .insert("evm:84532:native".to_string(), evm_asset(100));
        let payee = "evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
        let id = put_pending_in(
            &mut c,
            1,
            9,
            "evm:84532:native",
            payee,
            1_500_000_000_000_000_000,
            Reason::NewRecipient,
            10_000_000_000_000_000_000,
            Some(EvmParams {
                gas_limit: U128(21_000),
                max_fee_per_gas: U128(50),
                max_priority_fee_per_gas: U128(1),
            }),
        );
        let good = card(&c, 1);
        assert_eq!(good[2], "ETH.base");
        assert_eq!(good[3], "1.5");
        c.assets
            .insert("evm:84532:native".to_string(), evm_asset(10));
        let text = panics(|| approve_card(&mut c, &good));
        assert!(
            text.contains("approve rejected: Limit:FeeTooHigh"),
            "{text}"
        );
        assert_eq!(c.records.get(&id).unwrap().state, RequestState::Pending);
        c.assets
            .insert("evm:84532:native".to_string(), evm_asset(100));
        // the approve now reaches the EVM lane (AIR-100), which needs the owner's nonce for the path
        c.nonces.insert("base-sepolia-1".to_string(), 0);
        approve_card(&mut c, &good);
        let rec = c.records.get(&id).cloned().unwrap();
        assert_eq!(rec.state, RequestState::Executing);
        assert_eq!(rec.evm.unwrap().max_fee_per_gas, U128(50));
        let charge = rec.applied_charge.unwrap();
        assert_eq!(charge.asset_day, 1_500_000_000_000_000_000);
    }

    // ---- views ---------------------------------------------------------------------------------------------------------------

    /// `get_pending` sorts by number whatever order the set holds, slices from `from_index`, clamps `limit` to 20 and never reverts.
    #[test]
    fn get_pending_sorts_clamps_and_never_reverts() {
        let mut c = setup();
        for no in (1..=25u32).rev() {
            let task = u8::try_from(no).unwrap();
            put_pending(
                &mut c,
                no,
                task,
                BOB,
                near(1),
                Reason::NewRecipient,
                near(50),
            );
        }
        let ids = |v: Vec<RequestView>| -> Vec<String> {
            v.into_iter().map(|item| item.id.expect("an id")).collect()
        };
        let want = |range: std::ops::RangeInclusive<u32>| -> Vec<String> {
            range.map(|n| n.to_string()).collect()
        };
        assert_eq!(ids(c.get_pending(Some(0), Some(500))), want(1..=20));
        assert_eq!(ids(c.get_pending(None, None)), want(1..=20));
        assert_eq!(ids(c.get_pending(Some(0), Some(3))), want(1..=3));
        assert_eq!(ids(c.get_pending(Some(20), Some(500))), want(21..=25));
        assert_eq!(ids(c.get_pending(Some(24), Some(10))), want(25..=25));
        assert!(c.get_pending(Some(25), Some(10)).is_empty());
        assert!(c.get_pending(Some(u32::MAX), Some(u32::MAX)).is_empty());
        assert!(c.get_pending(Some(0), Some(0)).is_empty());
        // an approved number leaves the list and still resolves
        let card3 = card(&c, 3);
        approve_card(&mut c, &card3);
        assert_eq!(
            ids(c.get_pending(Some(0), Some(4))),
            ["1", "2", "4", "5"].map(String::from)
        );
        assert_eq!(
            c.get_request("3".to_string()).unwrap().state,
            RequestState::Executing
        );
    }

    /// Every field of the card is filled for every record with `pending` set whose state is not `Expired` (after the approval the
    /// record is `Executing`), and the `Expired` tombstone with no `pending` keeps answering three keys.
    #[test]
    fn get_request_fills_the_card_after_the_approval() {
        let mut c = setup();
        let id = put_pending(&mut c, 1, 9, BOB, near(3), Reason::NewRecipient, near(50));
        let before = serde_json::to_value(c.get_request(id.clone()).unwrap()).unwrap();
        let card1 = card(&c, 1);
        approve_card(&mut c, &card1);
        let after = serde_json::to_value(c.get_request(id.clone()).unwrap()).unwrap();
        assert_eq!(after["state"], "Executing");
        for key in ["id", "book_status", "display", "expires_ms", "digest"] {
            assert!(!after[key].is_null(), "{key}: {after}");
            assert_eq!(after[key], before[key], "{key}");
        }
        assert_eq!(
            after["display"],
            json!({ "asset_symbol": "NEAR", "amount_decimal": "3" })
        );
        assert_eq!(after["book_status"], "new");
        // the tombstone of AIR-081 (an Expired record with its escalation data freed) answers request_id, id and state only
        let mut tomb = c.records.get(&id).cloned().unwrap();
        tomb.state = RequestState::Expired;
        tomb.pending = None;
        c.records.insert(id.clone(), tomb);
        let json = serde_json::to_value(c.get_request(id).unwrap()).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["request_id", "id", "state"]);
        // a number that is not canonical decimal, or was never given, answers None
        for text in ["+1", "01", "2", "", "x"] {
            assert!(c.get_request(text.to_string()).is_none(), "{text:?}");
        }
    }
}

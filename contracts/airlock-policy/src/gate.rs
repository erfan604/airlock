// AIR-061: the `submit_batch` gate, the one method every payment goes through. It takes at most 3 requests under one owner-signed task,
// runs the proven verdict (`airlock_verdict::verdict`) on each in order against ledgers that already hold the charge of the request
// before, charges the four ledgers of every Allow before the next verdict, stores one record per request and emits the events. The
// verdict decides every outcome; this file only loads its inputs, stores what it answered and moves the ledgers.
//
// Placement (security): `submit_batch` and the read only `preview` (AIR-064) are the only `pub fn`s in a `#[near]` impl here. `evaluate`,
// `store_pending`, `start_execution` and every other helper live in a plain `impl Contract`, so none of them is an exported method: a
// helper in the `#[near]` block would be callable by anyone, and `start_execution` reaches MPC signing once AIR-100 and AIR-101 land
// (`tests/gate.rs::helpers_not_exported`).
//
// The agent never chooses an id, a nonce, a path or an asset: the request id is derived from the task hash and the action index
// (`request_id`), and the asset must be the one the payee key implies. Pause blocks every request (verdict rule 1), and there is no
// other signing path.
use crate::escalation::pending_info;
use crate::keys::{asset_for_payee_key, validate_payee_key};
use crate::ledgers::{LedgerKey, caps_for, is_untrusted_amount, verdict_inputs};
use crate::policy::{AssetEntry, BookEntry, MIN_EVM_GAS};
use crate::request::{
    ChargeRec, RequestRecord, RequestState, SubmitOutcome, SubmitRequest, check_labels, request_id,
    same_content,
};
use crate::task::{OwnerTask, VerifiedTask, task_hash};
use crate::time::utc_day;
use crate::*;
use airlock_verdict::ledger::{Spent, charge_for_allow};
use airlock_verdict::{Reason, Verdict};
use near_sdk::PromiseOrValue;
use near_sdk::json_types::{Base64VecU8, U128};

/// The most requests one call carries (gas; the number of requests of a task is bounded by its `max_actions`).
pub const MAX_BATCH: usize = 3;

/// What the verdict was given and what it answered for one request, read only: `submit_batch` stores from it and AIR-064's `preview`
/// reads the verdict. `asset` and `payee` are the registry and book entries (`None` when absent), `bound` the task bound of the payee,
/// `key` and `spent` the ledger keys and what they held at `now_ms`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvalCtx {
    pub asset_id: String,
    pub asset: Option<AssetEntry>,
    pub payee_key: String,
    pub payee: Option<BookEntry>,
    pub bound: Option<u128>,
    pub key: LedgerKey,
    pub spent: Spent,
    pub now_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluated {
    pub verdict: Verdict,
    pub ctx: EvalCtx,
}

/// What an Allow would charge to the four ledgers, as decimal strings (`ChargeRec` on the wire, AIR-064).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChargeView {
    pub asset_day: U128,
    pub payee_day: U128,
    pub payee_untrusted_day: U128,
    pub task: U128,
}

impl From<ChargeRec> for ChargeView {
    fn from(c: ChargeRec) -> Self {
        Self {
            asset_day: U128(c.asset_day),
            payee_day: U128(c.payee_day),
            payee_untrusted_day: U128(c.payee_untrusted_day),
            task: U128(c.task),
        }
    }
}

/// What `preview` answers: the outcome name (`allowed`, `escalated` or `blocked`, the names `submit_batch` answers), the verdict
/// reason (none for an Allow) and, for an Allow only, the charge `submit_batch` would apply. Advisory: see `preview`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewView {
    pub outcome: String,
    pub reason: Option<String>,
    pub would_charge: Option<ChargeView>,
}

/// What the replay table says about a request id (`replay_step`).
enum Replay {
    /// No record: a new request.
    New,
    /// A Retryable record that has not run again: runs steps c to e once more under the same id.
    Retry,
    /// A live record: its stored outcome is the answer.
    Stored(SubmitOutcome),
}

/// The stored outcome of a request id that was already submitted, as `submit_batch` answers a replay. `None` for a state that is not a
/// replay answer (Retryable and the dead states: see `replay_step`).
fn stored_outcome(id: &str, rec: &RequestRecord) -> Option<SubmitOutcome> {
    let (outcome, reason, pending_id) = match rec.state {
        RequestState::Pending => (
            "escalated",
            rec.reason.clone(),
            rec.pending.as_ref().map(|p| p.no.to_string()),
        ),
        RequestState::Executing | RequestState::Executed => ("allowed", None, None),
        RequestState::Blocked => ("blocked", rec.reason.clone(), None),
        _ => return None,
    };
    Some(SubmitOutcome {
        request_id: id.to_string(),
        outcome: outcome.to_string(),
        reason,
        pending_id,
    })
}

/// The outcome of a new request: the name, the verdict reason (none for an Allow) and the pending number of an escalation.
fn outcome_of(
    id: &str,
    outcome: &str,
    reason: Option<Reason>,
    pending_no: Option<u32>,
) -> SubmitOutcome {
    SubmitOutcome {
        request_id: id.to_string(),
        outcome: outcome.to_string(),
        reason: reason.map(|r| r.as_str().to_string()),
        pending_id: pending_no.map(|no| no.to_string()),
    }
}

/// The checks of step c that need no state: the label masks, the lane, the payee key, the asset the key implies and the EVM
/// parameters. Each failure is a revert with the quoted text.
fn check_request_shape(req: &SubmitRequest) {
    check_labels(&req.labels);
    // an `ft:` asset is refused before its payee key is validated (an `ft:` key would fail as an unknown scheme)
    require!(!req.asset.starts_with("ft:"), "lane not shipped");
    validate_payee_key(&req.payee);
    require!(
        req.asset == asset_for_payee_key(&req.payee),
        "asset does not match payee"
    );
    // AIR-109: only a native EVM asset (`evm:<chain_id>:native`) carries `evm`; an erc20 asset, like `near`, must not
    match (&req.evm, req.asset.ends_with(":native")) {
        (None, true) => env::panic_str("evm params required"),
        (Some(_), false) => env::panic_str("evm params not allowed"),
        (Some(evm), true) => require!(
            evm.gas_limit.0 >= MIN_EVM_GAS
                && evm.max_priority_fee_per_gas.0 <= evm.max_fee_per_gas.0,
            "invalid evm params"
        ),
        (None, false) => {}
    }
}

impl Contract {
    /// Loads the verdict inputs of one request and runs the verdict: read only. The task bound is `bound_for(vt, payee)`; a payee with no
    /// bound gives `task = None`, which the verdict escalates as `OutsideTask` and is never a revert. The verdict flags are `{ paused }`
    /// only (`self.flags` is the contract's own flags, a different type). The inputs come from `verdict_inputs`, which handles a new
    /// payee and an unbound payee, and the request from `to_verdict`: the three masks as sent, and for an EVM request the fee and gas.
    pub fn evaluate(&self, req: &SubmitRequest, vt: &VerifiedTask, now_ms: u64) -> Evaluated {
        let asset = self.asset(&req.asset);
        let payee = self.payee(&req.payee);
        let bound = self.bound_for(vt, &req.payee);
        let key = LedgerKey {
            asset: req.asset.clone(),
            payee: req.payee.clone(),
            task_hash: vt.hash,
        };
        let spent = self.spent_now(&key, now_ms);
        let inputs = verdict_inputs(asset.as_ref(), payee.as_ref(), bound, &spent);
        let flags = airlock_verdict::Flags {
            paused: self.paused,
        };
        let verdict = airlock_verdict::verdict(
            &req.to_verdict(),
            inputs.asset,
            inputs.payee,
            inputs.task,
            &flags,
        );
        Evaluated {
            verdict,
            ctx: EvalCtx {
                asset_id: req.asset.clone(),
                asset,
                payee_key: req.payee.clone(),
                payee,
                bound,
                key,
                spent,
                now_ms,
            },
        }
    }

    /// The body of `preview` at block time `now_ms`, read only (AIR-064). The task is not verified, because a view cannot see a
    /// signature or a caller: its hash and its bounds are built the way `verify_task` builds them (`task_hash`, `verify_bounds`, the
    /// same reverts), then the request shape is checked (`check_request_shape`, the same reverts as step c of `submit_batch`) and the
    /// same `evaluate` that `submit_batch` runs gives the verdict. There is no id, agent, state, replay or action count check, so a
    /// request that `submit_batch` would answer from its replay table, or refuse for its agent or its task, still gets a verdict
    /// here. `would_charge` is the charge `charge_allow` applies (`charge_for_allow`), for an Allow only.
    pub fn preview_at(&self, req: &SubmitRequest, task: &OwnerTask, now_ms: u64) -> PreviewView {
        let vt = VerifiedTask {
            hash: task_hash(task),
            bounds: self.verify_bounds(task),
        };
        check_request_shape(req);
        let (outcome, reason, would_charge) = match self.evaluate(req, &vt, now_ms).verdict {
            Verdict::Allow => {
                let charge = charge_for_allow(req.amount.0, is_untrusted_amount(&req.labels));
                ("allowed", None, Some(ChargeRec::from(charge).into()))
            }
            // the flood gate sits in front of `store_pending` in `submit_batch` (AIR-083): the agent of the counter is the task's agent
            // (a view has no caller), the one `submit_batch` requires of the task
            Verdict::Escalate(reason) => match self.flood_check(&task.agent_id, now_ms) {
                Ok(_) => ("escalated", Some(reason), None),
                Err(refused) => ("blocked", Some(refused), None),
            },
            Verdict::Block(reason) => ("blocked", Some(reason), None),
        };
        PreviewView {
            outcome: outcome.to_string(),
            reason: reason.map(|r| r.as_str().to_string()),
            would_charge,
        }
    }

    /// A record for a request that has no outcome yet. The caller sets `state`, `reason` and the parts of the outcome.
    fn new_record(
        task_hash: [u8; 32],
        req: &SubmitRequest,
        agent: &AccountId,
        now_ms: u64,
        retried: bool,
    ) -> RequestRecord {
        RequestRecord {
            agent: agent.clone(),
            task_hash,
            task_id: req.task_id.clone(),
            index: req.action_index,
            asset: req.asset.clone(),
            payee: req.payee.clone(),
            amount: req.amount.0,
            labels: req.labels,
            evm: req.evm,
            reason: None,
            state: RequestState::Blocked,
            retried,
            applied_charge: None,
            charge_day: 0,
            created_ms: now_ms,
            pending: None,
            exec: None,
        }
    }

    /// Stores an escalation: the record `Pending` with its `PendingInfo`, then the `escalated` event. The number is the next one of
    /// `next_pending_no` and is never reused (`pending counter overflow` at the end of `u32`): it is what `approve` takes. The flood gate
    /// of AIR-083 runs in front of this call. The display strings and the digest come from `escalation::pending_info` (AIR-080), and the
    /// number goes into both pending indexes (`index_pending`). Returns the number.
    pub fn store_pending(&mut self, mut rec: RequestRecord, ctx: &EvalCtx, reason: Reason) -> u32 {
        let no = self.next_pending_no;
        self.next_pending_no = no
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("pending counter overflow"));
        let expires_ms = ctx
            .now_ms
            .checked_add(self.flags.pending_ttl_ms)
            .unwrap_or_else(|| env::panic_str("pending expiry overflow"));
        rec.state = RequestState::Pending;
        rec.reason = Some(reason.as_str().to_string());
        rec.pending = Some(pending_info(&rec, ctx, no, expires_ms));
        let id = request_id(&rec.task_hash, rec.index);
        Event::Escalated {
            request_id: &id,
            id: no.to_string(),
            reason: reason.as_str(),
        }
        .emit();
        self.index_pending(no, &id);
        self.records.insert(id, rec);
        no
    }

    /// Stores a Block: a compact record with the reason, then the `blocked` event.
    fn store_blocked(&mut self, mut rec: RequestRecord, reason: Reason) {
        rec.state = RequestState::Blocked;
        rec.reason = Some(reason.as_str().to_string());
        let id = request_id(&rec.task_hash, rec.index);
        Event::Blocked {
            request_id: &id,
            reason: reason.as_str(),
        }
        .emit();
        self.records.insert(id, rec);
    }

    /// Stores an Allow: charges the four ledgers (`charge_allow`, a revert `ledger overflow` if the verdict ever let through what the model
    /// refuses), stores the record `Executing` with the charge it applied (the refund of AIR-080 and AIR-105 reads it) and the day it was
    /// made on, then emits `allowed` with what is left of the three ledgers after this charge.
    fn store_allowed(&mut self, mut rec: RequestRecord, ctx: &EvalCtx) {
        let (Some(asset), Some(payee), Some(bound)) =
            (ctx.asset.as_ref(), ctx.payee.as_ref(), ctx.bound)
        else {
            // the verdict allows only with an asset, a book payee and a task bound
            env::panic_str("allow without asset, payee or task bound")
        };
        let caps = caps_for(asset, payee, bound);
        let applied = self.charge_allow(
            &ctx.key,
            &caps,
            rec.amount,
            is_untrusted_amount(&rec.labels),
            ctx.now_ms,
        );
        let left = self.remaining(&ctx.key, &caps, ctx.bound, ctx.now_ms);
        rec.state = RequestState::Executing;
        rec.applied_charge = Some(applied);
        rec.charge_day = utc_day(ctx.now_ms);
        let id = request_id(&rec.task_hash, rec.index);
        Event::Allowed {
            request_id: &id,
            asset: &rec.asset,
            payee: &rec.payee,
            amount: U128(rec.amount),
            asset_day_remaining: U128(left.asset_day),
            payee_day_remaining: U128(left.payee_day),
            task_remaining: left.task.map(U128),
        }
        .emit();
        self.records.insert(id, rec);
    }

    /// Step b of a request, the replay table (the only place replays are decided). Reverts `request mismatch` when the stored request
    /// differs from this one in any state, and `request_id already used (UsedRequestId)` for a Retryable id that already ran again and for
    /// Failed, Rejected and Expired ids. A replay that returns a stored outcome emits no event, charges nothing and leaves `actions_used`
    /// alone.
    fn replay_step(&self, id: &str, req: &SubmitRequest) -> Replay {
        let Some(rec) = self.records.get(id) else {
            return Replay::New;
        };
        require!(same_content(rec, req), "request mismatch");
        if let Some(outcome) = stored_outcome(id, rec) {
            return Replay::Stored(outcome);
        }
        match rec.state {
            RequestState::Retryable if !rec.retried => Replay::Retry,
            _ => env::panic_str("request_id already used (UsedRequestId)"),
        }
    }

    /// One request of a batch, steps a to e. Returns the outcome and, when the request took the Allow branch in this call, its id for
    /// step 5 (never the id of a replay, not even a repeated index inside one batch).
    fn process_request(
        &mut self,
        req: &SubmitRequest,
        task: &OwnerTask,
        vt: &VerifiedTask,
        agent: &AccountId,
        now_ms: u64,
    ) -> (SubmitOutcome, Option<String>) {
        // a. the request belongs to this task and to an index the task allows
        require!(req.task_id == task.task_id, "wrong task_id");
        require!(
            req.hints.plan_hash == task.plan_sha256,
            "plan hash mismatch"
        );
        require!(
            req.action_index < task.max_actions,
            "task actions exhausted"
        );
        // b. the id is derived, then the replay table
        let id = request_id(&vt.hash, req.action_index);
        let retried = match self.replay_step(&id, req) {
            Replay::New => false,
            Replay::Retry => true,
            Replay::Stored(outcome) => return (outcome, None),
        };
        // c. the shape of the request; a new id is marked used after it
        check_request_shape(req);
        if !retried {
            self.mark_used(&id);
        }
        // d. the verdict decides, this code stores
        let Evaluated { verdict, ctx } = self.evaluate(req, vt, now_ms);
        let rec = Self::new_record(vt.hash, req, agent, now_ms, retried);
        let (outcome, allowed) = match verdict {
            Verdict::Allow => {
                self.store_allowed(rec, &ctx);
                (outcome_of(&id, "allowed", None, None), Some(id))
            }
            // the flood gate (AIR-083) runs before `store_pending`: a refusal is a stored Block with the flood reason, consumes the id and
            // one task action (step e) but no pending number
            Verdict::Escalate(reason) => match self.flood_admit(&rec.agent, now_ms) {
                Ok(()) => {
                    let no = self.store_pending(rec, &ctx, reason);
                    (outcome_of(&id, "escalated", Some(reason), Some(no)), None)
                }
                Err(refused) => {
                    self.store_blocked(rec, refused);
                    (outcome_of(&id, "blocked", Some(refused), None), None)
                }
            },
            Verdict::Block(reason) => {
                self.store_blocked(rec, reason);
                (outcome_of(&id, "blocked", Some(reason), None), None)
            }
        };
        // e. a new id uses up its index, whatever the outcome (a junk Blocked request burns one of the owner's actions: accepted, the
        // agent can already spend them); a retry reuses its index
        if !retried {
            self.add_actions(&vt.hash, 1);
        }
        (outcome, allowed)
    }
}

#[near]
impl Contract {
    /// The gate. `reqs` holds 1 to 3 requests of one owner-signed `task` (`task_sig` is the owner task key's Ed25519 signature of the task's
    /// borsh bytes). Not payable: a function-call key cannot attach a deposit, and an attached one fails the call.
    ///
    /// In order, each failure a revert with the quoted text: `batch size 1 to 3`; the caller must be a registered, valid and allowed agent
    /// (`require_valid_agent`: an invalid registration is removed, an `agent_removed` event is emitted and the call returns a failing
    /// promise, and that removal is the only state change on the path; a registered agent the owner did not allow returns a failing promise
    /// and changes nothing); the task verifies (`verify_task`); then each request in order (`process_request`). Every Allow of the call is
    /// charged before any execution promise is created. Returns one outcome per request: `allowed`, `escalated` or `blocked`.
    pub fn submit_batch(
        &mut self,
        reqs: Vec<SubmitRequest>,
        task: OwnerTask,
        task_sig: Base64VecU8,
    ) -> PromiseOrValue<Vec<SubmitOutcome>> {
        require!((1..=MAX_BATCH).contains(&reqs.len()), "batch size 1 to 3");
        if let Some(failure) = self.require_valid_agent() {
            return PromiseOrValue::Promise(failure);
        }
        let now_ms = block_timestamp_ms();
        let vt = self.verify_task(&task, &task_sig.0, now_ms);
        let agent = env::predecessor_account_id();
        Event::Submitted {
            task_hash: hex::encode(vt.hash),
            count: u8::try_from(reqs.len()).unwrap_or(u8::MAX),
            agent: &agent,
        }
        .emit();
        let mut outcomes = Vec::with_capacity(reqs.len());
        let mut started = Vec::new();
        for req in &reqs {
            let (outcome, allowed) = self.process_request(req, &task, &vt, &agent, now_ms);
            outcomes.push(outcome);
            started.extend(allowed);
        }
        // 5. promises are created after every charge of the call, and detached: the response is the outcomes
        for id in &started {
            if let Some(promise) = self.start_execution(id) {
                promise.detach();
            }
        }
        PromiseOrValue::Value(outcomes)
    }

    /// What `submit_batch` would answer for `req` under `task` right now, without changing anything: the outcome, the reason and, for
    /// an Allow, the charge (`preview_at`). For the console's verdict display and the bench loader. A view has no caller, so this is
    /// advisory: it checks no signature, agent, id or replay state, and `submit_batch` decides. Never treat an answer as authorization.
    /// Label, key and bound errors revert with the messages `submit_batch` uses.
    pub fn preview(&self, req: SubmitRequest, task: OwnerTask) -> PreviewView {
        self.preview_at(&req, &task, block_timestamp_ms())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{AllowedAgent, fingerprint};
    use crate::request::{EvmParams, Hex32, Hints, Labels};
    use crate::task::{TASK_TAG, TaskBound, VerifiedBound};
    use crate::testutil::{POLICY, ctx, fresh, sign, task_public_key};
    use near_sdk::test_utils::get_logs;
    use near_sdk::testing_env;
    use serde_json::Value;
    use shade_attestation::measurements::create_mock_full_measurements_hex;

    const AGENT: &str = "agent.test.near";
    const ALICE: &str = "near:alice.test.near";
    const BOB: &str = "near:bob.test.near";
    /// Block time of every call below, well inside the task window and the agent's registration.
    const NOW: u64 = 10_000_000;
    const OWNER_MASK: u16 = 1;
    const BOOK_MASK: u16 = 2;
    const POLICY_MASK: u16 = 4;

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
            hard_cap: 10_000,
            daily_cap: 100_000,
            max_fee_per_gas: 0,
            max_gas: 0,
            quick_task_cap: 100_000,
            path: None,
            eip712: None,
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

    /// A contract with asset `near`, book payee `ALICE`, the task key, and `AGENT` registered, whitelisted and allowed.
    fn setup() -> Contract {
        let mut c = fresh();
        c.assets.insert("near".to_string(), asset_entry());
        c.book.insert(ALICE.to_string(), book_entry());
        c.task_key = Some(task_public_key());
        let agent: AccountId = AGENT.parse().unwrap();
        c.agents.insert(
            agent.clone(),
            Agent {
                measurements: create_mock_full_measurements_hex(),
                ppid: Ppid::default(),
                valid_until_ms: NOW * 10,
            },
        );
        c.whitelisted_agents_for_local.insert(agent.clone());
        c.allowed_agents.insert(
            agent,
            AllowedAgent {
                fingerprint: fingerprint(AGENT),
                allowed_ms: 0,
            },
        );
        c
    }

    fn plan_hash() -> Hex32 {
        Hex32([0x11; 32])
    }

    fn owner_task(bounds: &[(&str, u128)], max_actions: u8) -> OwnerTask {
        OwnerTask {
            tag: TASK_TAG.to_string(),
            task_id: "task-1".to_string(),
            contract_id: POLICY.parse().unwrap(),
            agent_id: AGENT.parse().unwrap(),
            plan_sha256: plan_hash(),
            instruction_sha256_salted: Hex32([0x22; 32]),
            issued_ms: NOW - 5_000,
            expires_ms: NOW + 1_800_000,
            max_actions,
            bounds: bounds
                .iter()
                .map(|(key, max_total)| TaskBound {
                    payee_key: (*key).to_string(),
                    max_total: U128(*max_total),
                })
                .collect(),
        }
    }

    fn request(index: u8, payee: &str, amount: u128, labels: Labels) -> SubmitRequest {
        SubmitRequest {
            task_id: "task-1".to_string(),
            action_index: index,
            asset: crate::keys::asset_for_payee_key(payee),
            payee: payee.to_string(),
            amount: U128(amount),
            labels,
            evm: None,
            hints: Hints {
                plan_hash: plan_hash(),
                trace_digest: Hex32([0x33; 32]),
            },
        }
    }

    fn clean(index: u8, payee: &str, amount: u128) -> SubmitRequest {
        request(
            index,
            payee,
            amount,
            Labels {
                recipient: BOOK_MASK,
                amount: OWNER_MASK,
                pc: OWNER_MASK,
            },
        )
    }

    /// `submit_batch` as the agent at `NOW`, with the task signed by the test key.
    fn submit(c: &mut Contract, task: &OwnerTask, reqs: Vec<SubmitRequest>) -> Vec<SubmitOutcome> {
        testing_env!(ctx(AGENT, NOW, 0).build());
        let sig = Base64VecU8(sign(task));
        match c.submit_batch(reqs, task.clone(), sig) {
            PromiseOrValue::Value(outcomes) => outcomes,
            PromiseOrValue::Promise(_) => panic!("the agent was refused"),
        }
    }

    fn verified(task: &OwnerTask) -> VerifiedTask {
        VerifiedTask {
            hash: crate::task::task_hash(task),
            bounds: task
                .bounds
                .iter()
                .map(|b| VerifiedBound {
                    payee_key: b.payee_key.clone(),
                    asset: crate::keys::asset_for_payee_key(&b.payee_key),
                    max_total: b.max_total.0,
                })
                .collect(),
        }
    }

    fn events() -> Vec<Value> {
        get_logs()
            .iter()
            .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
            .map(|json| serde_json::from_str(json).expect("an event parses"))
            .collect()
    }

    /// The record of the request `index` of `task`.
    fn record(c: &Contract, task: &OwnerTask, index: u8) -> RequestRecord {
        c.records
            .get(&request_id(&crate::task::task_hash(task), index))
            .cloned()
            .expect("the record is stored")
    }

    fn key_for(task: &OwnerTask, payee: &str) -> LedgerKey {
        LedgerKey {
            asset: "near".to_string(),
            payee: payee.to_string(),
            task_hash: crate::task::task_hash(task),
        }
    }

    /// Ticket check 5: 500 requests with a fixed seed through `evaluate`. The recipient masks are random non-empty subsets of
    /// {Owner, Policy}, amount and pc are Owner, every key is a non-book key with a task bound: no request is allowed and every one
    /// escalates `NewRecipient` (a lying runtime that labels every value trusted still cannot pay a recipient outside the book).
    #[test]
    fn gate_random() {
        let c = setup();
        let mut state: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            // xorshift64
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let keys: Vec<String> = (0..64).map(|i| format!("near:rand{i}.test.near")).collect();
        let task = owner_task(&[], 20);
        let mut vt = verified(&task);
        vt.bounds = keys
            .iter()
            .map(|k| VerifiedBound {
                payee_key: k.clone(),
                asset: "near".to_string(),
                max_total: 10_000,
            })
            .collect();
        let masks = [OWNER_MASK, POLICY_MASK, OWNER_MASK | POLICY_MASK];
        let (mut allow, mut new_recipient) = (0u32, 0u32);
        for i in 0..500u32 {
            let key = &keys[usize::try_from(next() % 64).unwrap()];
            let amount = u128::from(next() % 10_000) + 1;
            let mask = masks[usize::try_from(next() % 3).unwrap()];
            let req = request(
                u8::try_from(i % 20).unwrap(),
                key,
                amount,
                Labels {
                    recipient: mask,
                    amount: OWNER_MASK,
                    pc: OWNER_MASK,
                },
            );
            assert!(c.payee(key).is_none());
            match c.evaluate(&req, &vt, NOW).verdict {
                Verdict::Allow => allow += 1,
                Verdict::Escalate(Reason::NewRecipient) => new_recipient += 1,
                other => panic!("request {i} to {key}: {other:?}"),
            }
        }
        println!("RANDOM 500 allow={allow}");
        assert_eq!(allow, 0);
        assert_eq!(new_recipient, 500);
    }

    /// `evaluate` writes nothing: no record, no ledger change, no event, no counter.
    #[test]
    fn evaluate_is_read_only() {
        let c = setup();
        let task = owner_task(&[(ALICE, 1_000)], 20);
        let vt = verified(&task);
        testing_env!(ctx(AGENT, NOW, 0).build());
        let req = clean(0, ALICE, 10);
        let evaluated = c.evaluate(&req, &vt, NOW);
        assert_eq!(evaluated.verdict, Verdict::Allow);
        assert_eq!(evaluated.ctx.bound, Some(1_000));
        assert_eq!(
            evaluated.ctx.spent,
            Spent {
                asset_day: 0,
                payee_day: 0,
                payee_untrusted_day: 0,
                task: 0
            }
        );
        assert!(
            c.records.get(&request_id(&vt.hash, 0)).is_none(),
            "evaluate stored a record"
        );
        assert_eq!(c.next_pending_no, 1);
        assert!(get_logs().is_empty());
    }

    /// The verdict `Flags` is `{ paused }`: a paused contract blocks through `evaluate`, and a payee with no task bound escalates.
    #[test]
    fn evaluate_reads_pause_and_missing_bound() {
        let mut c = setup();
        let task = owner_task(&[(BOB, 1_000)], 20);
        let vt = verified(&task);
        let alice = clean(0, ALICE, 10);
        assert_eq!(
            c.evaluate(&alice, &vt, NOW).verdict,
            Verdict::Escalate(Reason::OutsideTask)
        );
        c.paused = true;
        assert_eq!(
            c.evaluate(&alice, &vt, NOW).verdict,
            Verdict::Block(Reason::Paused)
        );
    }

    /// `preview_at` (AIR-064) writes nothing: no record, no ledger change, no event. Before and after a `submit_batch` of the same three
    /// requests it answers the outcome and reason the batch then gives, and for the Allow the charge the ledgers then hold.
    #[test]
    fn preview_is_read_only_and_agrees_with_submit_batch() {
        let mut c = setup();
        let task = owner_task(&[(ALICE, 1_000), (BOB, 1_000)], 20);
        let owner_labels = Labels {
            recipient: OWNER_MASK,
            amount: OWNER_MASK,
            pc: OWNER_MASK,
        };
        let reqs = vec![
            clean(0, ALICE, 10),
            request(1, BOB, 10, owner_labels),
            clean(2, ALICE, 10_001),
        ];
        let key = key_for(&task, ALICE);
        testing_env!(ctx(AGENT, NOW, 0).build());
        let before = c.spent_now(&key, NOW);
        let previews: Vec<PreviewView> = reqs.iter().map(|r| c.preview_at(r, &task, NOW)).collect();
        assert_eq!(c.spent_now(&key, NOW), before, "preview moved a ledger");
        assert!(get_logs().is_empty(), "preview emitted an event");
        assert!(
            c.records
                .get(&request_id(&crate::task::task_hash(&task), 0))
                .is_none()
        );
        assert_eq!(c.next_pending_no, 1);
        assert_eq!(c.actions_used(&crate::task::task_hash(&task)), 0);
        assert_eq!(previews[0].outcome, "allowed");
        assert_eq!(previews[0].reason, None);
        assert_eq!(
            previews[0].would_charge,
            Some(ChargeView {
                asset_day: U128(10),
                payee_day: U128(10),
                payee_untrusted_day: U128(0),
                task: U128(10)
            })
        );
        assert_eq!(previews[1].outcome, "escalated");
        assert_eq!(previews[1].reason.as_deref(), Some("NewRecipient"));
        assert_eq!(previews[1].would_charge, None);
        assert_eq!(previews[2].outcome, "blocked");
        assert_eq!(previews[2].reason.as_deref(), Some("AmountOutOfBounds"));
        assert_eq!(previews[2].would_charge, None);
        let outs = submit(&mut c, &task, reqs);
        for (preview, out) in previews.iter().zip(&outs) {
            assert_eq!(preview.outcome, out.outcome);
            assert_eq!(preview.reason, out.reason);
        }
        let after = c.spent_now(&key, NOW);
        assert_eq!(
            (
                after.asset_day,
                after.payee_day,
                after.payee_untrusted_day,
                after.task
            ),
            (10, 10, 0, 10)
        );
    }

    /// An untrusted amount charges the untrusted budget in the preview exactly as `charge_allow` does, and the shape errors of
    /// `submit_batch` revert in the preview with the same text.
    #[test]
    fn preview_charges_the_untrusted_budget_and_checks_the_shape() {
        let c = setup();
        let task = owner_task(&[(ALICE, 1_000)], 20);
        testing_env!(ctx(AGENT, NOW, 0).build());
        let untrusted = request(
            0,
            ALICE,
            100,
            Labels {
                recipient: BOOK_MASK,
                amount: airlock_verdict::labels::EMAIL,
                pc: OWNER_MASK,
            },
        );
        let answer = c.preview_at(&untrusted, &task, NOW);
        assert_eq!(answer.outcome, "allowed");
        assert_eq!(
            answer.would_charge.map(|w| w.payee_untrusted_day),
            Some(U128(100))
        );
        let mut bad_bit = clean(0, ALICE, 10);
        bad_bit.labels.pc = 0x8000;
        assert!(panics(|| c.preview_at(&bad_bit, &task, NOW)).contains("unknown label bit"));
        let mut wrong_asset = clean(0, ALICE, 10);
        wrong_asset.asset = "evm:84532:native".to_string();
        assert!(
            panics(|| c.preview_at(&wrong_asset, &task, NOW))
                .contains("asset does not match payee")
        );
        let no_bounds = owner_task(&[], 20);
        assert!(
            panics(|| c.preview_at(&clean(0, ALICE, 10), &no_bounds, NOW))
                .contains("bad bound count")
        );
    }

    /// The table rows that need a Retryable record, which only AIR-105 produces in the sandbox: here the record is edited the way
    /// its refund path will leave it. A Retryable id that has not retried runs once more under the same id (charged again, `retried`
    /// set, no new action), and a second Retryable is refused `UsedRequestId`.
    #[test]
    fn retryable_runs_once_more_then_second_retry_reverts() {
        let mut c = setup();
        let task = owner_task(&[(ALICE, 1_000)], 20);
        let req = clean(0, ALICE, 10);
        let outs = submit(&mut c, &task, vec![req.clone()]);
        assert_eq!(outs[0].outcome, "allowed");
        let first_id = outs[0].request_id.clone();
        let key = key_for(&task, ALICE);
        let fail = |c: &mut Contract| {
            // what AIR-105's `fail_request` will do: refund, then Retryable
            let mut rec = record(c, &task, 0);
            c.refund(&rec);
            rec.state = RequestState::Retryable;
            rec.applied_charge = None;
            c.records
                .insert(request_id(&crate::task::task_hash(&task), 0), rec);
        };
        fail(&mut c);
        assert_eq!(c.spent_now(&key, NOW).task, 0);
        // the retry runs c to e once more under the same id
        let outs = submit(&mut c, &task, vec![req.clone()]);
        assert_eq!(outs[0].outcome, "allowed");
        assert_eq!(outs[0].request_id, first_id);
        let rec = record(&c, &task, 0);
        assert_eq!(rec.state, RequestState::Executing);
        assert!(rec.retried);
        assert!(rec.applied_charge.is_some());
        assert_eq!(c.spent_now(&key, NOW).task, 10, "charged once again");
        assert_eq!(c.actions_used(&crate::task::task_hash(&task)), 1);
        assert_eq!(
            events().iter().filter(|e| e["event"] == "allowed").count(),
            1
        );
        // a second failure: the retry is not offered twice
        fail(&mut c);
        let text = panics(|| submit(&mut c, &task, vec![req.clone()]));
        assert!(
            text.contains("request_id already used (UsedRequestId)"),
            "{text}"
        );
        assert_eq!(c.spent_now(&key, NOW).task, 0, "the revert charged nothing");
        // a changed request is a mismatch, before the state matters
        let mut other = req;
        other.amount = U128(11);
        let text = panics(|| submit(&mut c, &task, vec![other]));
        assert!(text.contains("request mismatch"), "{text}");
    }

    /// A record in a dead state is used for good: `UsedRequestId`. One test per state, because the mocked storage of a test thread
    /// outlives a contract value (a second `setup()` in one test would read the first one's records).
    fn dead_state_reverts_used_request_id(state: RequestState) {
        let mut c = setup();
        let task = owner_task(&[(ALICE, 1_000)], 20);
        let req = clean(0, ALICE, 10);
        submit(&mut c, &task, vec![req.clone()]);
        let mut rec = record(&c, &task, 0);
        rec.state = state;
        c.records
            .insert(request_id(&crate::task::task_hash(&task), 0), rec);
        let text = panics(|| submit(&mut c, &task, vec![req]));
        assert!(
            text.contains("request_id already used (UsedRequestId)"),
            "{state:?}: {text}"
        );
    }

    #[test]
    fn failed_id_reverts_used_request_id() {
        dead_state_reverts_used_request_id(RequestState::Failed);
    }

    #[test]
    fn rejected_id_reverts_used_request_id() {
        dead_state_reverts_used_request_id(RequestState::Rejected);
    }

    #[test]
    fn expired_id_reverts_used_request_id() {
        dead_state_reverts_used_request_id(RequestState::Expired);
    }

    /// Executing and Executed answer `allowed` without a second charge; Pending answers `escalated` with its number.
    #[test]
    fn live_states_answer_their_stored_outcome() {
        let mut c = setup();
        let task = owner_task(&[(ALICE, 1_000), (BOB, 1_000)], 20);
        let allowed = clean(0, ALICE, 10);
        let pending = request(
            1,
            BOB,
            10,
            Labels {
                recipient: OWNER_MASK,
                amount: OWNER_MASK,
                pc: OWNER_MASK,
            },
        );
        let first = submit(&mut c, &task, vec![allowed.clone(), pending.clone()]);
        assert_eq!(first[1].pending_id.as_deref(), Some("1"));
        let mut rec = record(&c, &task, 0);
        rec.state = RequestState::Executed;
        c.records
            .insert(request_id(&crate::task::task_hash(&task), 0), rec);
        let again = submit(&mut c, &task, vec![allowed, pending]);
        assert_eq!(again[0], first[0]);
        assert_eq!(again[1], first[1]);
        assert!(events().iter().all(|e| e["event"] == "submitted"));
        let key = key_for(&task, ALICE);
        assert_eq!(c.spent_now(&key, NOW).asset_day, 10);
    }

    /// The pending number is never reused and never wraps: the last number of `u32` reverts `pending counter overflow`, and the batch
    /// stores nothing.
    #[test]
    fn pending_counter_overflow_reverts() {
        let mut c = setup();
        let task = owner_task(&[(BOB, 1_000)], 20);
        let escalating = |index: u8| {
            request(
                index,
                BOB,
                10,
                Labels {
                    recipient: OWNER_MASK,
                    amount: OWNER_MASK,
                    pc: OWNER_MASK,
                },
            )
        };
        let outs = submit(&mut c, &task, vec![escalating(0), escalating(1)]);
        assert_eq!(outs[0].pending_id.as_deref(), Some("1"));
        assert_eq!(outs[1].pending_id.as_deref(), Some("2"));
        assert_eq!(c.next_pending_no, 3);
        c.next_pending_no = u32::MAX;
        let text = panics(|| submit(&mut c, &task, vec![escalating(2)]));
        assert!(text.contains("pending counter overflow"), "{text}");
    }

    /// An Allow stores the charge it applied and the UTC day, and `start_execution` is the seam: it answers the NEAR transfer for an
    /// `Executing` near record and refuses any other state.
    #[test]
    fn allow_stores_its_charge_and_the_seam_refuses_other_states() {
        let mut c = setup();
        let task = owner_task(&[(ALICE, 1_000)], 20);
        submit(&mut c, &task, vec![clean(0, ALICE, 10)]);
        let rec = record(&c, &task, 0);
        assert_eq!(rec.state, RequestState::Executing);
        let charge = rec.applied_charge.clone().expect("a stored charge");
        assert_eq!(
            (
                charge.asset_day,
                charge.payee_day,
                charge.payee_untrusted_day,
                charge.task
            ),
            (10, 10, 0, 10)
        );
        assert_eq!(rec.charge_day, NOW / 86_400_000);
        assert!(rec.evm.is_none());
        let id = request_id(&crate::task::task_hash(&task), 0);
        assert!(c.start_execution(&id).is_some());
        let mut blocked = rec;
        blocked.state = RequestState::Blocked;
        c.records.insert(id.clone(), blocked);
        let text = panics(|| c.start_execution(&id));
        assert!(text.contains("request is not executing"), "{text}");
    }

    /// Every record keeps the `evm` parameters the request carried (Allow, Block and Escalate alike).
    #[test]
    fn records_keep_their_evm_parameters() {
        let mut c = setup();
        c.assets.insert(
            "evm:84532:native".to_string(),
            AssetEntry {
                symbol: "ETH.base".to_string(),
                decimals: 18,
                hard_cap: 1_000_000,
                daily_cap: 10_000_000,
                max_fee_per_gas: 100,
                max_gas: 100_000,
                quick_task_cap: 5_000_000,
                path: Some("base-sepolia-1".to_string()),
                eip712: None,
            },
        );
        let payee = "evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
        let task = owner_task(&[(payee, 1_000_000)], 20);
        let owner_labels = Labels {
            recipient: OWNER_MASK,
            amount: OWNER_MASK,
            pc: OWNER_MASK,
        };
        let params = |fee: u128| EvmParams {
            gas_limit: U128(21_000),
            max_fee_per_gas: U128(fee),
            max_priority_fee_per_gas: U128(1),
        };
        let mut escalate = request(0, payee, 10, owner_labels);
        escalate.evm = Some(params(50));
        let mut block = request(1, payee, 10, owner_labels);
        block.evm = Some(params(101));
        let outs = submit(&mut c, &task, vec![escalate, block]);
        assert_eq!(outs[0].outcome, "escalated");
        assert_eq!(outs[0].reason.as_deref(), Some("NewRecipient"));
        assert_eq!(outs[1].outcome, "blocked");
        assert_eq!(outs[1].reason.as_deref(), Some("FeeTooHigh"));
        assert_eq!(record(&c, &task, 0).evm, Some(params(50)));
        assert_eq!(record(&c, &task, 1).evm, Some(params(101)));
    }

    /// The agent is refused before any request is looked at: an unallowed agent gets a failing promise and no state changes.
    #[test]
    fn unallowed_agent_is_refused_before_the_task_is_read() {
        let mut c = setup();
        assert!(
            c.allowed_agents
                .remove(&AGENT.parse::<AccountId>().unwrap())
                .is_some()
        );
        let task = owner_task(&[(ALICE, 1_000)], 20);
        testing_env!(ctx(AGENT, NOW, 0).build());
        let sig = Base64VecU8(vec![0; 64]);
        let answer = c.submit_batch(vec![clean(0, ALICE, 10)], task.clone(), sig);
        assert!(matches!(answer, PromiseOrValue::Promise(_)));
        assert!(events().is_empty());
        assert!(
            c.records
                .get(&request_id(&crate::task::task_hash(&task), 0))
                .is_none()
        );
        // a batch of zero is refused before the agent is looked at
        let text = panics(|| c.submit_batch(vec![], task, Base64VecU8(vec![])));
        assert!(text.contains("batch size 1 to 3"), "{text}");
    }
}

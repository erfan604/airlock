// AIR-061: the `submit_batch` gate in the sandbox. Every payment goes through this one method, so the tests walk the ticket's order:
// a clean Allow, each Block reason, each Escalate reason, the batch rule (a request sees the charges of the one before it), the replay
// table, every revert, the seam to the execution lanes and the gas of the three call shapes. Every revert test asserts the message
// text, because a missing method also fails and would pass a bare `assert_failure()`. No character is escaped with a backslash and
// `u`: non-ASCII characters are built from their code points.
//
// Standard setup (the ticket's): asset `near` with hard cap 10_000, daily cap 100_000 and quick task cap 100_000 (base units);
// book payee `near:alice.sandbox` with cap 100, untrusted budget 1_000 and daily limit 5_000; the policy contract is `contract.sandbox`
// (the account `start()` deploys to, set in every task through `signed_task_with`); the agent is `agent.sandbox`, registered and allowed.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::request::RequestRecord;
use common::*;
use near_api::{AccountId, Contract, Data, NearToken, Signer};
use near_api_types::transaction::result::ExecutionFinalResult;
use near_sdk::json_types::Base64VecU8;
use serde_json::{Value, json};
use std::sync::Arc;

/// Label masks (GLOSSARY, `airlock_verdict::labels`).
const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
const ORACLE: u16 = airlock_verdict::ORACLE;
const EMAIL: u16 = airlock_verdict::labels::EMAIL;

const ALICE: &str = "near:alice.sandbox";
const BOB: &str = "near:bob.sandbox";
const EVM_PAYEE: &str = "evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const EVM_ASSET: &str = "evm:84532:native";

/// The `pending_ttl_ms` default (GLOSSARY, "Contract flags").
const PENDING_TTL_MS: u64 = 3_600_000;
/// The gas ceiling of a clean single Allow, also under a 16 bound task (ticket check 3).
const GAS_CEILING: u64 = 30_000_000_000_000;

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

/// Asset `near` with the amounts of this file in yoctoNEAR (hard cap 10_000, daily cap 100_000, quick task cap 100_000 base units): the
/// shared entry of tests/common with one base unit per whole unit (AIR-105).
fn near_entry() -> Value {
    near_asset_entry(1)
}

fn evm_entry() -> Value {
    evm_asset_entry()
}

/// A request JSON: task `task-1`, the asset the payee key implies, no `evm`, fixed hints (the plan hash is the one of `base_task`).
fn req(index: u8, payee: &str, amount: u128, labels: [u16; 3]) -> Value {
    json!({
        "task_id": "task-1",
        "action_index": index,
        "asset": airlock_policy::keys::asset_for_payee_key(payee),
        "payee": payee,
        "amount": amount.to_string(),
        "labels": { "recipient": labels[0], "amount": labels[1], "pc": labels[2] },
        "evm": null,
        "hints": {
            "plan_hash": hex::encode([0x11u8; 32]),
            "trace_digest": hex::encode([0x33u8; 32])
        }
    })
}

/// `v` with one top level key replaced.
fn with(mut v: Value, key: &str, value: Value) -> Value {
    v[key] = value;
    v
}

/// An EVM request: `req` plus the three EVM parameters.
fn evm_req(
    index: u8,
    payee: &str,
    amount: u128,
    labels: [u16; 3],
    gas_limit: u128,
    max_fee: u128,
    priority: u128,
) -> Value {
    with(
        req(index, payee, amount, labels),
        "evm",
        json!({
            "gas_limit": gas_limit.to_string(),
            "max_fee_per_gas": max_fee.to_string(),
            "max_priority_fee_per_gas": priority.to_string()
        }),
    )
}

/// A signed task and what a call needs of it.
struct Task {
    task: airlock_policy::task::OwnerTask,
    sig: Base64VecU8,
}

impl Task {
    fn hash(&self) -> [u8; 32] {
        airlock_policy::task::task_hash(&self.task)
    }

    fn hash_hex(&self) -> String {
        hex::encode(self.hash())
    }

    fn args(&self, reqs: Vec<Value>) -> Value {
        json!({ "reqs": reqs, "task": self.task, "task_sig": self.sig })
    }
}

/// A sandbox with the standard setup and the agent registered and allowed.
struct Fx {
    s: Started,
    agent: AccountId,
    agent_signer: Arc<Signer>,
}

async fn owner_ok(s: &Started, method: &str, args: Value) {
    let result = owner_call(s, method, args).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "{method} failed: {text}");
    result.assert_success();
}

/// Registers the agent `name` (whitelist, `register_agent`) without allowing it.
async fn registered_agent(s: &Started, name: &str) -> (AccountId, Arc<Signer>) {
    let (agent, signer) = create_user_account(&s.net, &s.owner, &s.owner_signer, name)
        .await
        .expect("the agent account is created");
    register_local_agent(
        &s.contract,
        &s.owner,
        &s.owner_signer,
        &agent,
        &signer,
        &s.net,
    )
    .await;
    (agent, signer)
}

async fn fixture() -> Fx {
    let s = start().await;
    // AIR-101: an Allow of a `near:` payee is paid by the contract in the same transaction, so the payees must exist
    for name in ["alice", "bob"] {
        create_user_account(&s.net, &s.owner, &s.owner_signer, name)
            .await
            .expect("the payee account is created");
    }
    owner_ok(
        &s,
        "asset_set",
        json!({ "asset": "near", "entry": near_entry() }),
    )
    .await;
    owner_ok(
        &s,
        "book_add",
        json!({
            "key": ALICE,
            "cap": "100",
            "daily_untrusted_budget": "1000",
            "daily_limit": "5000",
            "label": "Alice"
        }),
    )
    .await;
    set_test_task_key(&s.contract, &s.owner, &s.owner_signer, &s.net).await;
    let (agent, agent_signer) = registered_agent(&s, "agent").await;
    allow_agent_for(&s.contract, &s.owner, &s.owner_signer, &agent, &s.net).await;
    Fx {
        s,
        agent,
        agent_signer,
    }
}

/// An owner call that must succeed, for the tests that register the EVM asset or change the registry.
impl Fx {
    async fn register_evm(&self) {
        owner_ok(
            &self.s,
            "asset_set",
            json!({ "asset": EVM_ASSET, "entry": evm_entry() }),
        )
        .await;
    }

    /// A task signed for `agent` (the standard one unless the test passes another) with `edit` applied before the signature.
    fn task_as(
        &self,
        agent: &AccountId,
        bounds: &[(&str, u128)],
        max_actions: u8,
        edit: impl FnOnce(&mut airlock_policy::task::OwnerTask),
    ) -> Task {
        let contract: near_sdk::AccountId = self.s.contract.as_str().parse().unwrap();
        let agent_id: near_sdk::AccountId = agent.as_str().parse().unwrap();
        let (task, sig) = signed_task_with(bounds, max_actions, |t| {
            t.contract_id = contract;
            t.agent_id = agent_id;
            edit(t);
        });
        Task { task, sig }
    }

    fn task_with(
        &self,
        bounds: &[(&str, u128)],
        max_actions: u8,
        edit: impl FnOnce(&mut airlock_policy::task::OwnerTask),
    ) -> Task {
        self.task_as(&self.agent, bounds, max_actions, edit)
    }

    fn task(&self, bounds: &[(&str, u128)], max_actions: u8) -> Task {
        self.task_with(bounds, max_actions, |_| {})
    }

    async fn submit(&self, task: &Task, reqs: Vec<Value>) -> ExecutionFinalResult {
        agent_call(
            &self.s,
            &self.agent,
            &self.agent_signer,
            "submit_batch",
            task.args(reqs),
        )
        .await
    }

    /// A call that must succeed: its outcomes and its events.
    async fn submit_ok(&self, task: &Task, reqs: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
        let result = self.submit(task, reqs).await;
        let text = failure_text(&result);
        assert!(text.is_empty(), "submit_batch failed: {text}");
        let events = extract_event_logs(&result).expect("the events parse");
        let value: Value = result.json().expect("the outcomes parse");
        let outcomes = value.as_array().expect("an array of outcomes").clone();
        (outcomes, events)
    }

    async fn view(&self, method: &str, args: Value) -> Value {
        let answer: Data<Value> = call_view(&self.s.contract, method, args, &self.s.net)
            .await
            .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"));
        answer.data
    }

    async fn request(&self, id: &str) -> Value {
        self.view("get_request", json!({ "id": id })).await
    }

    async fn ledgers(&self, payee: &str, task: &Task) -> Value {
        self.view(
            "get_ledgers",
            json!({ "payee": payee, "asset": "near", "task": task.hash_hex() }),
        )
        .await
    }

    async fn actions_used(&self, task: &Task) -> u64 {
        self.view("get_task_state", json!({ "task_hash": task.hash_hex() }))
            .await["actions_used"]
            .as_u64()
            .expect("actions_used is a number")
    }

    /// The record the contract stored for `id`, read from the raw state: `get_request` does not show `pending` (AIR-080 adds the
    /// display fields). The key of a `LookupMap` entry is the borsh of the storage key, then the borsh of the map key.
    async fn stored(&self, id: &str) -> Option<RequestRecord> {
        let prefix = near_sdk::borsh::to_vec(&airlock_policy::StorageKey::Records).unwrap();
        let mut want = prefix.clone();
        want.extend(near_sdk::borsh::to_vec(&id.to_string()).unwrap());
        let state = Contract(self.s.contract.clone())
            .view_storage_with_prefix(&prefix)
            .fetch_from(&self.s.net)
            .await
            .expect("the contract state is readable")
            .data;
        let decode = |text: &str| -> Vec<u8> {
            serde_json::from_value::<Base64VecU8>(Value::String(text.to_string()))
                .expect("the state is base64")
                .0
        };
        state
            .values
            .iter()
            .find(|item| decode(&item.key.0) == want)
            .map(|item| {
                near_sdk::borsh::from_slice::<RequestRecord>(&decode(&item.value.0))
                    .expect("the stored record decodes")
            })
    }
}

/// The events of one name, in order.
fn named<'a>(events: &'a [Value], name: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["event"] == name).collect()
}

/// The call must fail with `text` in a failed receipt.
fn assert_reverts(result: &ExecutionFinalResult, text: &str) {
    let got = failure_text(result);
    assert!(
        !got.is_empty(),
        "the call must revert with `{text}`, but it succeeded"
    );
    assert!(got.contains(text), "expected `{text}` in: {got}");
}

fn assert_allowed(o: &Value) {
    assert_eq!(o["outcome"], "allowed", "{o}");
    assert!(o["reason"].is_null(), "{o}");
    assert!(o["pending_id"].is_null(), "{o}");
}

fn assert_escalated(o: &Value, reason: &str) {
    assert_eq!(o["outcome"], "escalated", "{o}");
    assert_eq!(o["reason"], reason, "{o}");
    assert!(o["pending_id"].is_string(), "{o}");
}

/// A blocked outcome with its stored record and its `blocked` event.
async fn assert_blocked(fx: &Fx, o: &Value, events: &[Value], reason: &str) {
    assert_eq!(o["outcome"], "blocked", "{o}");
    assert_eq!(o["reason"], reason, "{o}");
    assert!(o["pending_id"].is_null(), "{o}");
    let id = o["request_id"].as_str().expect("a request id");
    let stored = fx.request(id).await;
    assert_eq!(stored["state"], "Blocked", "{stored}");
    assert_eq!(stored["reason"], reason, "{stored}");
    assert!(
        named(events, "blocked")
            .iter()
            .any(|e| e["data"][0]["request_id"] == id && e["data"][0]["reason"] == reason),
        "no blocked event for {id} with {reason}: {events:?}"
    );
}

/// The three outcomes of a batch must not have charged anything for `payee` under `task`.
async fn assert_nothing_charged(fx: &Fx, payee: &str, task: &Task) {
    let l = fx.ledgers(payee, task).await;
    assert_eq!(l["asset_day"]["spent"], "0", "{l}");
    assert_eq!(l["payee_day"]["spent"], "0", "{l}");
    assert_eq!(l["task_spent"], "0", "{l}");
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Allow
// ---------------------------------------------------------------------------------------------------------------------

/// I1: a clean request (Book recipient in the book, Owner amount, pc Owner) is allowed: one outcome with null `reason` and
/// `pending_id`, a 66 character derived id, the record `Executed` (the NEAR lane pays in the same transaction, AIR-101) and the `allowed` event with the post-charge remainders.
#[tokio::test]
async fn i1_clean_allow_emits_allowed() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let (outs, events) = fx
        .submit_ok(&task, vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert_eq!(outs.len(), 1);
    assert_allowed(&outs[0]);
    let id = outs[0]["request_id"].as_str().unwrap();
    assert_eq!(id.len(), 66);
    assert_eq!(id, format!("{}:0", task.hash_hex()));
    let view = fx.request(id).await;
    assert_eq!(view["state"], "Executed", "{view}");
    let allowed = named(&events, "allowed");
    assert_eq!(allowed.len(), 1, "{events:?}");
    assert_eq!(allowed[0]["standard"], "airlock");
    assert_eq!(allowed[0]["version"], "1.0.0");
    let data = &allowed[0]["data"][0];
    assert_eq!(data["request_id"], id);
    assert_eq!(data["asset"], "near");
    assert_eq!(data["payee"], ALICE);
    assert_eq!(data["amount"], "10");
    assert_eq!(data["asset_day_remaining"], "99990");
    assert_eq!(data["payee_day_remaining"], "4990");
    assert_eq!(data["task_remaining"], "990");
    // the four ledgers took the charge
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["asset_day"]["spent"], "10", "{l}");
    assert_eq!(l["payee_day"]["spent"], "10", "{l}");
    assert_eq!(l["payee_untrusted_day"]["spent"], "0", "{l}");
    assert_eq!(l["task_spent"], "10", "{l}");
    // the stored record keeps the charge for the refund and the day it was made on
    let rec = fx.stored(id).await.expect("the record is stored");
    let charge = rec.applied_charge.expect("an Allow stores its charge");
    assert_eq!(
        (
            charge.asset_day,
            charge.payee_day,
            charge.payee_untrusted_day,
            charge.task
        ),
        (10, 10, 0, 10)
    );
    assert_eq!(rec.charge_day, rec.created_ms / 86_400_000);
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Blocks
// ---------------------------------------------------------------------------------------------------------------------

/// An empty mask on any of the three values blocks `MissingProvenance` (rule 4), each with a stored record and a `blocked` event.
#[tokio::test]
async fn blocks_missing_provenance_for_any_empty_mask() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let (outs, events) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, 10, [BOOK, OWNER, 0]),
                req(1, ALICE, 10, [BOOK, 0, OWNER]),
                req(2, ALICE, 10, [0, OWNER, OWNER]),
            ],
        )
        .await;
    assert_eq!(outs.len(), 3);
    for o in &outs {
        assert_blocked(&fx, o, &events, "MissingProvenance").await;
    }
    assert_nothing_charged(&fx, ALICE, &task).await;
}

/// I6: a request that labels the recipient Book for a key that is not in the book is blocked (rule 5, a lying runtime), even when
/// the task has no bound for it.
#[tokio::test]
async fn i6_book_label_for_non_book_key_blocks() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let (outs, events) = fx
        .submit_ok(&task, vec![req(0, BOB, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert_blocked(&fx, &outs[0], &events, "BookLabelNotInBook").await;
    assert_nothing_charged(&fx, BOB, &task).await;
}

/// Rule 2: an amount over the hard cap and an amount of 0 block `AmountOutOfBounds`.
#[tokio::test]
async fn blocks_amount_over_hard_cap_and_zero() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 50_000)], 20);
    let (outs, events) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, 10_001, [BOOK, OWNER, OWNER]),
                req(1, ALICE, 0, [BOOK, OWNER, OWNER]),
            ],
        )
        .await;
    assert_blocked(&fx, &outs[0], &events, "AmountOutOfBounds").await;
    assert_blocked(&fx, &outs[1], &events, "AmountOutOfBounds").await;
    assert_nothing_charged(&fx, ALICE, &task).await;
}

/// Rule 2: an amount above what is left of the asset's daily cap blocks `DailyLimit`. The asset is re-registered with a small
/// daily cap, because the standard hard cap and daily cap leave room for ten requests the payee limit would stop first.
#[tokio::test]
async fn blocks_over_the_daily_cap() {
    let _slot = slot().await;
    let fx = fixture().await;
    owner_ok(
        &fx.s,
        "asset_set",
        json!({
            "asset": "near",
            "entry": {
                "symbol": "NEAR", "decimals": 24, "hard_cap": "100", "daily_cap": "150",
                "max_fee_per_gas": "0", "max_gas": "0", "quick_task_cap": "150", "path": null
            }
        }),
    )
    .await;
    let task = fx.task(&[(ALICE, 150)], 20);
    let (first, _) = fx
        .submit_ok(&task, vec![req(0, ALICE, 100, [BOOK, OWNER, OWNER])])
        .await;
    assert_allowed(&first[0]);
    let (second, events) = fx
        .submit_ok(&task, vec![req(1, ALICE, 100, [BOOK, OWNER, OWNER])])
        .await;
    assert_blocked(&fx, &second[0], &events, "DailyLimit").await;
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["asset_day"]["spent"], "100", "{l}");
    assert_eq!(l["asset_day"]["remaining"], "50", "{l}");
}

/// Rule 1: while the owner has paused the contract every request is blocked `Paused` (`submit_batch` is the only signing path, so
/// pause stops every payment); resuming lets the next request through.
#[tokio::test]
async fn blocks_while_paused_and_resumes() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    owner_ok(&fx.s, "pause", json!({ "paused": true })).await;
    let (outs, events) = fx
        .submit_ok(&task, vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert_blocked(&fx, &outs[0], &events, "Paused").await;
    assert_nothing_charged(&fx, ALICE, &task).await;
    owner_ok(&fx.s, "pause", json!({ "paused": false })).await;
    let (outs, _) = fx
        .submit_ok(&task, vec![req(1, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert_allowed(&outs[0]);
}

/// Rule 0: an EVM chain that is not in the registry blocks `UnknownAsset`, as a stored outcome and not a revert.
#[tokio::test]
async fn blocks_unregistered_evm_chain() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let payee = "evm:1:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    let (outs, events) = fx
        .submit_ok(
            &task,
            vec![evm_req(
                0,
                payee,
                1_000,
                [OWNER, OWNER, OWNER],
                21_000,
                1_000,
                1_000,
            )],
        )
        .await;
    assert_blocked(&fx, &outs[0], &events, "UnknownAsset").await;
}

/// Rule 3: an EVM fee per gas above the registry cap, and a gas limit above the registry cap, each block `FeeTooHigh`.
#[tokio::test]
async fn blocks_evm_fee_above_registry_cap() {
    let _slot = slot().await;
    let fx = fixture().await;
    fx.register_evm().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [OWNER, OWNER, OWNER];
    let (outs, events) = fx
        .submit_ok(
            &task,
            vec![
                evm_req(0, EVM_PAYEE, 1_000, labels, 21_000, 50_000_000_001, 1),
                evm_req(1, EVM_PAYEE, 1_000, labels, 100_001, 1_000, 1),
            ],
        )
        .await;
    assert_blocked(&fx, &outs[0], &events, "FeeTooHigh").await;
    assert_blocked(&fx, &outs[1], &events, "FeeTooHigh").await;
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Escalations
// ---------------------------------------------------------------------------------------------------------------------

/// Rule 9: trusted labels to a key that is not in the book always escalate `NewRecipient`, with the pending number in the outcome,
/// the stored record (`Pending`, `id` "1") and the `escalated` event.
#[tokio::test]
async fn escalates_new_recipient_for_trusted_labels() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000), (BOB, 1_000)], 20);
    let (outs, events) = fx
        .submit_ok(&task, vec![req(0, BOB, 50, [OWNER, OWNER, OWNER])])
        .await;
    assert_escalated(&outs[0], "NewRecipient");
    assert_eq!(outs[0]["pending_id"], "1");
    let id = outs[0]["request_id"].as_str().unwrap();
    let view = fx.request(id).await;
    assert_eq!(view["state"], "Pending", "{view}");
    assert_eq!(view["id"], "1", "{view}");
    assert_eq!(view["reason"], "NewRecipient", "{view}");
    let escalated = named(&events, "escalated");
    assert_eq!(escalated.len(), 1, "{events:?}");
    assert_eq!(escalated[0]["data"][0]["request_id"], id);
    assert_eq!(escalated[0]["data"][0]["id"], "1");
    assert_eq!(escalated[0]["data"][0]["reason"], "NewRecipient");
    assert!(named(&events, "allowed").is_empty());
    assert_nothing_charged(&fx, BOB, &task).await;
}

/// F10: the book is matched by the exact key. A key that differs from a book key in one character is a new recipient when the
/// labels say Owner, and a lie when they say Book.
#[tokio::test]
async fn one_character_off_book_key_is_a_new_recipient() {
    let _slot = slot().await;
    let fx = fixture().await;
    let off = "near:alicf.sandbox";
    let task = fx.task(&[(ALICE, 1_000), (off, 1_000)], 20);
    let (outs, events) = fx
        .submit_ok(
            &task,
            vec![
                req(0, off, 10, [OWNER, OWNER, OWNER]),
                req(1, off, 10, [BOOK, OWNER, OWNER]),
            ],
        )
        .await;
    assert_escalated(&outs[0], "NewRecipient");
    assert_blocked(&fx, &outs[1], &events, "BookLabelNotInBook").await;
    assert_nothing_charged(&fx, off, &task).await;
}

/// Rule 11: an untrusted amount above the payee's cap escalates `UntrustedAmount`, while the same amount with an Owner label
/// is allowed: the label decides, not the number.
#[tokio::test]
async fn untrusted_amount_over_cap_escalates() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let (outs, _) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, 101, [BOOK, EMAIL, OWNER]),
                req(1, ALICE, 101, [BOOK, OWNER, OWNER]),
            ],
        )
        .await;
    assert_escalated(&outs[0], "UntrustedAmount");
    assert_allowed(&outs[1]);
}

/// F13: an untrusted amount exactly at the payee's cap is allowed and charges the untrusted budget; a trusted amount does not.
#[tokio::test]
async fn untrusted_amount_exactly_at_cap_allows_and_charges_the_budget() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let (outs, _) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, 100, [BOOK, EMAIL, OWNER]),
                req(1, ALICE, 50, [BOOK, OWNER, OWNER]),
            ],
        )
        .await;
    assert_allowed(&outs[0]);
    assert_allowed(&outs[1]);
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["payee_untrusted_day"]["spent"], "100", "{l}");
    assert_eq!(l["payee_untrusted_day"]["remaining"], "900", "{l}");
    assert_eq!(l["payee_day"]["spent"], "150", "{l}");
}

/// F13: ten untrusted requests of exactly the cap use the whole untrusted budget of 1_000 and are all allowed; one more base unit
/// escalates `UntrustedAmount`.
#[tokio::test]
async fn untrusted_budget_used_exactly_then_one_unit_above_escalates() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 5_000)], 20);
    let untrusted = |i: u8, amount: u128| req(i, ALICE, amount, [BOOK, EMAIL, OWNER]);
    let batches: [&[u8]; 4] = [&[0, 1, 2], &[3, 4, 5], &[6, 7, 8], &[9]];
    for batch in batches {
        let reqs: Vec<Value> = batch.iter().map(|i| untrusted(*i, 100)).collect();
        let (outs, _) = fx.submit_ok(&task, reqs).await;
        for o in &outs {
            assert_allowed(o);
        }
    }
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["payee_untrusted_day"]["spent"], "1000", "{l}");
    assert_eq!(l["payee_untrusted_day"]["remaining"], "0", "{l}");
    let (outs, _) = fx.submit_ok(&task, vec![untrusted(10, 1)]).await;
    assert_escalated(&outs[0], "UntrustedAmount");
    // the escalation charged nothing
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["payee_day"]["spent"], "1000", "{l}");
}

/// Rule 7: an untrusted pc escalates `UntrustedTrigger`; an Oracle pc is trusted and allowed.
#[tokio::test]
async fn untrusted_pc_escalates_and_oracle_pc_allows() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let (outs, _) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, 10, [BOOK, OWNER, EMAIL]),
                req(1, ALICE, 10, [BOOK, OWNER, ORACLE]),
            ],
        )
        .await;
    assert_escalated(&outs[0], "UntrustedTrigger");
    assert_allowed(&outs[1]);
}

/// Rule 6: a payee the task has no bound for escalates `OutsideTask`; it is never a revert, and the record keeps a task bound of 0.
#[tokio::test]
async fn payee_without_a_task_bound_escalates_outside_task() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, 1_000)], 20);
    let (outs, _) = fx
        .submit_ok(&task, vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert_escalated(&outs[0], "OutsideTask");
    let rec = fx
        .stored(outs[0]["request_id"].as_str().unwrap())
        .await
        .expect("the escalation is stored");
    let pending = rec.pending.expect("an escalation has `pending`");
    assert!(pending.book_in);
    assert_eq!(pending.task_bound, 0);
    assert_nothing_charged(&fx, ALICE, &task).await;
}

/// The pending part of a stored escalation: the number (never reused), `expires_ms = created + ttl`, whether the payee is in the
/// book and the task bound of the payee (0 when the task has none).
#[tokio::test]
async fn pending_info_has_number_expiry_book_flag_and_bound() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, 700)], 20);
    let (outs, _) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, 10, [BOOK, OWNER, OWNER]),
                req(1, BOB, 10, [OWNER, OWNER, OWNER]),
            ],
        )
        .await;
    assert_escalated(&outs[0], "OutsideTask");
    assert_escalated(&outs[1], "NewRecipient");
    assert_eq!(outs[0]["pending_id"], "1");
    assert_eq!(outs[1]["pending_id"], "2");
    let first = fx
        .stored(outs[0]["request_id"].as_str().unwrap())
        .await
        .expect("stored");
    let second = fx
        .stored(outs[1]["request_id"].as_str().unwrap())
        .await
        .expect("stored");
    let a = first.pending.clone().expect("pending");
    let b = second.pending.clone().expect("pending");
    assert_eq!((a.no, a.book_in, a.task_bound), (1, true, 0));
    assert_eq!((b.no, b.book_in, b.task_bound), (2, false, 700));
    for (rec, info) in [(&first, &a), (&second, &b)] {
        assert_eq!(info.expires_ms, rec.created_ms + PENDING_TTL_MS);
        assert_eq!(format!("{:?}", rec.state), "Pending");
        assert!(rec.applied_charge.is_none());
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Batch
// ---------------------------------------------------------------------------------------------------------------------

/// R3-02: three requests of 500 under a bound of 500: the first is allowed and the other two escalate `OverTaskBound`.
#[tokio::test]
async fn r3_02_three_requests_of_500_under_a_500_bound() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 500)], 20);
    let labels = [BOOK, OWNER, OWNER];
    let (outs, events) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, 500, labels),
                req(1, ALICE, 500, labels),
                req(2, ALICE, 500, labels),
            ],
        )
        .await;
    assert_allowed(&outs[0]);
    assert_escalated(&outs[1], "OverTaskBound");
    assert_escalated(&outs[2], "OverTaskBound");
    assert_eq!(named(&events, "allowed").len(), 1);
    assert_eq!(named(&events, "escalated").len(), 2);
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["task_spent"], "500", "{l}");
}

/// The second request's verdict uses the first one's charge: with a bound of 1_000, 600 is allowed, a second 600 escalates
/// `OverTaskBound` (a snapshot of the starting ledgers would allow it), and a third request of exactly the 400 left is allowed.
/// The ledgers read back through `get_ledgers`.
#[tokio::test]
async fn batch_charges_between_requests() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [BOOK, OWNER, OWNER];
    let (outs, events) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, 600, labels),
                req(1, ALICE, 600, labels),
                req(2, ALICE, 400, labels),
            ],
        )
        .await;
    assert_allowed(&outs[0]);
    assert_escalated(&outs[1], "OverTaskBound");
    assert_allowed(&outs[2]);
    let allowed = named(&events, "allowed");
    assert_eq!(allowed.len(), 2);
    // each `allowed` event shows what was left after its own charge
    assert_eq!(allowed[0]["data"][0]["task_remaining"], "400");
    assert_eq!(allowed[1]["data"][0]["task_remaining"], "0");
    assert_eq!(allowed[1]["data"][0]["asset_day_remaining"], "99000");
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["asset_day"]["spent"], "1000", "{l}");
    assert_eq!(l["payee_day"]["spent"], "1000", "{l}");
    assert_eq!(l["task_spent"], "1000", "{l}");
}

/// The task ledger is per task and the day ledgers are shared: two tasks of the same agent each spend their own bound of 500, and
/// the asset and payee day ledgers see both.
#[tokio::test]
async fn two_tasks_share_day_ledgers_and_not_task_ledgers() {
    let _slot = slot().await;
    let fx = fixture().await;
    let first = fx.task(&[(ALICE, 500)], 20);
    let second = fx.task_with(&[(ALICE, 500)], 20, |t| t.task_id = "task-2".to_string());
    assert_ne!(first.hash(), second.hash());
    let labels = [BOOK, OWNER, OWNER];
    let (outs, _) = fx.submit_ok(&first, vec![req(0, ALICE, 500, labels)]).await;
    assert_allowed(&outs[0]);
    let (outs, _) = fx
        .submit_ok(
            &second,
            vec![with(req(0, ALICE, 500, labels), "task_id", json!("task-2"))],
        )
        .await;
    assert_allowed(&outs[0]);
    let l = fx.ledgers(ALICE, &first).await;
    assert_eq!(l["asset_day"]["spent"], "1000", "{l}");
    assert_eq!(l["payee_day"]["spent"], "1000", "{l}");
    assert_eq!(l["task_spent"], "500", "{l}");
    let l = fx.ledgers(ALICE, &second).await;
    assert_eq!(l["task_spent"], "500", "{l}");
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Replays
// ---------------------------------------------------------------------------------------------------------------------

/// I2: the same action index twice returns the stored outcome and pays once: no second `allowed` event, no second charge, and the
/// task's action count stays at 1. The call still emits its own `submitted` event.
#[tokio::test]
async fn i2_same_action_index_twice_pays_once() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let request = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let (first, _) = fx.submit_ok(&task, vec![request.clone()]).await;
    assert_allowed(&first[0]);
    let (second, events) = fx.submit_ok(&task, vec![request]).await;
    assert_allowed(&second[0]);
    assert_eq!(first[0]["request_id"], second[0]["request_id"]);
    assert!(named(&events, "allowed").is_empty(), "{events:?}");
    assert!(named(&events, "escalated").is_empty());
    assert!(named(&events, "blocked").is_empty());
    assert_eq!(named(&events, "submitted").len(), 1);
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["asset_day"]["spent"], "10", "{l}");
    assert_eq!(l["task_spent"], "10", "{l}");
    assert_eq!(fx.actions_used(&task).await, 1);
}

/// A replay of a Pending record answers `escalated` with the stored pending number and consumes no number; a replay of a Blocked
/// record answers `blocked` with the stored reason. Neither emits an event.
#[tokio::test]
async fn replay_of_pending_and_blocked_returns_the_stored_outcome() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000), (BOB, 1_000)], 20);
    let pending = req(0, BOB, 10, [OWNER, OWNER, OWNER]);
    let blocked = req(1, ALICE, 10, [BOOK, OWNER, 0]);
    let (first, _) = fx
        .submit_ok(&task, vec![pending.clone(), blocked.clone()])
        .await;
    assert_escalated(&first[0], "NewRecipient");
    assert_eq!(first[0]["pending_id"], "1");
    let (again, events) = fx.submit_ok(&task, vec![pending, blocked]).await;
    assert_eq!(again[0], first[0]);
    assert_eq!(again[1], first[1]);
    assert_eq!(again[1]["outcome"], "blocked");
    assert_eq!(again[1]["reason"], "MissingProvenance");
    assert!(named(&events, "escalated").is_empty(), "{events:?}");
    assert!(named(&events, "blocked").is_empty());
    // the replay did not use up a pending number: the next escalation is number 2
    let (next, _) = fx
        .submit_ok(&task, vec![req(2, BOB, 10, [OWNER, OWNER, OWNER])])
        .await;
    assert_eq!(next[0]["pending_id"], "2");
    assert_eq!(fx.actions_used(&task).await, 3);
}

/// The same action index twice inside one batch pays once: the second copy is a replay of the first.
#[tokio::test]
async fn duplicate_index_in_one_batch_pays_once() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let request = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let (outs, events) = fx.submit_ok(&task, vec![request.clone(), request]).await;
    assert_allowed(&outs[0]);
    assert_allowed(&outs[1]);
    assert_eq!(outs[0]["request_id"], outs[1]["request_id"]);
    assert_eq!(named(&events, "allowed").len(), 1, "{events:?}");
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["asset_day"]["spent"], "10", "{l}");
    assert_eq!(fx.actions_used(&task).await, 1);
}

/// A replay whose payee, amount, asset, labels or evm differ from the stored request reverts `request mismatch`, whatever the
/// stored state (here Executing and Pending), before any other check of the request runs.
#[tokio::test]
async fn replay_with_changed_content_reverts_request_mismatch() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000), (BOB, 1_000)], 20);
    let allowed = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let pending = req(1, BOB, 10, [OWNER, OWNER, OWNER]);
    let (first, _) = fx
        .submit_ok(&task, vec![allowed.clone(), pending.clone()])
        .await;
    assert_allowed(&first[0]);
    assert_escalated(&first[1], "NewRecipient");
    let evm = json!({
        "gas_limit": "21000", "max_fee_per_gas": "10", "max_priority_fee_per_gas": "1"
    });
    let changes = [
        with(allowed.clone(), "payee", json!(BOB)),
        with(allowed.clone(), "amount", json!("11")),
        with(allowed.clone(), "asset", json!(EVM_ASSET)),
        with(
            allowed.clone(),
            "labels",
            json!({ "recipient": OWNER, "amount": OWNER, "pc": OWNER }),
        ),
        with(allowed.clone(), "evm", evm.clone()),
        with(pending.clone(), "amount", json!("11")),
        with(pending, "evm", evm),
    ];
    for changed in changes {
        let result = fx.submit(&task, vec![changed.clone()]).await;
        assert_reverts(&result, "request mismatch");
    }
    // the unchanged request still answers
    let (again, _) = fx.submit_ok(&task, vec![allowed]).await;
    assert_allowed(&again[0]);
}

/// A Retryable record runs once more under the same id (AIR-105 moves a request to Retryable after a failed signing or transfer;
/// the in-process tests of src/gate.rs cover the table row now).
#[tokio::test]
#[ignore = "enabled by AIR-105"]
async fn retryable_runs_once_more_under_the_same_id() {
    todo!(
        "AIR-105: fail the mock MPC, let the refund path set Retryable, then resubmit the same action"
    );
}

/// A second failure after the retry ends `Failed`, and a third submission reverts `UsedRequestId`.
#[tokio::test]
#[ignore = "enabled by AIR-105"]
async fn second_retry_reverts_used_request_id() {
    todo!(
        "AIR-105: fail the retry too, then resubmit and expect `request_id already used (UsedRequestId)`"
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Reverts
// ---------------------------------------------------------------------------------------------------------------------

/// A batch of 0 and a batch of 4 revert `batch size 1 to 3`.
#[tokio::test]
async fn batch_of_zero_and_batch_of_four_revert() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [BOOK, OWNER, OWNER];
    let result = fx.submit(&task, vec![]).await;
    assert_reverts(&result, "batch size 1 to 3");
    let four: Vec<Value> = (0..4).map(|i| req(i, ALICE, 10, labels)).collect();
    let result = fx.submit(&task, four).await;
    assert_reverts(&result, "batch size 1 to 3");
    // three is the limit and works
    let three: Vec<Value> = (0..3).map(|i| req(i, ALICE, 10, labels)).collect();
    let (outs, _) = fx.submit_ok(&task, three).await;
    assert_eq!(outs.len(), 3);
}

/// I8: a forged task signature reverts. A flipped bit, and a task edited after it was signed, both fail `bad task signature`,
/// and nothing is stored.
#[tokio::test]
async fn i8_forged_task_signature_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let request = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let mut task = fx.task(&[(ALICE, 1_000)], 20);
    task.sig.0[0] ^= 1;
    let result = fx.submit(&task, vec![request.clone()]).await;
    assert_reverts(&result, "bad task signature");
    // signed for one task, presented with a larger bound
    let mut task = fx.task(&[(ALICE, 1_000)], 20);
    task.task.bounds[0].max_total = near_sdk::json_types::U128(90_000);
    let result = fx.submit(&task, vec![request.clone()]).await;
    assert_reverts(&result, "bad task signature");
    // a signature of 63 bytes
    let mut task = fx.task(&[(ALICE, 1_000)], 20);
    task.sig.0.pop();
    let result = fx.submit(&task, vec![request]).await;
    assert_reverts(&result, "bad task signature");
    let honest = fx.task(&[(ALICE, 1_000)], 20);
    assert_nothing_charged(&fx, ALICE, &honest).await;
}

/// I8: an expired task reverts `task expired`.
#[tokio::test]
async fn i8_expired_task_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task_with(&[(ALICE, 1_000)], 20, |t| {
        t.expires_ms = t.issued_ms + 1_000
    });
    let result = fx
        .submit(&task, vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert_reverts(&result, "task expired");
    assert_nothing_charged(&fx, ALICE, &task).await;
}

/// I8: a task with `max_actions` 1 pays its first action and reverts the second index `task actions exhausted`; the revert stores
/// nothing and the count stays 1.
#[tokio::test]
async fn i8_max_actions_one_task_second_index_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 1);
    let labels = [BOOK, OWNER, OWNER];
    let (outs, _) = fx.submit_ok(&task, vec![req(0, ALICE, 10, labels)]).await;
    assert_allowed(&outs[0]);
    let result = fx.submit(&task, vec![req(1, ALICE, 10, labels)]).await;
    assert_reverts(&result, "task actions exhausted");
    assert_eq!(fx.actions_used(&task).await, 1);
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["task_spent"], "10", "{l}");
}

/// The agent cannot name another task: a `task_id` that is not the signed task's reverts `wrong task_id`.
#[tokio::test]
async fn wrong_task_id_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let request = with(
        req(0, ALICE, 10, [BOOK, OWNER, OWNER]),
        "task_id",
        json!("task-2"),
    );
    let result = fx.submit(&task, vec![request]).await;
    assert_reverts(&result, "wrong task_id");
}

/// A request whose `hints.plan_hash` is not the task's plan hash reverts `plan hash mismatch` (a consistency check only).
#[tokio::test]
async fn plan_hash_mismatch_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let mut request = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    request["hints"]["plan_hash"] = json!(hex::encode([0x12u8; 32]));
    let result = fx.submit(&task, vec![request]).await;
    assert_reverts(&result, "plan hash mismatch");
}

/// I9: a label mask with bit 15 set reverts `unknown label bit`, on any of the three masks, and nothing is stored. A mask of 0 is not
/// a revert (it blocks `MissingProvenance`, see above).
#[tokio::test]
async fn i9_label_bit_15_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let bad = 0x8000u16;
    for labels in [
        [bad, OWNER, OWNER],
        [BOOK, bad, OWNER],
        [BOOK, OWNER, bad],
        [0xffff, 0xffff, 0xffff],
        [BOOK | bad, OWNER, OWNER],
    ] {
        let result = fx.submit(&task, vec![req(0, ALICE, 10, labels)]).await;
        assert_reverts(&result, "unknown label bit");
    }
    assert_nothing_charged(&fx, ALICE, &task).await;
    assert_eq!(fx.actions_used(&task).await, 0);
}

/// An `ft:` asset reverts `lane not shipped`, before the payee key is validated (an `ft:` payee key would otherwise fail as an
/// unknown scheme).
#[tokio::test]
async fn ft_asset_reverts_lane_not_shipped() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [BOOK, OWNER, OWNER];
    let near_payee = with(req(0, ALICE, 10, labels), "asset", json!("ft:usdc.sandbox"));
    let result = fx.submit(&task, vec![near_payee]).await;
    assert_reverts(&result, "lane not shipped");
    let ft_payee = with(
        with(req(1, ALICE, 10, labels), "asset", json!("ft:usdc.sandbox")),
        "payee",
        json!("ft:usdc.sandbox:alice.sandbox"),
    );
    let result = fx.submit(&task, vec![ft_payee]).await;
    assert_reverts(&result, "lane not shipped");
}

/// A payee key with an uppercase character is not canonical: the key error names `BadChar` (NEAR account and EVM address).
#[tokio::test]
async fn payee_key_with_uppercase_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [BOOK, OWNER, OWNER];
    let near_upper = with(
        req(0, ALICE, 10, labels),
        "payee",
        json!("near:Alice.sandbox"),
    );
    let result = fx.submit(&task, vec![near_upper]).await;
    assert_reverts(&result, "bad payee key: BadChar");
    let evm_upper = with(
        with(req(1, EVM_PAYEE, 10, labels), "asset", json!(EVM_ASSET)),
        "payee",
        json!("evm:84532:0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045"),
    );
    let result = fx.submit(&task, vec![evm_upper]).await;
    assert_reverts(&result, "bad payee key: BadChar");
}

/// A payee key with a zero-width character, or a look-alike letter from another script, is refused `NonAscii`: the book is matched
/// on exact ASCII keys, so such a key could only ever be a different (new) recipient and is refused outright.
#[tokio::test]
async fn payee_key_with_zero_width_character_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [BOOK, OWNER, OWNER];
    let zero_width = char::from_u32(0x200b).unwrap();
    let cyrillic_a = char::from_u32(0x0430).unwrap();
    for payee in [
        format!("near:alice{zero_width}.sandbox"),
        format!("near:{cyrillic_a}lice.sandbox"),
    ] {
        let request = with(req(0, ALICE, 10, labels), "payee", json!(payee));
        let result = fx.submit(&task, vec![request]).await;
        assert_reverts(&result, "bad payee key: NonAscii");
    }
}

/// The asset must be the one the payee key implies (`near` for `near:`, `evm:<chain>:native` for `evm:<chain>:`).
#[tokio::test]
async fn asset_not_matching_the_payee_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [BOOK, OWNER, OWNER];
    let cases = [
        with(req(0, ALICE, 10, labels), "asset", json!(EVM_ASSET)),
        with(req(0, EVM_PAYEE, 10, labels), "asset", json!("near")),
        with(
            req(0, EVM_PAYEE, 10, labels),
            "asset",
            json!("evm:1:native"),
        ),
    ];
    for request in cases {
        let result = fx.submit(&task, vec![request]).await;
        assert_reverts(&result, "asset does not match payee");
    }
}

/// An EVM asset needs `evm` (`evm params required`) and any other asset must not have it (`evm params not allowed`).
#[tokio::test]
async fn evm_params_required_on_evm_and_forbidden_on_near() {
    let _slot = slot().await;
    let fx = fixture().await;
    fx.register_evm().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [OWNER, OWNER, OWNER];
    let missing = req(0, EVM_PAYEE, 10, labels);
    let result = fx.submit(&task, vec![missing]).await;
    assert_reverts(&result, "evm params required");
    let extra = with(
        req(1, ALICE, 10, [BOOK, OWNER, OWNER]),
        "evm",
        json!({ "gas_limit": "21000", "max_fee_per_gas": "10", "max_priority_fee_per_gas": "1" }),
    );
    let result = fx.submit(&task, vec![extra]).await;
    assert_reverts(&result, "evm params not allowed");
}

/// `invalid evm params`: a limit of 20_999 (below the 21_000 of a transfer) and a priority fee above the max fee revert; exactly
/// 21_000 and a priority fee equal to the max fee are accepted (the request then gets a verdict: no bound, so `OutsideTask`).
#[tokio::test]
async fn evm_params_below_the_minimum_revert() {
    let _slot = slot().await;
    let fx = fixture().await;
    fx.register_evm().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [OWNER, OWNER, OWNER];
    let low = evm_req(0, EVM_PAYEE, 10, labels, 20_999, 10, 1);
    let result = fx.submit(&task, vec![low]).await;
    assert_reverts(&result, "invalid evm params");
    let priority = evm_req(0, EVM_PAYEE, 10, labels, 21_000, 10, 11);
    let result = fx.submit(&task, vec![priority]).await;
    assert_reverts(&result, "invalid evm params");
    let edge = evm_req(0, EVM_PAYEE, 10, labels, 21_000, 10, 10);
    let (outs, _) = fx.submit_ok(&task, vec![edge]).await;
    assert_escalated(&outs[0], "OutsideTask");
}

/// `submit_batch` is not payable: an attached deposit (one yocto is enough) fails the call and stores nothing.
#[tokio::test]
async fn attached_deposit_reverts() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let request = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let result = call_transaction(
        &fx.s.contract,
        "submit_batch",
        task.args(vec![request]),
        &fx.agent,
        &fx.agent_signer,
        &fx.s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("the call is sent");
    assert_reverts(&result, "doesn't accept deposit");
    assert_nothing_charged(&fx, ALICE, &task).await;
    assert_eq!(fx.actions_used(&task).await, 0);
}

/// An account that never registered cannot submit: `Agent not registered`, whatever task it carries.
#[tokio::test]
async fn stranger_cannot_submit() {
    let _slot = slot().await;
    let fx = fixture().await;
    let (stranger, stranger_signer) =
        create_user_account(&fx.s.net, &fx.s.owner, &fx.s.owner_signer, "stranger")
            .await
            .expect("the stranger account is created");
    let task = fx.task_as(&stranger, &[(ALICE, 1_000)], 20, |_| {});
    let result = agent_call(
        &fx.s,
        &stranger,
        &stranger_signer,
        "submit_batch",
        task.args(vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])]),
    )
    .await;
    assert_reverts(&result, "Agent not registered");
    assert_nothing_charged(&fx, ALICE, &task).await;
}

/// A registered agent the owner never allowed fails with `Invalid agent: [NotAllowed]` before any request is looked at: no ledger,
/// no record, no `submitted` event, and the registration stays (the owner may allow the account later).
#[tokio::test]
async fn unallowed_agent_fails_and_changes_nothing() {
    let _slot = slot().await;
    let fx = fixture().await;
    let (other, other_signer) = registered_agent(&fx.s, "other").await;
    let task = fx.task_as(&other, &[(ALICE, 1_000)], 20, |_| {});
    let result = agent_call(
        &fx.s,
        &other,
        &other_signer,
        "submit_batch",
        task.args(vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])]),
    )
    .await;
    assert_reverts(&result, "Invalid agent");
    assert_reverts(&result, "NotAllowed");
    let events = extract_event_logs(&result).unwrap();
    assert!(named(&events, "submitted").is_empty(), "{events:?}");
    assert!(named(&events, "agent_removed").is_empty());
    let agent = fx.view("get_agent", json!({ "account_id": other })).await;
    assert!(agent.is_object(), "the registration stays: {agent}");
    assert_nothing_charged(&fx, ALICE, &task).await;
    assert_eq!(fx.actions_used(&task).await, 0);
}

/// An agent whose registration went invalid (here: the owner took it off the local whitelist) is removed lazily by its next
/// `submit_batch`: the call fails `Invalid agent: [NotWhitelistedForLocal]`, emits `agent_removed`, and that removal is the only
/// state change.
#[tokio::test]
async fn invalid_agent_is_lazily_removed() {
    let _slot = slot().await;
    let fx = fixture().await;
    owner_ok(
        &fx.s,
        "remove_agent_from_whitelist_for_local",
        json!({ "account_id": fx.agent }),
    )
    .await;
    // still registered until it submits
    let before = fx
        .view("get_agent", json!({ "account_id": fx.agent }))
        .await;
    assert!(before.is_object(), "{before}");
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let result = fx
        .submit(&task, vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert_reverts(&result, "NotWhitelistedForLocal");
    let events = extract_event_logs(&result).unwrap();
    let removed = named(&events, "agent_removed");
    assert_eq!(removed.len(), 1, "{events:?}");
    assert_eq!(removed[0]["data"][0]["account_id"], fx.agent.as_str());
    assert!(named(&events, "submitted").is_empty());
    let after = fx
        .view("get_agent", json!({ "account_id": fx.agent }))
        .await;
    assert!(after.is_null(), "the agent is removed: {after}");
    assert_nothing_charged(&fx, ALICE, &task).await;
}

/// A revert in a later request of the batch undoes the charges of the earlier ones and marks no id used: the same first request
/// is accepted afterwards.
#[tokio::test]
async fn later_revert_rolls_back_earlier_charges() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let good = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let bad = req(1, ALICE, 10, [BOOK, OWNER, 0x8000]);
    let result = fx.submit(&task, vec![good.clone(), bad]).await;
    assert_reverts(&result, "unknown label bit");
    assert_nothing_charged(&fx, ALICE, &task).await;
    assert_eq!(fx.actions_used(&task).await, 0);
    let id = format!("{}:0", task.hash_hex());
    assert!(fx.request(&id).await.is_null());
    let (outs, _) = fx.submit_ok(&task, vec![good]).await;
    assert_allowed(&outs[0]);
}

/// There is no request id, nonce or path in a request: extra keys are ignored and the id is the one the contract derives.
#[tokio::test]
async fn extra_request_fields_are_ignored_and_the_id_is_derived() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let mut request = req(3, ALICE, 10, [BOOK, OWNER, OWNER]);
    request["request_id"] = json!("chosen-by-the-agent:0");
    request["nonce"] = json!(5);
    request["path"] = json!("evil-path");
    request["to"] = json!("near:bob.sandbox");
    let (outs, _) = fx.submit_ok(&task, vec![request]).await;
    assert_allowed(&outs[0]);
    assert_eq!(
        outs[0]["request_id"],
        format!("{}:3", task.hash_hex()).as_str()
    );
    assert!(fx.request("chosen-by-the-agent:0").await.is_null());
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. Seam, events and the action count
// ---------------------------------------------------------------------------------------------------------------------

/// `submit_batch` is the only new export and no helper of the gate is a method: the wasm exports `submit_batch` and none of the
/// helpers (`start_execution` reaches MPC signing once AIR-100 lands, so exporting it would be a signing backdoor).
#[test]
fn helpers_not_exported() {
    let exports = wasm_exports();
    assert!(
        exports.iter().any(|name| name == "submit_batch"),
        "the wasm does not export submit_batch: {exports:?}"
    );
    for helper in [
        "start_execution",
        "evaluate",
        "store_pending",
        "charge_allow",
        "charge_approval",
        "refund",
        "spent_now",
        "remaining",
        "verify_task",
        "bound_for",
        "mark_used",
        "require_valid_agent",
        "process_request",
    ] {
        assert!(
            !exports.iter().any(|name| name == helper),
            "the wasm exports the helper {helper}"
        );
    }
    assert!(
        !exports.iter().any(|name| name.starts_with("emit_")),
        "the wasm exports an emit helper: {exports:?}"
    );
}

/// `submitted` is emitted once per call, with the task hash, the number of requests of the call and the agent, and carries no
/// request text.
#[tokio::test]
async fn submitted_event_once_per_call_with_the_right_count() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [BOOK, OWNER, OWNER];
    for (count, first_index) in [(3usize, 0u8), (1, 3), (2, 4)] {
        let reqs: Vec<Value> = (0..count)
            .map(|i| req(first_index + u8::try_from(i).unwrap(), ALICE, 10, labels))
            .collect();
        let (_, events) = fx.submit_ok(&task, reqs).await;
        let submitted = named(&events, "submitted");
        assert_eq!(submitted.len(), 1, "{events:?}");
        let data = &submitted[0]["data"][0];
        assert_eq!(submitted[0]["standard"], "airlock");
        assert_eq!(data["task_hash"], task.hash_hex().as_str());
        assert_eq!(data["count"], count);
        assert_eq!(data["agent"], fx.agent.as_str());
        assert_eq!(data.as_object().unwrap().len(), 3, "{data}");
    }
}

/// Every new outcome (Allowed, Escalated, Blocked) uses up its action index and counts once; a replay does not count and a revert
/// counts nothing.
#[tokio::test]
async fn every_new_outcome_burns_one_action() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000), (BOB, 1_000)], 20);
    let reqs = vec![
        req(0, ALICE, 10, [BOOK, OWNER, OWNER]),
        req(1, BOB, 10, [OWNER, OWNER, OWNER]),
        req(2, ALICE, 10, [BOOK, OWNER, 0]),
    ];
    let (outs, _) = fx.submit_ok(&task, reqs.clone()).await;
    assert_eq!(outs[0]["outcome"], "allowed");
    assert_eq!(outs[1]["outcome"], "escalated");
    assert_eq!(outs[2]["outcome"], "blocked");
    assert_eq!(fx.actions_used(&task).await, 3);
    let (_, _) = fx.submit_ok(&task, reqs).await;
    assert_eq!(fx.actions_used(&task).await, 3);
    let result = fx
        .submit(&task, vec![req(3, ALICE, 10, [BOOK, OWNER, 0x8000])])
        .await;
    assert_reverts(&result, "unknown label bit");
    assert_eq!(fx.actions_used(&task).await, 3);
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. Gas (sandbox neard 2.11.0 is protocol 83, so the numbers are indicative; AIR-107 measures on testnet)
// ---------------------------------------------------------------------------------------------------------------------

fn tgas(gas: u64) -> String {
    format!("{:.2}", gas as f64 / 1e12)
}

/// A clean single Allow burns under 30 Tgas in total.
#[tokio::test]
async fn gas_single_allow() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let result = fx
        .submit(&task, vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    let gas = gas_report(&result);
    println!("GAS single_allow={} Tgas", tgas(gas));
    assert_eq!(result.json::<Value>().unwrap()[0]["outcome"], "allowed");
    assert!(gas < GAS_CEILING, "a single Allow burnt {} Tgas", tgas(gas));
}

/// Three Allows in one batch (the most a call carries).
#[tokio::test]
async fn gas_batch3() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let labels = [BOOK, OWNER, OWNER];
    let reqs: Vec<Value> = (0..3).map(|i| req(i, ALICE, 10, labels)).collect();
    let result = fx.submit(&task, reqs).await;
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    let gas = gas_report(&result);
    println!("GAS batch3={} Tgas", tgas(gas));
    let value: Value = result.json().unwrap();
    for outcome in value.as_array().unwrap() {
        assert_allowed(outcome);
    }
    assert!(
        gas < 100_000_000_000_000,
        "a batch of 3 burnt {} Tgas",
        tgas(gas)
    );
}

/// A single Allow under a task with 16 bounds (the most a task has), the measurement AIR-060 hands over: also under 30 Tgas.
#[tokio::test]
async fn gas_16_bounds() {
    let _slot = slot().await;
    let fx = fixture().await;
    let others: Vec<String> = (0..15).map(|i| format!("near:payee{i}.sandbox")).collect();
    let mut bounds: Vec<(&str, u128)> = others.iter().map(|k| (k.as_str(), 1_000)).collect();
    bounds.push((ALICE, 1_000));
    assert_eq!(bounds.len(), 16);
    let task = fx.task(&bounds, 20);
    let result = fx
        .submit(&task, vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    let gas = gas_report(&result);
    println!("GAS bounds16={} Tgas", tgas(gas));
    assert_eq!(result.json::<Value>().unwrap()[0]["outcome"], "allowed");
    assert!(
        gas < GAS_CEILING,
        "a single Allow under 16 bounds burnt {} Tgas",
        tgas(gas)
    );
}

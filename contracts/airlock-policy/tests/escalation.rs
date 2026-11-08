// AIR-080: escalation storage and the readable `approve` in the sandbox. An escalated request is stored with a readable display and a
// digest; the owner's wallet call `approve(id, to, asset, amount, why, book)` is compared field by field with the stored card, and the
// contract then executes exactly the stored request, charges the ledgers and emits `approved`. Every revert test asserts the message
// text, because a missing method also fails and would pass a bare `assert_failure()`.
//
// Setup: asset `near` (symbol NEAR, 24 decimals, hard cap 10,000 NEAR, daily cap 100,000 NEAR); book payee `near:alice.sandbox` (untrusted
// cap 1 NEAR, untrusted budget 5 NEAR per day, daily limit 20 NEAR); `near:bob.sandbox` is not in the book; the policy contract is
// `contract.sandbox` and the agent `agent.sandbox`, registered and allowed. Amounts in the tests are written in NEAR through `near()`.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::escalation::{DigestPreimage, PREIMAGE_LAYOUT, digest_of};
use airlock_policy::request::{RequestRecord, request_id};
use common::*;
use near_api::{AccountId, Contract, Data, NearToken, Signer, Tokens};
use near_api_types::transaction::result::ExecutionFinalResult;
use near_sdk::json_types::Base64VecU8;
use serde_json::{Value, json};
use std::sync::Arc;

/// Label masks (GLOSSARY, `airlock_verdict::labels`).
const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
const EMAIL: u16 = airlock_verdict::labels::EMAIL;

const ALICE: &str = "near:alice.sandbox";
const BOB: &str = "near:bob.sandbox";
const CAROL: &str = "near:carol.sandbox";

/// The `pending_ttl_ms` default (GLOSSARY, "Contract flags").
const PENDING_TTL_MS: u64 = 3_600_000;
/// The ceiling for the approve of a NEAR escalation (the one AIR-061 uses for a single Allow; AIR-107 measures the real figure).
const GAS_CEILING: u64 = 30_000_000_000_000;

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

/// `n` NEAR in yoctoNEAR.
fn near(n: u128) -> u128 {
    n * 1_000_000_000_000_000_000_000_000
}

fn near_entry() -> Value {
    json!({
        "symbol": "NEAR",
        "decimals": 24,
        "hard_cap": near(10_000).to_string(),
        "daily_cap": near(100_000).to_string(),
        "max_fee_per_gas": "0",
        "max_gas": "0",
        "quick_task_cap": near(100_000).to_string(),
        "path": null
    })
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

/// The seven flags of `set_flags`, with the three the escalation tests change.
fn flags(pending_ttl_ms: u64, max_pending_per_agent: u32, hourly_escalation_budget: u32) -> Value {
    json!({ "flags": {
        "max_pending_per_agent": max_pending_per_agent,
        "pending_ttl_ms": pending_ttl_ms.to_string(),
        "hourly_escalation_budget": hourly_escalation_budget,
        "lock_consecutive_rejects": 3,
        "lock_rejects_per_day": 20,
        "max_task_ttl_ms": "3600000",
        "max_task_actions": 20
    } })
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

/// One escalation: its short pending number and its derived request id.
struct Esc {
    no: String,
    request_id: String,
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

async fn fixture() -> Fx {
    let s = start().await;
    // AIR-101: an approval of a `near:` payee is paid by the contract, so the payees must exist and the policy account must hold the
    // amounts below (30 NEAR from the deploy, about 10 of them locked by the wasm, plus 50)
    for name in ["alice", "bob", "carol"] {
        create_user_account(&s.net, &s.owner, &s.owner_signer, name)
            .await
            .expect("the payee account is created");
    }
    Tokens::account(s.owner.clone())
        .send_to(s.contract.clone())
        .near(NearToken::from_near(50))
        .with_signer(s.owner_signer.clone())
        .send_to(&s.net)
        .await
        .expect("the funding is sent")
        .assert_success();
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
            "cap": near(1).to_string(),
            "daily_untrusted_budget": near(5).to_string(),
            "daily_limit": near(20).to_string(),
            "label": "Alice"
        }),
    )
    .await;
    set_test_task_key(&s.contract, &s.owner, &s.owner_signer, &s.net).await;
    let (agent, agent_signer) = create_user_account(&s.net, &s.owner, &s.owner_signer, "agent")
        .await
        .expect("the agent account is created");
    register_local_agent(
        &s.contract,
        &s.owner,
        &s.owner_signer,
        &agent,
        &agent_signer,
        &s.net,
    )
    .await;
    allow_agent_for(&s.contract, &s.owner, &s.owner_signer, &agent, &s.net).await;
    Fx {
        s,
        agent,
        agent_signer,
    }
}

impl Fx {
    /// A task signed for the agent with `edit` applied before the signature.
    fn task_with(
        &self,
        bounds: &[(&str, u128)],
        max_actions: u8,
        edit: impl FnOnce(&mut airlock_policy::task::OwnerTask),
    ) -> Task {
        let contract: near_sdk::AccountId = self.s.contract.as_str().parse().unwrap();
        let agent_id: near_sdk::AccountId = self.agent.as_str().parse().unwrap();
        let (task, sig) = signed_task_with(bounds, max_actions, |t| {
            t.contract_id = contract;
            t.agent_id = agent_id;
            edit(t);
        });
        Task { task, sig }
    }

    fn task(&self, bounds: &[(&str, u128)], max_actions: u8) -> Task {
        self.task_with(bounds, max_actions, |_| {})
    }

    /// A call that must succeed: its outcomes and its events.
    async fn submit_ok(&self, task: &Task, reqs: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
        let result = agent_call(
            &self.s,
            &self.agent,
            &self.agent_signer,
            "submit_batch",
            task.args(reqs),
        )
        .await;
        let text = failure_text(&result);
        assert!(text.is_empty(), "submit_batch failed: {text}");
        let events = extract_event_logs(&result).expect("the events parse");
        let value: Value = result.json().expect("the outcomes parse");
        let outcomes = value.as_array().expect("an array of outcomes").clone();
        (outcomes, events)
    }

    /// Escalates one request and returns its numbers; the verdict reason must be `reason`.
    async fn escalate(
        &self,
        task: &Task,
        index: u8,
        payee: &str,
        amount: u128,
        labels: [u16; 3],
        reason: &str,
    ) -> Esc {
        let (outs, _) = self
            .submit_ok(task, vec![req(index, payee, amount, labels)])
            .await;
        assert_eq!(outs[0]["outcome"], "escalated", "{}", outs[0]);
        assert_eq!(outs[0]["reason"], reason, "{}", outs[0]);
        esc_of(&outs[0])
    }

    /// A new recipient (`BOB`, labels Owner, Owner, Owner) escalates `NewRecipient`.
    async fn new_recipient(&self, task: &Task, index: u8, amount: u128) -> Esc {
        self.escalate(task, index, BOB, amount, [OWNER; 3], "NewRecipient")
            .await
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

    /// What the console card sends: the six strings of the approve call, taken from the stored view of the request.
    async fn card(&self, esc: &Esc) -> Value {
        let v = self.request(&esc.request_id).await;
        json!({
            "id": v["id"],
            "to": v["payee"],
            "asset": v["display"]["asset_symbol"],
            "amount": v["display"]["amount_decimal"],
            "why": v["reason"],
            "book": v["book_status"]
        })
    }

    async fn approve(&self, args: Value) -> ExecutionFinalResult {
        owner_call(&self.s, "approve", args).await
    }

    /// An approval that must succeed.
    async fn approve_ok(&self, args: Value) -> ExecutionFinalResult {
        let result = self.approve(args).await;
        let text = failure_text(&result);
        assert!(text.is_empty(), "approve failed: {text}");
        result.clone().assert_success();
        result
    }

    /// The record the contract stored for `id`, read from the raw state. The key of a `LookupMap` entry is the borsh of the storage
    /// key, then the borsh of the map key.
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

    /// The state of the request as `get_request` shows it.
    async fn state(&self, esc: &Esc) -> String {
        self.request(&esc.request_id).await["state"]
            .as_str()
            .expect("a state")
            .to_string()
    }
}

fn esc_of(outcome: &Value) -> Esc {
    Esc {
        no: outcome["pending_id"]
            .as_str()
            .expect("a pending id")
            .to_string(),
        request_id: outcome["request_id"]
            .as_str()
            .expect("a request id")
            .to_string(),
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

/// The data field names docs/events.md gives the event `name`: the row is `| `name` | `field: type`, ... | emitted by |`.
fn documented_fields(name: &str) -> Vec<String> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/events.md");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let wanted = format!("`{name}`");
    for line in text.lines() {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        if cells.len() >= 4 && cells[1] == wanted {
            return cells[2]
                .split('`')
                .enumerate()
                .filter(|(i, _)| i % 2 == 1)
                .map(|(_, span)| span.split(':').next().unwrap_or("").trim().to_string())
                .collect();
        }
    }
    panic!("docs/events.md has no row for {name}");
}

fn is_decimal(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn tgas(gas: u64) -> String {
    format!("{:.2}", gas as f64 / 1e12)
}

/// The digest the contract must have stored, recomputed here from the raw record with `DigestPreimage` and sha256.
fn recomputed_digest(rec: &RequestRecord) -> String {
    let info = rec.pending.as_ref().expect("an escalation has `pending`");
    let preimage = DigestPreimage {
        request_id: request_id(&rec.task_hash, rec.index),
        no: info.no,
        agent: rec.agent.clone(),
        task_hash: rec.task_hash,
        asset: rec.asset.clone(),
        payee: rec.payee.clone(),
        amount: rec.amount,
        labels: [rec.labels.recipient, rec.labels.amount, rec.labels.pc],
        reason: rec.reason.clone().expect("an escalation has a reason"),
        book_status: if info.book_in { "in_book" } else { "new" }.to_string(),
        evm: rec.evm.map(|e| {
            [
                e.gas_limit.0,
                e.max_fee_per_gas.0,
                e.max_priority_fee_per_gas.0,
            ]
        }),
    };
    hex::encode(digest_of(&preimage))
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. The stored card
// ---------------------------------------------------------------------------------------------------------------------

/// The stored 9.4 NEAR correction shows the readable amount and symbol, the book status, the expiry and a digest, in `get_request`
/// (by derived id and by short number) and in `get_pending`.
#[tokio::test]
async fn stored_correction_shows_readable_display() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(9) + near(4) / 10).await;
    assert_eq!(esc.no, "1");
    let view = fx.request(&esc.request_id).await;
    assert_eq!(view["display"]["amount_decimal"], "9.4", "{view}");
    assert_eq!(view["display"]["asset_symbol"], "NEAR", "{view}");
    assert_eq!(view["amount"], "9400000000000000000000000", "{view}");
    assert_eq!(view["id"], "1", "{view}");
    assert_eq!(view["state"], "Pending", "{view}");
    assert_eq!(view["reason"], "NewRecipient", "{view}");
    assert_eq!(view["book_status"], "new", "{view}");
    assert_eq!(view["payee"], BOB, "{view}");
    let created: u64 = view["created_ms"].as_str().unwrap().parse().unwrap();
    let expires: u64 = view["expires_ms"].as_str().unwrap().parse().unwrap();
    assert_eq!(expires, created + PENDING_TTL_MS, "{view}");
    let digest = view["digest"].as_str().expect("a digest");
    assert_eq!(digest.len(), 64, "{view}");
    assert!(
        digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "{view}"
    );
    // the short number answers with the same view, and so does the pending list
    assert_eq!(fx.request("1").await, view);
    let pending = fx.view("get_pending", json!({})).await;
    assert_eq!(pending, json!([view]), "{pending}");
    // a digest that is not the placeholder of the gate: it equals sha256 of the borsh preimage
    let rec = fx.stored(&esc.request_id).await.expect("stored");
    assert_eq!(recomputed_digest(&rec), digest);
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Each wrong argument
// ---------------------------------------------------------------------------------------------------------------------

/// One new recipient escalation of 9.4 NEAR, the card with `key` replaced by `wrong`: the approve reverts with `text`, and the
/// request is still pending afterwards.
async fn wrong_argument_reverts(key: &str, wrong: &str, text: &str) {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(9) + near(4) / 10).await;
    let card = fx.card(&esc).await;
    let result = fx.approve(with(card.clone(), key, json!(wrong))).await;
    assert_reverts(&result, text);
    assert_eq!(fx.state(&esc).await, "Pending");
    // the unchanged card is still accepted: the revert left everything in place
    let _ = fx.approve_ok(card).await;
}

#[tokio::test]
async fn wrong_to_reverts_wrong_recipient() {
    wrong_argument_reverts("to", ALICE, "approve rejected: WrongRecipient").await;
}

#[tokio::test]
async fn wrong_asset_reverts_wrong_asset() {
    wrong_argument_reverts("asset", "near", "approve rejected: WrongAsset").await;
}

#[tokio::test]
async fn wrong_amount_reverts_wrong_amount() {
    wrong_argument_reverts("amount", "9.40", "approve rejected: WrongAmount").await;
}

#[tokio::test]
async fn wrong_why_reverts_wrong_reason() {
    wrong_argument_reverts("why", "OutsideTask", "approve rejected: WrongReason").await;
}

#[tokio::test]
async fn wrong_book_reverts_wrong_book() {
    wrong_argument_reverts("book", "in_book", "approve rejected: WrongBook").await;
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. The approval
// ---------------------------------------------------------------------------------------------------------------------

/// The correct call emits one `approved` event with exactly the five documented fields whose `digest` is the stored one and the one
/// recomputed from the record; `get_request` afterwards still shows the card (the record is `Executed` now).
#[tokio::test]
async fn approve_emits_approved_with_the_stored_and_recomputed_digest() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let before = fx.request(&esc.request_id).await;
    let result = fx.approve_ok(fx.card(&esc).await).await;
    let events = extract_event_logs(&result).expect("the events parse");
    let approved = named(&events, "approved");
    assert_eq!(approved.len(), 1, "{events:?}");
    // the NEAR lane (AIR-101) pays in the same transaction: `approved`, then `paid`, nothing else
    assert_eq!(named(&events, "paid").len(), 1, "{events:?}");
    assert_eq!(events.len(), 2, "approve emits nothing else: {events:?}");
    assert_eq!(approved[0]["standard"], "airlock");
    assert_eq!(approved[0]["version"], "1.0.0");
    let data = &approved[0]["data"][0];
    let mut keys: Vec<&str> = data
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["approver", "block_height", "digest", "id", "request_id"],
        "{data}"
    );
    // and they are the fields docs/events.md documents for `approved`
    let mut documented = documented_fields("approved");
    documented.sort_unstable();
    assert_eq!(keys, documented, "docs/events.md and the event differ");
    assert_eq!(data["request_id"], esc.request_id.as_str(), "{data}");
    assert_eq!(data["id"], esc.no.as_str(), "{data}");
    assert_eq!(data["approver"], fx.s.owner.as_str(), "{data}");
    let height = data["block_height"].as_str().expect("a decimal string");
    assert!(is_decimal(height) && height != "0", "{data}");
    // the digest of the event is the stored one and the recomputed one
    assert_eq!(data["digest"], before["digest"], "{data}");
    let rec = fx.stored(&esc.request_id).await.expect("stored");
    assert_eq!(data["digest"], recomputed_digest(&rec).as_str(), "{data}");
    // the record moved on and still shows the card, for the verifier that reads it at the approval block
    let after = fx.request(&esc.request_id).await;
    assert_eq!(after["state"], "Executed", "{after}");
    for key in ["id", "book_status", "display", "digest", "expires_ms"] {
        assert_eq!(after[key], before[key], "{key} changed: {after}");
    }
}

/// `get_request` by the short number keeps working after the approval; a number that is not canonical decimal answers null.
#[tokio::test]
async fn get_request_by_short_number_works_after_approve() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let _ = fx.approve_ok(fx.card(&esc).await).await;
    let by_number = fx.request(&esc.no).await;
    assert_eq!(by_number["request_id"], esc.request_id.as_str());
    assert_eq!(by_number["state"], "Executed");
    assert_eq!(by_number, fx.request(&esc.request_id).await);
    for text in ["+1", "01", "2", ""] {
        assert!(
            fx.request(text).await.is_null(),
            "get_request({text:?}) must be null"
        );
    }
}

/// A second approve of the same id says `NotPending`, not `unknown id`: the number stays resolvable after the approval.
#[tokio::test]
async fn second_approve_reverts_not_pending() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    let _ = fx.approve_ok(card.clone()).await;
    let again = fx.approve(card).await;
    assert_reverts(&again, "approve rejected: NotPending");
    let text = failure_text(&again);
    assert!(!text.contains("unknown id"), "{text}");
    // the second approve charged nothing
    let l = fx.ledgers(BOB, &task).await;
    assert_eq!(l["asset_day"]["spent"], near(3).to_string(), "{l}");
}

/// `id` must be the canonical decimal of a u32: `+1` and `001` parse to the pending number 1 and still revert `unknown id`, and so do
/// the other spellings; a number nobody was given reverts the same way. The request stays pending and the canonical id works.
#[tokio::test]
async fn id_must_be_canonical_decimal() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    for bad in [
        "+1",
        "007",
        "001",
        "01",
        " 1",
        "1 ",
        "0x1",
        "1.0",
        "-1",
        "",
        "2",
        "0",
        "4294967296",
        "00000000001",
    ] {
        let result = fx.approve(with(card.clone(), "id", json!(bad))).await;
        assert_reverts(&result, "unknown id");
    }
    assert_eq!(fx.state(&esc).await, "Pending");
    let _ = fx.approve_ok(card).await;
}

/// After the time to live the approve reverts `Expired`: `pending_ttl_ms` is 1, the escalation is stored, three seconds pass (blocks
/// come about every 1.5 s) and the owner's call comes too late.
#[tokio::test]
async fn approve_after_the_ttl_reverts_expired() {
    let _slot = slot().await;
    let fx = fixture().await;
    owner_ok(&fx.s, "set_flags", flags(1, 3, 6)).await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let result = fx.approve(card).await;
    assert_reverts(&result, "approve rejected: Expired");
    assert_eq!(fx.state(&esc).await, "Pending");
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Who may call and with what deposit
// ---------------------------------------------------------------------------------------------------------------------

/// A stranger and the agent itself cannot approve, even with the one yocto.
#[tokio::test]
async fn stranger_cannot_approve() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    let (stranger, stranger_signer) =
        create_user_account(&fx.s.net, &fx.s.owner, &fx.s.owner_signer, "stranger")
            .await
            .expect("the stranger account is created");
    for (who, signer) in [(&stranger, &stranger_signer), (&fx.agent, &fx.agent_signer)] {
        let result = call_transaction(
            &fx.s.contract,
            "approve",
            card.clone(),
            who,
            signer,
            &fx.s.net,
            Some(NearToken::from_yoctonear(1)),
        )
        .await
        .expect("the call is sent");
        assert_reverts(&result, "Caller is not the owner");
    }
    assert_eq!(fx.state(&esc).await, "Pending");
}

/// Not even the owner can approve without a deposit, or with two yocto: exactly one yoctoNEAR (a function-call key cannot attach it).
#[tokio::test]
async fn no_deposit_and_two_yocto_revert() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    for yocto in [0u128, 2] {
        let result = call_transaction(
            &fx.s.contract,
            "approve",
            card.clone(),
            &fx.s.owner,
            &fx.s.owner_signer,
            &fx.s.net,
            Some(NearToken::from_yoctonear(yocto)),
        )
        .await
        .expect("the call is sent");
        assert_reverts(&result, "Requires attached deposit of exactly 1 yoctoNEAR");
    }
    assert_eq!(fx.state(&esc).await, "Pending");
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. What is checked live
// ---------------------------------------------------------------------------------------------------------------------

/// While the contract is paused the approve fails the recheck `Limit:Paused`; after the owner resumes it succeeds.
#[tokio::test]
async fn approve_while_paused_reverts_limit_paused() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    owner_ok(&fx.s, "pause", json!({ "paused": true })).await;
    let result = fx.approve(card.clone()).await;
    assert_reverts(&result, "approve rejected: Limit:Paused");
    assert_eq!(fx.state(&esc).await, "Pending");
    owner_ok(&fx.s, "pause", json!({ "paused": false })).await;
    let _ = fx.approve_ok(card).await;
}

/// After `revoke_agent` the agent's pending escalation fails its approve `AgentNotAllowed`.
#[tokio::test]
async fn approve_after_revoke_agent_reverts_agent_not_allowed() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    owner_ok(
        &fx.s,
        "revoke_agent",
        json!({ "account_id": fx.agent.as_str() }),
    )
    .await;
    let result = fx.approve(card).await;
    assert_reverts(&result, "approve rejected: AgentNotAllowed");
    assert_eq!(fx.state(&esc).await, "Pending");
}

/// After `revoke_task` the task's pending escalation fails its approve `TaskRevoked`.
#[tokio::test]
async fn approve_after_revoke_task_reverts_task_revoked() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    owner_ok(
        &fx.s,
        "revoke_task",
        json!({ "task_hash": task.hash_hex() }),
    )
    .await;
    let result = fx.approve(card).await;
    assert_reverts(&result, "approve rejected: TaskRevoked");
    assert_eq!(fx.state(&esc).await, "Pending");
}

/// The recheck reads the registry now: a removed asset fails `Limit:UnknownAsset`.
#[tokio::test]
async fn approve_after_the_asset_was_removed_reverts_unknown_asset() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    owner_ok(&fx.s, "asset_remove", json!({ "asset": "near" })).await;
    let result = fx.approve(card).await;
    assert_reverts(&result, "approve rejected: Limit:UnknownAsset");
    assert_eq!(fx.state(&esc).await, "Pending");
}

/// The amount text is compared with the registry decimals read now: if the owner re-registers the asset with other decimals after the
/// card was stored, the stored card no longer matches and the approve fails closed with `WrongAmount`.
#[tokio::test]
async fn approve_after_the_decimals_changed_reverts_wrong_amount() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let card = fx.card(&esc).await;
    let mut entry = near_entry();
    entry["decimals"] = json!(18);
    owner_ok(
        &fx.s,
        "asset_set",
        json!({ "asset": "near", "entry": entry }),
    )
    .await;
    let result = fx.approve(card).await;
    assert_reverts(&result, "approve rejected: WrongAmount");
    assert_eq!(fx.state(&esc).await, "Pending");
}

/// A payee that left the book after the escalation does not change the stored card (`book_status` stays `in_book`): the approve works,
/// and the payment is recorded in that payee's day ledger, which has no limit any more.
#[tokio::test]
async fn approve_after_the_payee_left_the_book() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, near(100))], 20);
    // 25 NEAR is above Alice's daily limit of 20 NEAR
    let esc = fx
        .escalate(
            &task,
            0,
            ALICE,
            near(25),
            [BOOK, OWNER, OWNER],
            "OverPayeeLimit",
        )
        .await;
    let card = fx.card(&esc).await;
    assert_eq!(card["book"], "in_book", "{card}");
    owner_ok(&fx.s, "book_remove", json!({ "key": ALICE })).await;
    let _ = fx.approve_ok(card).await;
    assert_eq!(fx.state(&esc).await, "Executed");
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["payee_day"]["spent"], near(25).to_string(), "{l}");
    assert_eq!(l["asset_day"]["spent"], near(25).to_string(), "{l}");
    assert_eq!(l["task_spent"], near(25).to_string(), "{l}");
}

/// Approving at the same book epoch charges the payee's day ledger with the limit stored at escalation (AIR-326): 25 NEAR over a daily
/// limit of 20 NEAR leaves the ledger at the limit, while the asset ledger shows the whole 25.
#[tokio::test]
async fn approve_at_the_same_epoch_saturates_the_payee_ledger_at_the_stored_limit() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, near(100))], 20);
    let esc = fx
        .escalate(
            &task,
            0,
            ALICE,
            near(25),
            [BOOK, OWNER, OWNER],
            "OverPayeeLimit",
        )
        .await;
    let card = fx.card(&esc).await;
    assert_eq!(card["book"], "in_book", "{card}");
    let _ = fx.approve_ok(card).await;
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["payee_day"]["spent"], near(20).to_string(), "{l}");
    assert_eq!(l["asset_day"]["spent"], near(25).to_string(), "{l}");
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. The ledgers
// ---------------------------------------------------------------------------------------------------------------------

/// R3-03: approving an OverTaskBound request uses the bound up: 15 NEAR under a bound of 10 NEAR leaves 0 remaining on the bound. The
/// stored record keeps the applied charge for the refund (the task part saturated at the bound).
#[tokio::test]
async fn approving_over_task_bound_leaves_zero_remaining() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, near(10))], 20);
    let esc = fx
        .escalate(
            &task,
            0,
            ALICE,
            near(15),
            [BOOK, OWNER, OWNER],
            "OverTaskBound",
        )
        .await;
    let _ = fx.approve_ok(fx.card(&esc).await).await;
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(
        l["task_spent"],
        near(10).to_string(),
        "the bound is used up: {l}"
    );
    assert_eq!(l["asset_day"]["spent"], near(15).to_string(), "{l}");
    assert_eq!(l["payee_day"]["spent"], near(15).to_string(), "{l}");
    let rec = fx.stored(&esc.request_id).await.expect("stored");
    let charge = rec.applied_charge.expect("an approval stores its charge");
    assert_eq!(
        (
            charge.asset_day,
            charge.payee_day,
            charge.payee_untrusted_day,
            charge.task
        ),
        (near(15), near(15), 0, near(10))
    );
    assert!(rec.charge_day > 0, "the day of the charge is stored");
}

/// F05 "Approval charges": an approval reduces the asset day and the task remainder, and leaves the untrusted budget as it was. An
/// untrusted Allow first spends 0.5 NEAR of Alice's untrusted budget; the escalation that follows (2 NEAR, above her 1 NEAR cap) is
/// approved and every ledger but the untrusted one moves by 2 NEAR.
#[tokio::test]
async fn approval_charges_asset_day_and_task_and_not_the_untrusted_budget() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, near(100))], 20);
    let half = near(1) / 2;
    let (outs, _) = fx
        .submit_ok(
            &task,
            vec![
                req(0, ALICE, half, [BOOK, EMAIL, OWNER]),
                req(1, ALICE, near(2), [BOOK, EMAIL, OWNER]),
            ],
        )
        .await;
    assert_eq!(outs[0]["outcome"], "allowed", "{}", outs[0]);
    assert_eq!(outs[1]["outcome"], "escalated", "{}", outs[1]);
    assert_eq!(outs[1]["reason"], "UntrustedAmount", "{}", outs[1]);
    let before = fx.ledgers(ALICE, &task).await;
    assert_eq!(
        before["payee_untrusted_day"]["spent"],
        half.to_string(),
        "{before}"
    );
    let _ = fx.approve_ok(fx.card(&esc_of(&outs[1])).await).await;
    let after = fx.ledgers(ALICE, &task).await;
    let total = half + near(2);
    assert_eq!(after["asset_day"]["spent"], total.to_string(), "{after}");
    assert_eq!(after["payee_day"]["spent"], total.to_string(), "{after}");
    assert_eq!(after["task_spent"], total.to_string(), "{after}");
    assert_eq!(
        after["payee_untrusted_day"]["spent"], before["payee_untrusted_day"]["spent"],
        "an approval never charges the untrusted budget: {after}"
    );
    assert_eq!(
        after["asset_day"]["remaining"],
        (near(100_000) - total).to_string(),
        "{after}"
    );
}

/// Approving a NewRecipient request whose payee is not in the book records that payee's day ledger (it has no cap, so its cap reads 0,
/// and a later `book_add` sees the spend).
#[tokio::test]
async fn approving_a_new_recipient_records_the_payee_day_ledger() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let before = fx.ledgers(BOB, &task).await;
    assert_eq!(before["payee_day"]["spent"], "0", "{before}");
    let _ = fx.approve_ok(fx.card(&esc).await).await;
    let l = fx.ledgers(BOB, &task).await;
    assert_eq!(l["payee_day"]["spent"], near(3).to_string(), "{l}");
    assert_eq!(l["payee_day"]["cap"], "0", "{l}");
    assert_eq!(l["task_spent"], near(3).to_string(), "{l}");
    assert_eq!(l["payee_untrusted_day"]["spent"], "0", "{l}");
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. get_pending
// ---------------------------------------------------------------------------------------------------------------------

fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .expect("an array")
        .iter()
        .map(|item| item["id"].as_str().expect("an id").to_string())
        .collect()
}

/// `get_pending(0, 10)` lists the pending items in insertion order and omits the approved ones, however the set reorders itself on a
/// removal; `from_index` and `limit` slice the sorted list and never revert.
#[tokio::test]
async fn get_pending_is_ordered_and_omits_approved() {
    let _slot = slot().await;
    let fx = fixture().await;
    // four pending at once: the flood cap of AIR-083 (3 by default) is not what this test is about, so raise it
    owner_ok(&fx.s, "set_flags", flags(PENDING_TTL_MS, 100, 1_000)).await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let (outs, _) = fx
        .submit_ok(
            &task,
            vec![
                req(0, BOB, near(1), [OWNER; 3]),
                req(1, BOB, near(2), [OWNER; 3]),
                req(2, BOB, near(3), [OWNER; 3]),
            ],
        )
        .await;
    let fourth = fx.new_recipient(&task, 3, near(4)).await;
    let first = esc_of(&outs[0]);
    let third = esc_of(&outs[2]);
    let all = fx
        .view("get_pending", json!({ "from_index": 0, "limit": 10 }))
        .await;
    assert_eq!(ids(&all), ["1", "2", "3", "4"], "{all}");
    assert_eq!(all[3]["request_id"], fourth.request_id.as_str(), "{all}");
    // the items carry the fields the console card prints
    for key in [
        "id",
        "request_id",
        "payee",
        "asset",
        "amount",
        "labels",
        "reason",
        "book_status",
        "display",
        "created_ms",
        "expires_ms",
        "digest",
    ] {
        assert!(
            !all[0][key].is_null(),
            "get_pending lacks {key}: {}",
            all[0]
        );
    }
    let _ = fx.approve_ok(fx.card(&first).await).await;
    let rest = fx
        .view("get_pending", json!({ "from_index": 0, "limit": 10 }))
        .await;
    assert_eq!(ids(&rest), ["2", "3", "4"], "{rest}");
    let _ = fx.approve_ok(fx.card(&third).await).await;
    let rest = fx.view("get_pending", json!({})).await;
    assert_eq!(ids(&rest), ["2", "4"], "{rest}");
    let page = fx
        .view("get_pending", json!({ "from_index": 1, "limit": 1 }))
        .await;
    assert_eq!(ids(&page), ["4"], "{page}");
    let none = fx
        .view("get_pending", json!({ "from_index": 0, "limit": 0 }))
        .await;
    assert_eq!(ids(&none), Vec::<String>::new(), "{none}");
    let past = fx
        .view("get_pending", json!({ "from_index": 50, "limit": 5 }))
        .await;
    assert_eq!(ids(&past), Vec::<String>::new(), "{past}");
}

/// With 24 requests pending, `limit` 500 returns 20, the first twenty by number, and a second page starts where the first ended.
#[tokio::test]
async fn get_pending_limit_500_returns_at_most_20() {
    let _slot = slot().await;
    let fx = fixture().await;
    // a later flood cap (AIR-083) must not interfere with the count: raise the three numbers it reads
    owner_ok(&fx.s, "set_flags", flags(PENDING_TTL_MS, 100, 1_000)).await;
    // the wasm (about 1 MB) locks about 9.9 of the 10 NEAR a test contract account gets, which leaves room for about 15 stored
    // escalations (`LackBalanceForState`): top the account up so 24 fit
    Tokens::account(fx.s.owner.clone())
        .send_to(fx.s.contract.clone())
        .near(NearToken::from_near(5))
        .with_signer(fx.s.owner_signer.clone())
        .send_to(&fx.s.net)
        .await
        .expect("the top up is sent")
        .assert_success();
    for name in ["task-1", "task-2"] {
        let task = fx.task_with(&[(BOB, near(1_000))], 20, |t| t.task_id = name.to_string());
        for batch in 0..4u8 {
            let reqs: Vec<Value> = (0..3u8)
                .map(|i| {
                    with(
                        req(batch * 3 + i, BOB, near(1), [OWNER; 3]),
                        "task_id",
                        json!(name),
                    )
                })
                .collect();
            let (outs, _) = fx.submit_ok(&task, reqs).await;
            for out in &outs {
                assert_eq!(out["outcome"], "escalated", "{out}");
            }
        }
    }
    let page = fx
        .view("get_pending", json!({ "from_index": 0, "limit": 500 }))
        .await;
    let want: Vec<String> = (1..=20).map(|n| n.to_string()).collect();
    assert_eq!(ids(&page), want, "{page}");
    let default = fx.view("get_pending", json!({})).await;
    assert_eq!(ids(&default).len(), 20, "{default}");
    let second = fx
        .view("get_pending", json!({ "from_index": 20, "limit": 500 }))
        .await;
    let rest: Vec<String> = (21..=24).map(|n| n.to_string()).collect();
    assert_eq!(ids(&second), rest, "{second}");
}

/// Both methods exist in the wasm: `get_pending` answers, `approve` succeeds, and the list is empty afterwards. A missing export would
/// fail here with `MethodNotFound`.
#[tokio::test]
async fn approve_and_get_pending_exported() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let pending = fx
        .view("get_pending", json!({ "from_index": 0, "limit": 10 }))
        .await;
    assert_eq!(ids(&pending), ["1"], "{pending}");
    let result = fx.approve_ok(fx.card(&esc).await).await;
    assert!(
        !failure_text(&result).contains("MethodNotFound"),
        "approve is not exported"
    );
    let pending = fx
        .view("get_pending", json!({ "from_index": 0, "limit": 10 }))
        .await;
    assert_eq!(ids(&pending), Vec::<String>::new(), "{pending}");
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. Substitution (AB10) and gas
// ---------------------------------------------------------------------------------------------------------------------

/// AB10: the arguments never choose what executes, the stored request does. With two escalations pending, the card of one with the
/// strings of the other, or with invented strings, reverts and changes nothing; the approval that goes through charges exactly the
/// stored amount of the stored payee, and `get_request` still shows the stored amount.
#[tokio::test]
async fn ab10_substitution_cannot_change_what_executes() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100)), (CAROL, near(100))], 20);
    let small = fx.new_recipient(&task, 0, near(3)).await;
    let big = fx
        .escalate(&task, 1, CAROL, near(70), [OWNER; 3], "NewRecipient")
        .await;
    let small_card = fx.card(&small).await;
    let big_card = fx.card(&big).await;
    let untouched = fx.ledgers(BOB, &task).await;
    // the id of the small request with each of the big request's strings, one at a time and all together
    for (key, text) in [("to", "WrongRecipient"), ("amount", "WrongAmount")] {
        let swapped = with(small_card.clone(), key, big_card[key].clone());
        assert_reverts(
            &fx.approve(swapped).await,
            &format!("approve rejected: {text}"),
        );
    }
    let mut mixed = big_card.clone();
    mixed["id"] = small_card["id"].clone();
    assert_reverts(&fx.approve(mixed).await, "approve rejected: WrongRecipient");
    // invented strings: another payee, a larger amount, another asset
    let invented = json!({
        "id": small_card["id"], "to": ALICE, "asset": "ETH", "amount": "9000", "why": "OverPayeeLimit", "book": "in_book"
    });
    assert_reverts(
        &fx.approve(invented).await,
        "approve rejected: WrongRecipient",
    );
    // nothing moved: both requests are pending and no ledger changed
    assert_eq!(fx.state(&small).await, "Pending");
    assert_eq!(fx.state(&big).await, "Pending");
    assert_eq!(fx.ledgers(BOB, &task).await, untouched);
    assert_eq!(fx.ledgers(CAROL, &task).await["asset_day"]["spent"], "0");
    // the right card goes through and the charge is the stored amount of the stored payee
    let _ = fx.approve_ok(small_card).await;
    let l = fx.ledgers(BOB, &task).await;
    assert_eq!(l["asset_day"]["spent"], near(3).to_string(), "{l}");
    assert_eq!(l["payee_day"]["spent"], near(3).to_string(), "{l}");
    assert_eq!(l["task_spent"], near(3).to_string(), "{l}");
    let view = fx.request(&small.request_id).await;
    assert_eq!(view["amount"], near(3).to_string(), "{view}");
    assert_eq!(view["payee"], BOB, "{view}");
    assert_eq!(fx.ledgers(CAROL, &task).await["task_spent"], "0");
    assert_eq!(fx.state(&big).await, "Pending");
}

/// The approve of a NEAR escalation burns under 30 Tgas in total (the ceiling AIR-061 uses for a single Allow; AIR-107 measures the
/// real figure on testnet, because the sandbox is protocol 83).
#[tokio::test]
async fn approve_gas_near_under_30_tgas() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(3)).await;
    let result = fx.approve_ok(fx.card(&esc).await).await;
    let gas = gas_report(&result);
    println!("GAS approve_near={} Tgas", tgas(gas));
    assert!(gas < GAS_CEILING, "approve burnt {} Tgas", tgas(gas));
}

// ---------------------------------------------------------------------------------------------------------------------
// 9. The digest vector and the exports
// ---------------------------------------------------------------------------------------------------------------------

fn vector() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/digest-vector.json"
    );
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    serde_json::from_str(&text).expect("fixtures/digest-vector.json parses")
}

/// The record of the vector file as a `DigestPreimage`.
fn preimage_of_vector(v: &Value) -> DigestPreimage {
    let r = &v["record"];
    let text = |key: &str| {
        r[key]
            .as_str()
            .unwrap_or_else(|| panic!("{key}"))
            .to_string()
    };
    let amount =
        |value: &Value| -> u128 { value.as_str().expect("a decimal string").parse().unwrap() };
    let labels = r["labels"].as_array().expect("three labels");
    assert_eq!(labels.len(), 3);
    let mask = |i: usize| u16::try_from(labels[i].as_u64().expect("a number")).unwrap();
    let task_hash: [u8; 32] = hex::decode(text("task_hash")).unwrap().try_into().unwrap();
    let evm = if r["evm"].is_null() {
        None
    } else {
        let triple = r["evm"].as_array().expect("three decimal strings");
        assert_eq!(triple.len(), 3);
        Some([amount(&triple[0]), amount(&triple[1]), amount(&triple[2])])
    };
    DigestPreimage {
        request_id: text("request_id"),
        no: u32::try_from(r["no"].as_u64().expect("a number")).unwrap(),
        agent: text("agent").parse().unwrap(),
        task_hash,
        asset: text("asset"),
        payee: text("payee"),
        amount: amount(&r["amount"]),
        labels: [mask(0), mask(1), mask(2)],
        reason: text("reason"),
        book_status: text("book_status"),
        evm,
    }
}

/// `scripts/gen_digest_vector.mjs` writes the vector with hand written borsh; the contract's `DigestPreimage` must give the same bytes
/// and the same sha256 for the same record. A changed field gives another digest.
#[test]
fn digest_vector_matches_the_contract_preimage() {
    let v = vector();
    let preimage = preimage_of_vector(&v);
    let bytes = near_sdk::borsh::to_vec(&preimage).expect("the preimage serializes");
    assert_eq!(hex::encode(&bytes), v["borsh_hex"].as_str().unwrap());
    assert_eq!(
        hex::encode(digest_of(&preimage)),
        v["digest"].as_str().unwrap()
    );
    assert_eq!(v["digest"].as_str().unwrap().len(), 64);
    // the request id of the record is the task hash and the action index
    assert!(
        v["record"]["request_id"]
            .as_str()
            .unwrap()
            .starts_with(v["record"]["task_hash"].as_str().unwrap())
    );
    // every field is covered by the digest
    let mut other = preimage_of_vector(&v);
    other.amount += 1;
    assert_ne!(digest_of(&other), digest_of(&preimage), "amount");
    let mut other = preimage_of_vector(&v);
    other.no += 1;
    assert_ne!(digest_of(&other), digest_of(&preimage), "no");
    let mut other = preimage_of_vector(&v);
    other.evm = None;
    assert_ne!(digest_of(&other), digest_of(&preimage), "evm");
    let mut other = preimage_of_vector(&v);
    other.book_status = "new".to_string();
    assert_ne!(digest_of(&other), digest_of(&preimage), "book_status");
}

/// The layout the vector file carries (the ordered `{ name, borsh_type }` list AIR-085 reads) is the one the contract exports as
/// `PREIMAGE_LAYOUT`, and the record names exactly those fields.
#[test]
fn digest_vector_layout_is_the_contract_layout() {
    let v = vector();
    let layout = v["preimage_layout"].as_array().expect("a layout list");
    let from_file: Vec<(String, String)> = layout
        .iter()
        .map(|f| {
            (
                f["name"].as_str().unwrap().to_string(),
                f["borsh_type"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let from_contract: Vec<(String, String)> = PREIMAGE_LAYOUT
        .iter()
        .map(|(n, t)| ((*n).to_string(), (*t).to_string()))
        .collect();
    assert_eq!(from_file, from_contract);
    assert_eq!(from_file.len(), 11);
    let mut keys: Vec<&str> = v["record"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let mut names: Vec<&str> = from_file.iter().map(|(n, _)| n.as_str()).collect();
    keys.sort_unstable();
    names.sort_unstable();
    assert_eq!(keys, names);
    let top: Vec<&str> = {
        let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        k.sort_unstable();
        k
    };
    assert_eq!(top, ["borsh_hex", "digest", "preimage_layout", "record"]);
}

/// `approve` and `get_pending` are the new exports, and no helper of the escalation module is a method (`approve` runs the lane, so a
/// helper that reached it would be a backdoor).
#[test]
fn escalation_helpers_not_exported() {
    let exports = wasm_exports();
    for method in ["approve", "get_pending"] {
        assert!(
            exports.iter().any(|name| name == method),
            "the wasm does not export {method}: {exports:?}"
        );
    }
    for helper in [
        "escalate_reason_from_name",
        "canonical_no",
        "expire_tombstone",
        "resolve_escalation",
        "digest_of",
        "preimage_of",
        "pending_info",
        "amount_text",
        "index_pending",
        "pending_record",
    ] {
        assert!(
            !exports.iter().any(|name| name == helper),
            "the wasm exports the helper {helper}"
        );
    }
}

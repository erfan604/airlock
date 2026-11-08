// AIR-299: `approve_and_remember` in the sandbox. One owner call approves the held request exactly like `approve` and enters the stored
// payee into the address book with the owner's per-payment cap, daily limit and label, so the next payment inside those limits is
// allowed by the unchanged verdict. Every revert test asserts the message text and that nothing changed (the request is still pending
// and the book is empty).
//
// Setup is the one of tests/escalation.rs: asset `near`, book payee `near:alice.sandbox`, `near:bob.sandbox` is not in the book and is
// the payee that gets remembered.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, Data, NearToken, Signer, Tokens};
use near_api_types::transaction::result::ExecutionFinalResult;
use near_sdk::json_types::Base64VecU8;
use serde_json::{Value, json};
use std::sync::Arc;

/// Label masks (GLOSSARY, `airlock_verdict::labels`).
const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;

const ALICE: &str = "near:alice.sandbox";
const BOB: &str = "near:bob.sandbox";
const CAROL: &str = "near:carol.sandbox";

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

/// A signed task and what a call needs of it.
struct Task {
    task: airlock_policy::task::OwnerTask,
    sig: Base64VecU8,
}

impl Task {
    fn args(&self, reqs: Vec<Value>) -> Value {
        json!({ "reqs": reqs, "task": self.task, "task_sig": self.sig })
    }
}

/// One escalation: its short pending number and its derived request id.
struct Esc {
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

const CAP: u128 = 3;
const DAILY: u128 = 10;

impl Fx {
    /// The card of `esc` plus the owner's three remember arguments.
    async fn remember_args(&self, esc: &Esc, cap: u128, daily: u128, label: &str) -> Value {
        let _ = label; // the label lives in the owner's vault since AIR-326
        let mut args = self.card(esc).await;
        let payee = args["to"].as_str().expect("a payee").to_string();
        let (old, new_root, entry) =
            shim_remember(&self.s.contract, &self.s.net, &payee, cap, daily);
        args["expected_old"] = json!(old);
        args["new_root"] = json!(new_root);
        args["entry"] = entry;
        args
    }

    async fn remember(&self, args: Value) -> ExecutionFinalResult {
        let result = owner_call(&self.s, "approve_and_remember", args).await;
        if failure_text(&result).is_empty() {
            shim_remember_done(&self.s.contract, &self.s.net);
        }
        result
    }

    async fn book_entry(&self, key: &str) -> Value {
        shim_entry_json(&self.s.contract, &self.s.net, key)
    }

    /// A refused remember: the revert text, the request still pending, BOB not in the book.
    async fn refused(&self, esc: &Esc, args: Value, text: &str) {
        let result = self.remember(args).await;
        assert_reverts(&result, text);
        assert_eq!(self.state(esc).await, "Pending");
        assert!(self.book_entry(BOB).await.is_null());
    }
}

#[tokio::test]
async fn remember_approves_and_books() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(2)).await;
    let args = fx
        .remember_args(&esc, near(CAP), near(DAILY), "Bob the plumber")
        .await;
    let result = fx.remember(args).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "approve_and_remember failed: {text}");
    result.clone().assert_success();
    assert_eq!(fx.state(&esc).await, "Executed");
    let entry = fx.book_entry(BOB).await;
    assert_eq!(entry["cap"], near(CAP).to_string(), "{entry}");
    assert_eq!(entry["daily_limit"], near(DAILY).to_string(), "{entry}");
    assert_eq!(entry["daily_untrusted_budget"], "0", "{entry}");
    // approved first, book_root_set after it
    let events = extract_event_logs(&result).expect("the events parse");
    let names: Vec<&str> = events.iter().filter_map(|e| e["event"].as_str()).collect();
    let approved = names
        .iter()
        .position(|n| *n == "approved")
        .expect("approved");
    let added = names
        .iter()
        .position(|n| *n == "book_root_set")
        .expect("book_root_set");
    assert!(approved < added, "{names:?}");
    assert!(
        !named(&events, "book_root_set")[0]["data"][0]
            .to_string()
            .contains("bob")
    );
}

#[tokio::test]
async fn remember_next_payment_allowed() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(2)).await;
    let args = fx.remember_args(&esc, near(CAP), near(DAILY), "Bob").await;
    let result = fx.remember(args).await;
    assert!(failure_text(&result).is_empty());
    // a second payment inside the cap, with the recipient label the runtime gives a book payee
    let (outs, _) = fx
        .submit_ok(&task, vec![req(1, BOB, near(2), [BOOK, OWNER, OWNER])])
        .await;
    assert_eq!(outs[0]["outcome"], "allowed", "{}", outs[0]);
    // 2 approved + 2 allowed + 7 is above the daily limit of 10 NEAR, so it escalates again
    let (outs, _) = fx
        .submit_ok(&task, vec![req(2, BOB, near(7), [BOOK, OWNER, OWNER])])
        .await;
    assert_eq!(outs[0]["outcome"], "escalated", "{}", outs[0]);
}

#[tokio::test]
async fn remember_rejects_cap_below_amount() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(2)).await;
    let args = fx.remember_args(&esc, near(1), near(DAILY), "Bob").await;
    fx.refused(&esc, args, "remember rejected: CapBelowAmount")
        .await;
    // above the asset's hard cap of 10,000 NEAR
    let args = fx
        .remember_args(&esc, near(10_001), near(20_000), "Bob")
        .await;
    fx.refused(&esc, args, "remember rejected: CapAboveAssetCap")
        .await;
}

#[tokio::test]
async fn remember_rejects_daily_below_cap() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(2)).await;
    let args = fx
        .remember_args(&esc, near(CAP), near(CAP) - 1, "Bob")
        .await;
    fx.refused(&esc, args, "remember rejected: DailyBelowCap")
        .await;
}

#[tokio::test]
async fn remember_rejects_already_in_book() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, near(100))], 20);
    // 25 NEAR is above Alice's daily limit of 20 NEAR, so a book payee escalates
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
    let args = fx.remember_args(&esc, near(30), near(40), "Alice").await;
    let result = fx.remember(args).await;
    assert_reverts(&result, "remember rejected: AlreadyInBook");
    assert_eq!(fx.state(&esc).await, "Pending");
    // the entry is the owner's original one
    assert_eq!(fx.book_entry(ALICE).await["cap"], near(1).to_string());
}

/// The book changed after the escalation (the payee left it): the stored `in_book` is stale, so the remember is allowed (AIR-326).
#[tokio::test]
async fn remember_after_the_book_changed_is_not_already_in_book() {
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
    owner_ok(&fx.s, "book_remove", json!({ "key": ALICE })).await;
    let args = fx.remember_args(&esc, near(30), near(40), "Alice").await;
    let result = fx.remember(args).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "approve_and_remember failed: {text}");
    assert_eq!(fx.state(&esc).await, "Executed");
}

#[tokio::test]
async fn remember_agent_cannot_call() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(2)).await;
    let args = fx.remember_args(&esc, near(CAP), near(DAILY), "Bob").await;
    let result = call_transaction(
        &fx.s.contract,
        "approve_and_remember",
        args,
        &fx.agent,
        &fx.agent_signer,
        &fx.s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap();
    assert_reverts(&result, "Caller is not the owner");
    assert_eq!(fx.state(&esc).await, "Pending");
    assert!(fx.book_entry(BOB).await.is_null());
}

#[tokio::test]
async fn remember_tampered_to_rejected() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(BOB, near(100))], 20);
    let esc = fx.new_recipient(&task, 0, near(2)).await;
    let args = with(
        fx.remember_args(&esc, near(CAP), near(DAILY), "Bob").await,
        "to",
        json!(CAROL),
    );
    fx.refused(&esc, args, "approve rejected: WrongRecipient")
        .await;
    assert!(fx.book_entry(CAROL).await.is_null());
}

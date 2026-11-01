// AIR-064: the read-only `preview` view in the sandbox. `preview(req, task)` runs the same `evaluate` as `submit_batch`, on the
// request and an unsigned copy of the task, and returns the outcome name, the reason and the charge an Allow would apply. It changes
// no state, and it is advisory: a view cannot learn the caller, so `submit_batch` decides (never treat a preview as authorization).
//
// Standard setup (as in tests/gate.rs): asset `near` with hard cap 10_000, daily cap 100_000 and quick task cap 100_000 (base
// units); book payee `near:alice.sandbox` with cap 100, untrusted budget 1_000 and daily limit 5_000; the agent `agent.sandbox` is
// registered and allowed, and the task key is set. Every revert test asserts the message text, because a missing method also fails
// and would pass a bare error check.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, Data, Signer};
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
const EVM_PAYEE: &str = "evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
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
    fn hash_hex(&self) -> String {
        hex::encode(airlock_policy::task::task_hash(&self.task))
    }

    fn submit_args(&self, reqs: Vec<Value>) -> Value {
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

async fn fixture() -> Fx {
    let s = start().await;
    owner_ok(
        &s,
        "asset_set",
        json!({
            "asset": "near",
            "entry": {
                "symbol": "NEAR",
                "decimals": 24,
                "hard_cap": "10000",
                "daily_cap": "100000",
                "max_fee_per_gas": "0",
                "max_gas": "0",
                "quick_task_cap": "100000",
                "path": null
            }
        }),
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

    async fn submit(&self, task: &Task, reqs: Vec<Value>) -> ExecutionFinalResult {
        agent_call(
            &self.s,
            &self.agent,
            &self.agent_signer,
            "submit_batch",
            task.submit_args(reqs),
        )
        .await
    }

    /// A submit that must succeed: the outcomes.
    async fn submit_ok(&self, task: &Task, reqs: Vec<Value>) -> Vec<Value> {
        let result = self.submit(task, reqs).await;
        let text = failure_text(&result);
        assert!(text.is_empty(), "submit_batch failed: {text}");
        let value: Value = result.json().expect("the outcomes parse");
        value.as_array().expect("an array of outcomes").clone()
    }

    /// The answer of a view, or the error text of a view that panicked.
    async fn try_view(&self, method: &str, args: Value) -> Result<Value, String> {
        call_view::<Value>(&self.s.contract, method, args, &self.s.net)
            .await
            .map(|answer: Data<Value>| answer.data)
            .map_err(|e| format!("{e:?}"))
    }

    async fn view(&self, method: &str, args: Value) -> Value {
        self.try_view(method, args)
            .await
            .unwrap_or_else(|e| panic!("{method} must answer: {e}"))
    }

    async fn try_preview(&self, task: &Task, req: Value) -> Result<Value, String> {
        self.try_view("preview", json!({ "req": req, "task": task.task }))
            .await
    }

    /// A preview that must answer.
    async fn preview(&self, task: &Task, req: Value) -> Value {
        self.try_preview(task, req)
            .await
            .unwrap_or_else(|e| panic!("preview must answer: {e}"))
    }

    async fn ledgers(&self, payee: &str, task: &Task) -> Value {
        self.view(
            "get_ledgers",
            json!({ "payee": payee, "asset": "near", "task": task.hash_hex() }),
        )
        .await
    }

    async fn task_state(&self, task: &Task) -> Value {
        self.view("get_task_state", json!({ "task_hash": task.hash_hex() }))
            .await
    }
}

fn assert_view(v: &Value, outcome: &str, reason: Option<&str>) {
    assert_eq!(v["outcome"], outcome, "{v}");
    match reason {
        Some(r) => assert_eq!(v["reason"], r, "{v}"),
        None => assert!(v["reason"].is_null(), "{v}"),
    }
}

/// The answer must be a revert with `text`.
fn assert_view_reverts(answer: &Result<Value, String>, text: &str) {
    match answer {
        Ok(v) => panic!("the view must revert with `{text}`, but it answered {v}"),
        Err(e) => assert!(e.contains(text), "expected `{text}` in: {e}"),
    }
}

/// A submit that must revert with `text`.
fn assert_submit_reverts(result: &ExecutionFinalResult, text: &str) {
    let got = failure_text(result);
    assert!(
        !got.is_empty(),
        "submit_batch must revert with `{text}`, but it succeeded"
    );
    assert!(got.contains(text), "expected `{text}` in: {got}");
}

/// A clean request is allowed in the preview with the charge it would apply, and the preview changes nothing: the four ledgers, the
/// task's action count and the record store read the same before and after.
#[tokio::test]
async fn preview_of_a_clean_request_allows_and_changes_no_state() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let request = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let ledgers_before = fx.ledgers(ALICE, &task).await;
    let state_before = fx.task_state(&task).await;
    let answer = fx.preview(&task, request).await;
    assert_view(&answer, "allowed", None);
    assert_eq!(
        answer["would_charge"],
        json!({ "asset_day": "10", "payee_day": "10", "payee_untrusted_day": "0", "task": "10" }),
        "{answer}"
    );
    assert_eq!(fx.ledgers(ALICE, &task).await, ledgers_before);
    assert_eq!(fx.task_state(&task).await, state_before);
    assert_eq!(state_before["actions_used"], 0);
    let id = format!("{}:0", task.hash_hex());
    let stored = fx.view("get_request", json!({ "id": id })).await;
    assert!(stored.is_null(), "preview stored a record: {stored}");
    // asking twice gives the same answer: nothing was charged by the first one
    let again = fx
        .preview(&task, req(0, ALICE, 10, [BOOK, OWNER, OWNER]))
        .await;
    assert_eq!(again, answer);
}

/// The correction of the 9.4 scenario is an amount read from untrusted text that is above the payee's cap: the preview escalates it
/// `UntrustedAmount` and charges nothing, while the same amount labelled Owner is allowed (the label decides, not the number).
#[tokio::test]
async fn preview_of_the_9_4_correction_escalates_untrusted_amount() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let answer = fx
        .preview(&task, req(0, ALICE, 101, [BOOK, EMAIL, OWNER]))
        .await;
    assert_view(&answer, "escalated", Some("UntrustedAmount"));
    assert!(answer["would_charge"].is_null(), "{answer}");
    let trusted = fx
        .preview(&task, req(0, ALICE, 101, [BOOK, OWNER, OWNER]))
        .await;
    assert_view(&trusted, "allowed", None);
    assert_eq!(trusted["would_charge"]["payee_untrusted_day"], "0");
    // an untrusted amount that fits the cap is allowed and the preview says it would charge the untrusted budget
    let at_cap = fx
        .preview(&task, req(0, ALICE, 100, [BOOK, EMAIL, OWNER]))
        .await;
    assert_view(&at_cap, "allowed", None);
    assert_eq!(at_cap["would_charge"]["payee_untrusted_day"], "100");
}

/// An amount over the asset's hard cap is blocked `AmountOutOfBounds`, with no charge.
#[tokio::test]
async fn preview_of_an_over_cap_request_blocks_amount_out_of_bounds() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 50_000)], 20);
    let answer = fx
        .preview(&task, req(0, ALICE, 10_001, [BOOK, OWNER, OWNER]))
        .await;
    assert_view(&answer, "blocked", Some("AmountOutOfBounds"));
    assert!(answer["would_charge"].is_null(), "{answer}");
    let zero = fx
        .preview(&task, req(0, ALICE, 0, [BOOK, OWNER, OWNER]))
        .await;
    assert_view(&zero, "blocked", Some("AmountOutOfBounds"));
}

/// A preview and the `submit_batch` that follows agree on the outcome and the reason of an Allow, an escalation and a Block, and the
/// charge the preview named for the Allow is what the ledgers took.
#[tokio::test]
async fn preview_and_submit_batch_agree() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 50_000), (BOB, 1_000)], 20);
    let reqs = vec![
        req(0, ALICE, 10, [BOOK, OWNER, OWNER]),
        req(1, BOB, 10, [OWNER, OWNER, OWNER]),
        req(2, ALICE, 10_001, [BOOK, OWNER, OWNER]),
    ];
    let mut previews = Vec::new();
    for r in &reqs {
        previews.push(fx.preview(&task, r.clone()).await);
    }
    assert_view(&previews[0], "allowed", None);
    assert_view(&previews[1], "escalated", Some("NewRecipient"));
    assert_view(&previews[2], "blocked", Some("AmountOutOfBounds"));
    let outcomes = fx.submit_ok(&task, reqs).await;
    assert_eq!(outcomes.len(), 3);
    for (preview, outcome) in previews.iter().zip(&outcomes) {
        assert_eq!(
            preview["outcome"], outcome["outcome"],
            "{preview} {outcome}"
        );
        assert_eq!(preview["reason"], outcome["reason"], "{preview} {outcome}");
    }
    let would = &previews[0]["would_charge"];
    let l = fx.ledgers(ALICE, &task).await;
    assert_eq!(l["asset_day"]["spent"], would["asset_day"], "{l}");
    assert_eq!(l["payee_day"]["spent"], would["payee_day"], "{l}");
    assert_eq!(
        l["payee_untrusted_day"]["spent"], would["payee_untrusted_day"],
        "{l}"
    );
    assert_eq!(l["task_spent"], would["task"], "{l}");
}

/// A preview of a request whose mask has bit 15 set reverts `unknown label bit`, for each of the three masks, and `submit_batch`
/// reverts with the same text.
#[tokio::test]
async fn preview_with_bit_15_reverts_unknown_label_bit() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let bad = 0x8000u16;
    for labels in [
        [bad, OWNER, OWNER],
        [BOOK, bad, OWNER],
        [BOOK, OWNER, bad],
        [BOOK | bad, OWNER, OWNER],
    ] {
        let request = req(0, ALICE, 10, labels);
        let answer = fx.try_preview(&task, request.clone()).await;
        assert_view_reverts(&answer, "unknown label bit");
        let result = fx.submit(&task, vec![request]).await;
        assert_submit_reverts(&result, "unknown label bit");
    }
}

/// The shape checks of `submit_batch` run in the preview with the same messages: an `ft:` asset, an asset that is not the one the payee
/// key implies, and EVM parameters on a NEAR request.
#[tokio::test]
async fn preview_checks_the_request_shape_like_submit_batch() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 1_000)], 20);
    let good = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let evm = json!({
        "gas_limit": "21000",
        "max_fee_per_gas": "100",
        "max_priority_fee_per_gas": "1"
    });
    let cases = [
        (
            with(good.clone(), "asset", json!("ft:token.near")),
            "lane not shipped",
        ),
        (
            with(good.clone(), "asset", json!("evm:84532:native")),
            "asset does not match payee",
        ),
        (with(good.clone(), "evm", evm), "evm params not allowed"),
        (
            with(good.clone(), "payee", json!("near:Alice.sandbox")),
            "bad payee key: BadChar",
        ),
    ];
    for (request, text) in cases {
        let answer = fx.try_preview(&task, request.clone()).await;
        assert_view_reverts(&answer, text);
        let result = fx.submit(&task, vec![request]).await;
        assert_submit_reverts(&result, text);
    }
    // a request that is right is not refused by the same checks
    assert_view(&fx.preview(&task, good).await, "allowed", None);
}

/// The task is checked like `verify_task` checks its bounds (`verify_bounds`): a task with no bound and a bound for an asset the
/// registry does not hold revert with the same messages as `submit_batch`. The signature is not checked: the preview of a task the
/// owner never signed still answers.
#[tokio::test]
async fn preview_checks_the_task_bounds_and_no_signature() {
    let _slot = slot().await;
    let fx = fixture().await;
    let request = req(0, ALICE, 10, [BOOK, OWNER, OWNER]);
    let no_bounds = fx.task_with(&[], 20, |_| {});
    let answer = fx.try_preview(&no_bounds, request.clone()).await;
    assert_view_reverts(&answer, "bad bound count");
    assert_submit_reverts(
        &fx.submit(&no_bounds, vec![request.clone()]).await,
        "bad bound count",
    );
    let unknown_asset = fx.task(&[(EVM_PAYEE, 1_000)], 20);
    let answer = fx.try_preview(&unknown_asset, request.clone()).await;
    assert_view_reverts(&answer, "unknown asset in bound");
    assert_submit_reverts(
        &fx.submit(&unknown_asset, vec![request.clone()]).await,
        "unknown asset in bound",
    );
    // an unsigned task still gets its preview
    let unsigned = fx.task_with(&[(ALICE, 1_000)], 20, |_| {});
    let answer = fx
        .try_view("preview", json!({ "req": request, "task": unsigned.task }))
        .await
        .expect("a view needs no signature");
    assert_view(&answer, "allowed", None);
}

/// The preview reads the same state `submit_batch` reads: a paused contract blocks it `Paused`, and what the task has already paid
/// counts against the task bound (`OverTaskBound`).
#[tokio::test]
async fn preview_reads_pause_and_the_task_ledger() {
    let _slot = slot().await;
    let fx = fixture().await;
    let task = fx.task(&[(ALICE, 15)], 20);
    let outcomes = fx
        .submit_ok(&task, vec![req(0, ALICE, 10, [BOOK, OWNER, OWNER])])
        .await;
    assert_eq!(outcomes[0]["outcome"], "allowed", "{outcomes:?}");
    let next = req(1, ALICE, 10, [BOOK, OWNER, OWNER]);
    let answer = fx.preview(&task, next.clone()).await;
    assert_view(&answer, "escalated", Some("OverTaskBound"));
    assert!(answer["would_charge"].is_null(), "{answer}");
    let fits = fx
        .preview(&task, req(1, ALICE, 5, [BOOK, OWNER, OWNER]))
        .await;
    assert_view(&fits, "allowed", None);
    owner_ok(&fx.s, "pause", json!({ "paused": true })).await;
    let paused = fx.preview(&task, next.clone()).await;
    assert_view(&paused, "blocked", Some("Paused"));
    owner_ok(&fx.s, "pause", json!({ "paused": false })).await;
    let resumed = fx
        .preview(&task, req(1, ALICE, 5, [BOOK, OWNER, OWNER]))
        .await;
    assert_view(&resumed, "allowed", None);
}

/// `preview` is exported and its helper `preview_at` is not: the helper takes the block time as an argument and is a plain method.
#[test]
fn preview_is_exported_and_its_helper_is_not() {
    let exports = wasm_exports();
    assert!(
        exports.iter().any(|name| name == "preview"),
        "the wasm does not export preview: {exports:?}"
    );
    for helper in ["preview_at", "verify_bounds", "evaluate"] {
        assert!(
            !exports.iter().any(|name| name == helper),
            "the wasm exports the helper {helper}"
        );
    }
}

// AIR-066: the named tests of the contract invariants of SPEC 8.4 that need no signature: I2, I3, I4, I6, I7, I8 and I9 (I10 is the ABI
// equality test `abi_complete_equals_spec` of tests/abi_snapshot.rs; I1 and I5 come with AIR-108). Test names are `i<NN>_<what>`:
// `scripts/invariant-map.sh` counts them per invariant and fails when one has none.
//
// Sandbox tests use `world()` (AIR-105: accounts `agent.sandbox`, `alice.sandbox`, owner `sandbox`, contract `policy.sandbox`) and are run
// with `-- --test-threads=4`. Every revert assertion checks the revert text, because a missing method also fails and a bare "it failed"
// would pass on nothing. The I6 tests run in process (`inproc_contract()`): the sandbox clock is real time, so three simulated days
// cannot be crossed there.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::ledgers::{caps_for, is_untrusted_amount};
use airlock_policy::policy::AssetEntryJson;
use airlock_policy::request::{Hex32, Hints, Labels, SubmitRequest, request_id};
use airlock_policy::task::{OwnerTask, VerifiedBound, VerifiedTask, task_hash};
use airlock_verdict::labels::EMAIL;
use airlock_verdict::{BOOK, ORACLE, OWNER, POLICY, Reason, UNRESOLVED, Verdict};
use common::*;
use near_api::{AccountId, NearToken, Signer, Tokens};
use near_api_types::transaction::result::ExecutionFinalResult;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::testing_env;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

const ALICE: &str = "near:alice.sandbox";
const NOT_OWNER: &str = "Caller is not the owner";
const ONE_YOCTO_TEXT: &str = "Requires attached deposit of exactly 1 yoctoNEAR";

/// At most this many sandboxes of this file run at once (a neard is several hundred MB and a deploy times out when too many start
/// together; see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

type Task = (OwnerTask, Base64VecU8);
type Who = (AccountId, Arc<Signer>);

fn owner_of(w: &World) -> Who {
    (w.owner.clone(), w.owner_signer.clone())
}

fn agent_of(w: &World) -> Who {
    (w.agent.clone(), w.agent_signer.clone())
}

async fn account(w: &World, name: &str) -> Who {
    create_user_account(&w.net, &w.root, &w.owner_signer, name)
        .await
        .expect("the account is created")
}

/// A call of the policy contract with an explicit deposit in yoctoNEAR; a failed receipt is not an error, inspect `failure_text`.
async fn call(
    w: &World,
    who: &Who,
    method: &str,
    args: Value,
    yocto: u128,
) -> ExecutionFinalResult {
    call_transaction(
        &w.policy,
        method,
        args,
        &who.0,
        &who.1,
        &w.net,
        Some(NearToken::from_yoctonear(yocto)),
    )
    .await
    .unwrap_or_else(|e| panic!("{method} is not sent: {e}"))
}

/// The call must fail and its failure text must contain `want`.
fn assert_fails(result: &ExecutionFinalResult, want: &str) {
    let text = failure_text(result);
    assert!(text.contains(want), "wanted `{want}` in: {text}");
}

fn assert_ok(result: &ExecutionFinalResult, what: &str) {
    let text = failure_text(result);
    assert!(text.is_empty(), "{what} failed: {text}");
}

async fn view(w: &World, method: &str, args: Value) -> Value {
    call_view::<Value>(&w.policy, method, args, &w.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
        .data
}

/// The total balance of `id` in yoctoNEAR.
async fn balance(w: &World, id: &AccountId) -> u128 {
    Tokens::account(id.clone())
        .near_balance()
        .fetch_from(&w.net)
        .await
        .expect("the balance is read")
        .total
        .as_yoctonear()
}

/// A task for the agent bound to `near:alice.sandbox` at 100 NEAR, 20 actions.
fn alice_task(w: &World) -> Task {
    w.signed_task(&[(ALICE, 100 * ONE_NEAR)], 20)
}

/// A clean request (asset `near`, payee alice, labels Book, Owner, Owner): an Allow while it is within the limits.
fn clean(w: &World, task: &Task, index: u8, amount: u128) -> Value {
    w.request_json(
        &task.0,
        index,
        "near",
        ALICE,
        amount,
        (BOOK, OWNER, OWNER),
        None,
    )
}

/// The outcomes of a `submit_batch` that must not have failed.
fn outcomes_of(result: &ExecutionFinalResult) -> Vec<Value> {
    assert_ok(result, "submit_batch");
    let outcomes: Value = result.clone().json().expect("the outcomes parse");
    outcomes.as_array().expect("an array of outcomes").clone()
}

/// What the three ledgers of alice and the asset hold now (spent only), as one comparable string.
async fn spent_of_alice(w: &World) -> String {
    let l = w.ledgers(ALICE, "near").await;
    format!(
        "{}/{}/{}",
        l["asset_day"]["spent"], l["payee_day"]["spent"], l["payee_untrusted_day"]["spent"]
    )
}

/// `set_flags` with the defaults except the pending TTL and a roomy hourly budget.
async fn set_ttl(w: &World, ttl_ms: u64) {
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": 4,
            "pending_ttl_ms": ttl_ms.to_string(),
            "hourly_escalation_budget": 100,
            "lock_consecutive_rejects": 3,
            "lock_rejects_per_day": 20,
            "max_task_ttl_ms": "3600000",
            "max_task_actions": 20
        } }),
    )
    .await;
}

/// The `approve` arguments of the pending item `no`: the six strings of its stored card.
async fn card_of(w: &World, no: &str) -> Value {
    let pending = view(w, "get_pending", json!({})).await;
    let found = pending.as_array().expect("get_pending is an array");
    let item = found
        .iter()
        .find(|v| v["id"] == no)
        .unwrap_or_else(|| panic!("pending {no} is not in {found:?}"));
    json!({
        "id": no,
        "to": item["payee"],
        "asset": item["display"]["asset_symbol"],
        "amount": item["display"]["amount_decimal"],
        "why": item["reason"],
        "book": item["book_status"]
    })
}

/// The same request as `escalate` at `index` (amount 2U, labels Book, Untrusted:email, Owner), keeping the whole result.
async fn resubmit_escalation(w: &World, task: &Task, index: u8) -> ExecutionFinalResult {
    let req = w.request_json(
        &task.0,
        index,
        "near",
        "near:alice.sandbox",
        2 * U,
        (2, 32, 1),
        None,
    );
    w.submit(vec![req], task).await
}

/// Escalates request `index` and returns its pending number.
async fn escalate_no(w: &World, task: &Task, index: u8) -> String {
    let out = escalate(w, task, index).await;
    assert_eq!(out["outcome"], "escalated", "{out}");
    pending_id_of(&out).await
}

// ---------------------------------------------------------------------------------------------------------------------
// I2: a request id is a replay key
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn i02_replay_returns_the_stored_outcome_and_pays_once() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 180_000).await;
    let task = alice_task(&w);
    let req = clean(&w, &task, 0, ONE_NEAR);
    let alice_before = balance(&w, &w.payee_near).await;
    let first = w.submit(vec![req.clone()], &task).await;
    let first_out = outcomes_of(&first);
    assert_eq!(first_out[0]["outcome"], "allowed", "{first_out:?}");
    let alice_paid = balance(&w, &w.payee_near).await;
    assert_eq!(alice_paid, alice_before + ONE_NEAR, "alice rose once");
    let second = w.submit(vec![req], &task).await;
    let second_out = outcomes_of(&second);
    assert_eq!(second_out[0]["request_id"], first_out[0]["request_id"]);
    assert_eq!(second_out[0]["outcome"], "allowed", "{second_out:?}");
    // one `allowed` event in all, one payment in the ledger, and alice's balance did not move again
    let allowed = events(&first, "allowed").len() + events(&second, "allowed").len();
    assert_eq!(allowed, 1, "one allowed event in total");
    let ledgers = w.ledgers(ALICE, "near").await;
    assert_eq!(
        ledgers["payee_day"]["spent"],
        ONE_NEAR.to_string(),
        "{ledgers}"
    );
    assert_eq!(
        ledgers["asset_day"]["spent"],
        ONE_NEAR.to_string(),
        "{ledgers}"
    );
    assert_eq!(balance(&w, &w.payee_near).await, alice_paid);
}

#[tokio::test]
async fn i02_changed_content_reverts_request_mismatch() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 180_000).await;
    let task = alice_task(&w);
    let first = w.submit(vec![clean(&w, &task, 0, ONE_NEAR)], &task).await;
    assert_eq!(outcomes_of(&first)[0]["outcome"], "allowed");
    let changed = w
        .submit(vec![clean(&w, &task, 0, 2 * ONE_NEAR)], &task)
        .await;
    assert_fails(&changed, "request mismatch");
    // the revert charged nothing more
    let ledgers = w.ledgers(ALICE, "near").await;
    assert_eq!(
        ledgers["payee_day"]["spent"],
        ONE_NEAR.to_string(),
        "{ledgers}"
    );
}

#[tokio::test]
async fn i02_rejected_and_expired_ids_stay_used() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    ensure_day_window(&w, 180_000).await;
    let task = flood_task(&w);
    let used = "request_id already used (UsedRequestId)";

    // rejected: the owner rejects the escalation, the same content is refused for good
    let no = escalate_no(&w, &task, 0).await;
    let rejected = call(&w, &owner_of(&w), "reject", json!({ "id": no }), 1).await;
    assert_ok(&rejected, "reject");
    assert_fails(&resubmit_escalation(&w, &task, 0).await, used);

    // expired: a TTL of 1 ms, then anyone expires it after the next block
    set_ttl(&w, 1).await;
    let no = escalate_no(&w, &task, 1).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let expired = call(&w, &owner_of(&w), "expire", json!({ "id": no }), 0).await;
    assert_ok(&expired, "expire");
    assert_fails(&resubmit_escalation(&w, &task, 1).await, used);
}

// ---------------------------------------------------------------------------------------------------------------------
// I3: only the owner changes policy, and every callback is private
// ---------------------------------------------------------------------------------------------------------------------

/// Names that are views by the rule of `i03_owner_method_list_is_complete`: `get_*`, `is_*`, `list_assets` and `preview`.
fn is_view(name: &str) -> bool {
    name.starts_with("get_")
        || name.starts_with("is_")
        || name == "list_assets"
        || name == "preview"
}

/// Exports that are neither views nor owner methods: the constructor, the two anyone/agent methods and the three callbacks.
const NOT_OWNER_METHODS: &[&str] = &[
    "new",
    "expire",
    "register_agent",
    "submit_batch",
    "on_signed",
    "on_transfer",
    "fail_on_invalid_agent",
];

/// The self-calls of the contract: every one needs a row in `i03_every_callback_is_private`.
const CALLBACKS: &[&str] = &["on_signed", "on_transfer", "fail_on_invalid_agent"];

/// The lines of a list file: trimmed, with blank lines and `#` comments dropped.
fn rows_of(file: &str) -> Vec<String> {
    let path = format!("{}/tests/{file}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {path}: {e}"))
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// Every export of tests/abi_expected.txt, one per row.
fn abi_exports() -> BTreeSet<String> {
    rows_of("abi_expected.txt").into_iter().collect()
}

/// The rows of tests/owner_methods.txt as (method, raw arguments).
fn owner_rows() -> Vec<(String, String)> {
    rows_of("owner_methods.txt")
        .into_iter()
        .map(|row| match row.split_once(' ') {
            Some((method, args)) => (method.to_string(), args.trim().to_string()),
            None => panic!("owner_methods.txt row `{row}` has no arguments"),
        })
        .collect()
}

/// The arguments of a row: the token `@measurements` is the whole object of `approve_measurements_default_args()`, `@ppids` the one of
/// `default_ppids_json()`, anything else is JSON.
fn resolve_args(raw: &str) -> Value {
    match raw {
        "@measurements" => approve_measurements_default_args(),
        "@ppids" => default_ppids_json(),
        text => {
            serde_json::from_str(text).unwrap_or_else(|e| panic!("bad row arguments {text}: {e}"))
        }
    }
}

/// The exports that are not views and not in `NOT_OWNER_METHODS`: the owner methods the ABI list says exist.
fn abi_owner_methods() -> BTreeSet<String> {
    abi_exports()
        .into_iter()
        .filter(|n| !is_view(n) && !NOT_OWNER_METHODS.contains(&n.as_str()))
        .collect()
}

/// Calls every row of `owner_methods.txt` once as `who` with `yocto` attached, on this one world: every call must fail with `want`.
/// Nothing succeeds here (the one-yocto check runs first, then the owner check), so the rows can share the world.
async fn every_owner_method_fails(w: &World, who: &Who, yocto: u128, want: &str) {
    let rows = owner_rows();
    assert!(
        rows.len() >= 22,
        "owner_methods.txt has {} rows, at least 22 are required",
        rows.len()
    );
    for (method, raw) in &rows {
        let result = call(w, who, method, resolve_args(raw), yocto).await;
        let text = failure_text(&result);
        assert!(
            text.contains(want),
            "{method} as {} with {yocto} yocto: wanted `{want}` in: {text}",
            who.0
        );
    }
}

#[tokio::test]
async fn i03_every_owner_method_rejects_a_stranger() {
    let _slot = slot().await;
    let w = world().await;
    let stranger = account(&w, "stranger").await;
    every_owner_method_fails(&w, &stranger, 1, NOT_OWNER).await;
}

#[tokio::test]
async fn i03_every_owner_method_rejects_the_agent() {
    let _slot = slot().await;
    let w = world().await;
    every_owner_method_fails(&w, &agent_of(&w), 1, NOT_OWNER).await;
}

#[tokio::test]
async fn i03_every_owner_method_rejects_no_deposit() {
    let _slot = slot().await;
    let w = world().await;
    every_owner_method_fails(&w, &owner_of(&w), 0, ONE_YOCTO_TEXT).await;
}

#[tokio::test]
async fn i03_every_owner_method_rejects_two_yocto() {
    let _slot = slot().await;
    let w = world().await;
    every_owner_method_fails(&w, &owner_of(&w), 2, ONE_YOCTO_TEXT).await;
}

/// Ties the two lists together: a new owner method that nobody put in `owner_methods.txt` fails here, and so does a row for a method
/// the ABI list does not have.
#[test]
fn i03_owner_method_list_is_complete() {
    let abi = abi_exports();
    assert!(
        abi.len() >= 40 && abi.contains("get_policy"),
        "tests/abi_expected.txt did not load: {abi:?}"
    );
    let rows: Vec<String> = owner_rows().into_iter().map(|(m, _)| m).collect();
    let listed: BTreeSet<&String> = rows.iter().collect();
    assert_eq!(listed.len(), rows.len(), "a method has two rows: {rows:?}");
    let missing: Vec<String> = abi_owner_methods()
        .into_iter()
        .filter(|m| !rows.contains(m))
        .collect();
    assert!(
        missing.is_empty(),
        "exported owner methods with no row in tests/owner_methods.txt: {missing:?}"
    );
    let unknown: Vec<&String> = rows.iter().filter(|m| !abi.contains(*m)).collect();
    assert!(
        unknown.is_empty(),
        "rows of tests/owner_methods.txt that are not in tests/abi_expected.txt: {unknown:?}"
    );
}

/// NEAR audit detector `non-private-callback` (plan/reuse/AUDIT_MAP.md): every self-callback is `#[private]`. The callbacks are
/// exactly the exports that are not views, not owner rows and not `new`, `expire`, `register_agent`, `submit_batch`; a new one
/// fails the first half until it has a row here.
#[tokio::test]
async fn i03_every_callback_is_private() {
    let rows: Vec<String> = owner_rows().into_iter().map(|(m, _)| m).collect();
    let found: BTreeSet<String> = abi_exports()
        .into_iter()
        .filter(|n| {
            !is_view(n)
                && !rows.contains(n)
                && !["new", "expire", "register_agent", "submit_batch"].contains(&n.as_str())
        })
        .collect();
    let expected: BTreeSet<String> = CALLBACKS.iter().map(|s| (*s).to_string()).collect();
    assert_eq!(
        found, expected,
        "the self-callbacks of tests/abi_expected.txt are not the three tested here"
    );
    let _slot = slot().await;
    let w = world().await;
    let stranger = account(&w, "stranger").await;
    let args = [
        (
            "on_signed",
            json!({ "request_id": "x", "unsigned_hex": "02" }),
        ),
        ("on_transfer", json!({ "request_id": "x" })),
        ("fail_on_invalid_agent", json!({ "reasons": [] })),
    ];
    for (method, args) in args {
        for (who_name, who) in [("stranger", &stranger), ("agent", &agent_of(&w))] {
            let result = call(&w, who, method, args.clone(), 0).await;
            let text = failure_text(&result);
            assert!(
                text.contains(&format!("Method {method} is private")),
                "{who_name} calling {method}: wanted `Method {method} is private` in: {text}"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// I4: only a registered, allowed agent with a valid attestation submits
// ---------------------------------------------------------------------------------------------------------------------

/// A task for `who` (the policy contract and the agent account edited into the signed task), bound to alice.
fn task_for(w: &World, who: &AccountId) -> Task {
    let policy: near_sdk::AccountId = w.policy.as_str().parse().unwrap();
    let who: near_sdk::AccountId = who.as_str().parse().unwrap();
    signed_task_with(&[(ALICE, 100 * ONE_NEAR)], 20, |t| {
        t.contract_id = policy;
        t.agent_id = who;
    })
}

/// `submit_batch` of one clean request, sent by `who` with a task made for `who`.
async fn submit_as(w: &World, who: &Who) -> ExecutionFinalResult {
    let task = task_for(w, &who.0);
    call_300_tgas(
        &w.policy,
        &w.net,
        &who.0,
        &who.1,
        "submit_batch",
        json!({ "reqs": [clean(w, &task, 0, ONE_NEAR)], "task": task.0, "task_sig": task.1 }),
    )
    .await
}

#[tokio::test]
async fn i04_unregistered_account_fails() {
    let _slot = slot().await;
    let w = world().await;
    let stranger = account(&w, "stranger").await;
    assert_fails(&submit_as(&w, &stranger).await, "Agent not registered");
}

#[tokio::test]
async fn i04_registered_not_allowed_fails() {
    let _slot = slot().await;
    let w = world().await;
    let other = account(&w, "other").await;
    register_local_agent(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &other.0,
        &other.1,
        &w.net,
    )
    .await;
    assert_fails(&submit_as(&w, &other).await, "Invalid agent: [NotAllowed]");
    let agent = view(&w, "get_agent", json!({ "account_id": other.0 })).await;
    assert!(agent.is_object(), "the registration stays: {agent}");
}

#[tokio::test]
async fn i04_revoked_agent_fails() {
    let _slot = slot().await;
    let w = world().await;
    let revoke = call(
        &w,
        &owner_of(&w),
        "revoke_agent",
        json!({ "account_id": w.agent }),
        1,
    )
    .await;
    assert_ok(&revoke, "revoke_agent");
    assert_fails(
        &submit_as(&w, &agent_of(&w)).await,
        "Invalid agent: [NotAllowed]",
    );
    let agent = view(&w, "get_agent", json!({ "account_id": w.agent })).await;
    assert!(agent.is_object(), "get_agent is still non-null: {agent}");
}

#[tokio::test]
async fn i04_expired_attestation_fails() {
    let _slot = slot().await;
    let w = world().await;
    let update = call(
        &w,
        &owner_of(&w),
        "update_attestation_expiration_time",
        json!({ "attestation_expiration_time_ms": "60000" }),
        1,
    )
    .await;
    assert_ok(&update, "update_attestation_expiration_time");
    let second = account(&w, "second").await;
    register_local_agent(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &second.0,
        &second.1,
        &w.net,
    )
    .await;
    allow_agent_for(&w.policy, &w.owner, &w.owner_signer, &second.0, &w.net).await;
    // 400 blocks are about 119 s of sandbox time (0.297 s per block, measured), past the 60 s expiry
    w.sandbox
        .fast_forward(400)
        .await
        .expect("the sandbox fast-forwards");
    let first = submit_as(&w, &second).await;
    assert_fails(&first, "Invalid agent: [ExpiredAttestation]");
    assert_eq!(
        events(&first, "agent_removed").len(),
        1,
        "agent_removed was emitted"
    );
    let agent = view(&w, "get_agent", json!({ "account_id": second.0 })).await;
    assert!(agent.is_null(), "the agent is removed: {agent}");
    assert_fails(&submit_as(&w, &second).await, "Agent not registered");
}

// ---------------------------------------------------------------------------------------------------------------------
// I6: no labels, however set, make a payment beyond a limit (in process)
// ---------------------------------------------------------------------------------------------------------------------

const SEED: u64 = 0x9E37_79B9_7F4A_7C15;
const AGENT: &str = "agent.test.near";
const OWNER_ID: &str = "owner.test.near";
const MS_PER_DAY: u64 = 86_400_000;

/// xorshift64* (Vigna 2016): the generator of the randomized tests, so a failing run replays from the seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[usize::try_from(self.next() % items.len() as u64).expect("small index")]
    }
}

fn request(payee: &str, amount: u128, labels: Labels) -> SubmitRequest {
    SubmitRequest {
        task_id: "task-i06".to_string(),
        action_index: 0,
        asset: "near".to_string(),
        payee: payee.to_string(),
        amount: U128(amount),
        labels,
        evm: None,
        hints: Hints {
            plan_hash: Hex32([0; 32]),
            trace_digest: Hex32([0; 32]),
        },
    }
}

fn bound(payee: &str, max_total: u128) -> VerifiedBound {
    VerifiedBound {
        payee_key: payee.to_string(),
        asset: "near".to_string(),
        max_total,
    }
}

/// The sandbox form of this test is AIR-061's `gate_random`; this is the named invariant: when the recipient labels are only trusted
/// ones and the payee is not in the book, the verdict is never Allow (every payment to a new recipient is escalated).
#[test]
fn i06_all_trusted_labels_to_non_book_keys_never_allow() {
    let c = inproc_contract();
    let mut rng = Rng(SEED);
    let masks = [OWNER, POLICY, OWNER | POLICY];
    let (mut allow, mut total) = (0, 0);
    for _ in 0..500 {
        let payee = format!("near:random{}.test.near", rng.below(1_000));
        let amount =
            1 + ((u128::from(rng.next()) << 64) | u128::from(rng.next())) % (1_000 * ONE_NEAR);
        let labels = Labels {
            recipient: rng.pick(&masks),
            amount: OWNER,
            pc: OWNER,
        };
        let vt = VerifiedTask {
            hash: [9; 32],
            bounds: vec![bound(&payee, 10_000 * ONE_NEAR)],
        };
        let verdict = c
            .evaluate(&request(&payee, amount, labels), &vt, T0)
            .verdict;
        total += 1;
        if verdict == Verdict::Allow {
            allow += 1;
        }
        assert_eq!(
            verdict,
            Verdict::Escalate(Reason::NewRecipient),
            "{payee} amount {amount} recipient mask {}",
            labels.recipient
        );
    }
    assert_eq!((total, allow), (500, 0));
}

/// One of the four payees of `i06_random_sequences_over_three_days_respect_every_limit`.
struct Payee {
    key: &'static str,
    cap: Option<u128>,
    budget: u128,
    limit: u128,
    task_bound: u128,
    booked: bool,
}

/// Numbers: the ticket's, except alice's daily limit, which is 2_000 N and not 3_000 N. A payee's day ledger and the day's task ledger
/// grow together (one task per UTC day), so with a limit at or above the task bound `OverPayeeLimit` can never be reached; alice's
/// limit sits below her bound of 2_500 N. Every reason of the ticket's list is reached by seed `SEED`.
#[test]
fn i06_random_sequences_over_three_days_respect_every_limit() {
    const N: u128 = ONE_NEAR;
    const HARD: u128 = 1_000 * N;
    const DAILY: u128 = 6_000 * N;
    let payees = [
        Payee {
            key: "near:alice.test.near",
            cap: Some(100 * N),
            budget: 400 * N,
            limit: 2_000 * N,
            task_bound: 2_500 * N,
            booked: true,
        },
        Payee {
            key: "near:bob.test.near",
            cap: None,
            budget: 0,
            limit: 2_000 * N,
            task_bound: 1_000 * N,
            booked: true,
        },
        Payee {
            key: "near:carol.test.near",
            cap: Some(50 * N),
            budget: 200 * N,
            limit: 10_000 * N,
            task_bound: 3_000 * N,
            booked: true,
        },
        Payee {
            key: "near:dave.test.near",
            cap: None,
            budget: 0,
            limit: 0,
            task_bound: 1_000 * N,
            booked: false,
        },
    ];
    let mut c = inproc_contract();
    testing_env!(inproc_ctx(OWNER_ID, T0, 1).build());
    c.asset_set(
        "near".to_string(),
        AssetEntryJson {
            symbol: "NEAR".to_string(),
            decimals: 24,
            hard_cap: U128(HARD),
            daily_cap: U128(DAILY),
            max_fee_per_gas: U128(0),
            max_gas: U128(0),
            quick_task_cap: U128(DAILY),
            path: None,
        },
    );
    for (i, p) in payees.iter().enumerate().filter(|(_, p)| p.booked) {
        testing_env!(inproc_ctx(OWNER_ID, T0, 1).build());
        c.book_add(
            p.key.to_string(),
            p.cap.map(U128),
            U128(p.budget),
            U128(p.limit),
            format!("Payee{i}"),
        );
    }

    let first_day = T0 / MS_PER_DAY;
    let amount_labels = [OWNER, EMAIL, ORACLE, UNRESOLVED, OWNER | EMAIL];
    let recipient_labels = [BOOK, OWNER, EMAIL, BOOK | EMAIL, POLICY];
    let mut rng = Rng(SEED);
    let mut now = T0;
    let (mut allow, mut escalate, mut block) = (0u32, 0u32, 0u32);
    let mut reasons: BTreeSet<&'static str> = BTreeSet::new();
    let mut days: BTreeSet<u64> = BTreeSet::new();
    // the test's own sums, independent of the contract's ledgers
    let mut asset_day: HashMap<u64, u128> = HashMap::new();
    let mut payee_day: HashMap<(u64, usize), u128> = HashMap::new();
    let mut untrusted_day: HashMap<(u64, usize), u128> = HashMap::new();
    let mut task_sum: HashMap<(u64, usize), u128> = HashMap::new();

    for _ in 0..3_000 {
        now += rng.below(172_801);
        let day = now / MS_PER_DAY;
        days.insert(day);
        let d = u8::try_from(day - first_day).expect("a few days");
        let vt = VerifiedTask {
            hash: [d + 1; 32],
            bounds: payees.iter().map(|p| bound(p.key, p.task_bound)).collect(),
        };
        let idx = usize::try_from(rng.below(4)).expect("small index");
        let p = &payees[idx];
        let cap = p.cap.unwrap_or(100 * N);
        let amounts = [
            1,
            N,
            10 * N,
            cap - 1,
            cap,
            cap + 1,
            500 * N,
            999 * N,
            1_000 * N,
            1_001 * N,
            5_000 * N,
        ];
        let amount = rng.pick(&amounts);
        let recipient = rng.pick(&recipient_labels);
        let amount_mask = rng.pick(&amount_labels);
        let pc = match rng.below(100) {
            0..=89 => OWNER,
            90..=96 => OWNER | EMAIL,
            _ => 0,
        };
        let labels = Labels {
            recipient,
            amount: amount_mask,
            pc,
        };
        testing_env!(inproc_ctx(AGENT, now, 0).build());
        let evaluated = c.evaluate(&request(p.key, amount, labels), &vt, now);
        match evaluated.verdict {
            Verdict::Allow => {
                allow += 1;
                let ctx = &evaluated.ctx;
                let caps = caps_for(
                    ctx.asset.as_ref().expect("an Allow has an asset"),
                    ctx.payee.as_ref().expect("an Allow has a booked payee"),
                    ctx.bound.expect("an Allow has a task bound"),
                );
                let untrusted = is_untrusted_amount(&labels);
                c.charge_allow(&ctx.key, &caps, amount, untrusted, now);
                *asset_day.entry(day).or_default() += amount;
                *payee_day.entry((day, idx)).or_default() += amount;
                *task_sum.entry((u64::from(d), idx)).or_default() += amount;
                if untrusted {
                    *untrusted_day.entry((day, idx)).or_default() += amount;
                }
                let at = |m: &HashMap<(u64, usize), u128>, k: (u64, usize)| {
                    m.get(&k).copied().unwrap_or(0)
                };
                assert!(amount <= HARD, "amount {amount} above the hard cap");
                assert!(
                    asset_day[&day] <= DAILY,
                    "asset day {} above the daily cap",
                    asset_day[&day]
                );
                assert!(
                    at(&payee_day, (day, idx)) <= p.limit,
                    "{} above its daily limit",
                    p.key
                );
                assert!(
                    at(&untrusted_day, (day, idx)) <= p.budget,
                    "{} above its untrusted budget",
                    p.key
                );
                if untrusted {
                    let payee_cap = p.cap.expect("an untrusted amount needs a payee cap");
                    assert!(
                        amount <= payee_cap,
                        "untrusted {amount} above the cap of {}",
                        p.key
                    );
                }
                assert!(
                    at(&task_sum, (u64::from(d), idx)) <= p.task_bound,
                    "{} above its task bound",
                    p.key
                );
                // the contract's ledgers equal the test's own sums
                let ledgers = c.get_ledgers(
                    p.key.to_string(),
                    "near".to_string(),
                    Some(hex::encode(vt.hash)),
                );
                assert_eq!(ledgers.asset_day.spent.0, asset_day[&day]);
                assert_eq!(ledgers.payee_day.spent.0, at(&payee_day, (day, idx)));
                assert_eq!(
                    ledgers.payee_untrusted_day.spent.0,
                    at(&untrusted_day, (day, idx))
                );
                assert_eq!(
                    ledgers.task_spent.map(|v| v.0),
                    Some(at(&task_sum, (u64::from(d), idx)))
                );
            }
            Verdict::Escalate(r) => {
                escalate += 1;
                reasons.insert(r.as_str());
            }
            Verdict::Block(r) => {
                block += 1;
                reasons.insert(r.as_str());
            }
        }
    }
    let seen: Vec<&str> = reasons.iter().copied().collect();
    println!(
        "I6 steps=3000 days={} allow={allow} escalate={escalate} block={block} reasons={}",
        days.len(),
        seen.join(",")
    );
    assert!(days.len() >= 3, "only {} UTC days", days.len());
    assert!(allow >= 100, "only {allow} Allows");
    for want in [
        "AmountOutOfBounds",
        "DailyLimit",
        "BookLabelNotInBook",
        "MissingProvenance",
        "NewRecipient",
        "UntrustedRecipient",
        "UntrustedTrigger",
        "OverTaskBound",
        "OverPayeeLimit",
        "UntrustedAmount",
    ] {
        assert!(reasons.contains(want), "no step reached {want}: {seen:?}");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// I7: a pending request cannot be modified, and decides once
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn i07_pending_request_cannot_be_modified() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    ensure_day_window(&w, 180_000).await;
    let task = flood_task(&w);
    let no = escalate_no(&w, &task, 0).await;
    let card = card_of(&w, &no).await;
    let before = view(&w, "get_request", json!({ "id": no }))
        .await
        .to_string();
    for (field, wrong, text) in [
        ("to", "near:bob.sandbox", "approve rejected: WrongRecipient"),
        ("asset", "ETH.base", "approve rejected: WrongAsset"),
        ("amount", "0.003", "approve rejected: WrongAmount"),
        ("why", "OutsideTask", "approve rejected: WrongReason"),
        ("book", "new", "approve rejected: WrongBook"),
    ] {
        let mut changed = card.clone();
        assert_ne!(changed[field], wrong, "the card already holds {wrong}");
        changed[field] = json!(wrong);
        let result = call(&w, &owner_of(&w), "approve", changed, 1).await;
        assert_fails(&result, text);
        let after = view(&w, "get_request", json!({ "id": no }))
            .await
            .to_string();
        assert_eq!(before, after, "get_request moved after the {field} approve");
    }
    // the correct card is still accepted
    assert_ok(
        &call(&w, &owner_of(&w), "approve", card, 1).await,
        "approve",
    );
    let after = view(&w, "get_request", json!({ "id": no })).await;
    assert_ne!(after["state"], "Pending", "{after}");
}

#[tokio::test]
async fn i07_rejected_cannot_be_approved() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    ensure_day_window(&w, 180_000).await;
    let task = flood_task(&w);
    let no = escalate_no(&w, &task, 0).await;
    let card = card_of(&w, &no).await;
    assert_ok(
        &call(&w, &owner_of(&w), "reject", json!({ "id": no }), 1).await,
        "reject",
    );
    let result = call(&w, &owner_of(&w), "approve", card, 1).await;
    assert_fails(&result, "approve rejected: NotPending");
}

#[tokio::test]
async fn i07_second_approve_reverts() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    ensure_day_window(&w, 180_000).await;
    let task = flood_task(&w);
    let no = escalate_no(&w, &task, 0).await;
    let card = card_of(&w, &no).await;
    assert_ok(
        &call(&w, &owner_of(&w), "approve", card.clone(), 1).await,
        "approve",
    );
    let again = call(&w, &owner_of(&w), "approve", card, 1).await;
    assert_fails(&again, "approve rejected: NotPending");
}

// ---------------------------------------------------------------------------------------------------------------------
// I8: a task is signed by the owner, for this contract and this agent, and is live
// ---------------------------------------------------------------------------------------------------------------------

/// A signed task for alice made for the world, with `edit` applied before signing (and the contract and agent set first).
fn edited_task(w: &World, edit: impl FnOnce(&mut OwnerTask)) -> Task {
    let policy: near_sdk::AccountId = w.policy.as_str().parse().unwrap();
    let agent: near_sdk::AccountId = w.agent.as_str().parse().unwrap();
    signed_task_with(&[(ALICE, 100 * ONE_NEAR)], 20, |t| {
        t.contract_id = policy;
        t.agent_id = agent;
        edit(t);
    })
}

/// The wall clock of a task made by `base_task`: its `issued_ms` is five seconds before it.
fn now_of(t: &OwnerTask) -> u64 {
    t.issued_ms + 5_000
}

#[tokio::test]
async fn i08_forged_and_foreign_tasks_revert() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 180_000).await;
    let before = spent_of_alice(&w).await;
    // a task whose task_id was edited after it was signed
    let (mut task, sig) = alice_task(&w);
    task.task_id = "task-forged".to_string();
    let forged = (task, sig);
    let r = w
        .submit(vec![clean(&w, &forged, 0, ONE_NEAR)], &forged)
        .await;
    assert_fails(&r, "bad task signature");
    // signed correctly, but for another contract
    let foreign = edited_task(&w, |t| t.contract_id = "other.sandbox".parse().unwrap());
    let r = w
        .submit(vec![clean(&w, &foreign, 0, ONE_NEAR)], &foreign)
        .await;
    assert_fails(&r, "wrong contract");
    // signed correctly, but for another agent
    let other = edited_task(&w, |t| t.agent_id = "other.sandbox".parse().unwrap());
    let r = w.submit(vec![clean(&w, &other, 0, ONE_NEAR)], &other).await;
    assert_fails(&r, "wrong agent");
    assert_eq!(
        spent_of_alice(&w).await,
        before,
        "no revert charged anything"
    );
}

#[tokio::test]
async fn i08_expired_unborn_revoked_and_used_up_tasks_revert() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 180_000).await;
    let before = spent_of_alice(&w).await;
    // expired: issued 50 minutes before and expired 1 second before the wall clock
    let expired = edited_task(&w, |t| {
        let now = now_of(t);
        t.issued_ms = now - 3_000_000;
        t.expires_ms = now - 1_000;
    });
    let r = w
        .submit(vec![clean(&w, &expired, 0, ONE_NEAR)], &expired)
        .await;
    assert_fails(&r, "task expired");
    // not yet valid: issued 10 minutes ahead
    let unborn = edited_task(&w, |t| {
        let now = now_of(t);
        t.issued_ms = now + 600_000;
        t.expires_ms = now + 2_400_000;
    });
    let r = w
        .submit(vec![clean(&w, &unborn, 0, ONE_NEAR)], &unborn)
        .await;
    assert_fails(&r, "task not yet valid");
    // revoked: the owner revokes the hash, then the task is used
    let revoked = alice_task(&w);
    let revoke = call(
        &w,
        &owner_of(&w),
        "revoke_task",
        json!({ "task_hash": hex::encode(task_hash(&revoked.0)) }),
        1,
    )
    .await;
    assert_ok(&revoke, "revoke_task");
    let r = w
        .submit(vec![clean(&w, &revoked, 0, ONE_NEAR)], &revoked)
        .await;
    assert_fails(&r, "task revoked");
    // used up: one action allowed, index 1 asked
    let one = w.signed_task(&[(ALICE, 100 * ONE_NEAR)], 1);
    let r = w.submit(vec![clean(&w, &one, 1, ONE_NEAR)], &one).await;
    assert_fails(&r, "task actions exhausted");
    assert_eq!(
        spent_of_alice(&w).await,
        before,
        "no revert charged anything"
    );
}

#[tokio::test]
async fn i08_agent_supplied_request_id_is_ignored() {
    let _slot = slot().await;
    let w = world().await;
    let task = alice_task(&w);
    let mut req = clean(&w, &task, 0, ONE_NEAR);
    req["request_id"] = json!("my-own-id");
    let outcomes = outcomes_of(&w.submit(vec![req], &task).await);
    let derived = request_id(&task_hash(&task.0), 0);
    assert_eq!(outcomes[0]["request_id"], derived.as_str(), "{outcomes:?}");
    assert!(
        w.request("my-own-id").await.is_none(),
        "the agent's own id names no request"
    );
    assert!(w.request(&derived).await.is_some(), "the derived id does");
}

// ---------------------------------------------------------------------------------------------------------------------
// I9: label masks are closed
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn i09_unknown_label_bit_reverts_whole_batch() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 180_000).await;
    let task = alice_task(&w);
    let before = spent_of_alice(&w).await;
    let good = clean(&w, &task, 0, ONE_NEAR);
    let bad = w.request_json(
        &task.0,
        1,
        "near",
        ALICE,
        ONE_NEAR,
        (32_768, OWNER, OWNER),
        None,
    );
    let r = w.submit(vec![good, bad], &task).await;
    assert_fails(&r, "unknown label bit");
    let first_id = request_id(&task_hash(&task.0), 0);
    assert!(
        w.request(&first_id).await.is_none(),
        "the first request of the reverted batch left a record"
    );
    assert_eq!(spent_of_alice(&w).await, before, "get_ledgers is unchanged");
}

#[tokio::test]
async fn i09_empty_pc_blocks() {
    let _slot = slot().await;
    let w = world().await;
    let task = alice_task(&w);
    let req = w.request_json(&task.0, 0, "near", ALICE, ONE_NEAR, (BOOK, OWNER, 0), None);
    let outcomes = outcomes_of(&w.submit(vec![req], &task).await);
    assert_eq!(outcomes[0]["outcome"], "blocked", "{outcomes:?}");
    assert_eq!(outcomes[0]["reason"], "MissingProvenance", "{outcomes:?}");
}

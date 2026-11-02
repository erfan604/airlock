// AIR-101: the NEAR native lane in the sandbox. An Allow or an approval of a `near:` payee is paid by the contract itself from its own
// balance; `on_transfer` marks the record `Executed` and emits `paid`, or refunds the ledgers when the transfer receipt failed. A payment
// the reserve cannot cover is a refunded failure, never a reverted batch. A sandbox transaction result covers every receipt, so a NEAR
// Allow has ended `Executed` (or failed) by the time `submit_batch` returns.
//
// Setup is `world()` (AIR-105): `policy.sandbox` holds about 80 NEAR of which about 10 are locked by the wasm; `alice.sandbox` exists.
// Every request has labels Book, Owner, Owner (masks 2, 1, 1).
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, NearToken, Tokens};
use serde_json::{Value, json};

const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
const EMAIL: u16 = airlock_verdict::labels::EMAIL;

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

/// The total balance and the storage usage of `id`.
async fn balance(w: &World, id: &AccountId) -> (u128, u64) {
    let b = Tokens::account(id.clone())
        .near_balance()
        .fetch_from(&w.net)
        .await
        .expect("the balance is read");
    (b.total.as_yoctonear(), b.storage_usage)
}

fn clean(
    w: &World,
    task: &airlock_policy::task::OwnerTask,
    index: u8,
    payee: &str,
    amount: u128,
) -> Value {
    w.request_json(
        task,
        index,
        "near",
        payee,
        amount,
        (BOOK, OWNER, OWNER),
        None,
    )
}

/// Submits `reqs` and returns the result after asserting `submit_batch` itself did not fail.
async fn submit_ok(
    w: &World,
    reqs: Vec<Value>,
    task: &(
        airlock_policy::task::OwnerTask,
        near_sdk::json_types::Base64VecU8,
    ),
) -> near_api_types::transaction::result::ExecutionFinalResult {
    let result = w.submit(reqs, task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    result
}

/// `submit_batch` where the only receipts allowed to fail are the transfers to `ghost`: the policy contract's own receipts must succeed.
async fn submit_ghost(
    w: &World,
    reqs: Vec<Value>,
    task: &(
        airlock_policy::task::OwnerTask,
        near_sdk::json_types::Base64VecU8,
    ),
    ghost: &str,
) -> near_api_types::transaction::result::ExecutionFinalResult {
    let result = w.submit(reqs, task).await;
    for failure in result.failures() {
        assert_eq!(
            failure.executor_id.as_str(),
            ghost,
            "a receipt failed on {}: {failure:?}",
            failure.executor_id
        );
    }
    result
}

fn outcomes(result: &near_api_types::transaction::result::ExecutionFinalResult) -> Value {
    result.clone().json().expect("the outcomes parse")
}

async fn state_of(w: &World, id: &str) -> String {
    w.request(id).await.expect("the request exists")["state"]
        .as_str()
        .expect("a state")
        .to_string()
}

fn within(delta: u128, low: u128, high: u128) -> bool {
    delta >= low && delta <= high
}

/// `book_add` as the owner (1 yocto): a payee with the given cap, an untrusted budget of 1_000 NEAR and a daily limit of 5_000 NEAR. On
/// an existing key it replaces the entry.
async fn book_add(w: &World, key: &str, cap: u128) {
    owner_call_ok(
        &w.policy,
        &w.root,
        &w.owner_signer,
        &w.net,
        "book_add",
        json!({
            "key": key,
            "cap": cap.to_string(),
            "daily_untrusted_budget": (1_000 * ONE_NEAR).to_string(),
            "daily_limit": (5_000 * ONE_NEAR).to_string(),
            "label": "Test payee"
        }),
    )
    .await;
}

/// An owner call that sends `n` NEAR from the owner (the genesis account) to the policy account.
async fn fund_policy(w: &World, n: u128) {
    let sent = Tokens::account(w.root.clone())
        .send_to(w.policy.clone())
        .near(NearToken::from_near(n))
        .with_signer(w.owner_signer.clone())
        .send_to(&w.net)
        .await
        .expect("the funding is sent");
    sent.assert_success();
}

#[tokio::test]
async fn near_allow_pays_exact_amount() {
    let _slot = slot().await;
    let w = world().await;
    let payee = format!("near:{}", w.payee_near);
    let amount = 3 * ONE_NEAR;
    let task = w.signed_task(&[(&payee, 10 * ONE_NEAR)], 3);
    let (before, _) = balance(&w, &w.payee_near).await;
    let result = submit_ok(&w, vec![clean(&w, &task.0, 0, &payee, amount)], &task).await;
    let out = outcomes(&result);
    assert_eq!(out[0]["outcome"], "allowed", "{out}");
    let id = out[0]["request_id"].as_str().expect("an id").to_string();
    let (after, _) = balance(&w, &w.payee_near).await;
    assert_eq!(after - before, amount);
    let paid = events(&result, "paid");
    assert_eq!(paid.len(), 1, "{paid:?}");
    assert_eq!(paid[0]["request_id"], id.as_str());
    assert_eq!(paid[0]["payee"], payee.as_str());
    assert_eq!(paid[0]["amount"], amount.to_string());
    assert!(events(&result, "failed").is_empty());
    assert_eq!(state_of(&w, &id).await, "Executed");
}

#[tokio::test]
async fn contract_balance_falls_by_the_amount() {
    let _slot = slot().await;
    let w = world().await;
    let payee = format!("near:{}", w.payee_near);
    let amount = ONE_NEAR;
    let task = w.signed_task(&[(&payee, 10 * ONE_NEAR)], 3);
    let (before, _) = balance(&w, &w.policy).await;
    let _ = submit_ok(&w, vec![clean(&w, &task.0, 0, &payee, amount)], &task).await;
    let (after, _) = balance(&w, &w.policy).await;
    let fall = before - after;
    assert!(
        within(fall, amount - ONE_NEAR / 100, amount + ONE_NEAR / 1000),
        "the contract balance fell by {fall}"
    );
}

#[tokio::test]
async fn transfer_to_missing_account_is_retryable_then_failed() {
    let _slot = slot().await;
    let w = world().await;
    let ghost = "near:ghost.sandbox";
    let ghost_account = "ghost.sandbox";
    book_add(&w, ghost, 100 * ONE_NEAR).await;
    let amount = 2 * ONE_NEAR;
    let task = w.signed_task(&[(ghost, 10 * ONE_NEAR)], 3);
    let ledgers_before = w.ledgers(ghost, "near").await;
    let (before, _) = balance(&w, &w.policy).await;

    let result = submit_ghost(
        &w,
        vec![clean(&w, &task.0, 0, ghost, amount)],
        &task,
        ghost_account,
    )
    .await;
    let out = outcomes(&result);
    assert_eq!(out[0]["outcome"], "allowed", "{out}");
    let id = out[0]["request_id"].as_str().expect("an id").to_string();
    assert_eq!(state_of(&w, &id).await, "Retryable");
    let failed = events(&result, "failed");
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0]["reason"], "TransferFailed");
    assert_eq!(failed[0]["retryable"], true);
    assert!(events(&result, "paid").is_empty());
    assert_eq!(w.ledgers(ghost, "near").await, ledgers_before);
    let (after, _) = balance(&w, &w.policy).await;
    assert!(
        within(before.max(after) - before.min(after), 0, ONE_NEAR / 100),
        "the contract balance moved from {before} to {after}"
    );

    // the identical resubmit fails again and ends Failed
    let result = submit_ghost(
        &w,
        vec![clean(&w, &task.0, 0, ghost, amount)],
        &task,
        ghost_account,
    )
    .await;
    let failed = events(&result, "failed");
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0]["reason"], "TransferFailed");
    assert_eq!(failed[0]["retryable"], false);
    assert_eq!(state_of(&w, &id).await, "Failed");
    assert_eq!(w.ledgers(ghost, "near").await, ledgers_before);

    // a third resubmit reverts
    let result = w
        .submit(vec![clean(&w, &task.0, 0, ghost, amount)], &task)
        .await;
    let text = failure_text(&result);
    result.assert_failure();
    assert!(
        text.contains("request_id already used (UsedRequestId)"),
        "{text}"
    );
}

#[tokio::test]
async fn insufficient_balance_is_retryable_not_a_revert() {
    let _slot = slot().await;
    let w = world().await;
    let payee = format!("near:{}", w.payee_near);
    // the book cap is 100 NEAR: raise it so a 500 NEAR request is a clean Allow
    book_add(&w, &payee, 1_000 * ONE_NEAR).await;
    let amount = 500 * ONE_NEAR;
    let task = w.signed_task(&[(&payee, 1_000 * ONE_NEAR)], 3);
    let ledgers_before = w.ledgers(&payee, "near").await;
    let (payee_before, _) = balance(&w, &w.payee_near).await;

    let result = submit_ok(&w, vec![clean(&w, &task.0, 0, &payee, amount)], &task).await;
    let out = outcomes(&result);
    assert_eq!(out[0]["outcome"], "allowed", "{out}");
    let id = out[0]["request_id"].as_str().expect("an id").to_string();
    let failed = events(&result, "failed");
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0]["reason"], "InsufficientBalance");
    assert_eq!(failed[0]["retryable"], true);
    assert_eq!(state_of(&w, &id).await, "Retryable");
    assert_eq!(w.ledgers(&payee, "near").await, ledgers_before);
    assert!(events(&result, "paid").is_empty());
    let (payee_after, _) = balance(&w, &w.payee_near).await;
    assert_eq!(payee_after, payee_before, "no transfer receipt ran");

    // after the owner funds the policy account the identical resubmit pays
    fund_policy(&w, 600).await;
    let result = submit_ok(&w, vec![clean(&w, &task.0, 0, &payee, amount)], &task).await;
    assert_eq!(events(&result, "paid").len(), 1);
    assert_eq!(state_of(&w, &id).await, "Executed");
    let (payee_end, _) = balance(&w, &w.payee_near).await;
    assert_eq!(payee_end - payee_before, amount);
}

#[tokio::test]
async fn batch_of_three_sees_the_running_balance() {
    let _slot = slot().await;
    let w = world().await;
    let payee = format!("near:{}", w.payee_near);
    let task = w.signed_task(&[(&payee, 100 * ONE_NEAR)], 3);
    // the policy account holds about 80 NEAR, about 10 of them its storage stake: 25 NEAR leaves 55, then 30, then 5, below the stake plus
    // the 1 NEAR margin (the ticket's 20 NEAR assumed 60 NEAR; `world()` now funds 80)
    let reqs = (0..3)
        .map(|i| clean(&w, &task.0, i, &payee, 25 * ONE_NEAR))
        .collect();
    let result = submit_ok(&w, reqs, &task).await;
    let out = outcomes(&result);
    for i in 0..3 {
        assert_eq!(out[i]["outcome"], "allowed", "{out}");
    }
    let id = |i: usize| out[i]["request_id"].as_str().expect("an id").to_string();
    assert_eq!(state_of(&w, &id(0)).await, "Executed");
    assert_eq!(state_of(&w, &id(1)).await, "Executed");
    assert_eq!(state_of(&w, &id(2)).await, "Retryable");
    let paid = events(&result, "paid");
    assert_eq!(paid.len(), 2, "{paid:?}");
    let failed = events(&result, "failed");
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0]["request_id"], id(2).as_str());
    assert_eq!(failed[0]["reason"], "InsufficientBalance");
    assert_eq!(failed[0]["retryable"], true);
}

#[tokio::test]
async fn approved_escalation_pays_stored_amount() {
    let _slot = slot().await;
    let w = world().await;
    let payee = format!("near:{}", w.payee_near);
    // payee cap 5 NEAR (the owner call is `book_add` with one yocto)
    book_add(&w, &payee, 5 * ONE_NEAR).await;
    let amount = 9 * ONE_NEAR + 4 * ONE_NEAR / 10;
    let task = w.signed_task(&[(&payee, 50 * ONE_NEAR)], 3);
    let req = w.request_json(
        &task.0,
        0,
        "near",
        &payee,
        amount,
        (BOOK, EMAIL, OWNER),
        None,
    );
    let result = submit_ok(&w, vec![req], &task).await;
    let out = outcomes(&result);
    assert_eq!(out[0]["outcome"], "escalated", "{out}");
    assert_eq!(out[0]["reason"], "UntrustedAmount", "{out}");
    let id = out[0]["request_id"].as_str().expect("an id").to_string();
    let view = w.request(&id).await.expect("the request exists");
    let card = json!({
        "id": view["id"],
        "to": view["payee"],
        "asset": view["display"]["asset_symbol"],
        "amount": view["display"]["amount_decimal"],
        "why": view["reason"],
        "book": view["book_status"]
    });
    assert_eq!(card["amount"], "9.4", "{view}");
    let (before, _) = balance(&w, &w.payee_near).await;
    let approved = call_transaction(
        &w.policy,
        "approve",
        card,
        &w.owner,
        &w.owner_signer,
        &w.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("approve is sent");
    let text = failure_text(&approved);
    assert!(text.is_empty(), "approve failed: {text}");
    let (after, _) = balance(&w, &w.payee_near).await;
    assert_eq!(after - before, amount);
    let paid = events(&approved, "paid");
    assert_eq!(paid.len(), 1, "{paid:?}");
    assert_eq!(paid[0]["amount"], amount.to_string());
    assert_eq!(paid[0]["payee"], payee.as_str());
    assert_eq!(state_of(&w, &id).await, "Executed");
}

/// A stranger and the agent call `on_transfer` directly: both fail with the text of `#[private]`.
#[tokio::test]
async fn on_transfer_is_private() {
    let _slot = slot().await;
    let w = world().await;
    let (stranger, stranger_signer) =
        create_user_account(&w.net, &w.owner, &w.owner_signer, "stranger")
            .await
            .expect("the stranger account is created");
    let request_id = "ab".repeat(32);
    let callers = [
        ("stranger", &stranger, &stranger_signer),
        ("agent", &w.agent, &w.agent_signer),
    ];
    for (who, account, signer) in callers {
        let result = call_transaction(
            &w.policy,
            "on_transfer",
            json!({ "request_id": request_id }),
            account,
            signer,
            &w.net,
            None,
        )
        .await
        .expect("the call is sent");
        let text = failure_text(&result);
        result.assert_failure();
        assert!(
            text.contains("Method on_transfer is private"),
            "{who}: expected `Method on_transfer is private` in: {text}"
        );
    }
}

#[tokio::test]
async fn near_lane_helpers_not_exported() {
    let exports = wasm_exports();
    assert!(exports.iter().any(|n| n == "on_transfer"), "{exports:?}");
    for helper in ["start_near", "near_payment_fits"] {
        assert!(!exports.iter().any(|n| n == helper), "{helper} is exported");
    }
}

/// NEAR audit note `cover-storage-cost`: `env::storage_usage()` does not count writes still buffered in `store` collections, so the
/// reserve check undercounts by the growth of the batch's own records. The growth of one batch of three Allows, in bytes times the byte
/// cost, is at most a tenth of the margin.
#[tokio::test]
async fn reserve_margin_covers_batch_storage_growth() {
    let _slot = slot().await;
    let w = world().await;
    let payee = format!("near:{}", w.payee_near);
    let task = w.signed_task(&[(&payee, 100 * ONE_NEAR)], 3);
    let (_, usage_before) = balance(&w, &w.policy).await;
    let reqs = (0..3)
        .map(|i| clean(&w, &task.0, i, &payee, ONE_NEAR))
        .collect();
    let result = submit_ok(&w, reqs, &task).await;
    assert_eq!(events(&result, "paid").len(), 3);
    let (_, usage_after) = balance(&w, &w.policy).await;
    let d = usage_after - usage_before;
    println!("STORAGE batch3={d} bytes");
    let byte_cost: u128 = 10_000_000_000_000_000_000;
    assert!(
        u128::from(d) * byte_cost <= airlock_policy::exec::NEAR_RESERVE_MARGIN / 10,
        "the batch grew storage by {d} bytes"
    );
}

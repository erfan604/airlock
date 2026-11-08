// AIR-327: the approver role, the sponsor and sweep against the real wasm. The owner is the issuer of a card, the approver the borrower:
// the borrower approves and rejects held payments and cannot touch the book or anything else; the owner cannot approve; sweep pays only the
// sponsor. A world without roles behaves as before (the default of every other suite).
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, NearToken, Signer};
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};
use std::sync::Arc;

const OWNER_MASK: u16 = airlock_verdict::OWNER;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn call(
    w: &World,
    who: &AccountId,
    signer: &Arc<Signer>,
    method: &str,
    args: Value,
    yocto: u128,
) -> ExecutionFinalResult {
    call_transaction(
        &w.policy,
        method,
        args,
        who,
        signer,
        &w.net,
        Some(NearToken::from_yoctonear(yocto)),
    )
    .await
    .expect("the call is sent")
}

fn fails_with(r: &ExecutionFinalResult, text: &str) {
    let got = failure_text(r);
    assert!(got.contains(text), "wanted {text:?}, got {got:?}");
}

fn ok(r: &ExecutionFinalResult) {
    let got = failure_text(r);
    assert!(got.is_empty(), "failed: {got}");
}

/// A held payment: an Owner labelled request to a new payee (`bob.sandbox`, created here) is escalated NewRecipient. Returns the card
/// arguments of `approve`.
async fn held(w: &World, name: &str, amount: u128) -> (Value, String) {
    let (bob, _) = create_user_account(&w.net, &w.root, &w.owner_signer, name)
        .await
        .expect("the payee exists");
    let payee = format!("near:{bob}");
    let task = w.signed_task(&[(&payee, 10 * ONE_NEAR)], 1);
    let req = w.request_json(
        &task.0,
        0,
        "near",
        &payee,
        amount,
        (OWNER_MASK, OWNER_MASK, OWNER_MASK),
        None,
    );
    let result = w.submit(vec![req], &task).await;
    ok(&result);
    let outs: Value = result.json().expect("outcomes");
    assert_eq!(outs[0]["outcome"], "escalated", "{outs}");
    let id = outs[0]["request_id"].as_str().unwrap().to_string();
    let v = w.request(&id).await.expect("a request");
    let card = json!({ "id": v["id"], "to": v["payee"], "asset": v["display"]["asset_symbol"], "amount": v["display"]["amount_decimal"], "why": v["reason"], "book": v["book_status"] });
    (card, id)
}

async fn state(w: &World, id: &str) -> String {
    w.request(id).await.expect("a request")["state"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn the_default_world_has_no_approver_and_no_sponsor() {
    let _s = SLOTS.acquire().await.unwrap();
    let w = world().await;
    let roles = call_view::<Value>(&w.policy, "get_roles", json!({}), &w.net)
        .await
        .unwrap()
        .data;
    assert_eq!(roles["owner_id"], w.owner.as_str());
    assert!(
        roles["approver"].is_null() && roles["sponsor"].is_null(),
        "{roles}"
    );
    // the owner approves, as in every deployment before AIR-327
    let (card, id) = held(&w, "bob", ONE_NEAR).await;
    ok(&call(&w, &w.owner, &w.owner_signer, "approve", card, 1).await);
    assert_eq!(state(&w, &id).await, "Executed");
}

#[tokio::test]
async fn the_borrower_approves_and_the_issuer_cannot() {
    let _s = SLOTS.acquire().await.unwrap();
    let w = world_with(WorldOpts {
        roles: true,
        ..WorldOpts::default()
    })
    .await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let roles = call_view::<Value>(&w.policy, "get_roles", json!({}), &w.net)
        .await
        .unwrap()
        .data;
    assert_eq!(roles["approver"], approver.as_str());
    assert_eq!(roles["sponsor"], w.sponsor.as_ref().unwrap().as_str());
    let (card, id) = held(&w, "bob", ONE_NEAR).await;
    // the issuer (owner) cannot approve or reject, a stranger neither
    fails_with(
        &call(&w, &w.owner, &w.owner_signer, "approve", card.clone(), 1).await,
        "Caller is not the approver",
    );
    fails_with(
        &call(
            &w,
            &w.owner,
            &w.owner_signer,
            "reject",
            json!({ "id": card["id"] }),
            1,
        )
        .await,
        "Caller is not the approver",
    );
    fails_with(
        &call(&w, &w.agent, &w.agent_signer, "approve", card.clone(), 1).await,
        "Caller is not the approver",
    );
    // the approver needs exactly one yocto
    fails_with(
        &call(&w, &approver, &approver_signer, "approve", card.clone(), 0).await,
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
    assert_eq!(state(&w, &id).await, "Pending");
    // the approver approves
    ok(&call(&w, &approver, &approver_signer, "approve", card, 1).await);
    assert_eq!(state(&w, &id).await, "Executed");
}

#[tokio::test]
async fn the_borrower_can_reject_and_cannot_remember_a_payee() {
    let _s = SLOTS.acquire().await.unwrap();
    let w = world_with(WorldOpts {
        roles: true,
        ..WorldOpts::default()
    })
    .await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let (card, id) = held(&w, "bob", ONE_NEAR).await;
    let mut remember = card.clone();
    remember["expected_old"] = json!("00".repeat(32));
    remember["new_root"] = json!("11".repeat(32));
    remember["entry"] = json!({ "salt": "00".repeat(32), "cap": "1", "daily_untrusted_budget": "0", "daily_limit": "1", "index": 0, "siblings": [] });
    let r = call(
        &w,
        &approver,
        &approver_signer,
        "approve_and_remember",
        remember,
        1,
    )
    .await;
    fails_with(
        &r,
        "approve_and_remember is refused when an approver is set",
    );
    fails_with(&r, "book_set_root");
    assert_eq!(state(&w, &id).await, "Pending");
    ok(&call(
        &w,
        &approver,
        &approver_signer,
        "reject",
        json!({ "id": card["id"] }),
        1,
    )
    .await);
    assert_eq!(state(&w, &id).await, "Rejected");
}

#[tokio::test]
async fn the_borrower_cannot_change_the_policy_and_the_issuer_can() {
    let _s = SLOTS.acquire().await.unwrap();
    let w = world_with(WorldOpts {
        roles: true,
        ..WorldOpts::default()
    })
    .await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let root = call_view::<Value>(&w.policy, "get_book_root", json!({}), &w.net)
        .await
        .unwrap()
        .data;
    let args = json!({ "expected_old": root, "new_root": "22".repeat(32) });
    fails_with(
        &call(
            &w,
            &approver,
            &approver_signer,
            "book_set_root",
            args.clone(),
            1,
        )
        .await,
        "Caller is not the owner",
    );
    fails_with(
        &call(
            &w,
            &approver,
            &approver_signer,
            "pause",
            json!({ "paused": true }),
            1,
        )
        .await,
        "Caller is not the owner",
    );
    fails_with(
        &call(
            &w,
            &approver,
            &approver_signer,
            "sweep",
            json!({ "amount": "1" }),
            1,
        )
        .await,
        "Caller is not the owner",
    );
    ok(&call(&w, &w.owner, &w.owner_signer, "book_set_root", args, 1).await);
}

#[tokio::test]
async fn sweep_pays_only_the_sponsor_and_waits_for_pending_escalations() {
    let _s = SLOTS.acquire().await.unwrap();
    let w = world_with(WorldOpts {
        roles: true,
        ..WorldOpts::default()
    })
    .await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let sponsor = w.sponsor.clone().expect("a sponsor");
    // a stranger and the approver cannot sweep
    fails_with(
        &call(
            &w,
            &approver,
            &approver_signer,
            "sweep",
            json!({ "amount": "1" }),
            1,
        )
        .await,
        "Caller is not the owner",
    );
    fails_with(
        &call(
            &w,
            &w.agent,
            &w.agent_signer,
            "sweep",
            json!({ "amount": "1" }),
            1,
        )
        .await,
        "Caller is not the owner",
    );
    // more than the spendable balance, and zero
    fails_with(
        &call(
            &w,
            &w.owner,
            &w.owner_signer,
            "sweep",
            json!({ "amount": (1_000_000 * ONE_NEAR).to_string() }),
            1,
        )
        .await,
        "exceeds the spendable balance",
    );
    fails_with(
        &call(
            &w,
            &w.owner,
            &w.owner_signer,
            "sweep",
            json!({ "amount": "0" }),
            1,
        )
        .await,
        "sweep amount must be positive",
    );
    // a pending escalation holds the sweep
    let (card, id) = held(&w, "bob", ONE_NEAR).await;
    fails_with(
        &call(
            &w,
            &w.owner,
            &w.owner_signer,
            "sweep",
            json!({ "amount": ONE_NEAR.to_string() }),
            1,
        )
        .await,
        "escalations are pending",
    );
    ok(&call(
        &w,
        &approver,
        &approver_signer,
        "reject",
        json!({ "id": card["id"] }),
        1,
    )
    .await);
    assert_eq!(state(&w, &id).await, "Rejected");
    // the sweep: a function call to the sponsor, nowhere else. The sponsor here is a plain account (no contract), so the credit fails, the
    // deposit comes back to the card and `sweep_result` says so.
    let r = call(
        &w,
        &w.owner,
        &w.owner_signer,
        "sweep",
        json!({ "amount": ONE_NEAR.to_string() }),
        1,
    )
    .await;
    // the only failed receipt is the sponsor's (a plain account has no contract); the policy's own receipts succeed
    let failed = failure_text(&r);
    assert!(
        failed.contains(sponsor.as_str())
            && !failed.contains(&format!(
                "executor_id: AccountId(\"{}\"), status: Failure",
                w.policy
            )),
        "{failed}"
    );
    let swept = events(&r, "swept");
    assert_eq!(swept.len(), 1, "{swept:?}");
    assert_eq!(swept[0]["sponsor"], sponsor.as_str());
    assert_eq!(swept[0]["amount"], ONE_NEAR.to_string());
    let result = events(&r, "sweep_result");
    assert_eq!(result.len(), 1, "{result:?}");
    assert_eq!(
        result[0]["ok"], false,
        "a plain account has no on_card_return"
    );
    for receipt in r.receipt_outcomes() {
        let who = receipt.executor_id.as_str();
        assert!(
            who == sponsor.as_str() || who == w.policy.as_str() || who == w.owner.as_str(),
            "a receipt ran on {who}"
        );
    }
}

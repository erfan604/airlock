// Red team lane 1 (2026-11-11), the card side: what the borrower can do with the two keys he holds on a credit card, the agent's
// function-call key and the approver key. The approver settles only holds that stay inside the issuer's task bound and the payee's
// daily limit; each test passes when a payment past them is refused to the approver.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, NearToken, Signer};
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};
use std::sync::Arc;

const OWNER_MASK: u16 = airlock_verdict::OWNER;
const BOOK_MASK: u16 = airlock_verdict::BOOK;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

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

async fn card_world() -> World {
    let w = world_with(WorldOpts {
        roles: true,
        ..WorldOpts::default()
    })
    .await;
    // the issuer's merchant entry: daily limit 5 NEAR, as an issuer sets a merchant limit on a card
    owner_call_ok(&w.policy, &w.owner, &w.owner_signer, &w.net, "book_add", json!({
        "key": format!("near:{}", w.payee_near), "cap": ONE_NEAR.to_string(), "daily_untrusted_budget": (10 * ONE_NEAR).to_string(),
        "daily_limit": (5 * ONE_NEAR).to_string(), "label": "Alice" })).await;
    w
}

/// The agent sends one request under `bounds`; returns the outcome, the approve card and the request id.
async fn send(
    w: &World,
    bounds: &[(&str, u128)],
    payee: &str,
    amount: u128,
    task_id: &str,
) -> (Value, Value, String) {
    send_labelled(
        w,
        bounds,
        payee,
        amount,
        task_id,
        (BOOK_MASK, OWNER_MASK, OWNER_MASK),
    )
    .await
}

/// `send` with the labels `(recipient, amount, pc)`.
async fn send_labelled(
    w: &World,
    bounds: &[(&str, u128)],
    payee: &str,
    amount: u128,
    task_id: &str,
    labels: (u16, u16, u16),
) -> (Value, Value, String) {
    let policy: near_sdk::AccountId = w.policy.as_str().parse().unwrap();
    let agent: near_sdk::AccountId = w.agent.as_str().parse().unwrap();
    let task = signed_task_with(bounds, 1, |t| {
        t.contract_id = policy;
        t.agent_id = agent;
        t.task_id = task_id.to_string();
    });
    let req = w.request_json(&task.0, 0, "near", payee, amount, labels, None);
    let result = w.submit(vec![req], &task).await;
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    let outs: Value = result.json().expect("outcomes");
    let id = outs[0]["request_id"].as_str().unwrap().to_string();
    let v = w.request(&id).await.expect("a request");
    let card = json!({ "id": v["id"], "to": v["payee"], "asset": v["display"]["asset_symbol"], "amount": v["display"]["amount_decimal"], "why": v["reason"], "book": v["book_status"] });
    (outs[0].clone(), card, id)
}

async fn state(w: &World, id: &str) -> String {
    w.request(id).await.expect("a request")["state"]
        .as_str()
        .unwrap()
        .to_string()
}

/// TERMS 1.6 says every payment fits the task the owner (the issuer) signed. On a card the approver is the borrower, who also runs the
/// agent. A request above the issuer's task bound for a booked merchant is held `OverTaskBound` with `book: in_book`, so the approver may
/// settle it: the issuer's bound then does not bind the borrower. Expected (if the claim held): the approver's approve is refused.
#[tokio::test]
async fn lane1_borrower_cannot_approve_past_the_issuers_task_bound() {
    let w = card_world().await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let alice = format!("near:{}", w.payee_near);
    // the issuer signed a task that may pay Alice at most 1 NEAR
    let (out, card, id) = send(&w, &[(&alice, ONE_NEAR)], &alice, 4 * ONE_NEAR, "t-bound").await;
    assert_eq!(out["outcome"], "escalated", "{out}");
    assert_eq!(card["why"], "OverTaskBound");
    assert_eq!(card["book"], "in_book");
    let r = call(&w, &approver, &approver_signer, "approve", card, 1).await;
    let refused = !failure_text(&r).is_empty();
    assert!(
        refused,
        "the borrower approved 4 NEAR against an issuer task bound of 1 NEAR; request state {}",
        state(&w, &id).await
    );
}

/// The same with a task that does not name the merchant at all (held `OutsideTask`): any live task the issuer signed for the agent lets
/// the borrower pay any booked merchant, up to the asset's hard cap per payment.
#[tokio::test]
async fn lane1_borrower_cannot_approve_a_payee_outside_the_signed_task() {
    let w = card_world().await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let alice = format!("near:{}", w.payee_near);
    let (other, _) = create_user_account(&w.net, &w.root, &w.owner_signer, "bob")
        .await
        .expect("bob exists");
    let bob = format!("near:{other}");
    let (out, card, id) = send(&w, &[(&bob, ONE_NEAR)], &alice, 4 * ONE_NEAR, "t-outside").await;
    assert_eq!(out["outcome"], "escalated", "{out}");
    assert_eq!(card["why"], "OutsideTask");
    assert_eq!(card["book"], "in_book");
    let r = call(&w, &approver, &approver_signer, "approve", card, 1).await;
    let refused = !failure_text(&r).is_empty();
    assert!(
        refused,
        "the borrower paid a merchant the issuer's task never named; request state {}",
        state(&w, &id).await
    );
}

/// The issuer's daily limit for the merchant (5 NEAR) does not bind the borrower either: two approvals of 4 NEAR on one day.
#[tokio::test]
async fn lane1_borrower_cannot_approve_past_the_merchants_daily_limit() {
    let w = card_world().await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let alice = format!("near:{}", w.payee_near);
    let mut paid = 0u128;
    for i in 0..2 {
        let tid = format!("t-day-{i}");
        let (out, card, id) = send(&w, &[(&alice, ONE_NEAR)], &alice, 4 * ONE_NEAR, &tid).await;
        assert_eq!(out["outcome"], "escalated", "{out}");
        let r = call(&w, &approver, &approver_signer, "approve", card, 1).await;
        if failure_text(&r).is_empty() && state(&w, &id).await == "Executed" {
            paid += 4 * ONE_NEAR;
        }
    }
    assert!(
        paid <= 5 * ONE_NEAR,
        "the borrower paid {} NEAR to a merchant whose daily limit is 5",
        paid / ONE_NEAR
    );
}

/// A hold that is inside the task bound but held for another reason (an untrusted trigger) is the approver's to settle, but only while the
/// payee's daily limit can take the full amount: two such approvals of 4 NEAR to a merchant limited to 5 NEAR a day, the second refused
/// and still pending.
#[tokio::test]
async fn lane1_borrower_cannot_approve_an_untrusted_trigger_past_the_merchants_daily_limit() {
    let w = card_world().await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let alice = format!("near:{}", w.payee_near);
    let labels = (BOOK_MASK, OWNER_MASK, airlock_verdict::labels::EMAIL);
    let mut outcomes = Vec::new();
    for i in 0..2 {
        let tid = format!("t-trig-{i}");
        let (out, card, id) = send_labelled(
            &w,
            &[(&alice, 10 * ONE_NEAR)],
            &alice,
            4 * ONE_NEAR,
            &tid,
            labels,
        )
        .await;
        assert_eq!(out["outcome"], "escalated", "{out}");
        assert_eq!(card["why"], "UntrustedTrigger");
        let r = call(&w, &approver, &approver_signer, "approve", card, 1).await;
        outcomes.push((failure_text(&r), state(&w, &id).await));
    }
    assert!(
        outcomes[0].0.is_empty(),
        "the first approval inside the limit passes: {}",
        outcomes[0].0
    );
    assert_ne!(outcomes[0].1, "Pending");
    assert!(
        outcomes[1].0.contains("approve refused for the approver"),
        "the borrower paid 8 NEAR to a merchant whose daily limit is 5 (second approve: {:?})",
        outcomes[1]
    );
    assert_eq!(
        outcomes[1].1, "Pending",
        "a refused approve leaves the request pending"
    );
}

/// The task bound binds the approver in full too: two holds under one task bound of 5 NEAR to a merchant with a 20 NEAR daily limit, each
/// inside the bound when it was held; the second approval would pass the bound, so it is refused.
#[tokio::test]
async fn lane1_borrower_cannot_approve_two_holds_past_one_task_bound() {
    let w = card_world().await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let (bob_id, _) = create_user_account(&w.net, &w.root, &w.owner_signer, "bob")
        .await
        .expect("bob exists");
    owner_call_ok(&w.policy, &w.owner, &w.owner_signer, &w.net, "book_add", json!({
        "key": format!("near:{bob_id}"), "cap": ONE_NEAR.to_string(), "daily_untrusted_budget": (10 * ONE_NEAR).to_string(),
        "daily_limit": (20 * ONE_NEAR).to_string(), "label": "Bob" })).await;
    let bob = format!("near:{bob_id}");
    let labels = (BOOK_MASK, OWNER_MASK, airlock_verdict::labels::EMAIL);
    let policy: near_sdk::AccountId = w.policy.as_str().parse().unwrap();
    let agent: near_sdk::AccountId = w.agent.as_str().parse().unwrap();
    let task = signed_task_with(&[(&bob, 5 * ONE_NEAR)], 2, |t| {
        t.contract_id = policy;
        t.agent_id = agent;
        t.task_id = "t-one-bound".to_string();
    });
    let reqs = vec![
        w.request_json(&task.0, 0, "near", &bob, 4 * ONE_NEAR, labels, None),
        w.request_json(&task.0, 1, "near", &bob, 4 * ONE_NEAR, labels, None),
    ];
    let result = w.submit(reqs, &task).await;
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    let outs: Value = result.json().expect("outcomes");
    let mut results = Vec::new();
    for o in outs.as_array().unwrap() {
        assert_eq!(o["outcome"], "escalated", "{o}");
        let id = o["request_id"].as_str().unwrap().to_string();
        let v = w.request(&id).await.expect("a request");
        let card = json!({ "id": v["id"], "to": v["payee"], "asset": v["display"]["asset_symbol"], "amount": v["display"]["amount_decimal"], "why": v["reason"], "book": v["book_status"] });
        let r = call(&w, &approver, &approver_signer, "approve", card, 1).await;
        results.push((failure_text(&r), state(&w, &id).await));
    }
    assert!(
        results[0].0.is_empty(),
        "the first approval inside the bound passes: {}",
        results[0].0
    );
    assert!(
        results[1].0.contains("task bound"),
        "the borrower approved 8 NEAR under a task bound of 5 (second approve: {:?})",
        results[1]
    );
    assert_eq!(results[1].1, "Pending");
}

/// After the approver is refused, the request stays pending and the issuer can still clear it with `reject` (which `sweep` needs).
#[tokio::test]
async fn lane1_a_refused_approve_stays_pending_and_the_issuer_rejects_it() {
    let w = card_world().await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let alice = format!("near:{}", w.payee_near);
    let (_, card, id) = send(&w, &[(&alice, ONE_NEAR)], &alice, 4 * ONE_NEAR, "t-pending").await;
    let r = call(&w, &approver, &approver_signer, "approve", card.clone(), 1).await;
    let text = failure_text(&r);
    assert!(
        text.contains("approve refused for the approver: the payment is held OverTaskBound"),
        "{text}"
    );
    assert_eq!(state(&w, &id).await, "Pending");
    let r = call(
        &w,
        &w.owner,
        &w.owner_signer,
        "reject",
        json!({ "id": card["id"] }),
        1,
    )
    .await;
    assert!(failure_text(&r).is_empty(), "{}", failure_text(&r));
    assert_eq!(state(&w, &id).await, "Rejected");
}

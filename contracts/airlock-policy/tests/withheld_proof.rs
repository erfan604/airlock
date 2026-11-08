// AIR-326: a request is "in the book" only when it carries a proof that verifies for its own payee against the current root. Withholding
// a proof, replaying one from before a root change and presenting another payee's proof all fail the same way: the payee is new, the owner
// is asked, and the card says `new`. Nothing in these cases is ever allowed.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::book::{Entry, build};
use common::*;
use near_api::NearToken;
use serde_json::{Value, json};

const OWNER_MASK: u16 = airlock_verdict::OWNER;
const ALICE: &str = "near:alice.sandbox";
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

/// Alice replaced with cap 1 NEAR, untrusted budget 10 NEAR and a daily limit of 2 NEAR (through the shim, so her proof is attached).
async fn small_alice(w: &World) {
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "book_add",
        json!({
            "key": ALICE,
            "cap": ONE_NEAR.to_string(),
            "daily_untrusted_budget": (10 * ONE_NEAR).to_string(),
            "daily_limit": (2 * ONE_NEAR).to_string(),
            "label": "Alice"
        }),
    )
    .await;
}

/// One request paying `amount` to `payee` with the recipient label `recipient` (Owner amount and pc), `book` as the proof field.
async fn submit(
    w: &World,
    payee: &str,
    amount: u128,
    recipient: u16,
    book: Option<Value>,
) -> Value {
    let task = w.signed_task(&[(payee, 10 * ONE_NEAR)], 1);
    let mut r = w.request_json(
        &task.0,
        0,
        "near",
        payee,
        amount,
        (recipient, OWNER_MASK, OWNER_MASK),
        None,
    );
    if let Some(b) = book {
        r["book"] = b;
    }
    let result = w.submit(vec![r], &task).await;
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    let outs: Value = result.json().expect("outcomes");
    outs[0].clone()
}

async fn card(w: &World, outcome: &Value) -> Value {
    let v = w
        .request(outcome["request_id"].as_str().unwrap())
        .await
        .expect("a request");
    json!({
        "id": v["id"], "to": v["payee"], "asset": v["display"]["asset_symbol"],
        "amount": v["display"]["amount_decimal"], "why": v["reason"], "book": v["book_status"]
    })
}

async fn approve(w: &World, card: Value) {
    let r = call_transaction(
        &w.policy,
        "approve",
        card,
        &w.owner,
        &w.owner_signer,
        &w.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("sent");
    assert!(failure_text(&r).is_empty(), "{}", failure_text(&r));
}

/// An in-book payee submitted with no proof is held as new, never allowed. The owner's approval charges the asset cap and the task bound:
/// the payee's own daily limit (2 NEAR) does not clamp the day ledger, so it shows the full 5 NEAR.
#[tokio::test]
async fn a_withheld_proof_is_held_as_new_and_the_approval_ignores_the_payee_limit() {
    let _slot = SANDBOX_SLOTS.acquire().await.unwrap();
    let w = world().await;
    small_alice(&w).await;
    let o = submit(&w, ALICE, 5 * ONE_NEAR, OWNER_MASK, Some(json!("withhold"))).await;
    assert_eq!(o["outcome"], "escalated", "{o}");
    assert_eq!(o["reason"], "NewRecipient", "{o}");
    let c = card(&w, &o).await;
    assert_eq!(c["book"], "new", "{c}");
    approve(&w, c).await;
    let l = w.ledgers(ALICE, "near").await;
    assert_eq!(l["asset_day"]["spent"], (5 * ONE_NEAR).to_string(), "{l}");
    assert_eq!(l["payee_day"]["spent"], (5 * ONE_NEAR).to_string(), "{l}");
    assert_eq!(l["payee_day"]["cap"], (2 * ONE_NEAR).to_string(), "{l}");
}

/// The same payee with its proof is in the book and the card says so (the control of the test above).
#[tokio::test]
async fn the_same_payee_with_its_proof_is_in_the_book() {
    let _slot = SANDBOX_SLOTS.acquire().await.unwrap();
    let w = world().await;
    small_alice(&w).await;
    // 5 NEAR is over the daily limit of 2 NEAR: held, but as a book payee
    let o = submit(&w, ALICE, 5 * ONE_NEAR, airlock_verdict::BOOK, None).await;
    assert_eq!(o["outcome"], "escalated", "{o}");
    assert_eq!(card(&w, &o).await["book"], "in_book");
}

/// A proof made against the previous root counts as not in the book after a `book_set_root`.
#[tokio::test]
async fn a_proof_of_the_previous_root_is_not_in_the_book() {
    let _slot = SANDBOX_SLOTS.acquire().await.unwrap();
    let w = world().await;
    let entries = [Entry {
        salt: [8; 32],
        payee: ALICE.to_string(),
        cap: Some(ONE_NEAR),
        daily_untrusted_budget: ONE_NEAR,
        daily_limit: 2 * ONE_NEAR,
    }];
    let (root, proofs) = build(&entries, &[3; 32]);
    let set = |old: Value, new: [u8; 32]| {
        let (w_policy, net, owner, signer) = (
            w.policy.clone(),
            w.net.clone(),
            w.owner.clone(),
            w.owner_signer.clone(),
        );
        async move {
            let r = call_transaction(
                &w_policy,
                "book_set_root",
                json!({ "expected_old": old, "new_root": hex::encode(new) }),
                &owner,
                &signer,
                &net,
                Some(NearToken::from_yoctonear(1)),
            )
            .await
            .expect("sent");
            assert!(failure_text(&r).is_empty(), "{}", failure_text(&r));
        }
    };
    let old = call_view::<Value>(&w.policy, "get_book_root", json!({}), &w.net)
        .await
        .unwrap()
        .data;
    set(old, root).await;
    let proof = serde_json::to_value(&proofs[0]).unwrap();
    let o = submit(&w, ALICE, ONE_NEAR / 2, OWNER_MASK, Some(proof.clone())).await;
    assert_eq!(
        o["outcome"], "allowed",
        "the proof verifies against the current root: {o}"
    );
    // the owner changes the book: the same proof is now stale
    let (next, _) = build(&[], &[4; 32]);
    set(json!(hex::encode(root)), next).await;
    let o = submit(&w, ALICE, ONE_NEAR / 2, OWNER_MASK, Some(proof)).await;
    assert_eq!(o["outcome"], "escalated", "{o}");
    assert_eq!(card(&w, &o).await["book"], "new");
}

/// A proof for payee A presented on a request to payee B counts as not in the book.
#[tokio::test]
async fn another_payees_proof_does_not_make_a_payee_a_book_payee() {
    let _slot = SANDBOX_SLOTS.acquire().await.unwrap();
    let w = world().await;
    small_alice(&w).await;
    let proof = shim_proof(&w.policy, &w.net, ALICE).expect("alice is booked");
    let o = submit(
        &w,
        "near:bob.sandbox",
        ONE_NEAR / 2,
        OWNER_MASK,
        Some(proof),
    )
    .await;
    assert_eq!(o["outcome"], "escalated", "{o}");
    assert_eq!(o["reason"], "NewRecipient", "{o}");
    assert_eq!(card(&w, &o).await["book"], "new");
}

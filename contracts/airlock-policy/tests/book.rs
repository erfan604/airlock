// AIR-326: the address book commitment in the sandbox. The contract stores one root; only the owner changes it (one yocto,
// compare and swap); a request pays a booked payee only with a path that verifies for its own payee string. Every revert test
// asserts the message text, because a missing method also fails and would pass a bare `assert_failure()`.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::book::{Entry, build};
use common::*;
use near_api::NearToken;
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};

const ONE_YOCTO_TEXT: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
const NOT_OWNER_TEXT: &str = "Caller is not the owner";
const OWNER_MASK: u16 = airlock_verdict::OWNER;
const BOOK_MASK: u16 = airlock_verdict::BOOK;
const ALICE: &str = "near:alice.sandbox";
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

fn entry(payee: &str, salt: u8, cap: Option<u128>) -> Entry {
    Entry {
        salt: [salt; 32],
        payee: payee.to_string(),
        cap,
        daily_untrusted_budget: 1_000 * ONE_NEAR,
        daily_limit: 5_000 * ONE_NEAR,
    }
}

async fn root_of(w: &World) -> Value {
    call_view::<Value>(&w.policy, "get_book_root", json!({}), &w.net)
        .await
        .expect("get_book_root answers")
        .data
}

async fn set_root(w: &World, old: &Value, new: [u8; 32]) -> ExecutionFinalResult {
    call_transaction(
        &w.policy,
        "book_set_root",
        json!({ "expected_old": old, "new_root": hex::encode(new) }),
        &w.owner,
        &w.owner_signer,
        &w.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("the call is sent")
}

fn ok(r: &ExecutionFinalResult) {
    let text = failure_text(r);
    assert!(text.is_empty(), "failed: {text}");
}

fn fails_with(r: &ExecutionFinalResult, text: &str) {
    let got = failure_text(r);
    assert!(got.contains(text), "wanted {text:?}, got {got:?}");
}

/// A one-action task for `payee` and a request that pays 10 yocto of NEAR to it, Book recipient, Owner amount and pc, with `book` as
/// the proof (or none).
async fn pay(w: &World, payee: &str, book: Option<Value>) -> Value {
    pay_as(w, payee, book, BOOK_MASK).await
}

async fn pay_as(w: &World, payee: &str, book: Option<Value>, recipient: u16) -> Value {
    let task = w.signed_task(&[(payee, 10 * ONE_NEAR)], 1);
    let mut r = w.request_json(
        &task.0,
        0,
        "near",
        payee,
        10,
        (recipient, OWNER_MASK, OWNER_MASK),
        None,
    );
    if let Some(b) = book {
        r["book"] = b;
    }
    let result = w.submit(vec![r], &task).await;
    ok(&result);
    let outs: Value = result.json().expect("outcomes");
    outs[0].clone()
}

#[tokio::test]
async fn the_book_root_starts_zero_and_the_old_listing_views_are_gone() {
    let _slot = slot().await;
    let w = world().await;
    // world() books two payees through the test shim, which sets a root; a fresh contract starts at zero
    assert_ne!(root_of(&w).await, json!("0".repeat(64)));
    for gone in ["get_book", "get_book_entry", "book_add", "book_remove"] {
        assert!(
            !wasm_exports().iter().any(|e| e == gone),
            "{gone} must not be exported"
        );
    }
    for kept in ["book_set_root", "get_book_root", "get_book_epoch"] {
        assert!(wasm_exports().iter().any(|e| e == kept), "{kept} missing");
    }
}

#[tokio::test]
async fn owner_sets_the_root_with_the_old_root_and_emits_two_hashes() {
    let _slot = slot().await;
    let w = world().await;
    let old = root_of(&w).await;
    let epoch0: Value = call_view(&w.policy, "get_book_epoch", json!({}), &w.net)
        .await
        .unwrap()
        .data;
    let (root, _) = build(&[entry(ALICE, 9, Some(100 * ONE_NEAR))], &[3; 32]);
    let r = set_root(&w, &old, root).await;
    ok(&r);
    assert_eq!(root_of(&w).await, json!(hex::encode(root)));
    let epoch1: Value = call_view(&w.policy, "get_book_epoch", json!({}), &w.net)
        .await
        .unwrap()
        .data;
    assert_eq!(
        epoch1.as_str().unwrap().parse::<u64>().unwrap(),
        epoch0.as_str().unwrap().parse::<u64>().unwrap() + 1
    );
    let ev = events(&r, "book_root_set");
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert_eq!(ev[0]["new"], hex::encode(root));
    assert_eq!(ev[0]["old"], old);
    let text = serde_json::to_string(&ev[0]).unwrap();
    assert!(!text.contains("alice"), "{text}");
}

#[tokio::test]
async fn a_stale_expected_root_reverts_and_changes_nothing() {
    let _slot = slot().await;
    let w = world().await;
    let (root, _) = build(&[entry(ALICE, 9, Some(1))], &[3; 32]);
    let before = root_of(&w).await;
    let r = set_root(&w, &json!("11".repeat(32)), root).await;
    fails_with(&r, "stale book root");
    assert_eq!(root_of(&w).await, before);
}

#[tokio::test]
async fn only_the_owner_with_exactly_one_yocto_sets_the_root() {
    let _slot = slot().await;
    let w = world().await;
    let old = root_of(&w).await;
    let args = json!({ "expected_old": old, "new_root": "22".repeat(32) });
    let send =
        |who: &near_api::AccountId, signer: &std::sync::Arc<near_api::Signer>, yocto: u128| {
            let (policy, net, args) = (w.policy.clone(), w.net.clone(), args.clone());
            let (who, signer) = (who.clone(), signer.clone());
            async move {
                call_transaction(
                    &policy,
                    "book_set_root",
                    args,
                    &who,
                    &signer,
                    &net,
                    Some(NearToken::from_yoctonear(yocto)),
                )
                .await
                .expect("sent")
            }
        };
    fails_with(&send(&w.agent, &w.agent_signer, 1).await, NOT_OWNER_TEXT);
    fails_with(&send(&w.owner, &w.owner_signer, 0).await, ONE_YOCTO_TEXT);
    fails_with(&send(&w.owner, &w.owner_signer, 2).await, ONE_YOCTO_TEXT);
    assert_eq!(root_of(&w).await, old);
}

#[tokio::test]
async fn a_proof_pays_its_own_payee_and_a_bad_proof_is_a_new_payee() {
    let _slot = slot().await;
    let w = world().await;
    let old = root_of(&w).await;
    let others = [
        entry("near:other.sandbox", 4, None),
        entry(ALICE, 5, Some(100 * ONE_NEAR)),
    ];
    let (root, proofs) = build(&others, &[3; 32]);
    ok(&set_root(&w, &old, root).await);
    let proof = serde_json::to_value(&proofs[1]).unwrap();
    // the right path: the payee is in the book, the payment is allowed
    let good = pay(&w, ALICE, Some(proof.clone())).await;
    assert_eq!(good["outcome"], "allowed", "{good}");
    // a tampered cap, a path of another slot, and a path of another payee are not a book payee: never a revert
    let mut richer = proof.clone();
    richer["cap"] = json!((1_000 * ONE_NEAR).to_string());
    let w_task_payee = |p: &str| p.to_string();
    for (name, bad) in [
        ("tampered cap", richer),
        ("other slot", serde_json::to_value(&proofs[0]).unwrap()),
    ] {
        let o = pay(&w, &w_task_payee(ALICE), Some(bad)).await;
        // a Book labelled request whose proof does not verify names a payee that is not in the book: the verdict blocks it (rule 5)
        assert_eq!(o["outcome"], "blocked", "{name}: {o}");
        assert_eq!(o["reason"], "BookLabelNotInBook", "{name}: {o}");
    }
    // the same bad proof under an Owner recipient label is a new recipient: the owner is asked
    let mut richer = proof;
    richer["cap"] = json!((1_000 * ONE_NEAR).to_string());
    let o = pay_as(&w, ALICE, Some(richer), OWNER_MASK).await;
    assert_eq!(o["outcome"], "escalated", "{o}");
    assert_eq!(o["reason"], "NewRecipient", "{o}");
}

#[tokio::test]
async fn the_next_root_revokes_at_once() {
    let _slot = slot().await;
    let w = world().await;
    let old = root_of(&w).await;
    let (root, proofs) = build(&[entry(ALICE, 5, Some(100 * ONE_NEAR))], &[3; 32]);
    ok(&set_root(&w, &old, root).await);
    let proof = serde_json::to_value(&proofs[0]).unwrap();
    assert_eq!(
        pay(&w, ALICE, Some(proof.clone())).await["outcome"],
        "allowed"
    );
    let (empty, _) = build(&[], &[4; 32]);
    ok(&set_root(&w, &json!(hex::encode(root)), empty).await);
    let o = pay(&w, ALICE, Some(proof)).await;
    assert_eq!(o["outcome"], "blocked", "{o}");
    assert_eq!(o["reason"], "BookLabelNotInBook", "{o}");
}

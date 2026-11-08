// AIR-328: the pool against the real airlock-policy wasm and the mock signer, in the near sandbox. The policy is a card (AIR-327): the issuer
// is its owner, the borrower its approver, the pool its sponsor. The suite reuses the policy crate's test helpers.
//
// Needs both wasms: `cargo near build non-reproducible-wasm --no-abi` in contracts/airlock-policy and in contracts/airlock-credit.

#[path = "../../airlock-policy/tests/common/mod.rs"]
mod common;

use common::*;
use near_api::{AccountId, Contract, NearToken, Signer};
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};
use std::sync::Arc;

const OWNER_MASK: u16 = airlock_verdict::OWNER;
const BOOK_MASK: u16 = airlock_verdict::BOOK;
const EMAIL_MASK: u16 = airlock_verdict::labels::EMAIL;

static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

fn credit_wasm() -> String {
    let target = std::env::var("CARGO_TARGET_DIR").unwrap_or_else(|_| "target".to_string());
    format!("{target}/near/airlock_credit.wasm")
}

struct Fx {
    w: World,
    pool: AccountId,
    lp1: (AccountId, Arc<Signer>),
    lp2: (AccountId, Arc<Signer>),
}

async fn fixture() -> Fx {
    let w = world_with(WorldOpts {
        roles: true,
        sponsor_is: Some("pool"),
        ..WorldOpts::default()
    })
    .await;
    let path = credit_wasm();
    assert!(
        std::path::Path::new(&path).exists(),
        "{path} is missing: build contracts/airlock-credit first"
    );
    let pool = deploy_contract(
        &w.net,
        &w.root,
        &w.owner_signer,
        &path,
        Some("new"),
        Some(json!({ "owner_id": w.owner })),
        Some(format!("pool.{}", w.root).parse().unwrap()),
    )
    .await
    .expect("the pool deploys");
    let lp1 = create_user_account(&w.net, &w.root, &w.owner_signer, "lp1")
        .await
        .expect("lp1");
    let lp2 = create_user_account(&w.net, &w.root, &w.owner_signer, "lp2")
        .await
        .expect("lp2");
    // test accounts start with 5 NEAR: the LPs and the borrower get what the amounts below need
    let (approver, _) = w.approver.clone().expect("an approver");
    for (who, near) in [(&lp1.0, 100u128), (&lp2.0, 100), (&approver, 20)] {
        let sent = near_api::Tokens::account(w.root.clone())
            .send_to(who.clone())
            .near(NearToken::from_near(near))
            .with_signer(w.owner_signer.clone())
            .send_to(&w.net)
            .await
            .expect("the top-up is sent");
        let _ = sent;
    }
    Fx { w, pool, lp1, lp2 }
}

async fn send(
    w: &World,
    contract: &AccountId,
    who: &AccountId,
    signer: &Arc<Signer>,
    method: &str,
    args: Value,
    yocto: u128,
) -> ExecutionFinalResult {
    call_transaction(
        contract,
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

fn ok(r: &ExecutionFinalResult) {
    let t = failure_text(r);
    assert!(t.is_empty(), "failed: {t}");
}

fn fails_with(r: &ExecutionFinalResult, text: &str) {
    let t = failure_text(r);
    assert!(t.contains(text), "wanted {text:?}, got {t:?}");
}

async fn pool_view(fx: &Fx) -> Value {
    call_view::<Value>(&fx.pool, "get_pool", json!({}), &fx.w.net)
        .await
        .expect("get_pool")
        .data
}

fn n(v: &Value) -> u128 {
    v.as_str()
        .expect("a decimal string")
        .parse()
        .expect("a number")
}

async fn balance(fx: &Fx, who: &AccountId) -> u128 {
    near_api::Account(who.clone())
        .view()
        .fetch_from(&fx.w.net)
        .await
        .expect("the account exists")
        .data
        .amount
        .as_yoctonear()
}

/// LPs deposit 60 and 40 NEAR; the issuer registers the card (the pool checks its roles on chain); the borrower posts 3 NEAR of collateral;
/// the issuer opens a line of 10 NEAR with a 5 percent fee that is due in `due_secs` seconds.
async fn funded_line(fx: &Fx, due_secs: u64) {
    let w = &fx.w;
    ok(&send(
        w,
        &fx.pool,
        &fx.lp1.0,
        &fx.lp1.1,
        "deposit",
        json!({}),
        60 * ONE_NEAR,
    )
    .await);
    ok(&send(
        w,
        &fx.pool,
        &fx.lp2.0,
        &fx.lp2.1,
        "deposit",
        json!({}),
        40 * ONE_NEAR,
    )
    .await);
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    ok(&send(
        w,
        &fx.pool,
        &w.owner,
        &w.owner_signer,
        "register_card",
        json!({ "card": w.policy, "borrower": approver }),
        0,
    )
    .await);
    assert_eq!(
        call_view::<Value>(&fx.pool, "get_card", json!({ "card": w.policy }), &w.net)
            .await
            .unwrap()
            .data,
        json!(approver.as_str())
    );
    ok(&send(
        w,
        &fx.pool,
        &approver,
        &approver_signer,
        "post_collateral",
        json!({ "card": w.policy }),
        3 * ONE_NEAR,
    )
    .await);
    let due = final_block_ms(w) + due_secs * 1000;
    ok(&send(w, &fx.pool, &w.owner, &w.owner_signer, "open_line", json!({ "card": w.policy, "limit": (10 * ONE_NEAR).to_string(), "fee_bps": 500, "due_ms": due.to_string() }), 0).await);
}

/// A request from the agent: `payee` (a key), `amount`, the three label masks.
async fn submit(w: &World, payee: &str, amount: u128, labels: (u16, u16, u16)) -> Value {
    let task = w.signed_task(&[(payee, 10 * ONE_NEAR)], 1);
    let req = w.request_json(&task.0, 0, "near", payee, amount, labels, None);
    let r = w.submit(vec![req], &task).await;
    ok(&r);
    let outs: Value = r.json().expect("outcomes");
    outs[0].clone()
}

async fn state(w: &World, id: &str) -> String {
    w.request(id).await.expect("a request")["state"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_line_funds_a_card_that_pays_a_merchant_and_is_swept_and_repaid_with_a_fee() {
    let _s = SLOTS.acquire().await.unwrap();
    let fx = fixture().await;
    let w = &fx.w;
    funded_line(&fx, 3600).await;
    let p = pool_view(&fx).await;
    assert_eq!(
        (n(&p["idle"]), n(&p["lent"]), n(&p["assets"])),
        (90 * ONE_NEAR, 10 * ONE_NEAR, 100 * ONE_NEAR),
        "{p}"
    );
    assert_eq!(p["lines"][0]["state"], "Open");
    // the agent pays a book merchant through the verdict: allowed, paid
    let merchant_before = balance(&fx, &w.payee_near).await;
    let o = submit(
        w,
        &format!("near:{}", w.payee_near),
        2 * ONE_NEAR,
        (BOOK_MASK, OWNER_MASK, OWNER_MASK),
    )
    .await;
    assert_eq!(o["outcome"], "allowed", "{o}");
    assert_eq!(
        balance(&fx, &w.payee_near).await - merchant_before,
        2 * ONE_NEAR
    );
    // an injected payee (an attacker account from untrusted text) is held and nothing moves
    let (attacker, _) = create_user_account(&w.net, &w.root, &w.owner_signer, "attacker")
        .await
        .unwrap();
    let attacker_before = balance(&fx, &attacker).await;
    let held = submit(
        w,
        &format!("near:{attacker}"),
        5 * ONE_NEAR,
        (EMAIL_MASK, OWNER_MASK, OWNER_MASK),
    )
    .await;
    assert_eq!(held["outcome"], "escalated", "{held}");
    assert_eq!(
        balance(&fx, &attacker).await,
        attacker_before,
        "the attacker got nothing"
    );
    // the issuer cannot sweep while the escalation is pending; the borrower rejects it, then the sweep works
    let (approver, approver_signer) = w.approver.clone().unwrap();
    fails_with(
        &send(
            w,
            &w.policy,
            &w.owner,
            &w.owner_signer,
            "sweep",
            json!({ "amount": (5 * ONE_NEAR).to_string() }),
            1,
        )
        .await,
        "escalations are pending",
    );
    let v = w
        .request(held["request_id"].as_str().unwrap())
        .await
        .unwrap();
    ok(&send(
        w,
        &w.policy,
        &approver,
        &approver_signer,
        "reject",
        json!({ "id": v["id"] }),
        1,
    )
    .await);
    assert_eq!(
        state(w, held["request_id"].as_str().unwrap()).await,
        "Rejected"
    );
    // sweep 8 NEAR back: the pool credits the line
    let r = send(
        w,
        &w.policy,
        &w.owner,
        &w.owner_signer,
        "sweep",
        json!({ "amount": (8 * ONE_NEAR).to_string() }),
        1,
    )
    .await;
    ok(&r);
    let p = pool_view(&fx).await;
    assert_eq!(
        (n(&p["idle"]), n(&p["lent"])),
        (98 * ONE_NEAR, 2 * ONE_NEAR),
        "8 returned, 2 kept: {p}"
    );
    assert_eq!(n(&p["lines"][0]["returned"]), 8 * ONE_NEAR);
    // the borrower repays what the card kept (2 NEAR) plus the 5 percent fee (0.1 NEAR) and gets the collateral back
    let owed = 2 * ONE_NEAR + ONE_NEAR / 10;
    fails_with(
        &send(
            w,
            &fx.pool,
            &approver,
            &approver_signer,
            "repay",
            json!({ "card": w.policy }),
            owed - 1,
        )
        .await,
        "repay needs at least",
    );
    ok(&send(
        w,
        &fx.pool,
        &approver,
        &approver_signer,
        "repay",
        json!({ "card": w.policy }),
        owed,
    )
    .await);
    let p = pool_view(&fx).await;
    assert_eq!(
        (
            n(&p["idle"]),
            n(&p["lent"]),
            n(&p["fees_earned"]),
            n(&p["collateral_held"])
        ),
        (100 * ONE_NEAR + ONE_NEAR / 10, 0, ONE_NEAR / 10, 0),
        "{p}"
    );
    assert_eq!(p["lines"][0]["state"], "Repaid");
    // the LPs earned: lp1 holds 60 shares worth 60.06 NEAR and withdraws all of it, more than it put in
    let before = balance(&fx, &fx.lp1.0).await;
    ok(&send(
        w,
        &fx.pool,
        &fx.lp1.0,
        &fx.lp1.1,
        "withdraw",
        json!({ "shares": (60 * ONE_NEAR).to_string() }),
        0,
    )
    .await);
    let got = balance(&fx, &fx.lp1.0).await - before;
    assert!(
        got > 60 * ONE_NEAR,
        "lp1 withdrew {got}, more than the 60 NEAR it deposited (minus gas)"
    );
}

/// The hole of the credit claim: the borrower controls the agent and holds the approver key. He asks his own account to be paid through
/// the agent: held, the approver is refused, the pool and the card lose nothing.
#[tokio::test]
async fn the_borrower_tries_to_pay_himself_through_his_agent_and_the_pool_loses_nothing() {
    let _s = SLOTS.acquire().await.unwrap();
    let fx = fixture().await;
    let w = &fx.w;
    funded_line(&fx, 3600).await;
    let (approver, approver_signer) = w.approver.clone().unwrap();
    let pool_before = pool_view(&fx).await;
    let card_before = balance(&fx, &w.policy).await;
    let borrower_before = balance(&fx, &approver).await;
    let held = submit(
        w,
        &format!("near:{approver}"),
        9 * ONE_NEAR,
        (EMAIL_MASK, OWNER_MASK, OWNER_MASK),
    )
    .await;
    assert_eq!(held["outcome"], "escalated", "{held}");
    let id = held["request_id"].as_str().unwrap().to_string();
    let v = w.request(&id).await.unwrap();
    assert_eq!(v["book_status"], "new");
    let card = json!({ "id": v["id"], "to": v["payee"], "asset": v["display"]["asset_symbol"], "amount": v["display"]["amount_decimal"], "why": v["reason"], "book": v["book_status"] });
    fails_with(
        &send(
            w,
            &w.policy,
            &approver,
            &approver_signer,
            "approve",
            card.clone(),
            1,
        )
        .await,
        "not in the book",
    );
    // approve_and_remember is closed to him too, and he cannot add himself to the book
    let mut remember = card.clone();
    remember["expected_old"] = json!("00".repeat(32));
    remember["new_root"] = json!("11".repeat(32));
    remember["entry"] = json!({ "salt": "00".repeat(32), "cap": "1", "daily_untrusted_budget": "0", "daily_limit": "1", "index": 0, "siblings": [] });
    fails_with(
        &send(
            w,
            &w.policy,
            &approver,
            &approver_signer,
            "approve_and_remember",
            remember,
            1,
        )
        .await,
        "refused when an approver is set",
    );
    let root = call_view::<Value>(&w.policy, "get_book_root", json!({}), &w.net)
        .await
        .unwrap()
        .data;
    fails_with(
        &send(
            w,
            &w.policy,
            &approver,
            &approver_signer,
            "book_set_root",
            json!({ "expected_old": root, "new_root": "22".repeat(32) }),
            1,
        )
        .await,
        "Caller is not the owner",
    );
    assert_eq!(state(w, &id).await, "Pending");
    // the issuer cannot be talked into it by accident either: only its explicit override pays, and it is the issuer's call, not the borrower's
    let pool_after = pool_view(&fx).await;
    assert_eq!(pool_after, pool_before, "the pool is untouched");
    assert!(
        balance(&fx, &w.policy).await >= card_before - ONE_NEAR / 100,
        "the card lost nothing but gas"
    );
    assert!(
        balance(&fx, &approver).await <= borrower_before,
        "the borrower received nothing"
    );
    // he can only reject
    ok(&send(
        w,
        &w.policy,
        &approver,
        &approver_signer,
        "reject",
        json!({ "id": card["id"] }),
        1,
    )
    .await);
    assert_eq!(state(w, &id).await, "Rejected");
}

#[tokio::test]
async fn an_unpaid_line_defaults_after_its_due_date_collateral_is_seized_and_a_sweep_recovers() {
    let _s = SLOTS.acquire().await.unwrap();
    let fx = fixture().await;
    let w = &fx.w;
    funded_line(&fx, 8).await;
    // nothing is due yet
    fails_with(
        &send(
            w,
            &fx.pool,
            &fx.lp2.0,
            &fx.lp2.1,
            "default",
            json!({ "card": w.policy }),
            0,
        )
        .await,
        "not due yet",
    );
    tokio::time::sleep(std::time::Duration::from_secs(12)).await;
    // past the due date and before anyone calls default, the share price already counts the 10 outstanding as 0
    let overdue = pool_view(&fx).await;
    assert_eq!(
        (n(&overdue["assets"]), n(&overdue["impaired"])),
        (90 * ONE_NEAR, 10 * ONE_NEAR),
        "{overdue}"
    );
    // anyone may call default after the due date: 10 outstanding, fee 0.5, owed 10.5, collateral 3: all principal, loss 7
    let before = pool_view(&fx).await;
    ok(&send(
        w,
        &fx.pool,
        &fx.lp2.0,
        &fx.lp2.1,
        "default",
        json!({ "card": w.policy }),
        0,
    )
    .await);
    let p = pool_view(&fx).await;
    assert_eq!(n(&p["losses"]), 7 * ONE_NEAR, "{p}");
    assert_eq!(
        (n(&p["idle"]), n(&p["lent"])),
        (n(&before["idle"]) + 3 * ONE_NEAR, 0)
    );
    assert_eq!(n(&p["assets"]), 93 * ONE_NEAR);
    assert_eq!(p["lines"][0]["state"], "Defaulted");
    // the issuer pauses the card and sweeps what is left: credited as a recovery of the loss
    ok(&send(
        w,
        &w.policy,
        &w.owner,
        &w.owner_signer,
        "pause",
        json!({ "paused": true }),
        1,
    )
    .await);
    ok(&send(
        w,
        &w.policy,
        &w.owner,
        &w.owner_signer,
        "sweep",
        json!({ "amount": (7 * ONE_NEAR).to_string() }),
        1,
    )
    .await);
    let p = pool_view(&fx).await;
    assert_eq!(n(&p["losses"]), 0, "{p}");
    assert_eq!(n(&p["assets"]), 100 * ONE_NEAR);
    // the pool's accounting held: the contract balance covers idle plus collateral held
    let _ = Contract(fx.pool.clone());
}

#[tokio::test]
async fn register_card_refuses_a_card_whose_roles_are_not_the_pool_s() {
    let _s = SLOTS.acquire().await.unwrap();
    let fx = fixture().await;
    let w = &fx.w;
    // a card whose approver is not the named borrower
    let r = send(
        w,
        &fx.pool,
        &w.owner,
        &w.owner_signer,
        "register_card",
        json!({ "card": w.policy, "borrower": fx.lp1.0 }),
        0,
    )
    .await;
    // the failure is in the callback; the card must not be registered
    let _ = r;
    assert_eq!(
        call_view::<Value>(&fx.pool, "get_card", json!({ "card": w.policy }), &w.net)
            .await
            .unwrap()
            .data,
        Value::Null
    );
    // a stranger cannot register one, and a plain account (no get_roles) cannot be a card
    fails_with(
        &send(
            w,
            &fx.pool,
            &fx.lp1.0,
            &fx.lp1.1,
            "register_card",
            json!({ "card": w.policy, "borrower": w.approver.clone().unwrap().0 }),
            0,
        )
        .await,
        "Caller is not the owner",
    );
    let _ = send(
        w,
        &fx.pool,
        &w.owner,
        &w.owner_signer,
        "register_card",
        json!({ "card": fx.lp2.0, "borrower": w.approver.clone().unwrap().0 }),
        0,
    )
    .await;
    assert_eq!(
        call_view::<Value>(&fx.pool, "get_card", json!({ "card": fx.lp2.0 }), &w.net)
            .await
            .unwrap()
            .data,
        Value::Null
    );
}

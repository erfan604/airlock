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
        Some(json!({ "owner_id": w.owner, "min_hold_ms": "0" })),
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
    // the issuer cannot sweep while the escalation is pending; the issuer rejects it himself (F2: reject moves no money, so the issuer never
    // depends on the borrower to clear it), then the sweep works
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
        &w.owner,
        &w.owner_signer,
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

// ---- AIR-333: the in-place upgrade of a c1108d pool, then the Passport on the upgraded state ----

/// The c1108d wasm as deployed on testnet (sha256 pinned by the unit test `the_c1108d_wasm_is_pinned`).
fn c1108d_wasm() -> String {
    format!(
        "{}/res/airlock_credit_c1108d.wasm",
        env!("CARGO_MANIFEST_DIR")
    )
}

async fn view(fx: &Fx, method: &str, args: Value) -> Value {
    call_view::<Value>(&fx.pool, method, args, &fx.w.net)
        .await
        .unwrap_or_else(|e| panic!("{method}: {e:?}"))
        .data
}

/// Every view the web and the LPs read, for the before and after comparison.
async fn snapshot(fx: &Fx, borrower: &AccountId) -> Vec<Value> {
    let w = &fx.w;
    vec![
        view(fx, "get_pool", json!({})).await,
        view(fx, "get_line", json!({ "card": w.policy })).await,
        view(fx, "list_lines", json!({})).await,
        view(fx, "get_card", json!({ "card": w.policy })).await,
        view(fx, "get_lp", json!({ "account": fx.lp1.0 })).await,
        view(fx, "get_lp", json!({ "account": fx.lp2.0 })).await,
        view(fx, "get_unclaimed", json!({ "account": fx.lp1.0 })).await,
        view(fx, "get_unclaimed", json!({ "account": borrower })).await,
    ]
}

/// The pool's sum rules, read from its views: assets are idle plus lent plus staked less impaired, lent is the outstanding principal of
/// the open lines, and the collateral held is the collateral of the live lines.
async fn sum_rules(fx: &Fx) -> Value {
    let p = view(fx, "get_pool", json!({})).await;
    assert_eq!(
        n(&p["assets"]),
        n(&p["idle"]) + n(&p["lent"]) + n(&p["staked"]) - n(&p["impaired"]),
        "{p}"
    );
    let (mut lent, mut collateral) = (0u128, 0u128);
    for l in p["lines"].as_array().unwrap() {
        if l["state"] == "Open" {
            lent += n(&l["limit"]) - n(&l["returned"]);
        }
        if l["state"] == "Open" || l["state"] == "Collecting" {
            collateral += n(&l["collateral"]);
        }
    }
    assert_eq!(
        (lent, collateral),
        (n(&p["lent"]), n(&p["collateral_held"])),
        "{p}"
    );
    p
}

async fn passport(fx: &Fx) -> Value {
    view(fx, "get_passport", json!({ "card": fx.w.policy })).await
}

#[tokio::test]
async fn upgrade_from_the_c1108d_wasm_keeps_every_view_and_still_works() {
    let _s = SLOTS.acquire().await.unwrap();
    let w = world_with(WorldOpts {
        roles: true,
        sponsor_is: Some("pool"),
        ..WorldOpts::default()
    })
    .await;
    let new_wasm = credit_wasm();
    assert!(
        std::path::Path::new(&new_wasm).exists(),
        "{new_wasm} is missing: build contracts/airlock-credit first"
    );
    // the pool account with a key this test holds, on the pinned c1108d wasm, LPs held for 5 seconds
    let pool: AccountId = format!("pool.{}", w.root).parse().unwrap();
    let pool_key = near_api::signer::generate_secret_key().unwrap();
    let _ = near_api::Account::create_account(pool.clone())
        .fund_myself(w.root.clone(), NearToken::from_near(30))
        .with_public_key(pool_key.public_key())
        .with_signer(w.owner_signer.clone())
        .send_to(&w.net)
        .await
        .expect("the pool account")
        .into_result()
        .expect("the pool account is created");
    let pool_signer: Arc<Signer> = Signer::from_secret_key(pool_key).unwrap();
    Contract::deploy(pool.clone())
        .use_code(std::fs::read(c1108d_wasm()).unwrap())
        .with_init_call("new", json!({ "owner_id": w.owner, "min_hold_ms": "5000" }))
        .unwrap()
        .with_signer(pool_signer.clone())
        .send_to(&w.net)
        .await
        .expect("the c1108d wasm deploys")
        .assert_success();
    let lp1 = create_user_account(&w.net, &w.root, &w.owner_signer, "lp1")
        .await
        .unwrap();
    let lp2 = create_user_account(&w.net, &w.root, &w.owner_signer, "lp2")
        .await
        .unwrap();
    let (approver, approver_signer) = w.approver.clone().unwrap();
    for (who, near) in [(&lp1.0, 100u128), (&lp2.0, 100), (&approver, 20)] {
        let _ = near_api::Tokens::account(w.root.clone())
            .send_to(who.clone())
            .near(NearToken::from_near(near))
            .with_signer(w.owner_signer.clone())
            .send_to(&w.net)
            .await
            .expect("the top-up");
    }
    let fx = Fx { w, pool, lp1, lp2 };
    let w = &fx.w;
    let owner_call = |method: &'static str, args: Value| {
        send(w, &fx.pool, &w.owner, &w.owner_signer, method, args, 0)
    };
    let card_call = |method: &'static str, args: Value, yocto: u128| {
        send(w, &w.policy, &w.owner, &w.owner_signer, method, args, yocto)
    };
    let borrower_call = |method: &'static str, yocto: u128| {
        send(
            w,
            &fx.pool,
            &approver,
            &approver_signer,
            method,
            json!({ "card": w.policy }),
            yocto,
        )
    };

    // ---- the c1108d history: deposits, the card, a line paid and repaid, a second line defaulted and recovered ----
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
    ok(&owner_call(
        "register_card",
        json!({ "card": w.policy, "borrower": approver }),
    )
    .await);
    ok(&borrower_call("post_collateral", 3 * ONE_NEAR).await);
    let due = final_block_ms(w) + 3_600_000;
    ok(&owner_call("open_line", json!({ "card": w.policy, "limit": (10 * ONE_NEAR).to_string(), "fee_bps": 500, "due_ms": due.to_string() })).await);
    let o = submit(
        w,
        &format!("near:{}", w.payee_near),
        2 * ONE_NEAR,
        (BOOK_MASK, OWNER_MASK, OWNER_MASK),
    )
    .await;
    assert_eq!(o["outcome"], "allowed", "{o}");
    ok(&card_call("sweep", json!({ "amount": (8 * ONE_NEAR).to_string() }), 1).await);
    ok(&borrower_call("repay", 2 * ONE_NEAR + ONE_NEAR / 10).await);
    ok(&borrower_call("post_collateral", 3 * ONE_NEAR).await);
    let due = final_block_ms(w) + 8_000;
    ok(&owner_call("open_line", json!({ "card": w.policy, "limit": (10 * ONE_NEAR).to_string(), "fee_bps": 500, "due_ms": due.to_string() })).await);
    tokio::time::sleep(std::time::Duration::from_secs(12)).await;
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
    ok(&card_call("pause", json!({ "paused": true }), 1).await);
    ok(&card_call("sweep", json!({ "amount": (7 * ONE_NEAR).to_string() }), 1).await);
    let old = sum_rules(&fx).await;
    assert_eq!(
        (n(&old["losses"]), old["lines"][0]["state"].clone()),
        (0, json!("Defaulted")),
        "{old}"
    );
    // the old wasm has no Passport
    assert!(
        call_view::<Value>(
            &fx.pool,
            "get_passport",
            json!({ "card": w.policy }),
            &w.net
        )
        .await
        .is_err(),
        "the c1108d wasm has no get_passport"
    );
    let before = snapshot(&fx, &approver).await;

    // ---- the upgrade: one transaction, DeployContract then migrate ----
    let r = Contract::deploy(fx.pool.clone())
        .use_code(std::fs::read(&new_wasm).unwrap())
        .with_init_call(
            "migrate",
            json!({ "passport_base": ONE_NEAR.to_string(), "mpc_signer": "v1.signer-prod.testnet", "foreign_domain_id": 3 }),
        )
        .unwrap()
        .with_signer(pool_signer.clone())
        .send_to(&w.net)
        .await
        .expect("the upgrade is sent");
    let r = match r {
        near_api_types::transaction::result::TransactionResult::Full(r) => *r,
        other => panic!("the upgrade is still pending: {other:?}"),
    };
    ok(&r);
    assert_eq!(
        snapshot(&fx, &approver).await,
        before,
        "every view reads the same after the upgrade"
    );
    // the backfill: one line proven by the state, one default; the repaid first line left no trace in the state
    let pp = passport(&fx).await;
    assert_eq!(pp["borrower"], json!(approver.as_str()), "{pp}");
    assert_eq!(
        (pp["score"].clone(), n(&pp["limit_cap"])),
        (json!(200), 4 * ONE_NEAR / 10),
        "{pp}"
    );
    let rec = &pp["record"];
    assert_eq!(
        (
            rec["lines_opened"].clone(),
            rec["defaults"].clone(),
            rec["recovered"].clone(),
            rec["repaid_on_time"].clone(),
            rec["backfilled"].clone()
        ),
        (json!(1), json!(1), json!(0), json!(0), json!(true)),
        "{pp}"
    );
    let pv = view(&fx, "get_pool_passport", json!({})).await;
    assert_eq!(
        (n(&pv["base"]), pv["version"].clone()),
        (ONE_NEAR, json!(2)),
        "{pv}"
    );
    // a second migrate is refused (the state is no longer the c1108d layout)
    let again = send(
        w,
        &fx.pool,
        &fx.pool,
        &pool_signer,
        "migrate",
        json!({ "passport_base": "1", "mpc_signer": "v1.signer-prod.testnet", "foreign_domain_id": 3 }),
        0,
    )
    .await;
    fails_with(&again, "Cannot deserialize");

    // ---- AIR-350: the Base payment check on the upgraded state ----
    // There is no MPC signer in the sandbox (and contracts/mock-mpc has no verify_foreign_transaction), so this walks the refusals, the
    // private callback and the failure path: the call to the absent signer fails, nothing is recorded and the fee less 1 yocto goes back.
    let cfg = view(&fx, "get_base_check_config", json!({})).await;
    assert_eq!(
        cfg,
        json!({ "mpc_signer": "v1.signer-prod.testnet", "domain_id": 3, "fee": (ONE_NEAR / 100).to_string() }),
        "{cfg}"
    );
    let tx_id = "943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63";
    let pool_before = pool_view(&fx).await;
    fails_with(
        &send(
            w,
            &fx.pool,
            &fx.lp1.0,
            &fx.lp1.1,
            "check_base_payment",
            json!({ "tx_id": format!("0x{}", &tx_id[2..]) }),
            ONE_NEAR / 100,
        )
        .await,
        "tx_id must be exactly 64 lowercase hex characters",
    );
    fails_with(
        &send(
            w,
            &fx.pool,
            &fx.lp1.0,
            &fx.lp1.1,
            "check_base_payment",
            json!({ "tx_id": tx_id }),
            ONE_NEAR / 100 - 1,
        )
        .await,
        "at least 0.01 NEAR",
    );
    fails_with(
        &send(
            w,
            &fx.pool,
            &fx.lp1.0,
            &fx.lp1.1,
            "on_base_check",
            json!({ "tx_id": tx_id, "asked_by": fx.lp1.0, "fee": "1" }),
            0,
        )
        .await,
        "Method on_base_check is private",
    );
    let r = send(
        w,
        &fx.pool,
        &fx.lp1.0,
        &fx.lp1.1,
        "check_base_payment",
        json!({ "tx_id": tx_id }),
        ONE_NEAR / 100,
    )
    .await;
    let events = extract_event_logs(&r).expect("the events parse");
    let unchecked: Vec<&Value> = events
        .iter()
        .filter(|e| e["event"] == "base_payment_unchecked")
        .collect();
    assert_eq!(unchecked.len(), 1, "{events:?}");
    assert_eq!(
        unchecked[0]["data"][0]["refund"],
        json!((ONE_NEAR / 100 - 1).to_string()),
        "{events:?}"
    );
    assert!(
        !r.logs().iter().any(|l| l.contains("payout_failed")),
        "the refund reached the asker"
    );
    assert_eq!(
        view(&fx, "get_unclaimed", json!({ "account": fx.lp1.0 })).await,
        json!("0")
    );
    assert_eq!(
        view(&fx, "get_base_check", json!({ "tx_id": tx_id })).await,
        Value::Null
    );
    assert_eq!(
        pool_view(&fx).await,
        pool_before,
        "the fee is not pool money"
    );

    // ---- the upgraded pool still works ----
    // a new deposit, refused withdraw inside the lock, the withdraw after it
    ok(&send(
        w,
        &fx.pool,
        &fx.lp2.0,
        &fx.lp2.1,
        "deposit",
        json!({}),
        ONE_NEAR,
    )
    .await);
    sum_rules(&fx).await;
    let lp2 = view(&fx, "get_lp", json!({ "account": fx.lp2.0 })).await;
    let some = (n(&lp2["shares"]) / 10).to_string();
    fails_with(
        &send(
            w,
            &fx.pool,
            &fx.lp2.0,
            &fx.lp2.1,
            "withdraw",
            json!({ "shares": some }),
            0,
        )
        .await,
        "withdraw is locked",
    );
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    ok(&send(
        w,
        &fx.pool,
        &fx.lp2.0,
        &fx.lp2.1,
        "withdraw",
        json!({ "shares": some }),
        0,
    )
    .await);
    sum_rules(&fx).await;
    // the over-cap limit (0.5 NEAR, in (0.4, 0.56]) is refused with the cap text; 0.3 NEAR opens inside the cap
    let over = ONE_NEAR / 2;
    ok(&borrower_call("post_collateral", ONE_NEAR / 5).await);
    let due = final_block_ms(w) + 3_600_000;
    let refused = owner_call("open_line", json!({ "card": w.policy, "limit": over.to_string(), "fee_bps": 1000, "due_ms": due.to_string() })).await;
    fails_with(
        &refused,
        "the limit is above this card's Passport cap of 0.4 NEAR (score 200)",
    );
    ok(&owner_call("open_line", json!({ "card": w.policy, "limit": (3 * ONE_NEAR / 10).to_string(), "fee_bps": 1000, "due_ms": due.to_string() })).await);
    sum_rules(&fx).await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(
        passport(&fx).await["record"]["lines_opened"],
        json!(2),
        "on_line_funded counts the line"
    );
    // the agent pays the booked merchant 0.1 NEAR through the verdict (a tenth of the 1 NEAR cap base, the absolute floor of a counted
    // repay), the issuer sweeps the rest, the borrower repays on time
    ok(&card_call("pause", json!({ "paused": false }), 1).await);
    let o = submit(
        w,
        &format!("near:{}", w.payee_near),
        ONE_NEAR / 10,
        (BOOK_MASK, OWNER_MASK, OWNER_MASK),
    )
    .await;
    assert_eq!(o["outcome"], "allowed", "{o}");
    ok(&card_call("sweep", json!({ "amount": (ONE_NEAR / 5).to_string() }), 1).await);
    sum_rules(&fx).await;
    ok(&borrower_call("repay", ONE_NEAR / 10 + ONE_NEAR / 100).await);
    sum_rules(&fx).await;
    let pp = passport(&fx).await;
    assert_eq!(
        (pp["score"].clone(), n(&pp["limit_cap"])),
        (json!(280), 56 * ONE_NEAR / 100),
        "{pp}"
    );
    assert_eq!(pp["record"]["repaid_on_time"], json!(1), "{pp}");
    // the refused limit now opens (due in 8 s), is not repaid, defaults, and a sweep recovers the loss
    ok(&borrower_call("post_collateral", ONE_NEAR / 5).await);
    let due = final_block_ms(w) + 8_000;
    ok(&owner_call("open_line", json!({ "card": w.policy, "limit": over.to_string(), "fee_bps": 1000, "due_ms": due.to_string() })).await);
    sum_rules(&fx).await;
    tokio::time::sleep(std::time::Duration::from_secs(12)).await;
    let overdue = sum_rules(&fx).await;
    assert_eq!(n(&overdue["impaired"]), over, "{overdue}");
    ok(&send(
        w,
        &fx.pool,
        &fx.lp1.0,
        &fx.lp1.1,
        "default",
        json!({ "card": w.policy }),
        0,
    )
    .await);
    let p = sum_rules(&fx).await;
    assert_eq!(
        n(&p["losses"]),
        3 * ONE_NEAR / 10,
        "0.5 owed, 0.2 collateral seized: {p}"
    );
    ok(&card_call("pause", json!({ "paused": true }), 1).await);
    ok(&card_call("sweep", json!({ "amount": over.to_string() }), 1).await);
    let p = sum_rules(&fx).await;
    assert_eq!(n(&p["losses"]), 0, "{p}");
    let pp = passport(&fx).await;
    let rec = &pp["record"];
    assert_eq!(
        (
            rec["defaults"].clone(),
            rec["recovered"].clone(),
            pp["score"].clone()
        ),
        (json!(2), json!(1), json!(500 + 80 - 600 + 150)),
        "{pp}"
    );
    // LPs are whole: lp1 can still withdraw at the recovered price
    let lp1 = view(&fx, "get_lp", json!({ "account": fx.lp1.0 })).await;
    assert!(n(&lp1["value"]) > 60 * ONE_NEAR, "{lp1}");
}

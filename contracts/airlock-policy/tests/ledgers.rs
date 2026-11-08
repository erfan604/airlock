// AIR-067: the cumulative-authorization claims against the real contract (F05 section 5). Splitting a payment into small pieces does
// not get around the untrusted budget, a batch charges exactly what the same requests charge one by one, and the UTC day changes the
// ledgers at the exact millisecond. The two splitting tests and `batch_equals_sequential` run in the sandbox (the wasm must be built:
// `cargo near build non-reproducible-wasm --no-abi` in the crate first); the three day tests are in process (`inproc_contract`), because
// the sandbox clock is real time and cannot show two UTC days.
//
// F05 row "Approval charges" (an approved escalation reduces the asset daily and task remaining and leaves the untrusted budget alone)
// is implemented in AIR-080's tests/escalation.rs; it is listed here only so the F05 test table has one index.
//
// Run with `-- --test-threads=3` (each sandbox is a neard of several hundred MB).

mod common;

use airlock_policy::ledgers::{LedgerKey, caps_for};
use common::*;
use near_sdk::testing_env;
use serde_json::{Value, json};

const N: u128 = ONE_NEAR;

/// At most 3 sandboxes of this file run at once.
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

fn print_steps(steps: &[SplitStep]) {
    for (n, s) in steps.iter().enumerate() {
        println!(
            "SPLIT step={n} outcome={} untrusted_spent={}",
            s.outcome, s.untrusted_spent
        );
    }
}

fn check_split(steps: &[SplitStep], final_after_each_batch_only: bool) {
    assert_eq!(steps.len(), 11);
    for (n, s) in steps.iter().enumerate().take(10) {
        assert_eq!(s.outcome, "allowed", "step {n}");
        assert!(s.untrusted_spent <= 10 * U, "step {n} exceeded the budget");
        if !final_after_each_batch_only {
            assert_eq!(s.untrusted_spent, (n as u128 + 1) * U, "step {n}");
        }
    }
    assert_eq!(steps[10].outcome, "escalated UntrustedAmount");
    // an escalation never charges the untrusted ledger: the budget stays full, never above
    assert_eq!(steps[10].untrusted_spent, 10 * U);
    assert!(steps.iter().all(|s| s.untrusted_spent <= 10 * U));
}

#[tokio::test]
async fn splitting_attack() {
    let _slot = slot().await;
    let w = world().await;
    let steps = split_attack(&w, &[1; 11]).await;
    print_steps(&steps);
    check_split(&steps, false);
}

#[tokio::test]
async fn splitting_attack_inside_batches() {
    let _slot = slot().await;
    let w = world().await;
    let steps = split_attack(&w, &[3, 3, 3, 2]).await;
    print_steps(&steps);
    // the charge between requests of one batch (R3-02): the eleventh is refused although the batch started below the budget
    check_split(&steps, true);
    assert_eq!(steps[8].untrusted_spent, 9 * U);
    assert_eq!(steps[9].outcome, "allowed");
}

fn get_ledgers_task(w: &World, task_hash_hex: &str) -> impl std::future::Future<Output = Value> {
    let (policy, net, hash) = (w.policy.clone(), w.net.clone(), task_hash_hex.to_string());
    async move {
        call_view::<Value>(
            &policy,
            "get_ledgers",
            json!({ "payee": "near:alice.sandbox", "asset": "near", "task": hash }),
            &net,
        )
        .await
        .unwrap_or_else(|e| panic!("get_ledgers must answer: {e:?}"))
        .data
    }
}

fn amount(v: &Value, ledger: &str) -> u128 {
    v[ledger]["spent"]
        .as_str()
        .unwrap_or_else(|| panic!("no {ledger} spent in {v}"))
        .parse()
        .unwrap()
}

fn task_spent(v: &Value) -> u128 {
    v["task_spent"]
        .as_str()
        .unwrap_or_else(|| panic!("no task_spent in {v}"))
        .parse()
        .unwrap()
}

#[tokio::test]
async fn batch_equals_sequential() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 300_000).await;
    // four pending escalations remain after the two runs: the default cap of 3 would block the last one
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": 10,
            "pending_ttl_ms": "86400000",
            "hourly_escalation_budget": 100,
            "lock_consecutive_rejects": 3,
            "lock_rejects_per_day": 20,
            "max_task_ttl_ms": "3600000",
            "max_task_actions": 20
        } }),
    )
    .await;
    let ta = w.signed_task(&[("near:alice.sandbox", 500 * U)], 3);
    // the same bound and max_actions, another task_id (the same task cannot be run twice, and one task has one task ledger)
    let (policy, agent): (near_sdk::AccountId, near_sdk::AccountId) = (
        w.policy.as_str().parse().unwrap(),
        w.agent.as_str().parse().unwrap(),
    );
    let tb = signed_task_with(&[("near:alice.sandbox", 500 * U)], 3, |t| {
        t.contract_id = policy;
        t.agent_id = agent;
        t.task_id = "task-2".to_string();
    });
    assert_ne!(ta.0.task_id, tb.0.task_id, "the two runs need two tasks");
    let ha = hex::encode(airlock_policy::task::task_hash(&ta.0));
    let hb = hex::encode(airlock_policy::task::task_hash(&tb.0));
    let req = |t: &(airlock_policy::task::OwnerTask, _), i: u8| {
        w.request_json(
            &t.0,
            i,
            "near",
            "near:alice.sandbox",
            500 * U,
            (2, 1, 1),
            None,
        )
    };
    async fn outcomes_of(
        r: near_api_types::transaction::result::ExecutionFinalResult,
    ) -> Vec<String> {
        let text = failure_text(&r);
        assert!(text.is_empty(), "submit_batch failed: {text}");
        let v: Value = r.json().expect("the outcomes parse");
        v.as_array()
            .unwrap()
            .iter()
            .map(|o| match o["reason"].as_str() {
                Some(r) if o["outcome"] != "allowed" => {
                    format!("{} {r}", o["outcome"].as_str().unwrap())
                }
                _ => o["outcome"].as_str().unwrap().to_string(),
            })
            .collect()
    }

    let before = get_ledgers_task(&w, &ha).await;
    let out_a = outcomes_of(
        w.submit(vec![req(&ta, 0), req(&ta, 1), req(&ta, 2)], &ta)
            .await,
    )
    .await;
    let mid = get_ledgers_task(&w, &ha).await;
    let mid_b = get_ledgers_task(&w, &hb).await;
    let mut out_b = Vec::new();
    for i in 0..3u8 {
        out_b.extend(outcomes_of(w.submit(vec![req(&tb, i)], &tb).await).await);
    }
    let after = get_ledgers_task(&w, &hb).await;

    let expected = vec![
        "allowed",
        "escalated OverTaskBound",
        "escalated OverTaskBound",
    ];
    assert_eq!(out_a, expected);
    assert_eq!(out_b, expected);
    assert_eq!(out_a, out_b);
    for ledger in ["asset_day", "payee_day", "payee_untrusted_day"] {
        let da = amount(&mid, ledger) - amount(&before, ledger);
        let db = amount(&after, ledger) - amount(&mid_b, ledger);
        assert_eq!(da, db, "{ledger}: batch {da} vs sequential {db}");
        let want = if ledger == "payee_untrusted_day" {
            0
        } else {
            500 * U
        };
        assert_eq!(da, want, "{ledger}");
    }
    assert_eq!(task_spent(&mid), 500 * U);
    assert_eq!(task_spent(&after), 500 * U);
    assert_eq!(task_spent(&mid), task_spent(&after));
}

// ---- day boundary, in process -------------------------------------------------------------------------------------

const PAYEE: &str = "near:alice.test.near";
const DAY: u64 = 86_400_000;

fn key() -> LedgerKey {
    LedgerKey {
        asset: "near".to_string(),
        payee: PAYEE.to_string(),
        task_hash: [9; 32],
    }
}

fn ledgers_at(c: &airlock_policy::Contract, ms: u64) -> airlock_policy::ledgers::LedgersView {
    testing_env!(inproc_ctx("owner.test.near", ms, 0).build());
    c.get_ledgers(
        PAYEE.to_string(),
        "near".to_string(),
        Some("09".repeat(32)),
        Some(inproc_alice().1),
    )
}

fn caps(c: &airlock_policy::Contract) -> airlock_verdict::ledger::Caps {
    let asset = c.asset("near").expect("the asset exists");
    let payee = c
        .book_entry(PAYEE, Some(&inproc_alice().1))
        .expect("the payee exists");
    caps_for(&asset, &payee, 100_000 * N)
}

#[test]
fn day_boundary_asset_and_payee() {
    let mut c = inproc_contract();
    let caps = caps(&c);
    let last = T0 + DAY - 1;
    c.charge_allow(&key(), &caps, 1_000 * N, false, last);
    let v = ledgers_at(&c, last);
    assert_eq!(v.asset_day.spent.0, 1_000 * N);
    assert_eq!(v.payee_day.spent.0, 1_000 * N);
    // the next millisecond is a fresh day
    let v = ledgers_at(&c, T0 + DAY);
    assert_eq!(v.asset_day.spent.0, 0);
    assert_eq!(v.payee_day.spent.0, 0);
    c.charge_allow(&key(), &caps, 7 * N, false, T0 + DAY);
    let v = ledgers_at(&c, T0 + DAY);
    assert_eq!(v.asset_day.spent.0, 7 * N);
    assert_eq!(v.payee_day.spent.0, 7 * N);
    // the task ledger is not day-keyed
    assert_eq!(v.task_spent.expect("a task ledger").0, 1_007 * N);
}

#[test]
fn day_boundary_untrusted_budget() {
    let mut c = inproc_contract();
    let caps = caps(&c);
    let last = T0 + DAY - 1;
    c.charge_allow(&key(), &caps, 900 * N, true, last);
    let v = ledgers_at(&c, last);
    assert_eq!(v.payee_untrusted_day.spent.0, 900 * N);
    assert_eq!(v.payee_untrusted_day.remaining.0, 100 * N);
    let v = ledgers_at(&c, T0 + DAY);
    assert_eq!(v.payee_untrusted_day.spent.0, 0);
    assert_eq!(v.payee_untrusted_day.remaining.0, 1_000 * N);
}

#[test]
fn day_boundary_ignores_local_midnight() {
    let mut c = inproc_contract();
    let caps = caps(&c);
    // 07:00 UTC is midnight in Vancouver (PDT): one UTC day all the same
    c.charge_allow(&key(), &caps, 10 * N, false, T0 + 25_199_999);
    c.charge_allow(&key(), &caps, 10 * N, false, T0 + 25_200_000);
    let v = ledgers_at(&c, T0 + 25_200_000);
    assert_eq!(v.asset_day.spent.0, 20 * N);
}

// AIR-068: the plumbing classes of F13 as named contract tests. The three bug classes that won Pink's Overspend Challenge (a malformed
// currency treated as a known one, a UTC versus local hour, sub-cent rounding) and the overflow, JSON and vocabulary classes. The names
// are stable: `scripts/plumbing-index.sh` finds them with `cargo test --test plumbing -- --list` and docs/PLUMBING.md includes its output.
//
// Four tests run in the sandbox (the wasm must be built: `cargo near build non-reproducible-wasm --no-abi` in the crate first), three of
// them through the read-only `preview` view, which runs the same `evaluate` as `submit_batch` without charging. Three are in process or
// read files. Run with `-- --test-threads=4`.

mod common;

use airlock_policy::time::{utc_day, utc_hour};
use airlock_verdict::Reason;
use airlock_verdict::flood::{FloodLimits, FloodState, gate_escalation, on_approve};
use airlock_verdict::ledger::Caps;
use common::*;
use near_sdk::json_types::Base64VecU8;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const ALICE: &str = "near:alice.sandbox";
const OWNER_MASK: u16 = airlock_verdict::OWNER;
const BOOK_MASK: u16 = airlock_verdict::BOOK;
const EMAIL_MASK: u16 = airlock_verdict::labels::EMAIL;
const N: u128 = ONE_NEAR;

/// At most 4 sandboxes of this file run at once.
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

type Task = (airlock_policy::task::OwnerTask, Base64VecU8);

/// What `preview` answers for `req`: the outcome and the reason (`None` when the reason is null).
async fn preview(w: &World, task: &Task, req: Value) -> (String, Option<String>) {
    let answer = call_view::<Value>(
        &w.policy,
        "preview",
        json!({ "req": req, "task": task.0 }),
        &w.net,
    )
    .await
    .unwrap_or_else(|e| panic!("preview must answer: {e:?}"))
    .data;
    (
        answer["outcome"].as_str().expect("an outcome").to_string(),
        answer["reason"].as_str().map(str::to_string),
    )
}

fn expect(got: (String, Option<String>), outcome: &str, reason: Option<&str>) {
    assert_eq!(got.0, outcome, "outcome (reason {:?})", got.1);
    assert_eq!(got.1.as_deref(), reason, "reason of outcome {}", got.0);
}

/// A submit that must revert with `text`.
fn assert_reverts(result: &near_api_types::transaction::result::ExecutionFinalResult, text: &str) {
    let got = failure_text(result);
    assert!(
        !got.is_empty(),
        "the call must revert with `{text}`, but it succeeded"
    );
    assert!(got.contains(text), "expected `{text}` in: {got}");
}

#[tokio::test]
async fn pink_malformed_currency_is_not_priced() {
    let _slot = slot().await;
    let w = world().await;
    let entry = near_asset_entry(N);

    // (a) a malformed asset id never registers
    for bad in [
        "USD",
        "usdc ",
        " near",
        "ft:",
        "EVM:84532:native",
        "evm:84532:Native",
    ] {
        let result = call_transaction(
            &w.policy,
            "asset_set",
            json!({ "asset": bad, "entry": entry }),
            &w.owner,
            &w.owner_signer,
            &w.net,
            Some(near_api::NearToken::from_yoctonear(1)),
        )
        .await
        .unwrap_or_else(|e| panic!("asset_set({bad:?}) is not sent: {e}"));
        let got = failure_text(&result);
        result.assert_failure();
        assert!(
            got.contains("invalid asset id"),
            "asset_set({bad:?}): expected `invalid asset id` in: {got}"
        );
    }

    // (b) a request with a malformed asset reverts before any verdict
    let task = w.signed_task(&[(ALICE, 1_000 * N)], 3);
    for asset in ["USD", "usdc "] {
        let req = w.request_json(
            &task.0,
            0,
            asset,
            ALICE,
            N,
            (BOOK_MASK, OWNER_MASK, OWNER_MASK),
            None,
        );
        let result = w.submit(vec![req], &task).await;
        assert_reverts(&result, "asset does not match payee");
    }
    let ft = w.request_json(
        &task.0,
        0,
        "ft:usdc.near",
        ALICE,
        N,
        (BOOK_MASK, OWNER_MASK, OWNER_MASK),
        None,
    );
    let result = w.submit(vec![ft], &task).await;
    assert_reverts(&result, "lane not shipped");

    // (c) a well-formed asset that is not registered blocks
    let evm_payee = format!("evm:1:0x{}", "ab".repeat(20));
    // (the task binds only the NEAR payee: a bound on a payee of an unregistered asset reverts when the task is read)
    let evm_task = task.clone();
    let req = w.request_json(
        &evm_task.0,
        0,
        "evm:1:native",
        &evm_payee,
        1,
        (BOOK_MASK, OWNER_MASK, OWNER_MASK),
        Some((100_000, 2, 1)),
    );
    expect(
        preview(&w, &evm_task, req).await,
        "blocked",
        Some("UnknownAsset"),
    );

    // (d) there is no price lookup and no default currency anywhere in the sources
    assert_no_price_vocabulary();
}

/// The `.rs` files under `dir`, recursively.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {dir:?}: {e}")) {
        let path = entry.expect("a directory entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn src_dir(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

#[test]
fn pink_utc_not_local_hour() {
    assert_eq!(utc_hour(3_599_999), 0);
    assert_eq!(utc_hour(3_600_000), 1);
    assert_eq!(utc_day(86_399_999), 0);
    assert_eq!(utc_day(86_400_000), 1);

    // the UTC day does not change at 07:00 UTC, which is Vancouver midnight in PDT (T0 is a UTC midnight)
    assert_eq!(utc_day(T0 + 25_199_999), utc_day(T0 + 25_200_000));
    assert_eq!(utc_day(T0 + 25_200_000), utc_day(T0));

    // the hourly escalation budget follows the UTC hour at the exact millisecond
    let limits = FloodLimits {
        max_pending: 3,
        lock_consecutive: 3,
        lock_per_day: 20,
        hourly_budget: 1,
    };
    let first = gate_escalation(&FloodState::default(), &limits, utc_hour(T0 + 3_599_999))
        .expect("the first escalation of the hour is admitted");
    assert_eq!(
        gate_escalation(&first, &limits, utc_hour(T0 + 3_599_999)),
        Err(Reason::EscalationBudget),
        "a second escalation in the same UTC hour is over the budget"
    );
    let released = on_approve(&first);
    assert!(
        gate_escalation(&released, &limits, utc_hour(T0 + 3_600_000)).is_ok(),
        "the next UTC hour starts at the exact millisecond"
    );
}

#[tokio::test]
async fn pink_sub_unit_amounts() {
    let _slot = slot().await;
    let w = world().await;
    let task = w.signed_task(&[(ALICE, 20_000 * N)], 3);
    let req = |amount: u128, amount_label: u16| {
        w.request_json(
            &task.0,
            0,
            "near",
            ALICE,
            amount,
            (BOOK_MASK, amount_label, OWNER_MASK),
            None,
        )
    };
    let hard_cap = 10_000 * N;
    let payee_cap = 100 * N;

    // one yocto is a real amount; zero is not
    expect(
        preview(&w, &task, req(1, OWNER_MASK)).await,
        "allowed",
        None,
    );
    expect(
        preview(&w, &task, req(0, OWNER_MASK)).await,
        "blocked",
        Some("AmountOutOfBounds"),
    );

    // the hard cap is inclusive: exactly the cap is not blocked (the payee's daily limit of 5,000 NEAR escalates it), one yocto more is
    expect(
        preview(&w, &task, req(hard_cap, OWNER_MASK)).await,
        "escalated",
        Some("OverPayeeLimit"),
    );
    expect(
        preview(&w, &task, req(hard_cap + 1, OWNER_MASK)).await,
        "blocked",
        Some("AmountOutOfBounds"),
    );

    // the payee cap is inclusive for an amount read from untrusted text
    expect(
        preview(&w, &task, req(payee_cap, EMAIL_MASK)).await,
        "allowed",
        None,
    );
    expect(
        preview(&w, &task, req(payee_cap + 1, EMAIL_MASK)).await,
        "escalated",
        Some("UntrustedAmount"),
    );
}

#[test]
#[should_panic(expected = "ledger overflow")]
fn overflow_reverts() {
    use airlock_policy::ledgers::LedgerKey;
    let mut c = inproc_contract();
    let key = LedgerKey {
        asset: "near".to_string(),
        payee: "near:alice.test.near".to_string(),
        task_hash: [7; 32],
    };
    let caps = Caps {
        asset_daily: u128::MAX,
        payee_limit: u128::MAX,
        payee_budget: u128::MAX,
        task_bound: u128::MAX,
    };
    c.charge_allow(&key, &caps, u128::MAX - 1, false, T0);
    // the first charge reached all three ledgers a trusted amount touches, so the failure below is the second charge's
    let held = c.spent_now(&key, T0);
    assert_eq!(held.asset_day, u128::MAX - 1, "asset day ledger");
    assert_eq!(held.payee_day, u128::MAX - 1, "payee day ledger");
    assert_eq!(held.task, u128::MAX - 1, "task ledger");
    c.charge_allow(&key, &caps, 2, false, T0);
}

#[tokio::test]
async fn big_amounts_survive_json() {
    let _slot = slot().await;
    let w = world().await;
    let big: u128 = 9_007_199_254_740_993; // 2^53 + 1
    let task = w.signed_task(&[(ALICE, 20_000 * N)], 3);
    let labels = (BOOK_MASK, OWNER_MASK, OWNER_MASK);
    let allowed = w.request_json(&task.0, 0, "near", ALICE, big, labels, None);
    let too_big = w.request_json(&task.0, 1, "near", ALICE, u128::MAX, labels, None);

    let result = w.submit(vec![allowed.clone(), too_big], &task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    let outs: Value = result.json().expect("the outcomes parse");
    let outs = outs.as_array().expect("an array of outcomes");
    assert_eq!(outs.len(), 2, "{outs:?}");
    assert_eq!(outs[0]["outcome"], "allowed", "{outs:?}");
    assert_eq!(outs[1]["outcome"], "blocked", "{outs:?}");
    assert_eq!(outs[1]["reason"], "AmountOutOfBounds", "{outs:?}");

    // the amount comes back exactly, as a decimal string
    let id = outs[0]["request_id"].as_str().expect("a request id");
    let record = w.request(id).await.expect("the request is stored");
    assert_eq!(record["amount"], "9007199254740993", "{record}");

    // the same amount as a JSON number is refused when the input is parsed (raw bytes: the text is sent as written)
    let args = json!({ "reqs": [allowed], "task": task.0, "task_sig": task.1 });
    let text = serde_json::to_string(&args).expect("the arguments serialize");
    let as_number = text.replace(
        "\"amount\":\"9007199254740993\"",
        "\"amount\":9007199254740993",
    );
    assert_ne!(as_number, text, "the amount was turned into a number");
    let result = call_transaction_raw(
        &w.policy,
        "submit_batch",
        as_number.into_bytes(),
        &w.agent,
        &w.agent_signer,
        &w.net,
    )
    .await
    .expect("the raw call is sent");
    assert_reverts(&result, "Failed to deserialize input from JSON");
}

#[test]
fn no_time_zone_strings() {
    let mut files = Vec::new();
    rust_files(&src_dir("src"), &mut files);
    assert!(
        files.len() >= 10,
        "the contract sources were found: {files:?}"
    );
    for file in files {
        let text = std::fs::read_to_string(&file)
            .unwrap_or_else(|e| panic!("read {file:?}: {e}"))
            .to_lowercase();
        for word in [
            "timezone",
            "chrono",
            "local_time",
            "vancouver",
            "utc_offset",
        ] {
            assert!(!text.contains(word), "{file:?} contains `{word}`");
        }
    }
}

/// Class 1 (d): the contract has no price lookup and no default currency. The words are banned in `src` of the contract and of the
/// verdict model, comments included, as whole words (letters, digits and underscore make a word).
fn assert_no_price_vocabulary() {
    let mut files = Vec::new();
    rust_files(&src_dir("src"), &mut files);
    rust_files(&src_dir("../airlock-verdict/src"), &mut files);
    assert!(files.len() >= 15, "the sources were found: {files:?}");
    let banned = [
        "price",
        "prices",
        "pricing",
        "exchange_rate",
        "default_currency",
        "fiat",
    ];
    for file in files {
        let text = std::fs::read_to_string(&file)
            .unwrap_or_else(|e| panic!("read {file:?}: {e}"))
            .to_lowercase();
        for word in text.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
            assert!(
                !banned.contains(&word),
                "{file:?} contains the word `{word}`"
            );
        }
    }
}

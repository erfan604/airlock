// AIR-040: the owner plane. Every owner method demands exactly 1 yoctoNEAR and the owner as caller, so a leaked
// function-call key (which cannot attach a deposit) can never edit policy.
//
// The table has four methods and three callers each (12 rows, one sandbox test per row): the owner with 1 yocto succeeds,
// the owner with no deposit fails with the 1 yocto text, a stranger with 1 yocto fails with the owner text. Every failure
// assertion checks the text, because a missing method also fails and would pass a bare `assert_failure()`.

mod common;

use common::*;
use near_api::{AccountId, Data, NearToken, NetworkConfig, Signer};
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};
use std::sync::Arc;

type Res = Result<(), Box<dyn std::error::Error + Send + Sync>>;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const ONE_YOCTO_TEXT: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
const NOT_OWNER_TEXT: &str = "Caller is not the owner";

/// At most this many sandboxes run at once. Each of the 18 tests starts one neard; with all 18 at once on a busy machine the
/// RPC answers 408 to the deploy and the helper gives up (seen while two other lanes were building).
const MAX_SANDBOXES: usize = 3;
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(MAX_SANDBOXES);

/// A sandbox with the contract deployed (`requires_tee = false`, default measurements and PPID approved), the genesis account
/// as owner and a second account as the stranger.
struct World {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    owner: AccountId,
    owner_signer: Arc<Signer>,
    stranger: AccountId,
    stranger_signer: Arc<Signer>,
    contract: AccountId,
    // last field: dropped after the sandbox, so the next test starts when this neard is gone
    _slot: tokio::sync::SemaphorePermit<'static>,
}

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

async fn world() -> Result<World, Box<dyn std::error::Error + Send + Sync>> {
    let slot = slot().await;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = create_network_config(&sandbox);
    let (owner, owner_signer) = setup_genesis_account().await;
    let contract = deploy_contract_default(&net, &owner, &owner_signer).await?;
    let (stranger, stranger_signer) =
        create_user_account(&net, &owner, &owner_signer, "stranger").await?;
    Ok(World {
        _sandbox: sandbox,
        net,
        owner,
        owner_signer,
        stranger,
        stranger_signer,
        contract,
        _slot: slot,
    })
}

impl World {
    async fn view<T: serde::de::DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: Value,
    ) -> Result<T, Box<dyn std::error::Error + Send + Sync>> {
        let data: Data<T> = call_view(&self.contract, method, args, &self.net).await?;
        Ok(data.data)
    }

    async fn policy(&self) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        self.view("get_policy", json!({})).await
    }

    async fn owner_call(
        &self,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult, Box<dyn std::error::Error + Send + Sync>> {
        call_transaction(
            &self.contract,
            method,
            args,
            &self.owner,
            &self.owner_signer,
            &self.net,
            Some(deposit),
        )
        .await
    }
}

/// The defaults of `get_policy().flags` as JSON (U64 fields are strings).
fn default_flags() -> Value {
    json!({
        "max_pending_per_agent": 3,
        "pending_ttl_ms": "3600000",
        "hourly_escalation_budget": 6,
        "lock_consecutive_rejects": 3,
        "lock_rejects_per_day": 20,
        "max_task_ttl_ms": "3600000",
        "max_task_actions": 20
    })
}

/// The defaults with one field replaced.
fn flags_with(field: &str, value: Value) -> Value {
    let mut flags = default_flags();
    flags[field] = value;
    flags
}

// ---------------------------------------------------------------------------------------------------------------------
// The table: (method, args) by three callers
// ---------------------------------------------------------------------------------------------------------------------

fn pause_args() -> Value {
    json!({ "paused": true })
}

fn set_flags_args() -> Value {
    json!({ "flags": flags_with("max_pending_per_agent", json!(4)) })
}

fn whitelist_args() -> Value {
    json!({ "account_id": "agent.test.near" })
}

/// Whether the effect of the method is visible in the contract, `None` when the method has no visible effect in this row
/// (the default measurements are already approved by the deploy, so `approve_measurements` is idempotent here).
async fn effect_applied(
    w: &World,
    method: &str,
) -> Result<Option<bool>, Box<dyn std::error::Error + Send + Sync>> {
    Ok(match method {
        "pause" => Some(w.policy().await?["paused"] == json!(true)),
        "set_flags" => Some(w.policy().await?["flags"]["max_pending_per_agent"] == json!(4)),
        "whitelist_agent_for_local" => {
            let list: Vec<String> = w
                .view("get_whitelisted_agents_for_local", json!({}))
                .await?;
            Some(list.iter().any(|a| a == "agent.test.near"))
        }
        _ => None,
    })
}

#[derive(Clone, Copy)]
enum Row {
    OwnerOneYocto,
    OwnerNoDeposit,
    StrangerOneYocto,
}

async fn run_row(method: &str, args: Value, row: Row) -> Res {
    let w = world().await?;
    let (caller, signer, deposit) = match row {
        Row::OwnerOneYocto => (&w.owner, &w.owner_signer, ONE_YOCTO),
        Row::OwnerNoDeposit => (&w.owner, &w.owner_signer, NO_DEPOSIT),
        Row::StrangerOneYocto => (&w.stranger, &w.stranger_signer, ONE_YOCTO),
    };
    let result = call_transaction(
        &w.contract,
        method,
        args,
        caller,
        signer,
        &w.net,
        Some(deposit),
    )
    .await?;
    let text = failure_text(&result);
    match row {
        Row::OwnerOneYocto => {
            assert!(
                text.is_empty(),
                "{method}: owner with 1 yocto failed: {text}"
            );
            let events = extract_event_logs(&result)?;
            result.assert_success();
            if let Some(applied) = effect_applied(&w, method).await? {
                assert!(
                    applied,
                    "{method}: the owner call succeeded but changed nothing"
                );
            }
            // `pause` and `set_flags` announce themselves in the NEP-297 shape: one element array under `data`
            if method == "pause" || method == "set_flags" {
                let name = if method == "pause" {
                    "paused"
                } else {
                    "flags_set"
                };
                let event = events
                    .iter()
                    .find(|e| e["event"] == name)
                    .unwrap_or_else(|| panic!("{method}: no {name} event in {events:?}"));
                assert_eq!(event["standard"], "airlock");
                assert_eq!(event["version"], "1.0.0");
                assert!(
                    event["data"].as_array().is_some_and(|d| d.len() == 1),
                    "{event}"
                );
            }
        }
        Row::OwnerNoDeposit | Row::StrangerOneYocto => {
            let want = if matches!(row, Row::OwnerNoDeposit) {
                ONE_YOCTO_TEXT
            } else {
                NOT_OWNER_TEXT
            };
            result.assert_failure();
            assert!(
                text.contains(want),
                "{method}: expected `{want}` in: {text}"
            );
            if let Some(applied) = effect_applied(&w, method).await? {
                assert!(
                    !applied,
                    "{method}: the call failed but its effect is visible"
                );
            }
        }
    }
    Ok(())
}

/// Three tests (one per caller) for one method.
macro_rules! owner_rows {
    ($method:literal, $args:expr, $ok:ident, $no_deposit:ident, $stranger:ident) => {
        #[tokio::test]
        async fn $ok() -> Res {
            run_row($method, $args, Row::OwnerOneYocto).await
        }
        #[tokio::test]
        async fn $no_deposit() -> Res {
            run_row($method, $args, Row::OwnerNoDeposit).await
        }
        #[tokio::test]
        async fn $stranger() -> Res {
            run_row($method, $args, Row::StrangerOneYocto).await
        }
    };
}

owner_rows!(
    "pause",
    pause_args(),
    pause_owner_one_yocto_succeeds,
    pause_owner_no_deposit_fails,
    pause_stranger_one_yocto_fails
);
owner_rows!(
    "set_flags",
    set_flags_args(),
    set_flags_owner_one_yocto_succeeds,
    set_flags_owner_no_deposit_fails,
    set_flags_stranger_one_yocto_fails
);
owner_rows!(
    "approve_measurements",
    approve_measurements_default_args(),
    approve_measurements_owner_one_yocto_succeeds,
    approve_measurements_owner_no_deposit_fails,
    approve_measurements_stranger_one_yocto_fails
);
owner_rows!(
    "whitelist_agent_for_local",
    whitelist_args(),
    whitelist_owner_one_yocto_succeeds,
    whitelist_owner_no_deposit_fails,
    whitelist_stranger_one_yocto_fails
);

// ---------------------------------------------------------------------------------------------------------------------
// The rest of the owner plane
// ---------------------------------------------------------------------------------------------------------------------

/// The one yocto rule is exact: 2 yocto fails with the same text as no deposit, and nothing changes.
#[tokio::test]
async fn owner_two_yocto_fails() -> Res {
    let w = world().await?;
    let result = w
        .owner_call("pause", pause_args(), NearToken::from_yoctonear(2))
        .await?;
    let text = failure_text(&result);
    result.assert_failure();
    assert!(
        text.contains(ONE_YOCTO_TEXT),
        "expected the 1 yocto text in: {text}"
    );
    assert_eq!(w.policy().await?["paused"], json!(false));
    Ok(())
}

#[tokio::test]
async fn flags_defaults() -> Res {
    let w = world().await?;
    let policy = w.policy().await?;
    assert_eq!(policy["paused"], json!(false));
    assert_eq!(policy["owner_id"], json!(w.owner.to_string()));
    assert_eq!(policy["requires_tee"], json!(false));
    assert!(policy["mpc_contract_id"].is_string(), "{policy}");
    // the exact serialization: counters are numbers, the two TTLs are strings (U64), the field order is the struct order
    assert_eq!(
        serde_json::to_string(&policy["flags"])?,
        r#"{"max_pending_per_agent":3,"pending_ttl_ms":"3600000","hourly_escalation_budget":6,"lock_consecutive_rejects":3,"lock_rejects_per_day":20,"max_task_ttl_ms":"3600000","max_task_actions":20}"#
    );
    assert_eq!(policy["flags"], default_flags());
    Ok(())
}

/// A failed `set_flags` leaves the stored flags as they were.
async fn assert_flags_rejected(w: &World, flags: Value, text: &str) -> Res {
    let result = w
        .owner_call("set_flags", json!({ "flags": flags }), ONE_YOCTO)
        .await?;
    let got = failure_text(&result);
    result.assert_failure();
    assert!(got.contains(text), "expected `{text}` in: {got}");
    assert_eq!(
        w.policy().await?["flags"],
        default_flags(),
        "a rejected set_flags changed the flags"
    );
    Ok(())
}

#[tokio::test]
async fn set_flags_rejects_zero() -> Res {
    let w = world().await?;
    for field in [
        "max_pending_per_agent",
        "hourly_escalation_budget",
        "lock_consecutive_rejects",
        "lock_rejects_per_day",
        "max_task_actions",
    ] {
        assert_flags_rejected(&w, flags_with(field, json!(0)), "flag must be above 0").await?;
    }
    for field in ["pending_ttl_ms", "max_task_ttl_ms"] {
        assert_flags_rejected(&w, flags_with(field, json!("0")), "flag must be above 0").await?;
    }
    Ok(())
}

#[tokio::test]
async fn set_flags_rejects_ttl_over_7_days() -> Res {
    let w = world().await?;
    for field in ["pending_ttl_ms", "max_task_ttl_ms"] {
        assert_flags_rejected(
            &w,
            flags_with(field, json!("604800001")),
            "ttl above 7 days",
        )
        .await?;
    }
    // exactly 7 days is allowed
    let result = w
        .owner_call(
            "set_flags",
            json!({ "flags": flags_with("pending_ttl_ms", json!("604800000")) }),
            ONE_YOCTO,
        )
        .await?;
    let text = failure_text(&result);
    assert!(text.is_empty(), "7 days must be accepted: {text}");
    assert_eq!(
        w.policy().await?["flags"]["pending_ttl_ms"],
        json!("604800000")
    );
    Ok(())
}

#[tokio::test]
async fn set_flags_rejects_actions_over_99() -> Res {
    let w = world().await?;
    assert_flags_rejected(
        &w,
        flags_with("max_task_actions", json!(100)),
        "max_task_actions above 99",
    )
    .await?;
    // 99 is allowed: the request id of action index 98 stays at 67 characters
    let result = w
        .owner_call(
            "set_flags",
            json!({ "flags": flags_with("max_task_actions", json!(99)) }),
            ONE_YOCTO,
        )
        .await?;
    let text = failure_text(&result);
    assert!(text.is_empty(), "99 must be accepted: {text}");
    assert_eq!(w.policy().await?["flags"]["max_task_actions"], json!(99));
    Ok(())
}

/// NEAR audit detector `required-initialization-macro`: `new` runs once, only as the contract itself, and an uninitialized
/// deployment refuses calls.
#[tokio::test]
async fn init_runs_once_and_only_by_the_contract() -> Res {
    let _slot = slot().await;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = create_network_config(&sandbox);
    let (genesis, genesis_signer) = setup_genesis_account().await;
    let fresh: AccountId = format!("fresh.{genesis}").parse()?;
    let fresh_signer = deploy_uninitialized(&net, &genesis, &genesis_signer, &fresh).await?;
    let (stranger, stranger_signer) =
        create_user_account(&net, &genesis, &genesis_signer, "stranger").await?;

    // 1. an uninitialized deployment refuses calls (`PanicOnDefault`)
    let before: Result<Data<Value>, _> = call_view(&fresh, "get_policy", json!({}), &net).await;
    let err = format!("{:?}", before.expect_err("get_policy must fail before new"));
    assert!(
        err.contains("The contract is not initialized"),
        "unexpected view error: {err}"
    );

    let init_args = |owner: &AccountId| {
        json!({
            "owner_id": owner,
            "mpc_contract_id": "mpc-contract",
            "requires_tee": false,
            "attestation_expiration_time_ms": "100000"
        })
    };

    // 2. a stranger cannot run `new` (`#[private]`)
    let by_stranger = call_transaction(
        &fresh,
        "new",
        init_args(&stranger),
        &stranger,
        &stranger_signer,
        &net,
        None,
    )
    .await?;
    let text = failure_text(&by_stranger);
    by_stranger.assert_failure();
    assert!(text.contains("Method new is private"), "unexpected: {text}");

    // 3. the account itself can
    let first_owner = genesis.clone();
    call_transaction(
        &fresh,
        "new",
        init_args(&first_owner),
        &fresh,
        &fresh_signer,
        &net,
        None,
    )
    .await?
    .assert_success();
    let policy: Data<Value> = call_view(&fresh, "get_policy", json!({}), &net).await?;
    assert_eq!(policy.data["owner_id"], json!(first_owner.to_string()));

    // 4. a second `new` with another owner fails and the first owner stays
    let again = call_transaction(
        &fresh,
        "new",
        init_args(&stranger),
        &fresh,
        &fresh_signer,
        &net,
        None,
    )
    .await?;
    let text = failure_text(&again);
    again.assert_failure();
    assert!(
        text.contains("The contract has already been initialized"),
        "unexpected: {text}"
    );
    let policy: Data<Value> = call_view(&fresh, "get_policy", json!({}), &net).await?;
    assert_eq!(
        policy.data["owner_id"],
        json!(first_owner.to_string()),
        "a second new replaced the owner"
    );
    Ok(())
}

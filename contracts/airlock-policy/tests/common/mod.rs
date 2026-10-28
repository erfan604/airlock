// Test Helpers, shared by every sandbox test through `mod common;`.
// Every integration test file compiles its own copy of this module, so a helper that one file does not call would otherwise
// fail `clippy -D warnings`; the allow below covers the whole module.
#![allow(dead_code)]
use near_api::{
    Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, RPCEndpoint, Signer, signer,
};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use near_sandbox::{GenesisAccount, Sandbox};
use serde_json::json;
use shade_attestation::attestation::create_mock_dstack_attestation;
use shade_attestation::measurements::create_mock_full_measurements_hex;
use std::sync::Arc;
use tokio::time::{Duration, sleep};

// Deposit constants for integration tests
pub const DEPOSIT_005_NEAR: NearToken = NearToken::from_yoctonear(5_000_000_000_000_000_000_000); // 0.005 NEAR

/// Where `cargo near build` writes the contract wasm: `$CARGO_TARGET_DIR/near/airlock_policy.wasm` (scripts/env.sh exports
/// `CARGO_TARGET_DIR`, so the crate has no `target/`).
pub fn contract_wasm_path() -> String {
    let dir = std::env::var("CARGO_TARGET_DIR")
        .unwrap_or_else(|_| format!("{}/target", env!("CARGO_MANIFEST_DIR")));
    format!("{dir}/near/airlock_policy.wasm")
}

/// The owner methods of the Shade template that remain (AIR-041 deleted `update_owner_id`, `update_mpc_contract_id` and
/// `update_contract`) and `allow_agent` and `revoke_agent` (AIR-046). `call_transaction` and `call_transaction_raw` attach 1 yoctoNEAR to these when the caller passed no
/// deposit (every owner method is `#[payable]` and demands exactly 1 yocto), so the template tests need no other edit. A test
/// that wants "no deposit" passes `Some(NearToken::from_yoctonear(0))`. Later tickets add their owner methods here or call
/// them through `owner_call`, which always attaches 1 yocto.
pub const OWNER_METHODS: &[&str] = &[
    "update_attestation_expiration_time",
    "allow_agent",
    "revoke_agent",
    "approve_measurements",
    "remove_measurements",
    "approve_ppids",
    "remove_ppids",
    "remove_agent",
    "whitelist_agent_for_local",
    "remove_agent_from_whitelist_for_local",
];

/// The deposit a call gets when the caller gave none: 1 yocto for an owner method, nothing for any other.
fn deposit_or_default(method_name: &str, deposit: Option<NearToken>) -> Option<NearToken> {
    match deposit {
        Some(dep) => Some(dep),
        None if OWNER_METHODS.contains(&method_name) => Some(NearToken::from_yoctonear(1)),
        None => None,
    }
}

pub const MOCK_MPC_WASM_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contracts/mock_mpc.wasm");

pub fn create_network_config(sandbox: &Sandbox) -> NetworkConfig {
    NetworkConfig {
        network_name: "sandbox".to_string(),
        rpc_endpoints: vec![RPCEndpoint::new(sandbox.rpc_addr.parse().unwrap())],
        ..NetworkConfig::testnet()
    }
}

pub async fn setup_genesis_account() -> (AccountId, Arc<Signer>) {
    let genesis_account_default = GenesisAccount::default();
    let genesis_account_id: AccountId = genesis_account_default
        .account_id
        .to_string()
        .parse()
        .unwrap();
    let genesis_signer: Arc<Signer> =
        Signer::from_secret_key(genesis_account_default.private_key.parse().unwrap()).unwrap();

    (genesis_account_id, genesis_signer)
}

pub async fn deploy_contract(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
    wasm_path: &str,
    init_method: Option<&str>,
    init_args: Option<serde_json::Value>,
    account_id: Option<AccountId>,
) -> Result<AccountId, Box<dyn std::error::Error + Send + Sync>> {
    // Create contract account
    let contract_id =
        account_id.unwrap_or_else(|| format!("contract.{}", genesis_account_id).parse().unwrap());
    let contract_secret_key = signer::generate_secret_key()?;

    let _ = Account::create_account(contract_id.clone())
        .fund_myself(genesis_account_id.clone(), NearToken::from_near(10))
        .with_public_key(contract_secret_key.public_key())
        .with_signer(genesis_signer.clone())
        .send_to(network_config)
        .await?;

    // Read and deploy contract WASM
    let wasm_bytes = std::fs::read(wasm_path)?;
    let contract_signer: Arc<Signer> = Signer::from_secret_key(contract_secret_key)?;

    // Deploy contract
    let mut deploy_result = None;
    let mut last_error_str = None;
    for attempt in 1..=3 {
        // Retry
        let result = if let (Some(method), Some(args)) = (init_method, init_args.as_ref()) {
            // Deploy with init call
            Contract::deploy(contract_id.clone())
                .use_code(wasm_bytes.clone())
                .with_init_call(method, args.clone())?
                .with_signer(contract_signer.clone())
                .send_to(network_config)
                .await
        } else {
            // Deploy without init call
            Contract::deploy(contract_id.clone())
                .use_code(wasm_bytes.clone())
                .without_init_call()
                .with_signer(contract_signer.clone())
                .send_to(network_config)
                .await
        };

        match result {
            Ok(result) => {
                deploy_result = Some(result);
                break;
            }
            Err(e) => {
                let error_str = format!("{:?}", e);
                if error_str.contains("408")
                    || error_str.contains("timeout")
                    || error_str.contains("Timeout")
                    || error_str.contains("TransportError")
                {
                    println!(
                        "Deployment attempt {} timed out (408), retrying... (attempt {}/3)",
                        attempt, attempt
                    );
                    last_error_str = Some(error_str);
                    if attempt < 3 {
                        sleep(Duration::from_millis(1000)).await;
                        continue;
                    }
                } else {
                    return Err(format!("Contract deployment failed: {:?}", e).into());
                }
            }
        }
    }

    let deploy_result = deploy_result.ok_or_else(|| {
        format!(
            "Contract deployment failed after 3 attempts due to timeout. Last error: {:?}",
            last_error_str.unwrap_or_else(|| "Unknown".to_string())
        )
    })?;

    // Check if deploy succeeded
    // If the error is "already been initialized", that means the contract was deployed in a previous attempt
    // (likely a timeout that actually succeeded), so we treat it as success
    if let Err(e) = deploy_result.into_result() {
        let error_str = format!("{:?}", e);
        println!("Deployment result error: {}", error_str);
        if error_str.contains("already been initialized")
            || error_str.contains("already initialized")
            || error_str.contains("The contract has already been initialized")
            || error_str
                .contains("Smart contract panicked: The contract has already been initialized")
        {
            println!(
                "Contract already initialized (likely from previous timeout attempt), treating as success"
            );
            // Contract is deployed and initialized, we're good
        } else {
            return Err(format!("Contract deploy/init failed: {:?}", e).into());
        }
    }

    // Wait a bit for the deployment to finalize
    sleep(Duration::from_millis(300)).await;

    Ok(contract_id)
}

/// Deploys the contract wasm to a new account and does NOT call `new`. Returns the account id and the signer of its key,
/// because `new` is `#[private]` and only the account itself may call it (AIR-040 `init_runs_once_and_only_by_the_contract`).
pub async fn deploy_uninitialized(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
    account_id: &AccountId,
) -> Result<Arc<Signer>, Box<dyn std::error::Error + Send + Sync>> {
    let secret_key = signer::generate_secret_key()?;
    let _ = Account::create_account(account_id.clone())
        .fund_myself(genesis_account_id.clone(), NearToken::from_near(10))
        .with_public_key(secret_key.public_key())
        .with_signer(genesis_signer.clone())
        .send_to(network_config)
        .await?;
    let account_signer: Arc<Signer> = Signer::from_secret_key(secret_key)?;
    Contract::deploy(account_id.clone())
        .use_code(std::fs::read(contract_wasm_path())?)
        .without_init_call()
        .with_signer(account_signer.clone())
        .send_to(network_config)
        .await?
        .assert_success();
    sleep(Duration::from_millis(300)).await;
    Ok(account_signer)
}

/// The failure text of a transaction that did not succeed: every failed receipt, as the sandbox prints it (it contains
/// `Smart contract panicked: <message>` for a panic). Empty when nothing failed, so `assert_failure()` stays the first check;
/// a missing method also fails, so a test that expects one reason checks this text too.
pub fn failure_text(result: &ExecutionFinalResult) -> String {
    let failures = result.failures();
    if failures.is_empty() {
        String::new()
    } else {
        format!("{failures:?}")
    }
}

pub async fn deploy_contract_default(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
) -> Result<AccountId, Box<dyn std::error::Error + Send + Sync>> {
    let owner = genesis_account_id.clone();
    let mpc_contract: AccountId = "mpc-contract".parse().unwrap();

    // Use a short expiration time for tests: 100 seconds = 100000 ms
    let contract_id = deploy_contract(
        network_config,
        genesis_account_id,
        genesis_signer,
        &contract_wasm_path(),
        Some("new"),
        Some(json!({
            "owner_id": owner,
            "mpc_contract_id": mpc_contract,
            "requires_tee": false,
            "attestation_expiration_time_ms": "100000"
        })),
        None,
    )
    .await?;

    // Approve default measurements and PPID so agents can register in local mode
    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_measurements_default_args(),
        genesis_account_id,
        genesis_signer,
        network_config,
        None,
    )
    .await?
    .into_result()
    .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("approve_measurements failed: {:?}", e).into()
    })?;

    let _ = call_transaction(
        &contract_id,
        "approve_ppids",
        default_ppids_json(),
        genesis_account_id,
        genesis_signer,
        network_config,
        None,
    )
    .await?
    .into_result()
    .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("approve_ppids failed: {:?}", e).into()
    })?;

    Ok(contract_id)
}

/// Returns JSON for mock full measurements (all zeros). Used for local mode registration.
/// Uses the same type as the contract so serialization matches exactly.
pub fn default_measurements_json() -> serde_json::Value {
    serde_json::to_value(create_mock_full_measurements_hex())
        .expect("create_mock_full_measurements_hex() serializes")
}

/// Args for approve_measurements with default measurements (parameter name required by contract).
pub fn approve_measurements_default_args() -> serde_json::Value {
    json!({ "measurements": default_measurements_json() })
}

/// Returns JSON for approve_ppids with default PPID (16 zero bytes = 32 hex chars).
pub fn default_ppids_json() -> serde_json::Value {
    json!({
        "ppids": ["0".repeat(32)]
    })
}

/// Returns JSON for non-default measurements (one byte differs from default).
/// Used to test that registration fails when default measurements are not approved.
pub fn non_default_measurements_json() -> serde_json::Value {
    let mut m = default_measurements_json();
    let mrtd = m["rtmrs"]["mrtd"].as_str().expect("mrtd is string");
    let mut chars: Vec<char> = mrtd.chars().collect();
    chars[95] = '1';
    m["rtmrs"]["mrtd"] = serde_json::Value::String(chars.into_iter().collect());
    m
}

/// Returns JSON for approve_measurements with non-default measurements.
pub fn approve_non_default_measurements_args() -> serde_json::Value {
    json!({ "measurements": non_default_measurements_json() })
}

/// Returns JSON for approve_ppids with non-default PPID (differs from 16 zero bytes).
pub fn non_default_ppids_json() -> serde_json::Value {
    json!({
        "ppids": ["0".repeat(31) + "1"]
    })
}

pub async fn create_user_account(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
    user_name: &str,
) -> Result<(AccountId, Arc<Signer>), Box<dyn std::error::Error + Send + Sync>> {
    let user_id: AccountId = format!("{}.{}", user_name, genesis_account_id).parse()?;
    let user_secret_key = signer::generate_secret_key()?;
    let user_signer: Arc<Signer> = Signer::from_secret_key(user_secret_key.clone())?;

    let _ = Account::create_account(user_id.clone())
        .fund_myself(genesis_account_id.clone(), NearToken::from_near(5))
        .with_public_key(user_secret_key.public_key())
        .with_signer(genesis_signer.clone())
        .send_to(network_config)
        .await?;

    Ok((user_id, user_signer))
}

pub async fn call_view<T: serde::de::DeserializeOwned + Send + Sync>(
    contract_id: &AccountId,
    method_name: &str,
    args: serde_json::Value,
    network_config: &NetworkConfig,
) -> Result<near_api::Data<T>, Box<dyn std::error::Error + Send + Sync>> {
    let contract = Contract(contract_id.clone());
    let result: near_api::Data<T> = contract
        .call_function(method_name, args)
        .read_only()
        .fetch_from(network_config)
        .await?;
    Ok(result)
}

pub async fn call_transaction(
    contract_id: &AccountId,
    method_name: &str,
    args: serde_json::Value,
    signer_account_id: &AccountId,
    signer: &Arc<Signer>,
    network_config: &NetworkConfig,
    deposit: Option<NearToken>,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error + Send + Sync>> {
    let contract = Contract(contract_id.clone());
    let call = contract.call_function(method_name, args);

    let mut tx = call.transaction();

    if let Some(dep) = deposit_or_default(method_name, deposit) {
        tx = tx.deposit(dep);
    }

    let tx_result = tx
        .with_signer(signer_account_id.clone(), signer.clone())
        .send_to(network_config)
        .await?;

    unwrap_full(tx_result)
}

pub async fn call_transaction_raw(
    contract_id: &AccountId,
    method_name: &str,
    args: Vec<u8>,
    signer_account_id: &AccountId,
    signer: &Arc<Signer>,
    network_config: &NetworkConfig,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error + Send + Sync>> {
    let contract = Contract(contract_id.clone());
    let call = contract.call_function_raw(method_name, args);

    let mut tx = call.transaction();

    if let Some(dep) = deposit_or_default(method_name, None) {
        tx = tx.deposit(dep);
    }

    let tx_result = tx
        .with_signer(signer_account_id.clone(), signer.clone())
        .send_to(network_config)
        .await?;

    unwrap_full(tx_result)
}

fn unwrap_full(
    tx_result: TransactionResult,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error + Send + Sync>> {
    match tx_result {
        TransactionResult::Full(r) => Ok(*r),
        TransactionResult::Pending { status } => {
            Err(format!("transaction still pending: {status:?}").into())
        }
    }
}

pub async fn deploy_mock_mpc_contract(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
    contract_name: &str,
) -> Result<AccountId, Box<dyn std::error::Error + Send + Sync>> {
    let mpc_contract_id: AccountId = format!("{}.{}", contract_name, genesis_account_id).parse()?;

    // Deploy the AIRLOCK mock MPC (contracts/mock-mpc) and run its `new` (AIR-103: the mock keeps state, unlike the template's)
    deploy_contract(
        network_config,
        genesis_account_id,
        genesis_signer,
        MOCK_MPC_WASM_PATH,
        Some("new"),
        Some(json!({})),
        Some(mpc_contract_id.clone()),
    )
    .await?;

    Ok(mpc_contract_id)
}

/// Extract and parse EVENT_JSON logs from a transaction result
/// Returns a vector of parsed event JSON objects
pub fn extract_event_logs(
    result: &ExecutionFinalResult,
) -> Result<Vec<serde_json::Value>, Box<dyn std::error::Error + Send + Sync>> {
    let mut events = Vec::new();

    // Use the public logs() method to get all logs from transaction and receipt outcomes
    for log in result.logs() {
        // Look for EVENT_JSON: prefix
        if let Some(event_json) = log.strip_prefix("EVENT_JSON:") {
            match serde_json::from_str::<serde_json::Value>(event_json) {
                Ok(event) => events.push(event),
                Err(e) => {
                    eprintln!("Failed to parse event JSON: {} - {}", event_json, e);
                }
            }
        }
    }

    Ok(events)
}

// ---------------------------------------------------------------------------------------------------------------------
// AIR-041: the shared sandbox setup of every later contract test
// ---------------------------------------------------------------------------------------------------------------------

/// A sandbox with the policy contract deployed and initialized (`start`).
pub struct Started {
    pub sandbox: Sandbox,
    pub net: NetworkConfig,
    /// The genesis account `sandbox`: it owns the contract and funds every other account.
    pub owner: AccountId,
    pub owner_signer: Arc<Signer>,
    /// The policy contract: `new(requires_tee = false, attestation_expiration_time_ms = 100000, owner = genesis account, mpc
    /// "mpc-contract")` has run and the default measurements and PPID are approved, so a whitelisted agent can register.
    pub contract: AccountId,
}

/// Starts a sandbox and deploys the wasm at `contract_wasm_path()` (build it first: `cargo near build non-reproducible-wasm
/// --no-abi`). Panics with the reason when the wasm is missing or the deploy fails.
pub async fn start() -> Started {
    let path = contract_wasm_path();
    assert!(
        std::path::Path::new(&path).exists(),
        "{path} does not exist: run `cargo near build non-reproducible-wasm --no-abi` in the crate first"
    );
    let sandbox = Sandbox::start_sandbox().await.expect("the sandbox starts");
    let net = create_network_config(&sandbox);
    let (owner, owner_signer) = setup_genesis_account().await;
    let contract = deploy_contract_default(&net, &owner, &owner_signer)
        .await
        .expect("the policy contract deploys and initializes");
    Started {
        sandbox,
        net,
        owner,
        owner_signer,
        contract,
    }
}

/// Deploys the mock MPC (the wasm at `MOCK_MPC_WASM_PATH`, built by `scripts/build-mock-mpc.sh` from `contracts/mock-mpc`) to
/// `<name>.sandbox` and returns its account. AIR-103: after deploying it calls the mock's `version` view and asserts
/// `mock-3.17.0`, so a template or stale wasm (which has no such view) fails every sandbox test loudly.
pub async fn deploy_mock_mpc(s: &Started, name: &str) -> AccountId {
    let id = deploy_mock_mpc_contract(&s.net, &s.owner, &s.owner_signer, name)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "the mock MPC does not deploy and initialize ({e}); tests/contracts/mock_mpc.wasm may be the template's: run scripts/build-mock-mpc.sh"
            )
        });
    let version = call_view::<String>(&id, "version", json!({}), &s.net)
        .await
        .map(|v| v.data)
        .unwrap_or_default();
    assert_eq!(
        version, "mock-3.17.0",
        "tests/contracts/mock_mpc.wasm is not the AIRLOCK mock: run scripts/build-mock-mpc.sh"
    );
    id
}

/// Calls a method of the policy contract as the owner with exactly 1 yoctoNEAR (the default gas of the builder, 100 Tgas).
pub async fn owner_call(
    s: &Started,
    method: &str,
    args: serde_json::Value,
) -> ExecutionFinalResult {
    call_transaction(
        &s.contract,
        method,
        args,
        &s.owner,
        &s.owner_signer,
        &s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("the owner call is sent")
}

/// Calls a method of the policy contract as an agent (or any account) with no deposit and 300 Tgas, the budget of a
/// `submit_batch`. A failed receipt is not an error: inspect the result (`failure_text`).
pub async fn agent_call(
    s: &Started,
    agent: &AccountId,
    agent_signer: &Arc<Signer>,
    method: &str,
    args: serde_json::Value,
) -> ExecutionFinalResult {
    let sent = Contract(s.contract.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(300))
        .with_signer(agent.clone(), agent_signer.clone())
        .send_to(&s.net)
        .await
        .expect("the agent call is sent");
    unwrap_full(sent).expect("the agent call finished")
}

/// Prints the gas the whole transaction burnt (all receipts) in Tgas and returns it in gas units. Sandbox neard 2.11.0 is
/// protocol 83, so the number is indicative; AIR-107 measures on testnet.
pub fn gas_report(outcome: &ExecutionFinalResult) -> u64 {
    let gas = outcome.total_gas_burnt.as_gas();
    println!("gas: {:.2} Tgas ({gas} gas)", gas as f64 / 1e12);
    gas
}

/// Every function export of the wasm at `contract_wasm_path()`, in file order, **unfiltered**: `abi_snapshot.rs` applies the
/// ignore rules (`memory`, a leading `_`, `contract_source_metadata`, a leading `ring_core_`), and AIR-084's `ab03_` reads
/// this raw list. Panics when the wasm is missing or does not parse.
pub fn wasm_exports() -> Vec<String> {
    let path = contract_wasm_path();
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        panic!("read {path}: {e} (run `cargo near build non-reproducible-wasm --no-abi` first)")
    });
    let mut names = Vec::new();
    for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
        if let wasmparser::Payload::ExportSection(reader) = payload.expect("the wasm parses") {
            for export in reader {
                let export = export.expect("an export entry parses");
                if export.kind == wasmparser::ExternalKind::Func {
                    names.push(export.name.to_string());
                }
            }
        }
    }
    names
}

/// AIR-046: registers `agent` in local mode. The owner whitelists it (`whitelist_agent_for_local`, 1 yocto), then the agent calls
/// `register_agent` with the mock attestation and `DEPOSIT_005_NEAR` (the storage of a first registration); both calls are
/// asserted successful. Needs a contract deployed with `deploy_contract_default` (`start`), which also approves the default
/// measurements and PPID. The agent is not allowed yet: see `allow_agent_for`.
pub async fn register_local_agent(
    contract: &AccountId,
    owner: &AccountId,
    owner_signer: &Arc<Signer>,
    agent: &AccountId,
    agent_signer: &Arc<Signer>,
    net: &NetworkConfig,
) {
    call_transaction(
        contract,
        "whitelist_agent_for_local",
        json!({ "account_id": agent }),
        owner,
        owner_signer,
        net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("whitelist_agent_for_local is sent")
    .assert_success();
    call_transaction(
        contract,
        "register_agent",
        json!({ "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap() }),
        agent,
        agent_signer,
        net,
        Some(DEPOSIT_005_NEAR),
    )
    .await
    .expect("register_agent is sent")
    .assert_success();
}

/// AIR-046: the owner allows `agent` with the fingerprint the contract computes (`allow_agent`, 1 yocto), asserted successful.
pub async fn allow_agent_for(
    contract: &AccountId,
    owner: &AccountId,
    owner_signer: &Arc<Signer>,
    agent: &AccountId,
    net: &NetworkConfig,
) {
    call_transaction(
        contract,
        "allow_agent",
        json!({
            "account_id": agent,
            "fingerprint": airlock_policy::agents::fingerprint(agent.as_str())
        }),
        owner,
        owner_signer,
        net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("allow_agent is sent")
    .assert_success();
}

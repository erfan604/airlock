// Test Helpers, shared by every sandbox test through `mod common;`.
// Every integration test file compiles its own copy of this module, so a helper that one file does not call would otherwise
// fail `clippy -D warnings`; the allow below covers the whole module.
#![allow(dead_code)]
use near_api::{
    Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, RPCEndpoint, Signer, Tokens,
    signer,
};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use near_sandbox::{GenesisAccount, Sandbox};
use serde_json::{Value, json};
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

    // The wasm is about 1 MB and storing it locks about 9.9 NEAR (1e19 yocto per byte), so 10 NEAR left room for a few dozen stored
    // records only (`LackBalanceForState`, hit by tests/book.rs at its 41st payee when AIR-080 grew the wasm); 30 NEAR leaves about 20.
    let _ = Account::create_account(contract_id.clone())
        .fund_myself(genesis_account_id.clone(), NearToken::from_near(30))
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
    let mpc_contract: AccountId = "mpc-contract".parse().unwrap();
    // Use a short expiration time for tests: 100 seconds = 100000 ms
    deploy_policy(
        network_config,
        genesis_account_id,
        genesis_signer,
        None,
        &mpc_contract,
        "100000",
    )
    .await
}

/// Deploys the policy wasm to `account_id` (`contract.<genesis account>` when `None`), runs `new(requires_tee = false, owner = the
/// genesis account, mpc_contract_id, attestation_expiration_time_ms)` and approves the default measurements and PPID, so a
/// whitelisted agent can register in local mode. `deploy_contract_default` and `world_with` (AIR-105) are the two callers.
pub async fn deploy_policy(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
    account_id: Option<AccountId>,
    mpc_contract: &AccountId,
    attestation_expiration_time_ms: &str,
) -> Result<AccountId, Box<dyn std::error::Error + Send + Sync>> {
    let owner = genesis_account_id.clone();

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
            "attestation_expiration_time_ms": attestation_expiration_time_ms
        })),
        account_id,
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
    deploy_checked_mock_mpc(&s.net, &s.owner, &s.owner_signer, name).await
}

/// `deploy_mock_mpc` without a `Started`: the same deploy and the same `version` assertion (`world_with` calls it).
pub async fn deploy_checked_mock_mpc(
    net: &NetworkConfig,
    owner: &AccountId,
    owner_signer: &Arc<Signer>,
    name: &str,
) -> AccountId {
    let id = deploy_mock_mpc_contract(net, owner, owner_signer, name)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "the mock MPC does not deploy and initialize ({e}); tests/contracts/mock_mpc.wasm may be the template's: run scripts/build-mock-mpc.sh"
            )
        });
    let version = call_view::<String>(&id, "version", json!({}), net)
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
    call_300_tgas(&s.contract, &s.net, agent, agent_signer, method, args).await
}

/// `agent_call` for any contract and network: no deposit, 300 Tgas, a failed receipt is not an error.
pub async fn call_300_tgas(
    contract: &AccountId,
    net: &NetworkConfig,
    caller: &AccountId,
    caller_signer: &Arc<Signer>,
    method: &str,
    args: serde_json::Value,
) -> ExecutionFinalResult {
    let sent = Contract(contract.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(300))
        .with_signer(caller.clone(), caller_signer.clone())
        .send_to(net)
        .await
        .expect("the call is sent");
    unwrap_full(sent).expect("the call finished")
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

// ---------------------------------------------------------------------------------------------------------------------
// AIR-060: signed owner tasks for the gate tests (AIR-061 and every later sandbox ticket)
// ---------------------------------------------------------------------------------------------------------------------

/// The seed of the test task key: 32 bytes of 01, the seed of the `owner_task` vector, so `set_test_task_key` registers the vector's
/// public key `ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9`.
pub const TASK_SEED: [u8; 32] = [1; 32];

/// The public key of `TASK_SEED` as the text `set_task_key` takes.
pub const TASK_PUBLIC_KEY: &str = "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";

fn wall_clock_ms() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the clock is after 1970")
            .as_millis(),
    )
    .expect("the clock fits u64 milliseconds")
}

/// An unsigned task: tag `airlock-task-v1`, `contract_id` `policy.test.near` and `agent_id` `agent.test.near` (right for in-process
/// tests; a sandbox test sets both through `signed_task_with`, because the sandbox genesis account is `sandbox` and the policy and
/// agent accounts are `<name>.sandbox`), `issued_ms` five seconds before the wall clock and `expires_ms` 30 minutes after it. The
/// sandbox clock is real time and its last block lags the wall clock by about half a second (blocks come every 1.5 s), so an
/// `issued_ms` of the wall clock minus 5 s is always at or before the block time of the call. `bounds` are (payee key, max_total).
pub fn base_task(bounds: &[(&str, u128)], max_actions: u8) -> airlock_policy::task::OwnerTask {
    use airlock_policy::request::Hex32;
    use airlock_policy::task::{OwnerTask, TASK_TAG, TaskBound};
    let now = wall_clock_ms();
    OwnerTask {
        tag: TASK_TAG.to_string(),
        task_id: "task-1".to_string(),
        contract_id: "policy.test.near".parse().unwrap(),
        agent_id: "agent.test.near".parse().unwrap(),
        plan_sha256: Hex32([0x11; 32]),
        instruction_sha256_salted: Hex32([0x22; 32]),
        issued_ms: now - 5_000,
        expires_ms: now + 1_800_000,
        max_actions,
        bounds: bounds
            .iter()
            .map(|(payee_key, max_total)| TaskBound {
                payee_key: (*payee_key).to_string(),
                max_total: near_sdk::json_types::U128(*max_total),
            })
            .collect(),
    }
}

/// The signature of the test task key over the borsh bytes of the task, no prefix: what the console sends with a task.
pub fn sign_task(task: &airlock_policy::task::OwnerTask) -> near_sdk::json_types::Base64VecU8 {
    use ed25519_dalek::Signer;
    let key = ed25519_dalek::SigningKey::from_bytes(&TASK_SEED);
    let bytes = airlock_policy::task::task_bytes(task);
    near_sdk::json_types::Base64VecU8(key.sign(&bytes).to_bytes().to_vec())
}

/// `base_task`, then `sign_task`.
pub fn signed_task(
    bounds: &[(&str, u128)],
    max_actions: u8,
) -> (
    airlock_policy::task::OwnerTask,
    near_sdk::json_types::Base64VecU8,
) {
    signed_task_with(bounds, max_actions, |_| {})
}

/// `base_task`, then `edit`, then `sign_task`: the negative cases (wrong tag, wrong contract, another agent, not yet valid, expired,
/// ttl too long, `max_actions` 0 and 21, 17 bounds, a duplicate bound, a bound above the quick cap) change one field in `edit`.
pub fn signed_task_with(
    bounds: &[(&str, u128)],
    max_actions: u8,
    edit: impl FnOnce(&mut airlock_policy::task::OwnerTask),
) -> (
    airlock_policy::task::OwnerTask,
    near_sdk::json_types::Base64VecU8,
) {
    let mut task = base_task(bounds, max_actions);
    edit(&mut task);
    let signature = sign_task(&task);
    (task, signature)
}

/// The owner registers `TASK_PUBLIC_KEY` with `set_task_key` (1 yocto), asserted successful.
pub async fn set_test_task_key(
    contract: &AccountId,
    owner: &AccountId,
    owner_signer: &Arc<Signer>,
    network: &NetworkConfig,
) {
    call_transaction(
        contract,
        "set_task_key",
        json!({ "public_key": TASK_PUBLIC_KEY }),
        owner,
        owner_signer,
        network,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("set_task_key is sent")
    .assert_success();
}

// ---------------------------------------------------------------------------------------------------------------------
// AIR-105: the shared sandbox world of the lane tickets (AIR-100, 101, 106, 107, 108)
// ---------------------------------------------------------------------------------------------------------------------

/// Base units of one whole NEAR (24 decimals) and of one ETH (18 decimals).
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const ONE_ETH: u128 = 1_000_000_000_000_000_000;

/// The EVM asset of the world: Base Sepolia, derivation path `base-sepolia-1`.
pub const WORLD_EVM_ASSET: &str = "evm:84532:native";
pub const WORLD_EVM_PATH: &str = "base-sepolia-1";
/// The booked EVM payee: 40 lowercase hex characters, no `0x` (its book key is `evm:84532:0x<this>`).
pub const WORLD_EVM_PAYEE: &str = "d8da6bf26964af9d7eed9e03e53415d37aa96045";

/// The registry entry of asset `near` (symbol NEAR, 24 decimals): hard cap 10_000, daily cap 100_000 and quick task cap 100_000 whole units,
/// each times `unit` base units per whole unit. `world_with` registers it with `ONE_NEAR`; tests/gate.rs registers it with 1 (its amounts
/// are yoctoNEAR).
pub fn near_asset_entry(unit: u128) -> Value {
    json!({
        "symbol": "NEAR",
        "decimals": 24,
        "hard_cap": (10_000 * unit).to_string(),
        "daily_cap": (100_000 * unit).to_string(),
        "max_fee_per_gas": "0",
        "max_gas": "0",
        "quick_task_cap": (100_000 * unit).to_string(),
        "path": null
    })
}

/// The registry entry of asset `evm:84532:native` (ETH.base, 18 decimals, path `base-sepolia-1`): hard cap 1 ETH, daily cap 10 ETH, quick
/// task cap 5 ETH, max fee 50 gwei, max gas 100_000.
pub fn evm_asset_entry() -> Value {
    json!({
        "symbol": "ETH.base",
        "decimals": 18,
        "hard_cap": ONE_ETH.to_string(),
        "daily_cap": (10 * ONE_ETH).to_string(),
        "max_fee_per_gas": "50000000000",
        "max_gas": "100000",
        "quick_task_cap": (5 * ONE_ETH).to_string(),
        "path": WORLD_EVM_PATH
    })
}

/// An owner call (1 yocto) that must succeed: a failed receipt panics with its text.
pub async fn owner_call_ok(
    contract: &AccountId,
    owner: &AccountId,
    owner_signer: &Arc<Signer>,
    net: &NetworkConfig,
    method: &str,
    args: Value,
) {
    let result = call_transaction(
        contract,
        method,
        args,
        owner,
        owner_signer,
        net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap_or_else(|e| panic!("{method} is not sent: {e}"));
    let text = failure_text(&result);
    assert!(text.is_empty(), "{method} failed: {text}");
    result.assert_success();
}

/// A sandbox with the whole AIRLOCK setup, so a lane test only submits requests (`world`, `world_with`). Accounts are `<name>.sandbox`
/// (the genesis account is `sandbox`, which is both `root` and `owner`).
pub struct World {
    pub sandbox: Sandbox,
    pub net: NetworkConfig,
    pub root: AccountId,
    pub owner: AccountId,
    pub owner_signer: Arc<Signer>,
    pub agent: AccountId,
    pub agent_signer: Arc<Signer>,
    pub policy: AccountId,
    pub mpc: AccountId,
    /// `alice.sandbox`: an account that exists, so a NEAR payment to it can succeed. Its book key is `near:alice.sandbox`.
    pub payee_near: AccountId,
    /// 40 lowercase hex characters (`WORLD_EVM_PAYEE`).
    pub payee_evm: String,
}

/// What `world_with` varies. The default is `nonce: Some(0)`: `set_nonce("base-sepolia-1", 0)` has run; `None` skips it (the nonce is then
/// unset, which AIR-104's lane treats as an error).
#[derive(Clone, Copy, Debug)]
pub struct WorldOpts {
    pub nonce: Option<u64>,
}

impl Default for WorldOpts {
    fn default() -> Self {
        Self { nonce: Some(0) }
    }
}

/// `world_with(WorldOpts::default())`.
pub async fn world() -> World {
    world_with(WorldOpts::default()).await
}

/// Starts a sandbox and sets up: the mock MPC (`mpc.sandbox`, AIR-103) first, then the policy wasm at `policy.sandbox` with
/// `new(requires_tee = false, attestation_expiration_time_ms = "86400000", owner = the genesis account, mpc = the mock)`, the default
/// measurements and PPID approved, and 50 NEAR transferred to the policy account on top of the deploy funding (30 NEAR in `deploy_contract`,
/// about 80 NEAR in all, about 10 of it locked by the wasm). Then, as the owner: assets `near` (hard cap 10_000, daily cap 100_000, quick task cap 100_000
/// NEAR) and `evm:84532:native` (`evm_asset_entry`); book payees `near:alice.sandbox` (cap 100 NEAR, untrusted budget 1_000 NEAR, daily
/// limit 5_000 NEAR, label Alice) and `evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045` (cap null, budget 0, daily limit 10 ETH);
/// the task key of `TASK_SEED`; `agent.sandbox` whitelisted, registered and allowed; the nonce of `opts`. Flags are the defaults.
/// Build the wasm first: `cargo near build non-reproducible-wasm --no-abi`.
pub async fn world_with(o: WorldOpts) -> World {
    let path = contract_wasm_path();
    assert!(
        std::path::Path::new(&path).exists(),
        "{path} does not exist: run `cargo near build non-reproducible-wasm --no-abi` in the crate first"
    );
    let sandbox = Sandbox::start_sandbox().await.expect("the sandbox starts");
    let net = create_network_config(&sandbox);
    let (root, root_signer) = setup_genesis_account().await;
    let mpc = deploy_checked_mock_mpc(&net, &root, &root_signer, "mpc").await;
    let policy: AccountId = format!("policy.{root}").parse().unwrap();
    deploy_policy(
        &net,
        &root,
        &root_signer,
        Some(policy.clone()),
        &mpc,
        "86400000",
    )
    .await
    .expect("the policy contract deploys and initializes");
    let funding = Tokens::account(root.clone())
        .send_to(policy.clone())
        .near(NearToken::from_near(50))
        .with_signer(root_signer.clone())
        .send_to(&net)
        .await
        .expect("the funding transfer is sent");
    unwrap_full(funding)
        .expect("the funding transfer finished")
        .assert_success();

    let owner = |method: &'static str, args: Value| {
        let (policy, root, root_signer, net) = (
            policy.clone(),
            root.clone(),
            root_signer.clone(),
            net.clone(),
        );
        async move { owner_call_ok(&policy, &root, &root_signer, &net, method, args).await }
    };
    owner(
        "asset_set",
        json!({ "asset": "near", "entry": near_asset_entry(ONE_NEAR) }),
    )
    .await;
    owner(
        "asset_set",
        json!({ "asset": WORLD_EVM_ASSET, "entry": evm_asset_entry() }),
    )
    .await;
    let (payee_near, _) = create_user_account(&net, &root, &root_signer, "alice")
        .await
        .expect("the payee account is created");
    owner(
        "book_add",
        json!({
            "key": format!("near:{payee_near}"),
            "cap": (100 * ONE_NEAR).to_string(),
            "daily_untrusted_budget": (1_000 * ONE_NEAR).to_string(),
            "daily_limit": (5_000 * ONE_NEAR).to_string(),
            "label": "Alice"
        }),
    )
    .await;
    owner(
        "book_add",
        json!({
            "key": format!("evm:84532:0x{WORLD_EVM_PAYEE}"),
            "cap": null,
            "daily_untrusted_budget": "0",
            "daily_limit": (10 * ONE_ETH).to_string(),
            "label": "Base Sepolia payee"
        }),
    )
    .await;
    set_test_task_key(&policy, &root, &root_signer, &net).await;
    let (agent, agent_signer) = create_user_account(&net, &root, &root_signer, "agent")
        .await
        .expect("the agent account is created");
    register_local_agent(&policy, &root, &root_signer, &agent, &agent_signer, &net).await;
    allow_agent_for(&policy, &root, &root_signer, &agent, &net).await;
    if let Some(nonce) = o.nonce {
        owner(
            "set_nonce",
            json!({ "path": WORLD_EVM_PATH, "nonce": nonce.to_string() }),
        )
        .await;
    }
    World {
        sandbox,
        net,
        owner: root.clone(),
        root,
        owner_signer: root_signer,
        agent,
        agent_signer,
        policy,
        mpc,
        payee_near,
        payee_evm: WORLD_EVM_PAYEE.to_string(),
    }
}

impl World {
    /// AIR-060 `signed_task_with` with `contract_id = self.policy` and `agent_id = self.agent` (the vector's `policy.test.near` cannot be
    /// deployed in the sandbox).
    pub fn signed_task(
        &self,
        bounds: &[(&str, u128)],
        max_actions: u8,
    ) -> (
        airlock_policy::task::OwnerTask,
        near_sdk::json_types::Base64VecU8,
    ) {
        let policy: near_sdk::AccountId = self.policy.as_str().parse().unwrap();
        let agent: near_sdk::AccountId = self.agent.as_str().parse().unwrap();
        signed_task_with(bounds, max_actions, |task| {
            task.contract_id = policy;
            task.agent_id = agent;
        })
    }

    /// One request of `task`: `task_id` and `hints.plan_hash` are copied from the task (the gate compares both), `hints.trace_digest` is 64
    /// zeros. `labels` are the (recipient, amount, pc) masks; `evm` is (gas_limit, max_fee_per_gas, max_priority_fee_per_gas) for an EVM
    /// asset and `None` for NEAR.
    #[allow(clippy::too_many_arguments)]
    pub fn request_json(
        &self,
        task: &airlock_policy::task::OwnerTask,
        action_index: u8,
        asset: &str,
        payee: &str,
        amount: u128,
        labels: (u16, u16, u16),
        evm: Option<(u128, u128, u128)>,
    ) -> Value {
        json!({
            "task_id": task.task_id,
            "action_index": action_index,
            "asset": asset,
            "payee": payee,
            "amount": amount.to_string(),
            "labels": { "recipient": labels.0, "amount": labels.1, "pc": labels.2 },
            "evm": evm.map(|(gas_limit, max_fee, priority)| json!({
                "gas_limit": gas_limit.to_string(),
                "max_fee_per_gas": max_fee.to_string(),
                "max_priority_fee_per_gas": priority.to_string()
            })),
            "hints": {
                "plan_hash": task.plan_sha256.to_hex(),
                "trace_digest": "0".repeat(64)
            }
        })
    }

    /// `submit_batch` as the agent, 300 Tgas, no deposit. A failed receipt is not an error: inspect the result (`failure_text`).
    pub async fn submit(
        &self,
        reqs: Vec<Value>,
        task: &(
            airlock_policy::task::OwnerTask,
            near_sdk::json_types::Base64VecU8,
        ),
    ) -> ExecutionFinalResult {
        call_300_tgas(
            &self.policy,
            &self.net,
            &self.agent,
            &self.agent_signer,
            "submit_batch",
            json!({ "reqs": reqs, "task": task.0, "task_sig": task.1 }),
        )
        .await
    }

    /// `get_request`: the view of a request, or `None` for an unknown id.
    pub async fn request(&self, id: &str) -> Option<Value> {
        call_view::<Option<Value>>(&self.policy, "get_request", json!({ "id": id }), &self.net)
            .await
            .unwrap_or_else(|e| panic!("get_request must answer: {e:?}"))
            .data
    }

    /// `get_ledgers` for the payee key and asset id, with no task (`task_spent` is null).
    pub async fn ledgers(&self, payee: &str, asset: &str) -> Value {
        call_view::<Value>(
            &self.policy,
            "get_ledgers",
            json!({ "payee": payee, "asset": asset, "task": null }),
            &self.net,
        )
        .await
        .unwrap_or_else(|e| panic!("get_ledgers must answer: {e:?}"))
        .data
    }

    /// The mock's `set_mode`: `ok`, `fail`, `garbage` or `yield`.
    pub async fn set_mpc_mode(&self, mode: &str) {
        call_transaction(
            &self.mpc,
            "set_mode",
            json!({ "mode": mode }),
            &self.owner,
            &self.owner_signer,
            &self.net,
            None,
        )
        .await
        .expect("set_mode is sent")
        .assert_success();
    }

    /// The mock's `resume`: answers the oldest parked request that is still waiting (yield mode skips timed-out ids), no deposit.
    pub async fn resume_mpc(&self) {
        call_transaction(
            &self.mpc,
            "resume",
            json!({}),
            &self.owner,
            &self.owner_signer,
            &self.net,
            None,
        )
        .await
        .expect("resume is sent")
        .assert_success();
    }

    /// The mock's `parked` view: requests waiting for a resume or the timeout, plus any that already timed out (compare with the value
    /// before the submit).
    pub async fn mpc_parked(&self) -> u64 {
        call_view::<u64>(&self.mpc, "parked", json!({}), &self.net)
            .await
            .unwrap_or_else(|e| panic!("parked must answer: {e:?}"))
            .data
    }
}

/// Every `EVENT_JSON:` log of `r` whose `event` is `name`, each as its `data[0]`, in the order they were logged.
pub fn events(r: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    extract_event_logs(r)
        .expect("the events parse")
        .into_iter()
        .filter(|event| event["event"] == name)
        .map(|event| event["data"][0].clone())
        .collect()
}

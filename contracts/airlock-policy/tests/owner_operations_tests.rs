mod common;

use airlock_policy::ContractInfo;
use common::*;
use near_api::Data;
use serde_json::json;
use tokio::time::{Duration, sleep};

/// Tests the owner plane on a real contract. The owner is fixed at `new` (AB7): the genesis account owns the contract, a
/// stranger cannot approve measurements and the owner can. There is no ownership transfer (AIR-041 deleted `update_owner_id`),
/// so the owner stays the same through all of it.
#[tokio::test]
async fn test_owner_operations() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // A stranger
    let (stranger_id, stranger_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "stranger",
    )
    .await?;

    // The initial owner is the genesis account
    let contract_info: Data<ContractInfo> = call_view(
        &contract_id,
        "get_contract_info",
        json!({}),
        &network_config,
    )
    .await?;
    assert_eq!(
        contract_info.data.owner_id, genesis_account_id,
        "Initial owner should be genesis account"
    );

    // A stranger cannot approve measurements, even with the 1 yocto every owner method demands
    let non_default = approve_non_default_measurements_args();
    let result = call_transaction(
        &contract_id,
        "approve_measurements",
        non_default.clone(),
        &stranger_id,
        &stranger_signer,
        &network_config,
        None,
    )
    .await?;
    let text = failure_text(&result);
    result.assert_failure();
    assert!(
        text.contains("Caller is not the owner"),
        "Expected 'Caller is not the owner', got: {text}"
    );

    sleep(Duration::from_millis(200)).await;

    let before: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_approved_measurements",
        json!({
            "from_index": null,
            "limit": null
        }),
        &network_config,
    )
    .await?;
    assert_eq!(
        before.data.len(),
        1,
        "Only the default measurements (approved by the deploy) are listed; the stranger added nothing"
    );

    // The owner can
    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        non_default,
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify the owner's measurements were added next to the default ones
    let approved_measurements: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_approved_measurements",
        json!({
            "from_index": null,
            "limit": null
        }),
        &network_config,
    )
    .await?;
    assert_eq!(
        approved_measurements.data.len(),
        2,
        "Default and the owner's new measurements should be in the approved list"
    );

    // The owner is unchanged
    let contract_info: Data<ContractInfo> = call_view(
        &contract_id,
        "get_contract_info",
        json!({}),
        &network_config,
    )
    .await?;
    assert_eq!(contract_info.data.owner_id, genesis_account_id);

    Ok(())
}

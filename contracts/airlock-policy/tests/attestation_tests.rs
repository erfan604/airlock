mod common;

use airlock_policy::{AgentRemovalReason, AgentValidity, AgentView};
use common::*;
use near_api::Data;
use serde_json::json;
use shade_attestation::attestation::create_mock_dstack_attestation;
use tokio::time::{Duration, sleep};

/// The read-only view `is_agent_valid` (AIR-041: it replaces the probe through the deleted `request_signature`).
async fn agent_is_valid(
    contract_id: &near_api::AccountId,
    network_config: &near_api::NetworkConfig,
    account_id: &near_api::AccountId,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let valid: Data<bool> = call_view(
        contract_id,
        "is_agent_valid",
        json!({ "account_id": account_id }),
        network_config,
    )
    .await?;
    Ok(valid.data)
}

/// Tests measurements/PPID lifecycle with multiple agents, probing validity through the `is_agent_valid` view:
/// - Verifies that measurements removal affects all registered agents (validity -> Invalid with InvalidMeasurements)
/// - Ensures agents with removed measurements and PPID are invalid with both InvalidMeasurements and InvalidPpid reasons,
///   and that the view removes nothing (the lazy removal belongs to the gate, AIR-061)
/// - Ensures agents with removed PPID only are invalid with the InvalidPpid reason
/// - Confirms that re-approving measurements and PPID makes the registered agents valid again
/// - Validates that an agent the owner removed cannot be re-registered once it left the whitelist
#[tokio::test]
async fn test_measurements_and_ppid_lifecycle()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // Create multiple agents
    let (agent1_id, agent1_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent1",
    )
    .await?;

    let (agent2_id, agent2_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent2",
    )
    .await?;

    let (agent3_id, agent3_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent3",
    )
    .await?;

    // Default measurements and PPID already approved by deploy_contract_default

    // Whitelist and register all three agents
    for (agent_id, agent_signer) in [
        (&agent1_id, &agent1_signer),
        (&agent2_id, &agent2_signer),
        (&agent3_id, &agent3_signer),
    ] {
        let _ = call_transaction(
            &contract_id,
            "whitelist_agent_for_local",
            json!({
                "account_id": agent_id
            }),
            &genesis_account_id,
            &genesis_signer,
            &network_config,
            None,
        )
        .await?
        .assert_success();

        // Register agent with 0.005 NEAR deposit
        let _ = call_transaction(
            &contract_id,
            "register_agent",
            json!({
                "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
            }),
            agent_id,
            agent_signer,
            &network_config,
            Some(common::DEPOSIT_005_NEAR),
        )
        .await?
        .assert_success();
    }

    sleep(Duration::from_millis(300)).await;

    // Verify agent is valid (approved measurements and PPID)
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({ "account_id": agent1_id }),
        &network_config,
    )
    .await?;
    let agent = agent_info.data.unwrap();
    assert!(
        matches!(agent.validity, AgentValidity::Valid),
        "Agent should have approved measurements and PPID"
    );

    // Remove default measurements
    let _ = call_transaction(
        &contract_id,
        "remove_measurements",
        json!({ "measurements": default_measurements_json() }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify measurements removal affected agent (invalid due to measurements, not PPID)
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({ "account_id": agent1_id }),
        &network_config,
    )
    .await?;
    let agent = agent_info.data.unwrap();
    assert!(
        matches!(agent.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::InvalidMeasurements)),
        "Measurements should be unapproved, PPID still approved"
    );

    // Remove default PPID so agent has both invalid measurements and invalid PPID
    let _ = call_transaction(
        &contract_id,
        "remove_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // The agent is invalid now, for both reasons. The view reads only: nothing is removed
    assert!(
        !agent_is_valid(&contract_id, &network_config, &agent1_id).await?,
        "Agent1 must not be valid without approved measurements and PPID"
    );
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent1_id
        }),
        &network_config,
    )
    .await?;
    let agent = agent_info
        .data
        .expect("Agent1 stays registered: is_agent_valid is read only");
    assert!(
        matches!(agent.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::InvalidMeasurements) && r.contains(&AgentRemovalReason::InvalidPpid)),
        "Agent1 should be invalid for both InvalidMeasurements and InvalidPpid"
    );

    // Remove agent3 from agents map
    let _ = call_transaction(
        &contract_id,
        "remove_agent",
        json!({
            "account_id": agent3_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify agent3 is removed (no longer in agents map)
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent3_id
        }),
        &network_config,
    )
    .await?;

    assert!(agent_info.data.is_none(), "Agent3 should be removed");

    // Remove agent3 from whitelist so they cannot re-register
    let _ = call_transaction(
        &contract_id,
        "remove_agent_from_whitelist_for_local",
        json!({
            "account_id": agent3_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Try to register agent3 again - should fail (no longer whitelisted)
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent3_id,
        &agent3_signer,
        &network_config,
        Some(common::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_failure();

    // Re-approve measurements and PPID (both were removed earlier)
    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_measurements_default_args(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    let _ = call_transaction(
        &contract_id,
        "approve_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify agent2 still exists and is valid again
    let agent2_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent2_id
        }),
        &network_config,
    )
    .await?;

    let agent2 = agent2_info.data.unwrap();
    assert!(
        matches!(agent2.validity, AgentValidity::Valid),
        "Agent2 should have approved measurements and PPID again"
    );

    // Agents 1 and 2 stayed registered, so they are valid again; agent3 was removed by the owner
    assert!(agent_is_valid(&contract_id, &network_config, &agent1_id).await?);
    assert!(agent_is_valid(&contract_id, &network_config, &agent2_id).await?);
    assert!(
        !agent_is_valid(&contract_id, &network_config, &agent3_id).await?,
        "Agent3 was removed, so it is not valid"
    );

    // Now test PPID removal
    // Remove default PPID
    let _ = call_transaction(
        &contract_id,
        "remove_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify agent2 exists with invalid validity (InvalidPpid) before testing PPID removal
    let agent2_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent2_id
        }),
        &network_config,
    )
    .await?;

    let agent2 = agent2_info.data.unwrap();
    assert!(
        matches!(agent2.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::InvalidPpid) && !r.contains(&AgentRemovalReason::InvalidMeasurements)),
        "Agent2 should have approved measurements but not approved PPID"
    );

    // Only the PPID is gone: agent2 is invalid, agent1 as well, and neither is removed by the view
    assert!(!agent_is_valid(&contract_id, &network_config, &agent2_id).await?);
    assert!(!agent_is_valid(&contract_id, &network_config, &agent1_id).await?);
    let agent2_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent2_id
        }),
        &network_config,
    )
    .await?;
    assert!(
        agent2_info.data.is_some(),
        "Agent2 stays registered: is_agent_valid is read only"
    );

    // Re-approve PPID
    let _ = call_transaction(
        &contract_id,
        "approve_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // With the PPID approved again agents 1 and 2 are valid; agent3 (removed by the owner) is still not
    assert!(agent_is_valid(&contract_id, &network_config, &agent1_id).await?);
    assert!(agent_is_valid(&contract_id, &network_config, &agent2_id).await?);
    assert!(!agent_is_valid(&contract_id, &network_config, &agent3_id).await?);

    Ok(())
}

/// Verifies that registration fails when default measurements or default PPID are not approved.
/// In local mode, agents must register with default measurements and default PPID; approving
/// only non-default values should cause registration to fail.
#[tokio::test]
async fn test_register_fails_without_default_measurements_or_ppid()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent",
    )
    .await?;

    // Whitelist the agent
    let _ = call_transaction(
        &contract_id,
        "whitelist_agent_for_local",
        json!({ "account_id": agent_id }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // Remove default measurements and approve only non-default ones
    let _ = call_transaction(
        &contract_id,
        "remove_measurements",
        json!({ "measurements": default_measurements_json() }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_non_default_measurements_args(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Try to register - should fail (default measurements not approved)
    let result = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(common::DEPOSIT_005_NEAR),
    )
    .await?
    .into_result();

    match result {
        Ok(_) => panic!("Expected register_agent to fail when default measurements not approved"),
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Default measurements must be approved for local mode"),
                "Expected 'Default measurements must be approved for local mode', got: {}",
                error_str
            );
        }
    }

    // Re-approve default measurements
    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_measurements_default_args(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // Remove default PPID and approve only non-default one
    let _ = call_transaction(
        &contract_id,
        "remove_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    let _ = call_transaction(
        &contract_id,
        "approve_ppids",
        non_default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Try to register - should fail (default PPID not approved)
    let result = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(common::DEPOSIT_005_NEAR),
    )
    .await?
    .into_result();

    match result {
        Ok(_) => panic!("Expected register_agent to fail when default PPID not approved"),
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Default PPID must be approved for local mode"),
                "Expected 'Default PPID must be approved for local mode', got: {}",
                error_str
            );
        }
    }

    Ok(())
}

/// Tests attestation expiration using sandbox fast_forward and verifies agent can re-register afterwards
#[tokio::test]
async fn test_attestation_expiration() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // Create and register agent
    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent",
    )
    .await?;

    let _ = call_transaction(
        &contract_id,
        "whitelist_agent_for_local",
        json!({
            "account_id": agent_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // Register agent with 0.005 NEAR deposit
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(common::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Check agent info - should not be expired
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    let agent = agent_info.data.unwrap();
    assert!(
        matches!(agent.validity, AgentValidity::Valid),
        "Agent should be valid (not expired)"
    );

    // Fast forward time past expiration (attestation_expiration_time_ms is 100000 ms = 100 seconds)
    // NEAR blocks are produced roughly every 1 second, so we need at least 100 blocks for 100 seconds
    // Fast forward by 500 blocks to ensure we're well past expiration
    sandbox.fast_forward(500).await?;

    sleep(Duration::from_millis(200)).await;

    // Check agent info - should be expired
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    let agent = agent_info.data.unwrap();
    assert!(
        matches!(agent.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::ExpiredAttestation)),
        "Agent should not be valid (expired)"
    );

    // The view reports the expired agent invalid and removes nothing
    assert!(
        !agent_is_valid(&contract_id, &network_config, &agent_id).await?,
        "Agent should not be valid (expired)"
    );
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;
    assert!(
        agent_info.data.is_some(),
        "Agent stays registered: is_agent_valid is read only"
    );

    // Agent is still whitelisted, so it can register again after expiration (re-registration needs no new storage stake)
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(common::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify agent is registered again and valid
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    let agent = agent_info.data.unwrap();
    assert!(
        matches!(agent.validity, AgentValidity::Valid),
        "Agent should be valid after re-registration"
    );
    assert!(agent_is_valid(&contract_id, &network_config, &agent_id).await?);

    Ok(())
}

/// First-time `register_agent` must attach storage stake; zero deposit fails until then.
#[tokio::test]
async fn test_register_agent_new_agent_requires_storage_deposit_integration()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "deposit_flow_agent",
    )
    .await?;

    let _ = call_transaction(
        &contract_id,
        "whitelist_agent_for_local",
        json!({
            "account_id": agent_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // No attached deposit on first register → must fail (storage required)
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?
    .assert_failure();

    // First successful registration with storage deposit
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(common::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({ "account_id": agent_id }),
        &network_config,
    )
    .await?;
    let agent = agent_info
        .data
        .expect("agent should be registered after first success");
    assert!(
        matches!(agent.validity, AgentValidity::Valid),
        "Agent should be valid after first registration"
    );

    Ok(())
}

#[tokio::test]
async fn test_register_agent_reregister_without_storage_deposit_integration()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "deposit_reregister_agent",
    )
    .await?;

    let _ = call_transaction(
        &contract_id,
        "whitelist_agent_for_local",
        json!({
            "account_id": agent_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(common::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({ "account_id": agent_id }),
        &network_config,
    )
    .await?;
    let agent = agent_info.data.expect("agent should still be registered");
    assert!(
        matches!(agent.validity, AgentValidity::Valid),
        "Agent should remain valid after zero-deposit re-register"
    );

    Ok(())
}

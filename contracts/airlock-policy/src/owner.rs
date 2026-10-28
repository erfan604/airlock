use crate::*;

// Every owner method is `#[payable]` and calls `self.owner_call()` as its first statement: exactly 1 yoctoNEAR and the owner as
// caller (a method without `#[payable]` would fail the one yocto call with `Method X doesn't accept deposit`).
// AIR-041 deletes `update_owner_id`, `update_mpc_contract_id` and `update_contract`; until then no owner method skips the rule.
#[near]
impl Contract {
    // Update the attestation expiration time
    #[payable]
    pub fn update_attestation_expiration_time(&mut self, attestation_expiration_time_ms: U64) {
        self.owner_call();
        self.attestation_expiration_time_ms = attestation_expiration_time_ms.into();
    }

    // Update the owner account ID
    #[payable]
    pub fn update_owner_id(&mut self, owner_id: AccountId) {
        self.owner_call();
        self.owner_id = owner_id;
    }

    // Update the MPC contract ID
    #[payable]
    pub fn update_mpc_contract_id(&mut self, mpc_contract_id: AccountId) {
        self.owner_call();
        self.mpc_contract_id = mpc_contract_id;
    }

    // Add a new set of measurements to the approved list
    #[payable]
    pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.owner_call();
        self.approved_measurements.insert(measurements);
    }

    // Remove a set of measurements from the approved list
    #[payable]
    pub fn remove_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.owner_call();
        require!(
            self.approved_measurements.remove(&measurements),
            "Measurements not in approved list"
        );
    }

    // Add an array of PPIDs to the approved list
    #[payable]
    pub fn approve_ppids(&mut self, ppids: Vec<Ppid>) {
        self.owner_call();
        for id in ppids {
            self.approved_ppids.insert(id);
        }
    }

    // Remove an array of PPIDs from the approved list.
    #[payable]
    pub fn remove_ppids(&mut self, ppids: Vec<Ppid>) {
        self.owner_call();
        for id in ppids {
            require!(self.approved_ppids.remove(&id), "PPID not in approved list");
        }
    }

    // Remove an agent from the registered list
    #[payable]
    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.owner_call();
        require!(
            self.agents.remove(&account_id).is_some(),
            "Agent not registered"
        );
        Event::AgentRemoved {
            account_id: &account_id,
            reasons: vec![AgentRemovalReason::ManualRemoval],
        }
        .emit();
    }

    // Function to update the contract code
    // Input format: [gas_bytes (8 bytes u64 little-endian)] + [wasm_code_bytes...]
    // See tests/update_contract_tests.rs for an example of how to call this function
    #[payable]
    pub fn update_contract(&mut self) -> Promise {
        self.owner_call();

        let input = env::input().expect("Error: No input").to_vec();

        require!(
            input.len() >= 8,
            "Input must be at least 8 bytes: first 8 bytes are gas (u64), followed by WASM code"
        );

        // First 8 bytes are gas (u64 in little-endian)
        let gas_bytes: [u8; 8] = input[0..8].try_into().unwrap();
        let gas_tgas = u64::from_le_bytes(gas_bytes);

        // Rest is the WASM code
        let code = input[8..].to_vec();

        require!(!code.is_empty(), "WASM code cannot be empty");

        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate".to_string(),
                b"".to_vec(),
                NearToken::from_near(0),
                Gas::from_tgas(gas_tgas),
            )
            .as_return()
    }

    // Local only functions

    // Whitelist an agent, it will still need to register afterwards
    #[payable]
    pub fn whitelist_agent_for_local(&mut self, account_id: AccountId) {
        self.owner_call();
        if self.requires_tee {
            panic!("Whitelisting agents is not supported for TEE");
        }
        // Only insert if not already whitelisted
        self.whitelisted_agents_for_local.insert(account_id);
    }

    // Remove an agent from the list of whitelisted agents
    #[payable]
    pub fn remove_agent_from_whitelist_for_local(&mut self, account_id: AccountId) {
        self.owner_call();
        if self.requires_tee {
            panic!("Removing agents from the whitelist is not supported for TEE");
        }
        require!(
            self.whitelisted_agents_for_local.remove(&account_id),
            "Agent not in whitelist for local"
        );
    }
}

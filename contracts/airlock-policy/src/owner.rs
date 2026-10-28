use crate::*;

// Every owner method is `#[payable]` and calls `self.owner_call()` as its first statement: exactly 1 yoctoNEAR and the owner as
// caller (a method without `#[payable]` would fail the one yocto call with `Method X doesn't accept deposit`).
// The owner and the signer contract are fixed at `new` (AB7): there is no method that changes either, and no upgrade method.
#[near]
impl Contract {
    // Update the attestation expiration time
    #[payable]
    pub fn update_attestation_expiration_time(&mut self, attestation_expiration_time_ms: U64) {
        self.owner_call();
        self.attestation_expiration_time_ms = attestation_expiration_time_ms.into();
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

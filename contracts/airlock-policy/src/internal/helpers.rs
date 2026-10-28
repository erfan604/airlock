use crate::*;
use near_sdk::assert_one_yocto;

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentRemovalReason {
    ManualRemoval,
    ExpiredAttestation,
    InvalidMeasurements,
    InvalidPpid,
    NotWhitelistedForLocal,
    // AIR-046: the owner has not allowed the account (`allow_agent`). `check_invalid_reasons` never returns it, so no registration
    // is ever removed for it; only `fail_on_invalid_agent` takes it, from `require_valid_agent`.
    NotAllowed,
}

impl Contract {
    // The guard of every owner method, called as its first statement: exactly one yoctoNEAR attached, then the predecessor is
    // the owner. One yocto cannot be attached by a function-call key, so only a full-access key (an explicit wallet
    // confirmation) can edit policy; a leaked function-call key cannot (NEAR audit detector `yocto-attach`).
    // `assert_one_yocto` runs first, so a stranger with no deposit is told about the deposit. Only `pub fn` items of a `#[near]`
    // impl are exported, so this plain `impl` function is not a contract method.
    pub(crate) fn owner_call(&mut self) {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Caller is not the owner"
        );
    }

    pub(crate) fn check_invalid_reasons(
        &self,
        account_id: &AccountId,
        agent: &Agent,
    ) -> Vec<AgentRemovalReason> {
        let mut reasons = Vec::new();
        if agent.valid_until_ms < block_timestamp_ms() {
            reasons.push(AgentRemovalReason::ExpiredAttestation);
        }
        if !self.approved_measurements.contains(&agent.measurements) {
            reasons.push(AgentRemovalReason::InvalidMeasurements);
        }
        if !self.approved_ppids.contains(&agent.ppid) {
            reasons.push(AgentRemovalReason::InvalidPpid);
        }
        if !self.requires_tee && !self.whitelisted_agents_for_local.contains(account_id) {
            reasons.push(AgentRemovalReason::NotWhitelistedForLocal);
        }
        reasons
    }
}

#[near]
impl Contract {
    #[private]
    pub fn fail_on_invalid_agent(reasons: Vec<AgentRemovalReason>) {
        env::panic_str(&format!("Invalid agent: {:?}", reasons));
    }
}

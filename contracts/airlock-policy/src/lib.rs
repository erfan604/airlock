// adapted from NearDeFi/shade-agent-template@816b75b agent-contract/ (Apache-2.0): this crate is a fork of the Shade Agent
// template contract. LICENSE and NOTICE.txt are next to Cargo.toml; docs/THIRD_PARTY.md lists what changed. The struct is
// still called `Contract`.
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    env::{self, block_timestamp_ms},
    json_types::U64,
    log, near, require,
    serde::Serialize,
    serde_json,
    store::{IterableMap, IterableSet, LookupMap, LookupSet},
};
use shade_attestation::{
    attestation::{AcceptedDstackAttestation, DstackAttestation},
    measurements::{FullMeasurements, FullMeasurementsHex, create_mock_full_measurements_hex},
    report_data::ReportData,
    tcb_info::HexBytes,
};

pub use internal::events::Event;
pub use internal::helpers::AgentRemovalReason;
pub use policy::{Flags, FlagsJson, PolicyView};
pub use views::{AgentValidity, AgentView, ContractInfo};

// Modules are `pub` and every helper without a caller yet is `pub`, so `cargo clippy -D warnings` does not flag a helper whose
// caller lands in a later ticket (a private unused item is a `dead_code` error, a `pub` one in a `pub mod` is not).
pub mod internal;
pub mod owner;
pub mod policy;
pub mod request;
pub mod task;
#[cfg(test)]
pub mod testutil;
pub mod views;

pub type Ppid = HexBytes<16>;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: u64,
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub approved_measurements: IterableSet<FullMeasurementsHex>,
    pub approved_ppids: IterableSet<Ppid>,
    pub agents: IterableMap<AccountId, Agent>,
    pub whitelisted_agents_for_local: IterableSet<AccountId>,
    // AIR-040. The state layout is final before the first testnet deploy (AIR-048), because there is no `migrate`: later tickets
    // add their fields in the order of the table in plan/tickets/AIR-040 (assets, asset_symbols, book, ...).
    pub paused: bool,
    pub flags: Flags,
    // AIR-045: the owner's one Ed25519 task key (32 raw bytes), the revoked task hashes, and the request ids created per task hash
    // (entries are never removed, they are bounded by the tasks the owner signs). In the layout table they come after `book`
    // (AIR-043) and before `allowed_agents` (AIR-046): the ticket that adds the fields in between inserts them above these three.
    pub task_key: Option<[u8; 32]>,
    pub revoked_tasks: LookupSet<[u8; 32]>,
    pub task_actions: LookupMap<[u8; 32], u8>,
    // AIR-063: every submitted request by its derived id (the record is also the used marker of the id), and the next short number
    // of an escalation (numbers are never reused). In the layout table `records` and `next_pending_no` come after the ledgers
    // (AIR-062) and before `pending_by_no` (AIR-080): the ticket that adds the fields in between inserts them above these two.
    pub records: LookupMap<String, request::RequestRecord>,
    pub next_pending_no: u32,
}

#[near(serializers = [borsh])]
pub struct Agent {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: u64,
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    ApprovedMeasurements,
    ApprovedPpids,
    Agents,
    WhitelistedAgentsForLocal,
    // AIR-045 (the table puts them after `Book` and before `AllowedAgents`).
    RevokedTasks,
    TaskActions,
    // AIR-063. Later tickets insert theirs above it where the layout table in AIR-040 puts them (before the first deploy, AIR-048).
    Records,
}

const STORAGE_BYTES_TO_REGISTER: u128 = 486;

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(
        requires_tee: bool,
        attestation_expiration_time_ms: U64,
        owner_id: AccountId,
        mpc_contract_id: AccountId,
    ) -> Self {
        Self {
            requires_tee,
            attestation_expiration_time_ms: attestation_expiration_time_ms.into(),
            owner_id,
            mpc_contract_id, // Set to v1.signer-prod.testnet for testnet, v1.signer for mainnet
            approved_measurements: IterableSet::new(StorageKey::ApprovedMeasurements),
            approved_ppids: IterableSet::new(StorageKey::ApprovedPpids),
            agents: IterableMap::new(StorageKey::Agents),
            whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
            paused: false,
            flags: Flags::default(),
            task_key: None,
            revoked_tasks: LookupSet::new(StorageKey::RevokedTasks),
            task_actions: LookupMap::new(StorageKey::TaskActions),
            records: LookupMap::new(StorageKey::Records),
            next_pending_no: 1,
        }
    }

    // Register an agent, this needs to be called by the agent itself
    #[payable]
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        let predecessor = env::predecessor_account_id();
        let already_registered = self.agents.get(&predecessor).is_some();

        // New agents must cover storage; re-registration only updates existing state (no extra storage)
        if !already_registered {
            // You should update the STORAGE_BYTES_TO_REGISTER const if you store more data
            let storage_cost = env::storage_byte_cost()
                .checked_mul(STORAGE_BYTES_TO_REGISTER)
                .unwrap();
            require!(
                env::attached_deposit() >= storage_cost,
                &format!(
                    "Attached deposit must be greater than storage cost {:?}",
                    storage_cost.exact_amount_display()
                )
            );
        }

        // Verify the attestation and get the measurements and PPID for the agent
        let (measurements, ppid, advisory_ids) = self.verify_attestation(attestation);

        let valid_until_ms = block_timestamp_ms() + self.attestation_expiration_time_ms;
        let (advisory_ids_truncated, number_of_advisory_ids) =
            internal::events::summarize_advisory_ids(&advisory_ids);

        Event::AgentRegistered {
            account_id: &predecessor,
            measurements: &measurements,
            ppid: &ppid,
            advisory_ids_truncated,
            number_of_advisory_ids,
            current_time_ms: U64::from(block_timestamp_ms()),
            valid_until_ms: U64::from(valid_until_ms),
        }
        .emit();

        // Register the agent
        self.agents.insert(
            predecessor,
            Agent {
                measurements,
                ppid,
                valid_until_ms,
            },
        );

        true
    }
}

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
pub mod agents;
pub mod gate;
pub mod internal;
pub mod keys;
pub mod ledgers;
pub mod nonces;
pub mod owner;
pub mod policy;
pub mod request;
pub mod task;
#[cfg(test)]
pub mod testutil;
pub mod time;
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
    // AIR-042: the payable assets by id, and the lowercase display symbol of each (unique across the registry). In the layout table
    // they come right after `flags`, above `book` (AIR-043) and the task key.
    pub assets: IterableMap<String, policy::AssetEntry>,
    pub asset_symbols: LookupMap<String, String>,
    // AIR-043: the payees by canonical key (after the asset registry in the layout table, above the task key).
    pub book: IterableMap<String, policy::BookEntry>,
    // AIR-045: the owner's one Ed25519 task key (32 raw bytes), the revoked task hashes, and the request ids created per task hash
    // (entries are never removed, they are bounded by the tasks the owner signs). In the layout table they come after `book`
    // (AIR-043) and before `allowed_agents` (AIR-046): the ticket that adds the fields in between inserts them above these three.
    pub task_key: Option<[u8; 32]>,
    pub revoked_tasks: LookupSet<[u8; 32]>,
    pub task_actions: LookupMap<[u8; 32], u8>,
    // AIR-046: the agents the owner allowed, with the fingerprint he compared (after `task_actions` in the layout table).
    pub allowed_agents: IterableMap<AccountId, agents::AllowedAgent>,
    // AIR-062: the four ledgers (src/ledgers.rs). The three day ledgers hold `(day, spent)` and a value from an earlier day reads as 0, so
    // they are bounded by the number of assets and payees; the task ledger is keyed by (task hash, payee key) and never freed.
    pub asset_spent: LookupMap<String, ledgers::DayValue>,
    pub payee_spent: LookupMap<String, ledgers::DayValue>,
    pub payee_untrusted_spent: LookupMap<String, ledgers::DayValue>,
    pub task_spent: LookupMap<([u8; 32], String), u128>,
    // AIR-063: every submitted request by its derived id (the record is also the used marker of the id), and the next short number
    // of an escalation (numbers are never reused). In the layout table `records` and `next_pending_no` come after the ledgers
    // (AIR-062) and before `pending_by_no` (AIR-080): the ticket that adds the fields in between inserts them above these two.
    pub records: LookupMap<String, request::RequestRecord>,
    pub next_pending_no: u32,
    // AIR-104: the next EVM nonce to hand out per registry `path`, and the one transaction each request id was signed as (entries of
    // `evm_attempts` are never removed, they are bounded by the EVM requests the owner's tasks admit). In the layout table they are
    // the last two fields, after `flood` (AIR-083): the tickets that add fields in between insert them above these two.
    pub nonces: LookupMap<String, u64>,
    pub evm_attempts: LookupMap<String, nonces::EvmAttempt>,
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
    // AIR-042 (the table puts them right after the template's four)
    Assets,
    AssetSymbols,
    // AIR-043
    Book,
    // AIR-045 (the table puts them after `Book` and before `AllowedAgents`).
    RevokedTasks,
    TaskActions,
    // AIR-046
    AllowedAgents,
    // AIR-062 (the table puts the ledgers after `AllowedAgents` and before `Records`)
    AssetSpent,
    PayeeSpent,
    PayeeUntrustedSpent,
    TaskSpent,
    // AIR-063. Later tickets insert theirs above it where the layout table in AIR-040 puts them (before the first deploy, AIR-048).
    Records,
    // AIR-104 (the table puts them last, after `Flood` of AIR-083: AIR-080 and AIR-083 insert theirs above these two)
    Nonces,
    EvmAttempts,
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
            assets: IterableMap::new(StorageKey::Assets),
            asset_symbols: LookupMap::new(StorageKey::AssetSymbols),
            book: IterableMap::new(StorageKey::Book),
            task_key: None,
            revoked_tasks: LookupSet::new(StorageKey::RevokedTasks),
            task_actions: LookupMap::new(StorageKey::TaskActions),
            allowed_agents: IterableMap::new(StorageKey::AllowedAgents),
            asset_spent: LookupMap::new(StorageKey::AssetSpent),
            payee_spent: LookupMap::new(StorageKey::PayeeSpent),
            payee_untrusted_spent: LookupMap::new(StorageKey::PayeeUntrustedSpent),
            task_spent: LookupMap::new(StorageKey::TaskSpent),
            records: LookupMap::new(StorageKey::Records),
            next_pending_no: 1,
            nonces: LookupMap::new(StorageKey::Nonces),
            evm_attempts: LookupMap::new(StorageKey::EvmAttempts),
        }
    }

    // Register an agent, this needs to be called by the agent itself
    #[payable]
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        let predecessor = env::predecessor_account_id();
        let already_registered = self.agents.get(&predecessor).is_some();

        // New agents must cover storage; re-registration only updates existing state (no extra storage).
        // What the call does not keep goes back to the agent (AIR-046): the storage cost of a first registration stays with the
        // contract, everything else is refunded below. A removed agent's storage deposit is not returned (the only payer is the
        // owner's own agent account).
        let mut kept = NearToken::from_yoctonear(0);
        if !already_registered {
            // You should update the STORAGE_BYTES_TO_REGISTER const if you store more data
            let storage_cost = env::storage_byte_cost()
                .checked_mul(STORAGE_BYTES_TO_REGISTER)
                .unwrap();
            kept = storage_cost;
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
            predecessor.clone(),
            Agent {
                measurements,
                ppid,
                valid_until_ms,
            },
        );

        // Refund the deposit minus the storage it pays for (all of it on a re-registration) with a detached transfer
        let excess = env::attached_deposit()
            .as_yoctonear()
            .saturating_sub(kept.as_yoctonear());
        if excess > 0 {
            Promise::new(predecessor)
                .transfer(NearToken::from_yoctonear(excess))
                .detach();
        }

        true
    }
}

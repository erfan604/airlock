// In-process test helpers shared by the unit tests of AIR-040, 060, 062, 063 and 080. `#[cfg(test)]` (see lib.rs), so it is
// invisible to the sandbox tests in `tests/`.
use crate::*;
use near_sdk::NearToken;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use shade_attestation::measurements::create_mock_full_measurements_hex;

/// The contract account of every in-process test.
pub const POLICY: &str = "policy.test.near";
/// The owner `fresh()` initializes.
pub const OWNER: &str = "owner.test.near";
/// The signer contract `fresh()` initializes.
pub const MPC: &str = "mpc.test.near";

/// A call context: current account `policy.test.near`, the given predecessor (also the signer), block time `now_ms`
/// milliseconds (the VM wants nanoseconds) and the attached deposit in yoctoNEAR.
pub fn ctx(predecessor: &str, now_ms: u64, deposit_yocto: u128) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(POLICY.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto));
    builder
}

/// What the template's `setup_contract` does: a local-mode contract (`requires_tee = false`, attestation lifetime 100 s) owned by
/// `OWNER`, with the default measurements and PPID approved. The test environment is left as the owner's call with 1 yocto.
pub fn fresh() -> Contract {
    testing_env!(ctx(OWNER, 1_000, 1).build());
    let mut contract = Contract::new(
        false,
        U64(100_000),
        OWNER.parse().unwrap(),
        MPC.parse().unwrap(),
    );
    contract.approve_measurements(create_mock_full_measurements_hex());
    contract.approve_ppids(vec![Ppid::default()]);
    contract
}

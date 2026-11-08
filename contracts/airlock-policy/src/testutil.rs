// In-process test helpers shared by the unit tests of AIR-040, 060, 062, 063 and 080. `#[cfg(test)]` (see lib.rs), so it is
// invisible to the sandbox tests in `tests/`.
use crate::*;
use ed25519_dalek::{Signer, SigningKey};
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
        None,
        None,
    );
    contract.approve_measurements(create_mock_full_measurements_hex());
    contract.approve_ppids(vec![Ppid::default()]);
    contract
}

/// The seed of the test task key: 32 bytes of 01, the seed of the `owner_task` vector (so the key is the vector's public key).
pub const TASK_SEED: [u8; 32] = [1; 32];

/// The 32 raw bytes of the public key of `TASK_SEED`: what `set_task_key` stores.
pub fn task_public_key() -> [u8; 32] {
    SigningKey::from_bytes(&TASK_SEED)
        .verifying_key()
        .to_bytes()
}

/// The signature of the test task key over the borsh bytes of the task (no prefix): what the console sends with a task.
pub fn sign(task: &crate::task::OwnerTask) -> Vec<u8> {
    SigningKey::from_bytes(&TASK_SEED)
        .sign(&crate::task::task_bytes(task))
        .to_bytes()
        .to_vec()
}

/// AIR-326: the book root and the proof for a book that holds one payee (salt `[1; 32]`, filler seed `[7; 32]`). The tests that used to
/// `book.insert` set `c.book_root` to this root and attach the proof to the requests that pay the payee.
pub fn one_book(payee: &str, e: &crate::policy::BookEntry) -> ([u8; 32], crate::book::BookProof) {
    let entry = crate::book::Entry {
        salt: [1; 32],
        payee: payee.to_string(),
        cap: e.cap,
        daily_untrusted_budget: e.daily_untrusted_budget,
        daily_limit: e.daily_limit,
    };
    let (root, mut proofs) = crate::book::build(&[entry], &[7; 32]);
    (root, proofs.remove(0))
}

/// AIR-327: a contract like `fresh()` with an approver and a sponsor (`None` keeps the default: the owner approves, no sweep).
pub fn fresh_roles(approver: Option<&str>, sponsor: Option<&str>) -> Contract {
    testing_env!(ctx(OWNER, 1_000, 1).build());
    let mut contract = Contract::new(
        false,
        U64(100_000),
        OWNER.parse().unwrap(),
        MPC.parse().unwrap(),
        approver.map(|a| a.parse().unwrap()),
        sponsor.map(|s| s.parse().unwrap()),
    );
    contract.approve_measurements(create_mock_full_measurements_hex());
    contract.approve_ppids(vec![Ppid::default()]);
    contract
}

/// The approver and the sponsor of the AIR-327 tests.
pub const APPROVER: &str = "approver.test.near";
pub const SPONSOR: &str = "sponsor.test.near";

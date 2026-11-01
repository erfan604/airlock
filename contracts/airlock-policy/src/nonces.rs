// AIR-104: the EVM nonce state. The contract, not the runtime, owns the nonce of each derivation path (the `path` of an EVM asset in
// the registry), hands out consecutive values, never takes one back, and remembers the one transaction each request id was signed
// as, so a retry re-signs the same bytes under the same nonce and cannot create a second payment. The owner resyncs the counter
// with `set_nonce`. The reasoning, the recovery steps and the one dangerous move (lowering the counter) are in docs/design/nonce.md.
//
// Nothing here is called by the gate yet: `next_nonce`, `attempt_of` and `record_attempt` are used by the EVM lane (AIR-100), and
// the counter is first set by the owner's setup (AIR-049). Every item is `pub` so `cargo clippy -D warnings` does not flag a
// helper whose caller lands in a later ticket (see lib.rs).
use crate::*;

/// The one transaction a request id was signed as. AIR-100 records it before the first signing call; a retry (SPEC R5-07) signs
/// `unsigned_hex` again under `nonce` and takes no new nonce. `unsigned_hex` is the unsigned EIP-1559 payload the contract built,
/// as lowercase hex.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmAttempt {
    pub path: String,
    pub nonce: u64,
    pub unsigned_hex: String,
}

impl Contract {
    /// True when a registered asset has `path == Some(path)`. A scan of the registry, which holds at most 16 assets.
    pub fn path_registered(&self, path: &str) -> bool {
        self.assets
            .values()
            .any(|asset| asset.path.as_deref() == Some(path))
    }

    /// The next nonce of `path`, and the counter moves up by one. Reverts `nonce not set` when the owner never set a value (the
    /// contract cannot know the chain's count) and `nonce overflow` when the stored value is `u64::MAX` (EIP-2681 caps a nonce at
    /// 2^64 - 2, so `u64::MAX - 1` is the last value issued). The contract never decrements the counter, even when the signing
    /// that used the nonce fails later: other signatures for later nonces may already exist.
    pub fn next_nonce(&mut self, path: &str) -> u64 {
        let stored = *self
            .nonces
            .get(path)
            .unwrap_or_else(|| env::panic_str("nonce not set"));
        require!(stored != u64::MAX, "nonce overflow");
        self.nonces.insert(path.to_string(), stored + 1);
        stored
    }

    /// The attempt recorded for this request id, or `None`.
    pub fn attempt_of(&self, request_id: &str) -> Option<EvmAttempt> {
        self.evm_attempts.get(request_id).cloned()
    }

    /// Records the first signing attempt of a request. Reverts `attempt exists` when the id already has one: an attempt is never
    /// replaced and never removed, so one request id produces at most one transaction.
    pub fn record_attempt(&mut self, request_id: &str, attempt: EvmAttempt) {
        require!(
            !self.evm_attempts.contains_key(request_id),
            "attempt exists"
        );
        self.evm_attempts.insert(request_id.to_string(), attempt);
    }
}

#[near]
impl Contract {
    /// Owner: set the next nonce of an EVM derivation path (after an unbroadcast signature, or an external transaction from the same
    /// address). Reverts `unknown path` unless a registered asset has this path. It may lower or raise the stored value: lowering is
    /// an owner decision with a risk described in docs/design/nonce.md. Emits `nonce_set` with the value as a decimal string.
    #[payable]
    pub fn set_nonce(&mut self, path: String, nonce: U64) {
        self.owner_call();
        require!(self.path_registered(&path), "unknown path");
        self.nonces.insert(path.clone(), nonce.0);
        Event::NonceSet { path: &path, nonce }.emit();
    }

    /// The next nonce `path` will hand out, or `None` when it was never set.
    pub fn get_nonce(&self, path: String) -> Option<U64> {
        self.nonces.get(&path).map(|n| U64(*n))
    }
}

#[cfg(test)]
mod tests {
    use crate::policy::AssetEntry;
    use crate::testutil::{OWNER, ctx, fresh};
    use crate::*;
    use near_sdk::test_utils::get_logs;
    use near_sdk::testing_env;
    use nonces::EvmAttempt;

    const PATH: &str = "base-sepolia-1";
    const EVM_ID: &str = "evm:84532:native";
    const T0_MS: u64 = 1_000;

    fn evm_entry(path: &str) -> AssetEntry {
        AssetEntry {
            symbol: "ETH.base".to_string(),
            decimals: 18,
            hard_cap: 1_000_000_000_000_000_000,
            daily_cap: 10_000_000_000_000_000_000,
            max_fee_per_gas: 50_000_000_000,
            max_gas: 100_000,
            quick_task_cap: 5_000_000_000_000_000_000,
            path: Some(path.to_string()),
        }
    }

    /// A contract with the EVM asset `evm:84532:native` on path `base-sepolia-1`, called as the owner with 1 yocto.
    fn setup() -> Contract {
        let mut c = fresh();
        c.assets.insert(EVM_ID.to_string(), evm_entry(PATH));
        as_owner();
        c
    }

    fn as_owner() {
        testing_env!(ctx(OWNER, T0_MS, 1).build());
    }

    fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default()
    }

    /// The revert text of `f`; fails the test when `f` succeeds.
    fn reverts<R>(f: impl FnOnce() -> R) -> String {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(_) => panic!("expected a revert, the call succeeded"),
            Err(payload) => panic_text(payload),
        }
    }

    fn attempt(nonce: u64) -> EvmAttempt {
        EvmAttempt {
            path: PATH.to_string(),
            nonce,
            unsigned_hex: format!("02{nonce:02x}"),
        }
    }

    #[test]
    fn nonces_consecutive_values_0_1_2() {
        let mut c = setup();
        c.set_nonce(PATH.to_string(), U64(0));
        assert_eq!(c.next_nonce(PATH), 0);
        assert_eq!(c.next_nonce(PATH), 1);
        assert_eq!(c.next_nonce(PATH), 2);
        // the stored value is the next one to hand out
        assert_eq!(c.get_nonce(PATH.to_string()), Some(U64(3)));
    }

    #[test]
    fn nonces_paths_are_independent() {
        let mut c = setup();
        c.assets.insert("evm:1:native".to_string(), {
            let mut e = evm_entry("other-path");
            e.symbol = "ETH".to_string();
            e
        });
        c.set_nonce(PATH.to_string(), U64(5));
        c.set_nonce("other-path".to_string(), U64(100));
        assert_eq!(c.next_nonce(PATH), 5);
        assert_eq!(c.next_nonce("other-path"), 100);
        assert_eq!(c.next_nonce(PATH), 6);
        assert_eq!(c.get_nonce("other-path".to_string()), Some(U64(101)));
    }

    #[test]
    #[should_panic(expected = "nonce not set")]
    fn nonces_not_set_reverts() {
        let mut c = setup();
        c.next_nonce(PATH);
    }

    #[test]
    #[should_panic(expected = "nonce overflow")]
    fn nonces_overflow_at_max_reverts() {
        let mut c = setup();
        c.set_nonce(PATH.to_string(), U64(u64::MAX));
        c.next_nonce(PATH);
    }

    #[test]
    fn nonces_max_minus_one_is_issued_then_overflow() {
        let mut c = setup();
        c.set_nonce(PATH.to_string(), U64(u64::MAX - 1));
        assert_eq!(c.next_nonce(PATH), u64::MAX - 1);
        assert_eq!(c.get_nonce(PATH.to_string()), Some(U64(u64::MAX)));
        let text = reverts(|| c.next_nonce(PATH));
        assert!(text.contains("nonce overflow"), "{text}");
        // u64::MAX is never handed out, and the stored value did not move
        assert_eq!(c.get_nonce(PATH.to_string()), Some(U64(u64::MAX)));
    }

    #[test]
    fn nonces_set_nonce_can_lower() {
        // an owner decision (docs/design/nonce.md): set_nonce may move the counter down as well as up
        let mut c = setup();
        c.set_nonce(PATH.to_string(), U64(10));
        assert_eq!(c.next_nonce(PATH), 10);
        c.set_nonce(PATH.to_string(), U64(3));
        assert_eq!(c.get_nonce(PATH.to_string()), Some(U64(3)));
        assert_eq!(c.next_nonce(PATH), 3);
        c.set_nonce(PATH.to_string(), U64(50));
        assert_eq!(c.next_nonce(PATH), 50);
    }

    #[test]
    fn nonces_get_nonce_unset_is_none() {
        let c = setup();
        assert_eq!(c.get_nonce(PATH.to_string()), None);
    }

    #[test]
    #[should_panic(expected = "attempt exists")]
    fn nonces_record_attempt_twice_reverts() {
        let mut c = setup();
        c.record_attempt("req-1", attempt(0));
        c.record_attempt("req-1", attempt(1));
    }

    #[test]
    fn nonces_attempt_of_unknown_is_none() {
        let c = setup();
        assert_eq!(c.attempt_of("req-unknown"), None);
    }

    #[test]
    fn nonces_record_attempt_keeps_the_first_and_each_id_is_separate() {
        let mut c = setup();
        c.record_attempt("req-1", attempt(7));
        c.record_attempt("req-2", attempt(8));
        assert_eq!(c.attempt_of("req-1"), Some(attempt(7)));
        assert_eq!(c.attempt_of("req-2"), Some(attempt(8)));
        // the second record for req-1 reverts and leaves the first untouched
        let text = reverts(|| c.record_attempt("req-1", attempt(9)));
        assert!(text.contains("attempt exists"), "{text}");
        assert_eq!(c.attempt_of("req-1"), Some(attempt(7)));
    }

    #[test]
    fn nonces_next_nonce_does_not_touch_attempts() {
        // a retry reuses the recorded attempt and takes no new nonce: the counter moves only when next_nonce is called
        let mut c = setup();
        c.set_nonce(PATH.to_string(), U64(0));
        let n = c.next_nonce(PATH);
        c.record_attempt("req-1", attempt(n));
        assert_eq!(c.attempt_of("req-1").unwrap().nonce, 0);
        assert_eq!(c.get_nonce(PATH.to_string()), Some(U64(1)));
    }

    #[test]
    fn nonces_set_nonce_unknown_path_reverts() {
        // no asset has this path
        let mut c = setup();
        let text = reverts(|| c.set_nonce("no-such-path".to_string(), U64(1)));
        assert!(text.contains("unknown path"), "{text}");
        assert_eq!(c.get_nonce("no-such-path".to_string()), None);
        // an asset without a path (near) does not register one
        c.assets.insert(
            "near".to_string(),
            AssetEntry {
                symbol: "NEAR".to_string(),
                decimals: 24,
                hard_cap: 10,
                daily_cap: 100,
                max_fee_per_gas: 0,
                max_gas: 0,
                quick_task_cap: 100,
                path: None,
            },
        );
        let text = reverts(|| c.set_nonce(String::new(), U64(1)));
        assert!(text.contains("unknown path"), "{text}");
        // a path whose asset was removed is unknown again
        c.set_nonce(PATH.to_string(), U64(4));
        c.asset_remove(EVM_ID.to_string());
        let text = reverts(|| c.set_nonce(PATH.to_string(), U64(9)));
        assert!(text.contains("unknown path"), "{text}");
        // the value stored before the removal stays readable, and the revert did not change it
        assert_eq!(c.get_nonce(PATH.to_string()), Some(U64(4)));
    }

    #[test]
    fn nonces_set_nonce_requires_the_owner_and_one_yocto() {
        let mut c = setup();
        testing_env!(ctx("stranger.test.near", T0_MS, 1).build());
        let text = reverts(|| c.set_nonce(PATH.to_string(), U64(1)));
        assert!(text.contains("Caller is not the owner"), "{text}");
        testing_env!(ctx(OWNER, T0_MS, 0).build());
        let text = reverts(|| c.set_nonce(PATH.to_string(), U64(1)));
        assert!(
            text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
            "{text}"
        );
        assert_eq!(c.get_nonce(PATH.to_string()), None);
    }

    #[test]
    fn nonces_set_nonce_emits_one_event_with_a_decimal_string() {
        let mut c = setup();
        c.set_nonce(PATH.to_string(), U64(18_446_744_073_709_551_614));
        assert_eq!(
            get_logs(),
            vec![
                r#"EVENT_JSON:{"standard":"airlock","version":"1.0.0","event":"nonce_set","data":[{"path":"base-sepolia-1","nonce":"18446744073709551614"}]}"#
                    .to_string()
            ]
        );
    }
}

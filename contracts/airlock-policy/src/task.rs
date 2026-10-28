// AIR-045: the owner's task key, `revoke_task` and the `OwnerTask` type. The layout, hash and signature are pinned byte for byte by
// the `owner_task` section of fixtures/verdict-vectors.json (AIR-024); the TypeScript console reproduces the same bytes
// (`ownerTaskBorsh`). Checking a task signature inside `submit_batch` is AIR-060, the verdict inputs from a task are AIR-061.
//
// A task is multi-use until its expiry, its revocation, its bounds or its `max_actions` (SPEC R5-13). The signed message is exactly
// `task_bytes` with no prefix: the `tag` and the `contract_id` inside it are the domain separation. Two tasks with identical content
// have the same hash on purpose: the hash is the task identity and the prefix of every request id under it.
use crate::request::Hex32;
use crate::*;
use near_sdk::json_types::U128;
use near_sdk::{CurveType, PublicKey};

/// The domain tag of a signed task. A task whose tag differs is refused (`OwnerTask::require_tag`).
pub const TASK_TAG: &str = "airlock-task-v1";

/// One payee the task may pay and the most it may pay him in total. The payee key implies the asset (`near:` or `evm:`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskBound {
    pub payee_key: String,
    pub max_total: U128,
}

/// What the owner signs after seeing it. Borsh field order is the order below: a string is a u32 little-endian length plus UTF-8,
/// a `Hex32` is 32 raw bytes, a `U128` is 16 bytes little-endian, an `AccountId` is a string, `bounds` is a u32 count plus the
/// bounds. In JSON the `u64` fields are numbers and the `U128` fields are decimal strings.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerTask {
    pub tag: String,
    pub task_id: String,
    pub contract_id: AccountId,
    pub agent_id: AccountId,
    pub plan_sha256: Hex32,
    pub instruction_sha256_salted: Hex32,
    pub issued_ms: u64,
    pub expires_ms: u64,
    pub max_actions: u8,
    pub bounds: Vec<TaskBound>,
}

impl OwnerTask {
    /// Reverts `bad task tag` unless the tag is `TASK_TAG`. AIR-060 calls it right after the signature check.
    pub fn require_tag(&self) {
        require!(self.tag == TASK_TAG, "bad task tag");
    }
}

/// The borsh bytes of the task: the exact message the owner's key signs, with no prefix.
pub fn task_bytes(t: &OwnerTask) -> Vec<u8> {
    near_sdk::borsh::to_vec(t).unwrap_or_else(|_| env::panic_str("task does not serialize"))
}

/// SHA-256 of `task_bytes`: the identity of the task and the prefix of every request id under it.
pub fn task_hash(t: &OwnerTask) -> [u8; 32] {
    env::sha256_array(task_bytes(t))
}

/// What `get_task_state` answers.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskState {
    pub revoked: bool,
    pub actions_used: u8,
}

/// A task hash argument: exactly 64 lowercase hex characters, otherwise `bad task hash` (the text `get_ledgers` uses).
fn parse_task_hash(text: &str) -> [u8; 32] {
    Hex32::parse(text)
        .unwrap_or_else(|_| env::panic_str("bad task hash"))
        .0
}

impl Contract {
    /// How many request ids of this task were ever created (entries are never removed).
    pub fn actions_used(&self, hash: &[u8; 32]) -> u8 {
        self.task_actions.get(hash).copied().unwrap_or(0)
    }

    /// Adds `n` to the count of the task, reverts `task actions overflow` past 255, and returns the new count. AIR-061 calls it
    /// for new request ids only.
    pub fn add_actions(&mut self, hash: &[u8; 32], n: u8) -> u8 {
        let used = self
            .actions_used(hash)
            .checked_add(n)
            .unwrap_or_else(|| env::panic_str("task actions overflow"));
        self.task_actions.insert(*hash, used);
        used
    }

    /// Whether the owner revoked the task. AIR-060 and AIR-080 call it.
    pub fn is_task_revoked(&self, hash: &[u8; 32]) -> bool {
        self.revoked_tasks.contains(hash)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Task verification (AIR-060). `submit_batch` (AIR-061) calls `verify_task` before it looks at any request, so every `Owner` label of a
// batch is backed by a signature that was verified on chain. Nothing here is exported (a plain `impl`), and nothing here reads the
// block clock: the caller reads `env::block_timestamp_ms()` once and passes it in.
// ---------------------------------------------------------------------------------------------------------------------

/// The most bounds a task may have (the limit is storage and review cost, not gas).
pub const MAX_BOUNDS: usize = 16;

/// One bound of a verified task: the payee, the asset it is paid in (derived from the key) and the most the task may pay it in total.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedBound {
    pub payee_key: String,
    pub asset: String,
    pub max_total: u128,
}

/// What `verify_task` returns: the task hash (the prefix of every request id under it) and its bounds, for the gate's `TaskScope`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedTask {
    pub hash: [u8; 32],
    pub bounds: Vec<VerifiedBound>,
}

impl Contract {
    /// Verifies a task the agent presents. In this order, each failure a revert with the quoted text:
    ///  1. a task key is set (`task key not set`), `sig` is 64 bytes and an Ed25519 signature of `task_bytes` by that key (`bad task
    ///     signature`), then the tag is `airlock-task-v1` (`bad task tag`): the signature is checked before any other field is read;
    ///  2. `contract_id` is this contract (`wrong contract`);
    ///  3. the predecessor is `agent_id` (`wrong agent`);
    ///  4. time, from the `now_ms` the caller passes: `issued_ms <= now_ms` (`task not yet valid`), `now_ms < expires_ms` (`task
    ///     expired`), `expires_ms - issued_ms <= max_task_ttl_ms` (`task ttl too long`), `1 <= max_actions <= max_task_actions` (`bad
    ///     max_actions`);
    ///  5. the bounds (`verify_bounds`);
    ///  6. the task is not revoked (`task revoked`).
    ///
    /// The action limit is not checked here: AIR-061 requires `action_index < max_actions` per request, and a request id is
    /// `<task hash>:<action_index>`, so at most `max_actions` distinct requests exist per task. The allowed-agent check is AIR-061's.
    pub fn verify_task(&self, task: &OwnerTask, sig: &[u8], now_ms: u64) -> VerifiedTask {
        // 1. the signature, before anything else of the task is read
        let key = self
            .task_key
            .unwrap_or_else(|| env::panic_str("task key not set"));
        let sig: [u8; 64] = sig
            .try_into()
            .unwrap_or_else(|_| env::panic_str("bad task signature"));
        let bytes = task_bytes(task);
        require!(
            env::ed25519_verify(&sig, &bytes, &key),
            "bad task signature"
        );
        task.require_tag();
        // 2 and 3. this contract, this agent
        require!(
            task.contract_id == env::current_account_id(),
            "wrong contract"
        );
        require!(
            env::predecessor_account_id() == task.agent_id,
            "wrong agent"
        );
        // 4. time: the ttl is computed only after both time checks passed, so the subtraction cannot underflow
        require!(task.issued_ms <= now_ms, "task not yet valid");
        require!(now_ms < task.expires_ms, "task expired");
        require!(
            task.expires_ms - task.issued_ms <= self.flags.max_task_ttl_ms,
            "task ttl too long"
        );
        require!(
            task.max_actions >= 1 && task.max_actions <= self.flags.max_task_actions,
            "bad max_actions"
        );
        // 5. bounds
        let bounds = self.verify_bounds(task);
        // 6. not revoked
        let hash = env::sha256_array(&bytes);
        require!(!self.is_task_revoked(&hash), "task revoked");
        VerifiedTask { hash, bounds }
    }

    /// Step 5 of `verify_task`, read only (AIR-064's preview reuses it): 1 to 16 bounds (`bad bound count`), no duplicate payee key
    /// (`duplicate bound`), then for each bound in order: the key is canonical (`bad bound key: <KeyError name>`, so an `ft:` key fails
    /// here), its asset is registered (`unknown asset in bound`), `0 < max_total < u128::MAX` (`bad max_total`), `max_total <=
    /// hard_cap * max_actions` (`bound above hard cap times actions`; an overflowing product cannot be exceeded, so it is no limit) and
    /// `max_total <= quick_task_cap` of the asset (`task above quick cap`, R3-09: NEP-413 tasks are not built, so a task signed with
    /// the local key above the cap reverts).
    pub fn verify_bounds(&self, task: &OwnerTask) -> Vec<VerifiedBound> {
        require!(
            (1..=MAX_BOUNDS).contains(&task.bounds.len()),
            "bad bound count"
        );
        for (i, bound) in task.bounds.iter().enumerate() {
            require!(
                !task.bounds[..i]
                    .iter()
                    .any(|earlier| earlier.payee_key == bound.payee_key),
                "duplicate bound"
            );
        }
        let mut verified = Vec::with_capacity(task.bounds.len());
        for bound in &task.bounds {
            if let Err(error) =
                airlock_verdict::keys::validate_payee_key(bound.payee_key.as_bytes())
            {
                env::panic_str(&format!("bad bound key: {error:?}"));
            }
            let asset = crate::keys::asset_for_payee_key(&bound.payee_key);
            let entry = self
                .asset(&asset)
                .unwrap_or_else(|| env::panic_str("unknown asset in bound"));
            let max_total = bound.max_total.0;
            require!(max_total > 0 && max_total != u128::MAX, "bad max_total");
            require!(
                entry
                    .hard_cap
                    .checked_mul(u128::from(task.max_actions))
                    .is_none_or(|cap| max_total <= cap),
                "bound above hard cap times actions"
            );
            require!(max_total <= entry.quick_task_cap, "task above quick cap");
            verified.push(VerifiedBound {
                payee_key: bound.payee_key.clone(),
                asset,
                max_total,
            });
        }
        verified
    }

    /// The bound of the verified task for this payee key, if the task has one.
    pub fn bound_for(&self, vt: &VerifiedTask, payee_key: &str) -> Option<u128> {
        vt.bounds
            .iter()
            .find(|bound| bound.payee_key == payee_key)
            .map(|bound| bound.max_total)
    }
}

#[near]
impl Contract {
    /// Owner: register the Ed25519 key that signs tasks. Replaces any previous key (rotation and several keys are deferred,
    /// AIR-110). Reverts `task key must be ed25519` for another curve and `bad task key` when the text does not parse or the key is
    /// not 32 bytes. A small-order point is not rejected: only the owner's full-access key can set the key and the console shows it.
    /// Emits `task_key_set`.
    #[payable]
    pub fn set_task_key(&mut self, public_key: String) {
        self.owner_call();
        let key: PublicKey = public_key
            .parse()
            .unwrap_or_else(|_| env::panic_str("bad task key"));
        require!(
            key.curve_type() == CurveType::ED25519,
            "task key must be ed25519"
        );
        // the bytes carry the curve byte first
        let raw: [u8; 32] = key
            .as_bytes()
            .get(1..)
            .and_then(|b| b.try_into().ok())
            .unwrap_or_else(|| env::panic_str("bad task key"));
        self.task_key = Some(raw);
        Event::TaskKeySet {
            public_key: String::from(&key),
        }
        .emit();
    }

    /// The registered task key as `ed25519:<base58>`, or `None` before `set_task_key`.
    pub fn get_task_key(&self) -> Option<String> {
        self.task_key.map(|raw| {
            let key = PublicKey::from_parts(CurveType::ED25519, raw.to_vec())
                .unwrap_or_else(|_| env::panic_str("bad task key"));
            String::from(&key)
        })
    }

    /// Owner: revoke a task by its hash (64 lowercase hex characters, otherwise `bad task hash`). Idempotent and final: revoking a
    /// revoked or never seen hash succeeds and emits again. Emits `task_revoked`.
    #[payable]
    pub fn revoke_task(&mut self, task_hash: String) {
        self.owner_call();
        let hash = parse_task_hash(&task_hash);
        self.revoked_tasks.insert(hash);
        Event::TaskRevoked { task_hash }.emit();
    }

    /// Whether a task is revoked and how many request ids were created under it. Same hash rule as `revoke_task`.
    pub fn get_task_state(&self, task_hash: String) -> TaskState {
        let hash = parse_task_hash(&task_hash);
        TaskState {
            revoked: self.is_task_revoked(&hash),
            actions_used: self.actions_used(&hash),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{OWNER, ctx, fresh};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use near_sdk::testing_env;
    use serde_json::Value;

    const VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/verdict-vectors.json"
    ));

    fn vector() -> Value {
        let all: Value = serde_json::from_str(VECTORS).expect("the vector file parses");
        all["owner_task"].clone()
    }

    /// The vector task read through the JSON the console sends (the other keys of the object, `borsh_hex` and the like, are ignored).
    fn vector_task() -> OwnerTask {
        serde_json::from_value(vector()).expect("the vector task is an OwnerTask")
    }

    fn unhex(s: &str) -> Vec<u8> {
        hex::decode(s).expect("hex")
    }

    fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default()
    }

    /// Runs `f` and returns its panic text (fails when it does not panic).
    fn panics<R>(f: impl FnOnce() -> R) -> String {
        let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        match hit {
            Ok(_) => panic!("expected a revert, the call succeeded"),
            Err(payload) => panic_text(payload),
        }
    }

    // ---- the vector --------------------------------------------------------------------------------------------------------

    #[test]
    fn task_bytes_equal_vector_borsh_hex() {
        let v = vector();
        let task = vector_task();
        assert_eq!(
            hex::encode(task_bytes(&task)),
            v["borsh_hex"].as_str().unwrap()
        );
        // field by field, so a mismatch names the layout
        assert_eq!(task.tag, TASK_TAG);
        assert_eq!(task.max_actions, 3);
        assert_eq!(task.bounds.len(), 2);
        assert_eq!(
            task.bounds[0].max_total.0,
            5_000_000_000_000_000_000_000_000
        );
        // borsh strings are a u32 little-endian length plus UTF-8: 15 bytes for the vector task id (12 characters, two of them not ASCII)
        let bytes = task_bytes(&task);
        let tag_len = 4 + TASK_TAG.len();
        assert_eq!(&bytes[tag_len..tag_len + 4], &15u32.to_le_bytes());
    }

    #[test]
    fn task_hash_equals_vector_sha256() {
        let _c = fresh();
        let v = vector();
        assert_eq!(
            hex::encode(task_hash(&vector_task())),
            v["sha256_hex"].as_str().unwrap()
        );
    }

    #[test]
    fn vector_signature_verifies_against_vector_public_key() {
        let _c = fresh();
        let v = vector();
        let message = task_bytes(&vector_task());
        let key: PublicKey = v["public_key"].as_str().unwrap().parse().unwrap();
        assert_eq!(key.curve_type(), CurveType::ED25519);
        let raw: [u8; 32] = key.as_bytes()[1..].try_into().unwrap();
        let signature: [u8; 64] = unhex(v["signature_hex"].as_str().unwrap())
            .try_into()
            .expect("64 byte signature");
        // ed25519-dalek, the library the console's WebCrypto signature must satisfy
        let verifying = VerifyingKey::from_bytes(&raw).expect("a valid point");
        verifying
            .verify(&message, &Signature::from_bytes(&signature))
            .expect("the vector signature verifies");
        // and the host function the contract will call (AIR-060)
        assert!(env::ed25519_verify(&signature, &message, &raw));
        // one flipped bit of the message does not verify
        let mut other = message.clone();
        other[0] ^= 1;
        assert!(
            verifying
                .verify(&other, &Signature::from_bytes(&signature))
                .is_err()
        );
        assert!(!env::ed25519_verify(&signature, &other, &raw));
    }

    #[test]
    fn flipping_one_bound_byte_changes_the_hash() {
        let _c = fresh();
        let task = vector_task();
        let base = task_hash(&task);
        let mut other = task.clone();
        other.bounds[1].max_total = U128(other.bounds[1].max_total.0 + 1);
        assert_ne!(task_hash(&other), base);
        let mut other = task.clone();
        other.bounds[0].payee_key.push('x');
        assert_ne!(task_hash(&other), base);
        let mut other = task.clone();
        other.bounds.reverse();
        assert_ne!(
            task_hash(&other),
            base,
            "the order of the bounds is part of the identity"
        );
        // identical content has the same hash
        assert_eq!(task_hash(&task.clone()), base);
    }

    #[test]
    fn owner_task_json_round_trips_the_vector() {
        let v = vector();
        let task = vector_task();
        let back = serde_json::to_value(&task).unwrap();
        for key in [
            "tag",
            "task_id",
            "contract_id",
            "agent_id",
            "plan_sha256",
            "instruction_sha256_salted",
            "issued_ms",
            "expires_ms",
            "max_actions",
            "bounds",
        ] {
            assert_eq!(back[key], v[key], "{key}");
        }
        // u64 fields are numbers, U128 fields are strings
        assert!(back["issued_ms"].is_u64());
        assert_eq!(back["bounds"][0]["max_total"], "5000000000000000000000000");
        // the field order of the JSON is the field order of the struct
        let keys: Vec<&String> = back.as_object().unwrap().keys().collect();
        assert_eq!(keys.first().map(|k| k.as_str()), Some("tag"));
        assert_eq!(keys.last().map(|k| k.as_str()), Some("bounds"));
    }

    // ---- tag and counters --------------------------------------------------------------------------------------------------

    #[test]
    #[should_panic(expected = "bad task tag")]
    fn require_tag_rejects_wrong_tag() {
        let mut task = vector_task();
        task.tag = "airlock-task-v2".to_string();
        task.require_tag();
    }

    #[test]
    fn require_tag_accepts_the_tag() {
        vector_task().require_tag();
    }

    #[test]
    fn add_actions_overflows_at_256() {
        let mut c = fresh();
        let hash = [3u8; 32];
        assert_eq!(c.actions_used(&hash), 0);
        assert_eq!(c.add_actions(&hash, 255), 255);
        assert_eq!(c.actions_used(&hash), 255);
        let text = panics(|| c.add_actions(&hash, 1));
        assert!(text.contains("task actions overflow"), "{text}");
        assert_eq!(c.actions_used(&hash), 255, "the failed add changed nothing");
    }

    #[test]
    fn add_actions_counts_each_task_alone() {
        let mut c = fresh();
        let (a, b) = ([1u8; 32], [2u8; 32]);
        assert_eq!(c.add_actions(&a, 1), 1);
        assert_eq!(c.add_actions(&a, 2), 3);
        assert_eq!(c.add_actions(&b, 1), 1);
        assert_eq!(c.actions_used(&a), 3);
        assert_eq!(c.actions_used(&b), 1);
        assert_eq!(c.actions_used(&[9u8; 32]), 0);
    }

    // ---- set_task_key ------------------------------------------------------------------------------------------------------

    fn key_text(curve: CurveType, bytes: Vec<u8>) -> String {
        String::from(&PublicKey::from_parts(curve, bytes).expect("a well formed key"))
    }

    fn set_key_as(caller: &str, deposit: u128, key: &str) -> Result<Contract, String> {
        let mut c = fresh();
        testing_env!(ctx(caller, 1_000, deposit).build());
        let key = key.to_string();
        let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.set_task_key(key);
        }));
        hit.map(|()| c).map_err(panic_text)
    }

    #[test]
    fn set_task_key_stores_the_32_raw_bytes_and_emits() {
        let good = vector()["public_key"].as_str().unwrap().to_string();
        let c = set_key_as(OWNER, 1, &good).expect("the owner sets a valid key");
        assert_eq!(c.get_task_key(), Some(good.clone()));
        let raw = raw_of(&good);
        assert_eq!(c.task_key, Some(raw));
        let logs = near_sdk::test_utils::get_logs();
        let event: Value =
            serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(event["standard"], "airlock");
        assert_eq!(event["event"], "task_key_set");
        assert_eq!(event["data"][0]["public_key"], good.as_str());
    }

    /// The 32 raw bytes of a key text.
    fn raw_of(text: &str) -> [u8; 32] {
        let key: PublicKey = text.parse().unwrap();
        key.as_bytes()[1..].try_into().unwrap()
    }

    #[test]
    fn set_task_key_refuses_every_bad_key() {
        let secp = key_text(CurveType::SECP256K1, vec![5; 64]);
        let err = set_key_as(OWNER, 1, &secp)
            .err()
            .expect("secp256k1 must revert");
        assert!(err.contains("task key must be ed25519"), "{err}");
        for bad in [
            "ed25519:0OIl",                                         // not base58
            "ed25519:",                                             // empty key
            "ed25519:thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE",    // 31 bytes
            "ed25519:JNArUumxYJcSQpbuxuroRZtcSMVLcy5WbYGt14SRm1Fv", // 33 bytes
            "not a key",
            "",
        ] {
            let err = set_key_as(OWNER, 1, bad).err().expect("must revert");
            assert!(err.contains("bad task key"), "{bad}: {err}");
        }
    }

    #[test]
    fn set_task_key_is_owner_and_one_yocto_only() {
        let good = vector()["public_key"].as_str().unwrap().to_string();
        let err = set_key_as("stranger.test.near", 1, &good).err().unwrap();
        assert!(err.contains("Caller is not the owner"), "{err}");
        for deposit in [0u128, 2] {
            let err = set_key_as(OWNER, deposit, &good).err().unwrap();
            assert!(
                err.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
                "{err}"
            );
        }
    }

    #[test]
    fn set_task_key_replaces_the_previous_key() {
        let first = vector()["public_key"].as_str().unwrap().to_string();
        let second = key_text(CurveType::ED25519, vec![2; 32]);
        let mut c = set_key_as(OWNER, 1, &first).unwrap();
        assert_eq!(c.get_task_key(), Some(first));
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.set_task_key(second.clone());
        assert_eq!(c.get_task_key(), Some(second));
    }

    #[test]
    fn get_task_key_is_none_before_it_is_set() {
        assert_eq!(fresh().get_task_key(), None);
    }

    // ---- revoke_task and get_task_state ------------------------------------------------------------------------------------

    #[test]
    fn revoke_task_marks_the_hash_and_is_idempotent() {
        let mut c = fresh();
        let hash = hex::encode([0xcd; 32]);
        assert_eq!(
            c.get_task_state(hash.clone()),
            TaskState {
                revoked: false,
                actions_used: 0
            }
        );
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.revoke_task(hash.clone());
        assert!(c.is_task_revoked(&[0xcd; 32]));
        assert_eq!(
            c.get_task_state(hash.clone()),
            TaskState {
                revoked: true,
                actions_used: 0
            }
        );
        // the second revoke succeeds and emits again
        c.revoke_task(hash.clone());
        let logs = near_sdk::test_utils::get_logs();
        assert_eq!(logs.len(), 2);
        let event: Value =
            serde_json::from_str(logs[1].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(event["event"], "task_revoked");
        assert_eq!(event["data"][0]["task_hash"], hash.as_str());
        // another hash is not affected
        assert!(!c.is_task_revoked(&[0xce; 32]));
    }

    #[test]
    fn task_hash_arguments_must_be_64_lowercase_hex() {
        let ok = hex::encode([0xab; 32]);
        for bad in [
            "xyz".to_string(),
            ok[..63].to_string(),
            format!("{ok}0"),
            ok.to_uppercase(),
            String::new(),
        ] {
            let mut c = fresh();
            testing_env!(ctx(OWNER, 1_000, 1).build());
            let text = panics(|| c.revoke_task(bad.clone()));
            assert!(text.contains("bad task hash"), "{bad}: {text}");
            let text = panics(|| c.get_task_state(bad.clone()));
            assert!(text.contains("bad task hash"), "{bad}: {text}");
        }
    }

    #[test]
    fn revoke_task_is_owner_and_one_yocto_only() {
        let hash = hex::encode([0xab; 32]);
        let mut c = fresh();
        testing_env!(ctx("stranger.test.near", 1_000, 1).build());
        let text = panics(|| c.revoke_task(hash.clone()));
        assert!(text.contains("Caller is not the owner"), "{text}");
        testing_env!(ctx(OWNER, 1_000, 0).build());
        let text = panics(|| c.revoke_task(hash.clone()));
        assert!(
            text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
            "{text}"
        );
        assert!(!c.is_task_revoked(&[0xab; 32]));
    }

    #[test]
    fn get_task_state_reports_the_actions_used() {
        let mut c = fresh();
        c.add_actions(&[0x11; 32], 2);
        assert_eq!(
            c.get_task_state(hex::encode([0x11; 32])),
            TaskState {
                revoked: false,
                actions_used: 2
            }
        );
    }

    // ---- verify_task (AIR-060) ---------------------------------------------------------------------------------------------

    use crate::policy::AssetEntryJson;
    use crate::testutil::{POLICY, sign, task_public_key};

    const AGENT: &str = "agent.test.near";
    const NEAR_PAYEE: &str = "near:accountant.test.near";
    const EVM_PAYEE: &str = "evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    /// A moment inside the window of `base_task`.
    const NOW: u64 = 1_100_000;

    fn asset(hard: u128, daily: u128, quick: u128, evm: bool) -> AssetEntryJson {
        AssetEntryJson {
            symbol: if evm { "ETH.base" } else { "NEAR" }.to_string(),
            decimals: 18,
            hard_cap: U128(hard),
            daily_cap: U128(daily),
            max_fee_per_gas: U128(if evm { 50 } else { 0 }),
            max_gas: U128(if evm { 100_000 } else { 0 }),
            quick_task_cap: U128(quick),
            path: evm.then(|| "base-sepolia-1".to_string()),
        }
    }

    /// A contract with the test task key, `near` (hard cap 1,000, quick cap 5,000) and `evm:84532:native` (hard cap 100, quick cap
    /// 1,000) registered.
    fn ready() -> Contract {
        let mut c = fresh();
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.asset_set("near".to_string(), asset(1_000, 100_000, 5_000, false));
        c.asset_set(
            "evm:84532:native".to_string(),
            asset(100, 10_000, 1_000, true),
        );
        c.task_key = Some(task_public_key());
        c
    }

    fn base_task(bounds: &[(&str, u128)], max_actions: u8) -> OwnerTask {
        OwnerTask {
            tag: TASK_TAG.to_string(),
            task_id: "task-1".to_string(),
            contract_id: POLICY.parse().unwrap(),
            agent_id: AGENT.parse().unwrap(),
            plan_sha256: Hex32([0x11; 32]),
            instruction_sha256_salted: Hex32([0x22; 32]),
            issued_ms: 1_000_000,
            expires_ms: 1_000_000 + 1_800_000,
            max_actions,
            bounds: bounds
                .iter()
                .map(|(key, max)| TaskBound {
                    payee_key: (*key).to_string(),
                    max_total: U128(*max),
                })
                .collect(),
        }
    }

    fn good() -> OwnerTask {
        base_task(&[(NEAR_PAYEE, 800), (EVM_PAYEE, 90)], 3)
    }

    /// Verifies `task` signed by the test key as the agent at `now_ms`.
    fn verify(c: &Contract, task: &OwnerTask, now_ms: u64) -> VerifiedTask {
        testing_env!(ctx(AGENT, now_ms, 0).build());
        c.verify_task(task, &sign(task), now_ms)
    }

    fn verify_text(c: &Contract, task: &OwnerTask, now_ms: u64) -> String {
        panics(|| verify(c, task, now_ms))
    }

    #[test]
    fn task_verify_good_task_passes_and_returns_hash_and_bounds() {
        let c = ready();
        let task = good();
        let vt = verify(&c, &task, NOW);
        assert_eq!(vt.hash, task_hash(&task));
        assert_eq!(
            vt.bounds,
            vec![
                VerifiedBound {
                    payee_key: NEAR_PAYEE.to_string(),
                    asset: "near".to_string(),
                    max_total: 800
                },
                VerifiedBound {
                    payee_key: EVM_PAYEE.to_string(),
                    asset: "evm:84532:native".to_string(),
                    max_total: 90
                },
            ]
        );
        assert_eq!(c.bound_for(&vt, NEAR_PAYEE), Some(800));
        assert_eq!(c.bound_for(&vt, EVM_PAYEE), Some(90));
        assert_eq!(c.bound_for(&vt, "near:other.test.near"), None);
        assert_eq!(
            c.bound_for(&vt, "NEAR:accountant.test.near"),
            None,
            "an exact match only"
        );
    }

    /// The `owner_task` vector verifies with the vector key: the registry admits it (caps equal to its largest `max_total`), the block
    /// time is inside its window and the flags are at least its ttl and `max_actions`.
    #[test]
    fn task_verify_vector_task_passes() {
        let mut c = fresh();
        let v = vector();
        let task = vector_task();
        let sig = unhex(v["signature_hex"].as_str().unwrap());
        let biggest = task.bounds.iter().map(|b| b.max_total.0).max().unwrap();
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.asset_set("near".to_string(), asset(biggest, biggest, biggest, false));
        c.asset_set(
            "evm:84532:native".to_string(),
            asset(biggest, biggest, biggest, true),
        );
        let key: PublicKey = v["public_key"].as_str().unwrap().parse().unwrap();
        c.task_key = Some(key.as_bytes()[1..].try_into().unwrap());
        testing_env!(ctx(AGENT, task.issued_ms + 1_000, 0).build());
        let vt = c.verify_task(&task, &sig, task.issued_ms + 1_000);
        assert_eq!(hex::encode(vt.hash), v["sha256_hex"].as_str().unwrap());
        assert_eq!(vt.bounds.len(), 2);
        assert_eq!(
            c.bound_for(&vt, NEAR_PAYEE),
            Some(task.bounds[0].max_total.0)
        );
    }

    #[test]
    #[should_panic(expected = "task key not set")]
    fn task_verify_key_not_set() {
        let mut c = ready();
        c.task_key = None;
        verify(&c, &good(), NOW);
    }

    #[test]
    #[should_panic(expected = "bad task signature")]
    fn task_verify_bad_signature() {
        let c = ready();
        let task = good();
        let mut sig = sign(&task);
        sig[10] ^= 1;
        testing_env!(ctx(AGENT, NOW, 0).build());
        c.verify_task(&task, &sig, NOW);
    }

    #[test]
    #[should_panic(expected = "bad task signature")]
    fn task_verify_signature_over_another_task() {
        let c = ready();
        let task = good();
        let other = base_task(&[(NEAR_PAYEE, 801)], 3);
        testing_env!(ctx(AGENT, NOW, 0).build());
        c.verify_task(&task, &sign(&other), NOW);
    }

    #[test]
    #[should_panic(expected = "bad task signature")]
    fn task_verify_signature_63_bytes() {
        let c = ready();
        let task = good();
        let sig = sign(&task);
        testing_env!(ctx(AGENT, NOW, 0).build());
        c.verify_task(&task, &sig[..63], NOW);
    }

    #[test]
    fn task_verify_signature_length_cases() {
        let c = ready();
        let task = good();
        let sig = sign(&task);
        testing_env!(ctx(AGENT, NOW, 0).build());
        for bad in [
            Vec::new(),
            sig[..1].to_vec(),
            sig[..63].to_vec(),
            [sig.clone(), vec![0]].concat(),
        ] {
            let text = panics(|| c.verify_task(&task, &bad, NOW));
            assert!(
                text.contains("bad task signature"),
                "{} bytes: {text}",
                bad.len()
            );
        }
    }

    #[test]
    #[should_panic(expected = "bad task tag")]
    fn task_verify_wrong_tag() {
        let c = ready();
        let mut task = good();
        task.tag = "airlock-task-v2".to_string();
        verify(&c, &task, NOW);
    }

    #[test]
    #[should_panic(expected = "wrong contract")]
    fn task_verify_wrong_contract() {
        let c = ready();
        let mut task = good();
        task.contract_id = "other.test.near".parse().unwrap();
        verify(&c, &task, NOW);
    }

    /// A signature over a task whose `agent_id` differs from the caller fails: the owner signed it for another agent.
    #[test]
    #[should_panic(expected = "wrong agent")]
    fn task_verify_agent_differs_from_caller() {
        let c = ready();
        let mut task = good();
        task.agent_id = "other-agent.test.near".parse().unwrap();
        verify(&c, &task, NOW);
    }

    #[test]
    #[should_panic(expected = "task not yet valid")]
    fn task_verify_not_yet_valid() {
        let c = ready();
        verify(&c, &good(), 999_999);
    }

    #[test]
    #[should_panic(expected = "task expired")]
    fn task_verify_expired() {
        let c = ready();
        verify(&c, &good(), 2_800_001);
    }

    #[test]
    fn task_verify_time_boundaries() {
        let c = ready();
        let task = good();
        // issued_ms itself is valid, expires_ms itself is expired, one millisecond before it is valid
        verify(&c, &task, task.issued_ms);
        verify(&c, &task, task.expires_ms - 1);
        let text = verify_text(&c, &task, task.expires_ms);
        assert!(text.contains("task expired"), "{text}");
        let text = verify_text(&c, &task, task.issued_ms - 1);
        assert!(text.contains("task not yet valid"), "{text}");
    }

    #[test]
    #[should_panic(expected = "task ttl too long")]
    fn task_verify_ttl_too_long() {
        let c = ready();
        let mut task = good();
        // the default max_task_ttl_ms is 3,600,000: one millisecond more
        task.expires_ms = task.issued_ms + 3_600_001;
        verify(&c, &task, NOW);
    }

    #[test]
    fn task_verify_ttl_exactly_the_maximum_passes() {
        let c = ready();
        let mut task = good();
        task.expires_ms = task.issued_ms + 3_600_000;
        verify(&c, &task, NOW);
    }

    #[test]
    fn task_verify_ttl_never_underflows() {
        // expires before it is issued: the time checks fail first, so the subtraction is never reached
        let c = ready();
        let mut task = good();
        task.issued_ms = 2_000_000;
        task.expires_ms = 1_000_000;
        let text = verify_text(&c, &task, 1_500_000);
        assert!(text.contains("task not yet valid"), "{text}");
        let text = verify_text(&c, &task, 2_500_000);
        assert!(text.contains("task expired"), "{text}");
    }

    #[test]
    fn task_verify_max_actions_0_and_21() {
        let c = ready();
        for bad in [0u8, 21, 99, 255] {
            let task = base_task(&[(NEAR_PAYEE, 800)], bad);
            let text = verify_text(&c, &task, NOW);
            assert!(text.contains("bad max_actions"), "{bad}: {text}");
        }
        // 1 and 20 (the default max_task_actions) are fine
        verify(&c, &base_task(&[(NEAR_PAYEE, 800)], 1), NOW);
        verify(&c, &base_task(&[(NEAR_PAYEE, 800)], 20), NOW);
    }

    #[test]
    #[should_panic(expected = "bad bound count")]
    fn task_verify_no_bounds() {
        let c = ready();
        verify(&c, &base_task(&[], 3), NOW);
    }

    #[test]
    #[should_panic(expected = "bad bound count")]
    fn task_verify_17_bounds() {
        let c = ready();
        let keys: Vec<String> = (0..17)
            .map(|i| format!("near:payee{i:02}.test.near"))
            .collect();
        let bounds: Vec<(&str, u128)> = keys.iter().map(|k| (k.as_str(), 10)).collect();
        verify(&c, &base_task(&bounds, 3), NOW);
    }

    #[test]
    fn task_verify_sixteen_bounds() {
        let c = ready();
        let keys: Vec<String> = (0..16)
            .map(|i| format!("near:payee{i:02}.test.near"))
            .collect();
        let bounds: Vec<(&str, u128)> = keys.iter().map(|k| (k.as_str(), 10 + 1)).collect();
        let vt = verify(&c, &base_task(&bounds, 3), NOW);
        assert_eq!(vt.bounds.len(), 16);
        assert_eq!(c.bound_for(&vt, "near:payee15.test.near"), Some(11));
    }

    #[test]
    #[should_panic(expected = "duplicate bound")]
    fn task_verify_duplicate_bound() {
        let c = ready();
        verify(
            &c,
            &base_task(&[(NEAR_PAYEE, 800), (EVM_PAYEE, 90), (NEAR_PAYEE, 10)], 3),
            NOW,
        );
    }

    #[test]
    fn task_verify_bad_bound_keys() {
        let c = ready();
        for (key, name) in [
            ("near:Accountant.test.near", "BadChar"),
            ("near:a", "BadLength"),
            ("near:a..b", "BadSeparator"),
            (
                "evm:0:0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
                "BadChainId",
            ),
            (
                "evm:84532:d8da6bf26964af9d7eed9e03e53415d37aa96045",
                "BadLength",
            ),
            ("btc:bc1q", "UnknownScheme"),
        ] {
            let text = verify_text(&c, &base_task(&[(key, 10)], 3), NOW);
            assert!(
                text.contains(&format!("bad bound key: {name}")),
                "{key}: {text}"
            );
        }
        let kelvin = format!("near:{}elvin.test.near", char::from_u32(0x212A).unwrap());
        let text = verify_text(&c, &base_task(&[(kelvin.as_str(), 10)], 3), NOW);
        assert!(text.contains("bad bound key: NonAscii"), "{text}");
    }

    #[test]
    #[should_panic(expected = "bad bound key: UnknownScheme")]
    fn task_verify_bound_key_ft() {
        let c = ready();
        verify(
            &c,
            &base_task(&[("ft:usdc.test.near:accountant.test.near", 10)], 3),
            NOW,
        );
    }

    #[test]
    #[should_panic(expected = "unknown asset in bound")]
    fn task_verify_unknown_asset_in_bound() {
        let c = ready();
        // the chain 1 asset is not registered
        verify(
            &c,
            &base_task(
                &[("evm:1:0xd8da6bf26964af9d7eed9e03e53415d37aa96045", 10)],
                3,
            ),
            NOW,
        );
    }

    #[test]
    fn task_verify_max_total_zero_and_max() {
        let c = ready();
        for bad in [0u128, u128::MAX] {
            let text = verify_text(&c, &base_task(&[(NEAR_PAYEE, bad)], 3), NOW);
            assert!(text.contains("bad max_total"), "{bad}: {text}");
        }
        verify(&c, &base_task(&[(NEAR_PAYEE, 1)], 3), NOW);
    }

    #[test]
    fn task_verify_bound_above_hard_cap_times_actions() {
        // near: hard cap 1,000, so 3 actions allow 3,000 and no more
        let c = ready();
        verify(&c, &base_task(&[(NEAR_PAYEE, 3_000)], 3), NOW);
        let text = verify_text(&c, &base_task(&[(NEAR_PAYEE, 3_001)], 3), NOW);
        assert!(
            text.contains("bound above hard cap times actions"),
            "{text}"
        );
        // one action: the hard cap itself
        verify(&c, &base_task(&[(NEAR_PAYEE, 1_000)], 1), NOW);
        let text = verify_text(&c, &base_task(&[(NEAR_PAYEE, 1_001)], 1), NOW);
        assert!(
            text.contains("bound above hard cap times actions"),
            "{text}"
        );
    }

    #[test]
    fn task_verify_overflowing_hard_cap_product() {
        // hard_cap * max_actions overflows u128: there is no limit from it, only the quick cap and `u128::MAX` bound the task
        let mut c = ready();
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.asset_set(
            "near".to_string(),
            asset(u128::MAX, u128::MAX, u128::MAX, false),
        );
        let vt = verify(&c, &base_task(&[(NEAR_PAYEE, u128::MAX - 1)], 2), NOW);
        assert_eq!(c.bound_for(&vt, NEAR_PAYEE), Some(u128::MAX - 1));
        // and it still refuses the largest value
        let text = verify_text(&c, &base_task(&[(NEAR_PAYEE, u128::MAX)], 2), NOW);
        assert!(text.contains("bad max_total"), "{text}");
    }

    #[test]
    #[should_panic(expected = "task above quick cap")]
    fn task_verify_bound_above_quick_cap() {
        // near: hard cap 1,000, quick cap 5,000: 3 actions allow 3,000 by the hard cap, so raise the actions to reach the quick cap
        let c = ready();
        verify(&c, &base_task(&[(NEAR_PAYEE, 5_001)], 6), NOW);
    }

    #[test]
    fn task_verify_quick_cap_edge() {
        let c = ready();
        verify(&c, &base_task(&[(NEAR_PAYEE, 5_000)], 6), NOW);
        let text = verify_text(&c, &base_task(&[(NEAR_PAYEE, 5_001)], 6), NOW);
        assert!(text.contains("task above quick cap"), "{text}");
        // the EVM asset: hard cap 100, quick cap 1,000
        verify(&c, &base_task(&[(EVM_PAYEE, 1_000)], 10), NOW);
        let text = verify_text(&c, &base_task(&[(EVM_PAYEE, 1_001)], 11), NOW);
        assert!(text.contains("task above quick cap"), "{text}");
    }

    #[test]
    #[should_panic(expected = "task revoked")]
    fn task_verify_revoked() {
        let mut c = ready();
        let task = good();
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.revoke_task(hex::encode(task_hash(&task)));
        verify(&c, &task, NOW);
    }

    /// The order of the failures: the signature first, then the tag, the contract, the agent, the time, the bounds, the revocation.
    #[test]
    fn task_verify_order() {
        let mut c = ready();
        // expired and a bad signature: the signature says so
        let task = good();
        let mut sig = sign(&task);
        sig[0] ^= 1;
        testing_env!(ctx(AGENT, 9_999_999, 0).build());
        let text = panics(|| c.verify_task(&task, &sig, 9_999_999));
        assert!(text.contains("bad task signature"), "{text}");
        // revoked and a bad signature: still the signature
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.revoke_task(hex::encode(task_hash(&task)));
        testing_env!(ctx(AGENT, NOW, 0).build());
        let text = panics(|| c.verify_task(&task, &sig, NOW));
        assert!(text.contains("bad task signature"), "{text}");
        // revoked alone, with everything else right
        let text = verify_text(&c, &task, NOW);
        assert!(text.contains("task revoked"), "{text}");
        // the key is checked before the signature
        c.task_key = None;
        let text = panics(|| c.verify_task(&task, &sig, NOW));
        assert!(text.contains("task key not set"), "{text}");
        c.task_key = Some(task_public_key());
        // a valid signature over a task with everything wrong: tag, then contract, then agent, then time, then max_actions, then bounds
        let c = ready();
        let mut t = base_task(&[], 0);
        t.tag = "x".to_string();
        t.contract_id = "other.test.near".parse().unwrap();
        t.agent_id = "other-agent.test.near".parse().unwrap();
        t.issued_ms = 5_000_000;
        t.expires_ms = 1_000;
        let text = verify_text(&c, &t, NOW);
        assert!(text.contains("bad task tag"), "{text}");
        t.tag = TASK_TAG.to_string();
        let text = verify_text(&c, &t, NOW);
        assert!(text.contains("wrong contract"), "{text}");
        t.contract_id = POLICY.parse().unwrap();
        let text = verify_text(&c, &t, NOW);
        assert!(text.contains("wrong agent"), "{text}");
        t.agent_id = AGENT.parse().unwrap();
        let text = verify_text(&c, &t, NOW);
        assert!(text.contains("task not yet valid"), "{text}");
        t.issued_ms = 1_000_000;
        t.expires_ms = 1_000_100;
        let text = verify_text(&c, &t, NOW);
        assert!(text.contains("task expired"), "{text}");
        t.expires_ms = 1_000_000 + 3_600_001;
        let text = verify_text(&c, &t, NOW);
        assert!(text.contains("task ttl too long"), "{text}");
        t.expires_ms = 2_800_000;
        let text = verify_text(&c, &t, NOW);
        assert!(text.contains("bad max_actions"), "{text}");
        t.max_actions = 3;
        let text = verify_text(&c, &t, NOW);
        assert!(text.contains("bad bound count"), "{text}");
    }

    /// The bound checks run in order: duplicates, then key, asset, max_total, hard cap product, quick cap.
    #[test]
    fn task_verify_bound_check_order() {
        let c = ready();
        // a duplicate comes before an invalid key
        let text = verify_text(&c, &base_task(&[("bad key", 1), ("bad key", 1)], 3), NOW);
        assert!(text.contains("duplicate bound"), "{text}");
        // key, asset, max_total, product, quick
        let text = verify_text(&c, &base_task(&[("near:A", 0)], 3), NOW);
        assert!(text.contains("bad bound key"), "{text}");
        let text = verify_text(
            &c,
            &base_task(
                &[("evm:1:0xd8da6bf26964af9d7eed9e03e53415d37aa96045", 0)],
                3,
            ),
            NOW,
        );
        assert!(text.contains("unknown asset in bound"), "{text}");
        let text = verify_text(&c, &base_task(&[(NEAR_PAYEE, 0)], 3), NOW);
        assert!(text.contains("bad max_total"), "{text}");
        let text = verify_text(&c, &base_task(&[(NEAR_PAYEE, 5_001)], 3), NOW);
        assert!(
            text.contains("bound above hard cap times actions"),
            "{text}"
        );
    }

    /// The clock is the caller's: the block time of the environment is never read.
    #[test]
    fn task_verify_does_not_read_the_block_clock() {
        let c = ready();
        let task = good();
        // the environment says the task is long expired, the caller passes a moment inside the window
        testing_env!(ctx(AGENT, 99_999_999_999, 0).build());
        c.verify_task(&task, &sign(&task), NOW);
        // and the other way round
        testing_env!(ctx(AGENT, NOW, 0).build());
        let text = panics(|| c.verify_task(&task, &sign(&task), 99_999_999_999));
        assert!(text.contains("task expired"), "{text}");
    }

    #[test]
    fn task_verify_bounds_view_is_read_only_and_has_no_signature_checks() {
        let c = ready();
        let vb = c.verify_bounds(&good());
        assert_eq!(vb.len(), 2);
        // a task that would fail the signature and the time still lists its bounds
        let mut task = good();
        task.expires_ms = 1;
        assert_eq!(c.verify_bounds(&task).len(), 2);
    }
}

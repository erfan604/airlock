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
        // borsh strings are a u32 little-endian length plus UTF-8: 15 bytes for `task-é中-0001` (12 characters)
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
}

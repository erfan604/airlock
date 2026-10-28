// AIR-046: the allow list. Only an agent account the owner explicitly allowed, after comparing a fingerprint printed in the owner's
// own deployment log, can submit requests, and the owner can revoke it at any time. Registration (the template's `register_agent`,
// attestation or local whitelist) says the agent is who it claims to be; the allowance says the owner wants this account to act.
// The fingerprint is a typo guard (48 bits), not authentication: every owner task binds `agent_id` (SPEC R3-07).
use crate::*;

/// What the owner allowed: the fingerprint he compared and when.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedAgent {
    pub fingerprint: String,
    pub allowed_ms: u64,
}

/// `AllowedAgent` on the wire (`allowed_ms` is a string, as every u64 of the contract's JSON).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedAgentView {
    pub fingerprint: String,
    pub allowed_ms: U64,
}

/// The most entries `get_allowed_agents` returns in one call.
pub const MAX_ALLOWED_AGENTS_PAGE: u32 = 50;

/// The first 12 characters of the lowercase hex of the SHA-256 of the account id. `scripts/agent-fingerprint.mjs` computes the
/// same text, so the runtime's boot log and the owner's `allow_agent` argument agree.
pub fn fingerprint(account: &str) -> String {
    let mut text = hex::encode(env::sha256_array(account.as_bytes()));
    text.truncate(12);
    text
}

/// The promise that makes the caller's transaction fail with `Invalid agent: [<reasons>]` (the template's way: a call to the
/// private `fail_on_invalid_agent`).
pub fn invalid_agent_promise(reasons: &[AgentRemovalReason]) -> Promise {
    let args = serde_json::json!({ "reasons": reasons });
    Promise::new(env::current_account_id()).function_call(
        "fail_on_invalid_agent".to_string(),
        serde_json::to_vec(&args).expect("Failed to serialize reasons"),
        NearToken::from_near(0),
        Gas::from_tgas(10),
    )
}

impl Contract {
    /// The first step of `submit_batch` (AIR-061). Each step is final:
    ///  1. the caller is not in `agents`: panic `Agent not registered`;
    ///  2. the registration is invalid (`check_invalid_reasons`): remove the agent, emit `agent_removed`, return a promise to
    ///     `fail_on_invalid_agent` (the template's behaviour, and the only state change on that path);
    ///  3. the caller is not in `allowed_agents`: return a promise to `fail_on_invalid_agent` with `[NotAllowed]` and change
    ///     nothing (no removal, no event), because the owner may allow the account later;
    ///  4. `None`: the caller may go on.
    pub fn require_valid_agent(&mut self) -> Option<Promise> {
        let account_id = env::predecessor_account_id();
        let agent = self.agents.get(&account_id).expect("Agent not registered");

        let removal_reasons = self.check_invalid_reasons(&account_id, agent);
        if !removal_reasons.is_empty() {
            self.agents.remove(&account_id);
            Event::AgentRemoved {
                account_id: &account_id,
                reasons: removal_reasons.clone(),
            }
            .emit();
            return Some(invalid_agent_promise(&removal_reasons));
        }

        if !self.allowed_agents.contains_key(&account_id) {
            return Some(invalid_agent_promise(&[AgentRemovalReason::NotAllowed]));
        }
        None
    }
}

#[near]
impl Contract {
    /// Owner: allow an agent account after comparing its fingerprint. Reverts `fingerprint mismatch` unless `fingerprint` equals
    /// `fingerprint(account_id)` exactly (an uppercase or a 13 character value mismatches too), so a mistyped account cannot be
    /// allowed after the owner compared the log line. The account need not be registered yet (either order works). A second call
    /// overwrites `allowed_ms`. Emits `agent_allowed`.
    #[payable]
    pub fn allow_agent(&mut self, account_id: AccountId, fingerprint: String) {
        self.owner_call();
        require!(
            crate::agents::fingerprint(account_id.as_str()) == fingerprint,
            "fingerprint mismatch"
        );
        self.allowed_agents.insert(
            account_id.clone(),
            AllowedAgent {
                fingerprint: fingerprint.clone(),
                allowed_ms: block_timestamp_ms(),
            },
        );
        Event::AgentAllowed {
            account_id: &account_id,
            fingerprint: &fingerprint,
        }
        .emit();
    }

    /// Owner: take the allowance away. Reverts `agent not allowed` when there is none. Only the allowance goes: the registration
    /// stays, requests already `Executing` finish, and the agent's pending escalations stay pending and fail their approve with
    /// `AgentNotAllowed` (AIR-080). Emits `agent_revoked`.
    #[payable]
    pub fn revoke_agent(&mut self, account_id: AccountId) {
        self.owner_call();
        require!(
            self.allowed_agents.remove(&account_id).is_some(),
            "agent not allowed"
        );
        Event::AgentRevoked {
            account_id: &account_id,
        }
        .emit();
    }

    /// Whether the owner allowed this account (it may or may not be registered).
    pub fn is_agent_allowed(&self, account_id: AccountId) -> bool {
        self.allowed_agents.contains_key(&account_id)
    }

    /// The allowances in insertion order. `limit` is clamped to 50 and the call never reverts (an index past the end answers an
    /// empty list).
    pub fn get_allowed_agents(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<(AccountId, AllowedAgentView)> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit
            .unwrap_or(MAX_ALLOWED_AGENTS_PAGE)
            .min(MAX_ALLOWED_AGENTS_PAGE) as usize;
        self.allowed_agents
            .iter()
            .skip(from)
            .take(limit)
            .map(|(account, allowed)| {
                (
                    account.clone(),
                    AllowedAgentView {
                        fingerprint: allowed.fingerprint.clone(),
                        allowed_ms: U64(allowed.allowed_ms),
                    },
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{OWNER, ctx, fresh};
    use near_sdk::test_utils::get_logs;
    use near_sdk::testing_env;

    const AGENT: &str = "agent.test.near";

    fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default()
    }

    fn panics<R>(f: impl FnOnce() -> R) -> String {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(_) => panic!("expected a revert, the call succeeded"),
            Err(payload) => panic_text(payload),
        }
    }

    fn account(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    /// A contract with `AGENT` registered at 1,000 ms (valid for the 100 s of `fresh()`), through the public fields.
    fn with_registered_agent() -> Contract {
        let mut c = fresh();
        c.agents.insert(
            account(AGENT),
            Agent {
                measurements: shade_attestation::measurements::create_mock_full_measurements_hex(),
                ppid: Ppid::default(),
                valid_until_ms: 1_000 + 100_000,
            },
        );
        c.whitelisted_agents_for_local.insert(account(AGENT));
        c
    }

    fn allow(c: &mut Contract, who: &str) {
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.allow_agent(account(who), fingerprint(who));
    }

    #[test]
    fn agents_fingerprint_vectors() {
        let _c = fresh();
        assert_eq!(fingerprint("agent.example.testnet"), "c11e2c219f09");
        assert_eq!(fingerprint("agent.test.near"), "1573203cff8b");
        assert_eq!(fingerprint("agent.examp1e.testnet"), "68ddd2e20b90");
    }

    #[test]
    fn agents_similar_accounts_have_different_fingerprints() {
        let _c = fresh();
        assert_ne!(
            fingerprint("agent.examp1e.testnet"),
            fingerprint("agent.example.testnet")
        );
    }

    #[test]
    #[should_panic(expected = "Agent not registered")]
    fn agents_require_valid_agent_unregistered_panics() {
        let mut c = fresh();
        testing_env!(ctx(AGENT, 1_000, 0).build());
        let _ = c.require_valid_agent();
    }

    #[test]
    fn agents_require_valid_agent_not_allowed_returns_promise_and_keeps_registration() {
        let mut c = with_registered_agent();
        testing_env!(ctx(AGENT, 2_000, 0).build());
        let promise = c.require_valid_agent();
        assert!(
            promise.is_some(),
            "an unallowed caller gets the failure promise"
        );
        assert!(
            c.agents.get(&account(AGENT)).is_some(),
            "the registration is not removed for a missing allowance"
        );
        assert!(
            get_logs().iter().all(|l| !l.contains("agent_removed")),
            "no agent_removed event: {:?}",
            get_logs()
        );
    }

    #[test]
    fn agents_require_valid_agent_expired_removes_and_emits() {
        let mut c = with_registered_agent();
        allow(&mut c, AGENT);
        // past valid_until_ms (101,000): the template behaviour, even for an allowed agent
        testing_env!(ctx(AGENT, 101_001, 0).build());
        let promise = c.require_valid_agent();
        assert!(promise.is_some());
        assert!(
            c.agents.get(&account(AGENT)).is_none(),
            "the expired agent is removed"
        );
        let logs = get_logs();
        assert!(
            logs.iter()
                .any(|l| l.contains("\"event\":\"agent_removed\"")
                    && l.contains("ExpiredAttestation")),
            "{logs:?}"
        );
        assert!(
            c.allowed_agents.contains_key(&account(AGENT)),
            "the allowance is untouched"
        );
    }

    #[test]
    fn agents_require_valid_agent_allowed_is_none() {
        let mut c = with_registered_agent();
        allow(&mut c, AGENT);
        testing_env!(ctx(AGENT, 2_000, 0).build());
        assert!(c.require_valid_agent().is_none());
        assert!(c.agents.get(&account(AGENT)).is_some());
    }

    #[test]
    fn agents_is_agent_valid_requires_allowance() {
        let mut c = with_registered_agent();
        assert!(!c.is_agent_valid(account(AGENT)), "registered, not allowed");
        allow(&mut c, AGENT);
        testing_env!(ctx("anyone.test.near", 2_000, 0).build());
        assert!(c.is_agent_valid(account(AGENT)));
        assert!(c.is_agent_allowed(account(AGENT)));
        // allowed but not registered
        testing_env!(ctx(OWNER, 2_000, 1).build());
        c.allow_agent(account("ghost.test.near"), fingerprint("ghost.test.near"));
        assert!(c.is_agent_allowed(account("ghost.test.near")));
        assert!(!c.is_agent_valid(account("ghost.test.near")));
        // revoked
        c.revoke_agent(account(AGENT));
        assert!(!c.is_agent_valid(account(AGENT)));
        assert!(!c.is_agent_allowed(account(AGENT)));
    }

    #[test]
    fn agents_allow_agent_checks_the_fingerprint_exactly() {
        let mut c = fresh();
        testing_env!(ctx(OWNER, 1_000, 1).build());
        let good = fingerprint(AGENT);
        for bad in [
            fingerprint("agent.example.testnet"),
            good.to_uppercase(),
            format!("{good}0"),
            good[..11].to_string(),
            String::new(),
        ] {
            let text = panics(|| c.allow_agent(account(AGENT), bad.clone()));
            assert!(text.contains("fingerprint mismatch"), "{bad}: {text}");
        }
        assert!(!c.is_agent_allowed(account(AGENT)));
    }

    #[test]
    fn agents_allow_and_revoke_emit_events_and_upsert() {
        let mut c = fresh();
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.allow_agent(account(AGENT), fingerprint(AGENT));
        let first_logs = get_logs();
        testing_env!(ctx(OWNER, 5_000, 1).build());
        c.allow_agent(account(AGENT), fingerprint(AGENT));
        let list = c.get_allowed_agents(None, None);
        assert_eq!(list.len(), 1, "a second allow overwrites, it does not add");
        assert_eq!(list[0].1.allowed_ms, U64(5_000));
        assert_eq!(list[0].1.fingerprint, "1573203cff8b");
        c.revoke_agent(account(AGENT));
        let logs = get_logs();
        assert_eq!(first_logs.len(), 1);
        assert!(
            first_logs[0].contains("\"event\":\"agent_allowed\"")
                && first_logs[0].contains("\"fingerprint\":\"1573203cff8b\"")
                && first_logs[0].contains("\"account_id\":\"agent.test.near\""),
            "{first_logs:?}"
        );
        assert_eq!(logs.len(), 2, "the second allow and the revoke: {logs:?}");
        assert!(logs[0].contains("\"event\":\"agent_allowed\""));
        assert!(logs[1].contains("\"event\":\"agent_revoked\""), "{logs:?}");
        let text = panics(|| c.revoke_agent(account(AGENT)));
        assert!(text.contains("agent not allowed"), "{text}");
    }

    #[test]
    fn agents_owner_rules_hold() {
        let mut c = fresh();
        let fp = fingerprint(AGENT);
        testing_env!(ctx("stranger.test.near", 1_000, 1).build());
        let text = panics(|| c.allow_agent(account(AGENT), fp.clone()));
        assert!(text.contains("Caller is not the owner"), "{text}");
        for deposit in [0u128, 2] {
            testing_env!(ctx(OWNER, 1_000, deposit).build());
            let text = panics(|| c.allow_agent(account(AGENT), fp.clone()));
            assert!(
                text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
                "{text}"
            );
        }
        testing_env!(ctx(OWNER, 1_000, 1).build());
        c.allow_agent(account(AGENT), fp);
        testing_env!(ctx("stranger.test.near", 1_000, 1).build());
        let text = panics(|| c.revoke_agent(account(AGENT)));
        assert!(text.contains("Caller is not the owner"), "{text}");
        assert!(c.is_agent_allowed(account(AGENT)));
    }

    #[test]
    fn agents_get_allowed_agents_clamps_to_50_and_never_reverts() {
        let mut c = fresh();
        testing_env!(ctx(OWNER, 1_000, 1).build());
        for i in 0..60 {
            let who = format!("agent{i:02}.test.near");
            c.allow_agent(account(&who), fingerprint(&who));
        }
        let page = c.get_allowed_agents(None, Some(500));
        assert_eq!(page.len(), 50, "limit 500 returns at most 50");
        assert_eq!(page[0].0.as_str(), "agent00.test.near", "insertion order");
        assert_eq!(page[49].0.as_str(), "agent49.test.near");
        let rest = c.get_allowed_agents(Some(50), Some(500));
        assert_eq!(rest.len(), 10);
        assert_eq!(rest[0].0.as_str(), "agent50.test.near");
        assert_eq!(c.get_allowed_agents(Some(1_000), None), vec![]);
        assert_eq!(c.get_allowed_agents(Some(u32::MAX), Some(u32::MAX)), vec![]);
        assert_eq!(c.get_allowed_agents(Some(3), Some(2)).len(), 2);
        assert_eq!(c.get_allowed_agents(None, None).len(), 50);
        assert_eq!(c.get_allowed_agents(None, Some(0)), vec![]);
    }
}

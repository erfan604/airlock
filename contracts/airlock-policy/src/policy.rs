// The policy state the owner edits: the pause switch and the flood-control flags (AIR-040), the asset registry (AIR-042) and the
// address book (AIR-043).
use crate::request::Hex32;
use crate::*;
use airlock_verdict::approve;
use airlock_verdict::decimal::MAX_DECIMALS;
use near_sdk::json_types::U128;
use std::str::FromStr;

/// `set_flags` bound: a TTL is at most 7 days, because AIR-061 computes `now_ms + pending_ttl_ms`.
pub const MAX_TTL_MS: u64 = 604_800_000;
/// `set_flags` bound: a counter (pending cap, hourly budget, lock thresholds) is at most this.
pub const MAX_COUNTER: u32 = 10_000;
/// `set_flags` bound: at most 99 actions per task, so a request id stays at 67 characters or fewer (GLOSSARY, AIR-063).
pub const MAX_TASK_ACTIONS: u8 = 99;

/// The owner-settable flags, as stored (borsh). The defaults are in `Default` and in docs, GLOSSARY "Contract flags".
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flags {
    /// Pending escalations one agent may have at once (a further ESCALATE is blocked `PendingFull`, AIR-083).
    pub max_pending_per_agent: u32,
    /// How long a pending escalation lives before anyone may expire it, in milliseconds.
    pub pending_ttl_ms: u64,
    /// Escalations one agent may raise per hour (AIR-083).
    pub hourly_escalation_budget: u32,
    /// Consecutive rejects that lock an agent's escalations (AIR-083).
    pub lock_consecutive_rejects: u32,
    /// Rejects in one UTC day that lock an agent's escalations (AIR-083).
    pub lock_rejects_per_day: u32,
    /// The longest an owner-signed task may live, in milliseconds (AIR-060).
    pub max_task_ttl_ms: u64,
    /// The most actions an owner-signed task may allow (AIR-045, AIR-060).
    pub max_task_actions: u8,
}

impl Default for Flags {
    fn default() -> Self {
        Self {
            max_pending_per_agent: 3,
            pending_ttl_ms: 3_600_000,
            hourly_escalation_budget: 6,
            lock_consecutive_rejects: 3,
            lock_rejects_per_day: 20,
            max_task_ttl_ms: 3_600_000,
            max_task_actions: 20,
        }
    }
}

/// The flags on the wire (JSON): counters are numbers, the two millisecond fields are strings (`U64`), the field order is
/// the order of the struct.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlagsJson {
    pub max_pending_per_agent: u32,
    pub pending_ttl_ms: U64,
    pub hourly_escalation_budget: u32,
    pub lock_consecutive_rejects: u32,
    pub lock_rejects_per_day: u32,
    pub max_task_ttl_ms: U64,
    pub max_task_actions: u8,
}

impl From<Flags> for FlagsJson {
    fn from(flags: Flags) -> Self {
        Self {
            max_pending_per_agent: flags.max_pending_per_agent,
            pending_ttl_ms: U64(flags.pending_ttl_ms),
            hourly_escalation_budget: flags.hourly_escalation_budget,
            lock_consecutive_rejects: flags.lock_consecutive_rejects,
            lock_rejects_per_day: flags.lock_rejects_per_day,
            max_task_ttl_ms: U64(flags.max_task_ttl_ms),
            max_task_actions: flags.max_task_actions,
        }
    }
}

impl FlagsJson {
    /// Checks the `set_flags` bounds (each a `require!`, so the text is the panic message) and returns the stored form.
    /// Every field at least 1; both TTLs at most 7 days; the four u32 counters at most 10,000; `max_task_actions` at most 99.
    pub fn checked(&self) -> Flags {
        let counters = [
            self.max_pending_per_agent,
            self.hourly_escalation_budget,
            self.lock_consecutive_rejects,
            self.lock_rejects_per_day,
        ];
        require!(
            counters.iter().all(|c| *c > 0)
                && self.pending_ttl_ms.0 > 0
                && self.max_task_ttl_ms.0 > 0
                && self.max_task_actions > 0,
            "flag must be above 0"
        );
        require!(
            self.pending_ttl_ms.0 <= MAX_TTL_MS && self.max_task_ttl_ms.0 <= MAX_TTL_MS,
            "ttl above 7 days"
        );
        require!(
            counters.iter().all(|c| *c <= MAX_COUNTER),
            "flag above 10000"
        );
        require!(
            self.max_task_actions <= MAX_TASK_ACTIONS,
            "max_task_actions above 99"
        );
        Flags {
            max_pending_per_agent: self.max_pending_per_agent,
            pending_ttl_ms: self.pending_ttl_ms.0,
            hourly_escalation_budget: self.hourly_escalation_budget,
            lock_consecutive_rejects: self.lock_consecutive_rejects,
            lock_rejects_per_day: self.lock_rejects_per_day,
            max_task_ttl_ms: self.max_task_ttl_ms.0,
            max_task_actions: self.max_task_actions,
        }
    }
}

/// What `get_policy` returns.
#[near(serializers = [json])]
pub struct PolicyView {
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub requires_tee: bool,
    pub paused: bool,
    pub flags: FlagsJson,
}

// ---------------------------------------------------------------------------------------------------------------------
// The asset registry (AIR-042). The owner registers each payable asset once with its decimals, caps and signing path. An asset that
// is not registered can only ever block (the verdict, rule 0). Display symbols are unique, compared case-insensitively, so the
// approval screen never shows one symbol for two assets (AB6, SPEC R4-01).
// ---------------------------------------------------------------------------------------------------------------------

/// The most assets the registry holds (distinct ids), so `list_assets` needs no pagination.
pub const MAX_ASSETS: u32 = 16;
/// The longest display symbol.
pub const MAX_SYMBOL_LEN: usize = 12;
/// The longest EVM signing path.
pub const MAX_PATH_LEN: usize = 64;
/// The least gas an EVM asset must allow: a plain transfer costs 21,000 (AIR-061 requires `gas_limit >= 21_000`).
pub const MIN_EVM_GAS: u128 = 21_000;

/// One registered asset. `max_fee_per_gas`, `max_gas` and `path` are for EVM assets only (the verdict never reads the first two for
/// NEAR); the EVM `path` is the signing derivation path and comes from here, never from a request (R2-05).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetEntry {
    pub symbol: String,
    pub decimals: u8,
    pub hard_cap: u128,
    pub daily_cap: u128,
    pub max_fee_per_gas: u128,
    pub max_gas: u128,
    pub quick_task_cap: u128,
    pub path: Option<String>,
    /// AIR-109: for an erc20 asset only, what the EIP-3009 authorization needs (`Some` exactly for `evm:<chain_id>:erc20:0x<token>`).
    pub eip712: Option<Eip712Entry>,
}

/// AIR-109: the EIP-712 data of an erc20 asset. The 32-byte domain separator is stored, never rebuilt from the token's name and version
/// (Base Sepolia's `name()` is `USDC`, mainnet's `USD Coin`); the token address is in the asset id. `from` is the MPC-derived address
/// of the asset's path: `0x` plus 40 lowercase hex.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Eip712Entry {
    pub domain_separator: Hex32,
    pub from: String,
}

/// `AssetEntry` as the owner sends it: every u128 is a decimal string.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetEntryJson {
    pub symbol: String,
    pub decimals: u8,
    pub hard_cap: U128,
    pub daily_cap: U128,
    pub max_fee_per_gas: U128,
    pub max_gas: U128,
    pub quick_task_cap: U128,
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub eip712: Option<Eip712Entry>,
}

/// `AssetEntry` as the views answer: the same fields as `AssetEntryJson`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetEntryView {
    pub symbol: String,
    pub decimals: u8,
    pub hard_cap: U128,
    pub daily_cap: U128,
    pub max_fee_per_gas: U128,
    pub max_gas: U128,
    pub quick_task_cap: U128,
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub eip712: Option<Eip712Entry>,
}

impl From<AssetEntryJson> for AssetEntry {
    fn from(e: AssetEntryJson) -> Self {
        Self {
            symbol: e.symbol,
            decimals: e.decimals,
            hard_cap: e.hard_cap.0,
            daily_cap: e.daily_cap.0,
            max_fee_per_gas: e.max_fee_per_gas.0,
            max_gas: e.max_gas.0,
            quick_task_cap: e.quick_task_cap.0,
            path: e.path,
            eip712: e.eip712,
        }
    }
}

impl From<&AssetEntry> for AssetEntryView {
    fn from(e: &AssetEntry) -> Self {
        Self {
            symbol: e.symbol.clone(),
            decimals: e.decimals,
            hard_cap: U128(e.hard_cap),
            daily_cap: U128(e.daily_cap),
            max_fee_per_gas: U128(e.max_fee_per_gas),
            max_gas: U128(e.max_gas),
            quick_task_cap: U128(e.quick_task_cap),
            path: e.path.clone(),
            eip712: e.eip712.clone(),
        }
    }
}

/// A decimal u64 chain id of at least 1 without a leading zero.
fn valid_chain_id(chain: &str) -> bool {
    !chain.starts_with('0')
        && chain.bytes().all(|b| b.is_ascii_digit())
        && chain.parse::<u64>().is_ok_and(|n| n >= 1)
}

/// The asset id grammar: `near`, `evm:<chain_id>:native` (a decimal u64 of at least 1 without a leading zero), `evm:<chain_id>:erc20:0x<40
/// lowercase hex token>` (AIR-109) or `ft:<account>` where the part after `ft:` parses as an `AccountId` (accepted so the bench can name
/// tokens; there is no execution lane).
pub fn valid_asset_id(id: &str) -> bool {
    if id == "near" {
        return true;
    }
    if let Some(rest) = id.strip_prefix("evm:") {
        if let Some(chain) = rest.strip_suffix(":native") {
            return valid_chain_id(chain);
        }
        return crate::x402::is_erc20_asset(id);
    }
    id.strip_prefix("ft:")
        .is_some_and(|account| AccountId::from_str(account).is_ok())
}

/// A display symbol: ASCII letters, digits and dots, 1 to 12 characters.
pub fn valid_symbol(symbol: &str) -> bool {
    (1..=MAX_SYMBOL_LEN).contains(&symbol.len())
        && symbol
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.')
}

/// An EVM signing path: `[a-z0-9._-]`, 1 to 64 characters.
pub fn valid_path(path: &str) -> bool {
    (1..=MAX_PATH_LEN).contains(&path.len())
        && path
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

impl Contract {
    /// The registered asset with this id, if any.
    pub fn asset(&self, id: &str) -> Option<AssetEntry> {
        self.assets.get(id).cloned()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The address book (AIR-043). Payees are stored and matched by exact canonical ASCII keys (`crate::keys`): there is no fuzzy or
// nearest-key matching anywhere in the contract, and only the owner adds or removes a payee (I3).
// ---------------------------------------------------------------------------------------------------------------------

/// The most characters of a payee label.
pub const MAX_LABEL_LEN: usize = 40;

/// One payee. `cap` is the largest single untrusted amount the owner accepts for this payee (`None`: never, which is how strict
/// configuration is expressed), `daily_untrusted_budget` the untrusted amount per UTC day, `daily_limit` the payee's daily limit for
/// any amount (the verdict's `limit_remaining`). The label lives only in the owner's vault (AIR-326).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookEntry {
    pub cap: Option<u128>,
    pub daily_untrusted_budget: u128,
    pub daily_limit: u128,
}

/// A payee label: at most 40 characters of `[A-Za-z0-9 ._-]` (empty is allowed).
pub fn valid_label(label: &str) -> bool {
    label.len() <= MAX_LABEL_LEN
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'-'))
}

impl Contract {
    /// The address book entry for a canonical payee key when `proof` verifies against the stored root (AIR-326), else `None`.
    /// An exact match on the request's own payee string: no folding, no prefix match. A missing or bad proof is a new payee.
    pub fn book_entry(
        &self,
        key: &str,
        proof: Option<&crate::book::BookProof>,
    ) -> Option<BookEntry> {
        crate::book::verify(&self.book_root, key, proof?)
    }
}

#[near]
impl Contract {
    /// Owner: stop or resume the gate. While paused every request is blocked (AIR-061). Emits `paused`.
    #[payable]
    pub fn pause(&mut self, paused: bool) {
        self.owner_call();
        self.paused = paused;
        Event::Paused { paused }.emit();
    }

    /// Owner: replace every flag at once. Out of bounds values revert (see `FlagsJson::checked`). Emits `flags_set`.
    #[payable]
    pub fn set_flags(&mut self, flags: FlagsJson) {
        self.owner_call();
        self.flags = flags.checked();
        Event::FlagsSet {
            flags: FlagsJson::from(self.flags),
        }
        .emit();
    }

    /// Owner: register or replace an asset. The checks run in this order and each reverts with the quoted text: `invalid asset id`,
    /// `invalid symbol`, `symbol already used` (case-insensitive across the registry, AB6; the entry being replaced does not count),
    /// `decimals above 38`, `caps must satisfy 0 < hard_cap <= daily_cap`, `quick_task_cap must be above 0 and at most daily_cap`,
    /// `approve arguments could exceed 200 bytes` (AIR-086, skipped for an erc20 asset), then for an EVM asset `evm path required`, `evm path invalid`,
    /// `evm path already used`, then for an erc20 asset (AIR-109) `erc20 fee and gas caps must be 0`, `eip712 required for erc20`, `eip712 invalid`, for a native EVM asset
    /// `evm fee and gas caps required`, for any other asset `path not allowed` and `fee and gas caps only for evm`, and last `registry full` (more than 16 distinct ids;
    /// a replace never trips it). A changed symbol frees the old one. Emits `asset_set`.
    #[payable]
    pub fn asset_set(&mut self, asset: String, entry: AssetEntryJson) {
        self.owner_call();
        require!(valid_asset_id(&asset), "invalid asset id");
        require!(valid_symbol(&entry.symbol), "invalid symbol");
        let lowered = entry.symbol.to_ascii_lowercase();
        let taken = self
            .asset_symbols
            .get(&lowered)
            .is_some_and(|owner| *owner != asset);
        require!(!taken, "symbol already used");
        require!(entry.decimals <= MAX_DECIMALS, "decimals above 38");
        let (hard, daily, quick) = (entry.hard_cap.0, entry.daily_cap.0, entry.quick_task_cap.0);
        require!(
            hard > 0 && hard <= daily,
            "caps must satisfy 0 < hard_cap <= daily_cap"
        );
        require!(
            quick > 0 && quick <= daily,
            "quick_task_cap must be above 0 and at most daily_cap"
        );
        let erc20 = crate::x402::is_erc20_asset(&asset);
        // AIR-086 (R4-12): a Ledger device shows the arguments of `approve` only under 200 bytes, so refuse an asset whose worst-case
        // arguments could reach that: the longest payee key, reason and book status, a ten digit pending number, this symbol and the
        // longest amount text up to the hard cap. The effective decimals ceiling is 33, and NEAR's hard cap stays below 10,000,000 NEAR.
        // AIR-109: skipped for an erc20 asset, whose payee key is up to 112 characters against MAX_TO 69 (docs/KNOWN_LIMITATIONS.md)
        require!(
            erc20
                || approve::approve_args_len(
                    approve::MAX_ID_DIGITS,
                    approve::MAX_TO,
                    entry.symbol.len(),
                    approve::amount_text_len(hard, entry.decimals),
                    approve::MAX_WHY,
                    approve::MAX_BOOK,
                ) < approve::LEDGER_LIMIT,
            "approve arguments could exceed 200 bytes"
        );
        if asset.starts_with("evm:") {
            let path = entry.path.as_deref().filter(|p| !p.is_empty());
            let path = path.unwrap_or_else(|| env::panic_str("evm path required"));
            require!(valid_path(path), "evm path invalid");
            require!(
                !self
                    .assets
                    .iter()
                    .any(|(id, e)| *id != asset && e.path.as_deref() == Some(path)),
                "evm path already used"
            );
            if erc20 {
                require!(
                    entry.max_fee_per_gas.0 == 0 && entry.max_gas.0 == 0,
                    "erc20 fee and gas caps must be 0"
                );
                let eip712 = entry
                    .eip712
                    .as_ref()
                    .unwrap_or_else(|| env::panic_str("eip712 required for erc20"));
                require!(
                    crate::x402::valid_from(&eip712.from) && eip712.domain_separator.0 != [0u8; 32],
                    "eip712 invalid"
                );
            } else {
                require!(
                    entry.max_fee_per_gas.0 > 0 && entry.max_gas.0 >= MIN_EVM_GAS,
                    "evm fee and gas caps required"
                );
            }
        } else {
            require!(entry.path.is_none(), "path not allowed");
            require!(
                entry.max_fee_per_gas.0 == 0 && entry.max_gas.0 == 0,
                "fee and gas caps only for evm"
            );
        }
        require!(erc20 || entry.eip712.is_none(), "eip712 only for erc20");
        require!(
            self.assets.contains_key(&asset) || self.assets.len() < MAX_ASSETS,
            "registry full"
        );
        let entry = AssetEntry::from(entry);
        Event::AssetSet {
            asset: &asset,
            symbol: &entry.symbol,
            decimals: entry.decimals,
            hard_cap: U128(entry.hard_cap),
            daily_cap: U128(entry.daily_cap),
            quick_task_cap: U128(entry.quick_task_cap),
            path: entry.path.as_deref(),
        }
        .emit();
        if let Some(old) = self.assets.get(&asset) {
            // a changed symbol frees the old one
            let old_lowered = old.symbol.to_ascii_lowercase();
            if old_lowered != lowered {
                self.asset_symbols.remove(&old_lowered);
            }
        }
        self.asset_symbols.insert(lowered, asset.clone());
        self.assets.insert(asset, entry);
    }

    /// Owner: remove an asset and its symbol. Reverts `unknown asset` when it is not registered. Pending escalations stay in place:
    /// their approve fails at the recheck with `Limit:UnknownAsset`. Emits `asset_removed`.
    #[payable]
    pub fn asset_remove(&mut self, asset: String) {
        self.owner_call();
        let removed = self
            .assets
            .remove(&asset)
            .unwrap_or_else(|| env::panic_str("unknown asset"));
        self.asset_symbols
            .remove(&removed.symbol.to_ascii_lowercase());
        Event::AssetRemoved { asset: &asset }.emit();
    }

    /// Owner: replace the address book commitment (AIR-326). `expected_old` must equal the stored root (`stale book root`), which
    /// makes concurrent edits fail instead of overwriting each other. The epoch grows by one and `book_root_set` is emitted.
    #[payable]
    pub fn book_set_root(&mut self, expected_old: Hex32, new_root: Hex32) {
        self.owner_call();
        require!(expected_old.0 == self.book_root, "stale book root");
        Event::BookRootSet {
            old: &expected_old.to_hex(),
            new: &new_root.to_hex(),
            epoch: U64(self.book_epoch + 1),
        }
        .emit();
        self.book_root = new_root.0;
        self.book_epoch += 1;
    }

    /// The stored address book root (64 hex characters). 64 zeros until the owner sets one: every payee is then new.
    pub fn get_book_root(&self) -> Hex32 {
        Hex32(self.book_root)
    }

    /// How many times the book root has changed.
    pub fn get_book_epoch(&self) -> U64 {
        U64(self.book_epoch)
    }

    /// The registered asset with this id, or `None`.
    pub fn get_asset(&self, asset: String) -> Option<AssetEntryView> {
        self.assets.get(&asset).map(AssetEntryView::from)
    }

    /// Every registered asset (at most 16, so no pagination) in registration order.
    pub fn list_assets(&self) -> Vec<(String, AssetEntryView)> {
        self.assets
            .iter()
            .map(|(id, entry)| (id.clone(), AssetEntryView::from(entry)))
            .collect()
    }

    /// The owner, the signer contract, the TEE mode, the pause switch and the flags.
    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            owner_id: self.owner_id.clone(),
            mpc_contract_id: self.mpc_contract_id.clone(),
            requires_tee: self.requires_tee,
            paused: self.paused,
            flags: FlagsJson::from(self.flags),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{MPC, OWNER, ctx, fresh};
    use near_sdk::test_utils::get_logs;
    use near_sdk::testing_env;

    const T0_MS: u64 = 1_000;

    fn json_with(field: &str, value: serde_json::Value) -> FlagsJson {
        let mut v = serde_json::to_value(FlagsJson::from(Flags::default())).unwrap();
        v[field] = value;
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn flags_default_serialization_is_exact() {
        assert_eq!(
            serde_json::to_string(&FlagsJson::from(Flags::default())).unwrap(),
            r#"{"max_pending_per_agent":3,"pending_ttl_ms":"3600000","hourly_escalation_budget":6,"lock_consecutive_rejects":3,"lock_rejects_per_day":20,"max_task_ttl_ms":"3600000","max_task_actions":20}"#
        );
    }

    #[test]
    fn new_starts_unpaused_with_default_flags() {
        let c = fresh();
        let view = c.get_policy();
        assert!(!view.paused);
        assert_eq!(view.flags, FlagsJson::from(Flags::default()));
        assert_eq!(view.owner_id.as_str(), OWNER);
        assert_eq!(view.mpc_contract_id.as_str(), MPC);
        assert!(!view.requires_tee);
    }

    #[test]
    fn owner_call_needs_exactly_one_yocto() {
        for deposit in [0u128, 2, 1_000_000_000_000_000_000_000_000] {
            let mut c = fresh();
            testing_env!(ctx(OWNER, T0_MS, deposit).build());
            let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.owner_call()));
            let message = hit.expect_err("owner_call must refuse a deposit that is not 1 yocto");
            let text = message
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| message.downcast_ref::<&str>().map(|s| (*s).to_string()))
                .unwrap_or_default();
            assert!(
                text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
                "deposit {deposit}: {text}"
            );
        }
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        c.owner_call();
    }

    #[test]
    #[should_panic(expected = "Caller is not the owner")]
    fn owner_call_refuses_a_stranger_with_one_yocto() {
        let mut c = fresh();
        testing_env!(ctx("stranger.test.near", T0_MS, 1).build());
        c.owner_call();
    }

    #[test]
    fn pause_sets_the_flag_and_emits_one_event() {
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        c.pause(true);
        assert!(c.get_policy().paused);
        assert_eq!(
            get_logs(),
            vec![
                r#"EVENT_JSON:{"standard":"airlock","version":"1.0.0","event":"paused","data":[{"paused":true}]}"#
                    .to_string()
            ]
        );
        c.pause(false);
        assert!(!c.get_policy().paused);
    }

    #[test]
    fn set_flags_stores_and_emits_the_flags() {
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        let flags = json_with("max_pending_per_agent", serde_json::json!(4));
        c.set_flags(flags.clone());
        assert_eq!(c.get_policy().flags, flags);
        assert_eq!(c.flags.max_pending_per_agent, 4);
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        let line = logs[0].strip_prefix("EVENT_JSON:").expect("an event line");
        let event: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(event["standard"], "airlock");
        assert_eq!(event["event"], "flags_set");
        assert_eq!(event["data"][0]["flags"]["max_pending_per_agent"], 4);
    }

    fn rejects(flags: FlagsJson, text: &str) {
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        let before = c.flags;
        let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_flags(flags)));
        let message = hit.expect_err("set_flags must reject");
        let got = message
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| message.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default();
        assert!(got.contains(text), "expected `{text}` in `{got}`");
        assert_eq!(c.flags, before, "a rejected set_flags changed the flags");
    }

    #[test]
    fn flag_bounds_cover_every_field() {
        use serde_json::json;
        for field in [
            "max_pending_per_agent",
            "hourly_escalation_budget",
            "lock_consecutive_rejects",
            "lock_rejects_per_day",
            "max_task_actions",
        ] {
            rejects(json_with(field, json!(0)), "flag must be above 0");
        }
        for field in ["pending_ttl_ms", "max_task_ttl_ms"] {
            rejects(json_with(field, json!("0")), "flag must be above 0");
            rejects(json_with(field, json!("604800001")), "ttl above 7 days");
            rejects(
                json_with(field, json!(u64::MAX.to_string())),
                "ttl above 7 days",
            );
        }
        for field in [
            "max_pending_per_agent",
            "hourly_escalation_budget",
            "lock_consecutive_rejects",
            "lock_rejects_per_day",
        ] {
            rejects(json_with(field, json!(10_001)), "flag above 10000");
            rejects(json_with(field, json!(u32::MAX)), "flag above 10000");
        }
        rejects(
            json_with("max_task_actions", json!(100)),
            "max_task_actions above 99",
        );
        rejects(
            json_with("max_task_actions", json!(255)),
            "max_task_actions above 99",
        );
    }

    #[test]
    fn flag_bounds_accept_the_edges() {
        use serde_json::json;
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        let edge = FlagsJson {
            max_pending_per_agent: 10_000,
            pending_ttl_ms: U64(604_800_000),
            hourly_escalation_budget: 10_000,
            lock_consecutive_rejects: 10_000,
            lock_rejects_per_day: 10_000,
            max_task_ttl_ms: U64(604_800_000),
            max_task_actions: 99,
        };
        c.set_flags(edge.clone());
        assert_eq!(c.get_policy().flags, edge);
        let low = json_with("max_pending_per_agent", json!(1));
        c.set_flags(low.clone());
        assert_eq!(c.get_policy().flags, low);
    }

    // ---- the asset registry (AIR-042) --------------------------------------------------------------------------------------

    /// The panic text of a call that must revert.
    fn panics<R>(f: impl FnOnce() -> R) -> String {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(_) => panic!("expected a revert, the call succeeded"),
            Err(payload) => payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                .unwrap_or_default(),
        }
    }

    fn near_json() -> AssetEntryJson {
        AssetEntryJson {
            symbol: "NEAR".to_string(),
            decimals: 24,
            hard_cap: U128(10_000),
            daily_cap: U128(100_000),
            max_fee_per_gas: U128(0),
            max_gas: U128(0),
            quick_task_cap: U128(100_000),
            path: None,
            eip712: None,
        }
    }

    fn evm_json() -> AssetEntryJson {
        AssetEntryJson {
            symbol: "ETH.base".to_string(),
            decimals: 18,
            hard_cap: U128(1_000),
            daily_cap: U128(10_000),
            max_fee_per_gas: U128(50),
            max_gas: U128(100_000),
            quick_task_cap: U128(5_000),
            path: Some("base-sepolia-1".to_string()),
            eip712: None,
        }
    }

    #[test]
    fn registry_asset_id_grammar() {
        for ok in [
            "near",
            "evm:1:native",
            "evm:84532:native",
            "evm:18446744073709551615:native",
            "ft:usdc.near",
            "ft:a1",
        ] {
            assert!(valid_asset_id(ok), "{ok} must be valid");
        }
        for bad in [
            "",
            "USD",
            "usdc ",
            " near",
            "Near",
            "NEAR",
            "EVM:84532:native",
            "evm:84532:Native",
            "evm:84532:native ",
            "evm:0:native",
            "evm:084532:native",
            "evm::native",
            "evm:-1:native",
            "evm:+1:native",
            "evm:18446744073709551616:native",
            "evm:84532:",
            "evm:84532",
            "evm:84532:native:x",
            "ft:",
            "ft:a",
            "ft:USDC.near",
            "ft:usdc..near",
            "ft:usdc.near ",
            "evm:1_0:native",
        ] {
            assert!(!valid_asset_id(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn registry_ft_grammar_is_the_account_id_grammar() {
        for account in [
            "usdc.near",
            "a",
            "ab",
            "-ab",
            "ab-",
            "a--b",
            "a.b",
            "a..b",
            ".ab",
            "AB",
            "ab_c",
            "a-b_c.d",
            "0123456789012345678901234567890123456789012345678901234567890123",
            "01234567890123456789012345678901234567890123456789012345678901234",
            "\u{e9}a",
        ] {
            assert_eq!(
                valid_asset_id(&format!("ft:{account}")),
                AccountId::from_str(account).is_ok(),
                "{account}"
            );
        }
    }

    #[test]
    fn registry_symbol_and_path_grammar() {
        for ok in ["A", "NEAR", "USDC.base", "a1.b2.c3.d4", "abcdefghijkl", "0"] {
            assert!(valid_symbol(ok), "{ok}");
        }
        for bad in ["", "ABCDEFGHIJKLM", "A B", "A_B", "A-B", "\u{c9}", "A\n"] {
            assert!(!valid_symbol(bad), "{bad:?}");
        }
        for ok in ["base-sepolia-1", "a", "a.b_c-d", &"a".repeat(64)] {
            assert!(valid_path(ok), "{ok}");
        }
        for bad in ["", "Base", "a b", "a/b", &"a".repeat(65), "\u{e9}"] {
            assert!(!valid_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn registry_entry_conversions_keep_every_field() {
        let json = evm_json();
        let entry = AssetEntry::from(json.clone());
        assert_eq!(entry.hard_cap, 1_000);
        assert_eq!(entry.max_gas, 100_000);
        assert_eq!(entry.path.as_deref(), Some("base-sepolia-1"));
        let view = AssetEntryView::from(&entry);
        assert_eq!(serde_json::to_value(&view).unwrap()["hard_cap"], "1000");
        assert_eq!(
            serde_json::to_value(&view).unwrap()["path"],
            "base-sepolia-1"
        );
        assert_eq!(
            serde_json::to_value(&json).unwrap(),
            serde_json::to_value(&view).unwrap()
        );
    }

    #[test]
    fn registry_set_upsert_remove_in_process() {
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        c.asset_set("near".to_string(), near_json());
        c.asset_set("evm:84532:native".to_string(), evm_json());
        assert_eq!(c.asset("near").unwrap().symbol, "NEAR");
        assert_eq!(c.list_assets().len(), 2);
        // the symbol of another asset, in another letter case
        let mut taken = evm_json();
        taken.symbol = "near".to_string();
        let text = panics(|| c.asset_set("evm:84532:native".to_string(), taken));
        assert!(text.contains("symbol already used"), "{text}");
        // a changed symbol frees the old one
        let mut renamed = near_json();
        renamed.symbol = "N2".to_string();
        c.asset_set("near".to_string(), renamed);
        let mut reuse = evm_json();
        reuse.symbol = "NEAR".to_string();
        c.asset_set("evm:84532:native".to_string(), reuse);
        assert_eq!(
            c.get_asset("evm:84532:native".to_string()).unwrap().symbol,
            "NEAR"
        );
        // remove frees the symbol too and answers `unknown asset` the second time
        c.asset_remove("evm:84532:native".to_string());
        assert!(c.asset("evm:84532:native").is_none());
        let text = panics(|| c.asset_remove("evm:84532:native".to_string()));
        assert!(text.contains("unknown asset"), "{text}");
        c.asset_set("ft:x.near".to_string(), {
            let mut e = near_json();
            e.symbol = "near".to_string();
            e
        });
    }

    #[test]
    fn registry_owner_rules_hold_in_process() {
        let mut c = fresh();
        testing_env!(ctx("stranger.test.near", T0_MS, 1).build());
        let text = panics(|| c.asset_set("near".to_string(), near_json()));
        assert!(text.contains("Caller is not the owner"), "{text}");
        for deposit in [0u128, 2] {
            testing_env!(ctx(OWNER, T0_MS, deposit).build());
            let text = panics(|| c.asset_set("near".to_string(), near_json()));
            assert!(
                text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
                "{text}"
            );
            let text = panics(|| c.asset_remove("near".to_string()));
            assert!(
                text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
                "{text}"
            );
        }
        assert!(c.list_assets().is_empty());
    }

    // ---- the address book commitment (AIR-326) -----------------------------------------------------------------------------

    const NEAR_KEY: &str = "near:accountant.test.near";

    fn one_entry() -> ([u8; 32], crate::book::BookProof) {
        let e = crate::book::Entry {
            salt: [5; 32],
            payee: NEAR_KEY.to_string(),
            cap: Some(100),
            daily_untrusted_budget: 1_000,
            daily_limit: 5_000,
        };
        let (root, mut proofs) = crate::book::build(&[e], &[3; 32]);
        (root, proofs.remove(0))
    }

    #[test]
    fn book_root_starts_zero_and_every_payee_is_new() {
        let c = fresh();
        assert_eq!(c.get_book_root().0, [0u8; 32]);
        assert_eq!(c.get_book_epoch().0, 0);
        let (_, proof) = one_entry();
        assert!(c.book_entry(NEAR_KEY, Some(&proof)).is_none());
        assert!(c.book_entry(NEAR_KEY, None).is_none());
    }

    #[test]
    fn book_set_root_swaps_checks_the_old_root_and_counts_epochs() {
        let mut c = fresh();
        let (root, proof) = one_entry();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        c.book_set_root(Hex32([0; 32]), Hex32(root));
        assert_eq!(c.get_book_root().0, root);
        assert_eq!(c.get_book_epoch().0, 1);
        let entry = c.book_entry(NEAR_KEY, Some(&proof)).expect("member");
        assert_eq!(
            (entry.cap, entry.daily_untrusted_budget, entry.daily_limit),
            (Some(100), 1_000, 5_000)
        );
        assert!(c.book_entry("near:other.test.near", Some(&proof)).is_none());
        // a stale expected root reverts and changes nothing
        let text = panics(|| c.book_set_root(Hex32([0; 32]), Hex32([7; 32])));
        assert!(text.contains("stale book root"), "{text}");
        assert_eq!(c.get_book_root().0, root);
        // revocation: the next root drops the entry at once
        c.book_set_root(Hex32(root), Hex32([9; 32]));
        assert!(c.book_entry(NEAR_KEY, Some(&proof)).is_none());
        assert_eq!(c.get_book_epoch().0, 2);
    }

    #[test]
    fn book_set_root_is_owner_only_with_one_yocto() {
        let mut c = fresh();
        testing_env!(ctx("mallory.test.near", T0_MS, 1).build());
        let text = panics(|| c.book_set_root(Hex32([0; 32]), Hex32([1; 32])));
        assert!(text.contains("owner"), "{text}");
        testing_env!(ctx(OWNER, T0_MS, 0).build());
        let text = panics(|| c.book_set_root(Hex32([0; 32]), Hex32([1; 32])));
        assert!(
            text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
            "{text}"
        );
        assert_eq!(c.get_book_epoch().0, 0);
    }
}

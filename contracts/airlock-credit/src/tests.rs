// Unit tests of the pool (AIR-328): share math through the calls, every refusal, the callbacks, and a property test of the accounting.
use crate::*;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{PromiseResult, testing_env};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const OWNER: &str = "owner.test.near";
const POOL: &str = "pool.test.near";
const LP1: &str = "lp1.test.near";
const LP2: &str = "lp2.test.near";
const BORROWER: &str = "borrower.test.near";
const CARD: &str = "card.test.near";
const NOW: u64 = 1_800_000_000_000;
const DAY: u64 = 86_400_000;

fn ctx(who: &str, deposit: u128, now_ms: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(POOL.parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .signer_account_id(who.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000);
    b
}

fn call_as(who: &str, deposit: u128, now_ms: u64) {
    testing_env!(ctx(who, deposit, now_ms).build());
}

fn pool() -> Pool {
    call_as(OWNER, 0, NOW);
    Pool::new(OWNER.parse().unwrap())
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn panics<R>(f: impl FnOnce() -> R) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(_) => panic!("expected a revert, the call succeeded"),
        Err(p) => p
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| p.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default(),
    }
}

/// Registers `CARD` for `BORROWER` the way the callback does, with the roles the card must have.
fn register(p: &mut Pool) {
    let roles = format!(r#"{{"owner_id":"{OWNER}","approver":"{BORROWER}","sponsor":"{POOL}"}}"#);
    testing_env!(
        ctx(POOL, 0, NOW).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(roles.into_bytes())]
    );
    p.on_card_roles(acct(CARD), acct(BORROWER));
}

fn open(p: &mut Pool, limit: u128, fee_bps: u32) {
    call_as(BORROWER, limit * 3 / 10, NOW);
    p.post_collateral(acct(CARD));
    call_as(OWNER, 0, NOW);
    let _ = p.open_line(
        acct(CARD),
        U128(limit),
        fee_bps,
        near_sdk::json_types::U64(NOW + 30 * DAY),
    );
}

fn funded_pool() -> Pool {
    let mut p = pool();
    call_as(LP1, 100 * NEAR, NOW);
    p.deposit();
    register(&mut p);
    p
}

/// What the last call sent as plain transfers, `(receiver, amount)`.
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .iter()
        .flat_map(|r| {
            r.actions.iter().filter_map(move |a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => {
                    Some((r.receiver_id.to_string(), deposit.as_yoctonear()))
                }
                _ => None,
            })
        })
        .collect()
}

fn fails_to_fund(p: &mut Pool, limit: u128) {
    testing_env!(
        ctx(POOL, 0, NOW).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    p.on_line_funded(acct(CARD), U128(limit));
}

// ---- LPs ----

#[test]
fn deposit_mints_one_to_one_first_then_at_the_price() {
    let mut p = pool();
    call_as(LP1, 10 * NEAR, NOW);
    assert_eq!(p.deposit().0, 10 * NEAR);
    // a fee of 5 NEAR raises the price to 1.5
    p.idle += 5 * NEAR;
    p.fees_earned += 5 * NEAR;
    call_as(LP2, 3 * NEAR, NOW);
    assert_eq!(
        p.deposit().0,
        2 * NEAR,
        "3 NEAR at price 1.5 buys 2 shares worth"
    );
    assert_eq!(p.get_lp(acct(LP1)).value.0, 15 * NEAR);
    assert!(
        p.get_lp(acct(LP2)).value.0 <= 3 * NEAR,
        "rounding never favours the depositor"
    );
    assert!(
        get_logs()
            .join("\n")
            .contains("\"standard\":\"airlock-credit\"")
    );
}

#[test]
fn deposit_refusals() {
    let mut p = pool();
    call_as(LP1, MIN_DEPOSIT - 1, NOW);
    assert!(panics(|| p.deposit()).contains("below the minimum"));
    call_as(LP1, 10 * NEAR, NOW);
    p.deposit();
    // shares outstanding and no assets: the pool cannot price a share
    p.idle = 0;
    call_as(LP2, NEAR, NOW);
    assert!(panics(|| p.deposit()).contains("no assets to price"));
    // a price so high that the deposit buys no share
    p.total_shares = 10;
    p.idle = 1_000_000 * NEAR;
    call_as(LP2, MIN_DEPOSIT, NOW);
    assert!(panics(|| p.deposit()).contains("too small for one share"));
}

#[test]
fn a_plain_transfer_to_the_contract_cannot_move_the_share_price() {
    let mut p = pool();
    call_as(LP1, 10 * NEAR, NOW);
    p.deposit();
    let before = p.get_pool().share_price.0;
    // the balance of the account grows by a gift; the pool accounts with its own fields
    testing_env!(
        ctx(LP2, 0, NOW)
            .account_balance(NearToken::from_near(1_000_000))
            .build()
    );
    assert_eq!(p.get_pool().share_price.0, before);
    assert_eq!(p.get_pool().assets.0, 10 * NEAR);
}

#[test]
fn withdraw_pays_the_pro_rata_amount_down_to_idle_and_refuses_beyond() {
    let mut p = funded_pool();
    open(&mut p, 60 * NEAR, 500);
    // 100 deposited, 60 lent, 40 idle: 50 shares are worth 50 but only 40 are idle
    call_as(LP1, 0, NOW);
    let text = panics(|| p.withdraw(U128(50 * NEAR)));
    assert!(
        text.contains(
            "insufficient idle liquidity: withdraw at most 40000000000000000000000000 shares now"
        ),
        "{text}"
    );
    let _ = p.withdraw(U128(40 * NEAR));
    assert_eq!(p.idle, 0);
    assert_eq!(p.total_shares, 60 * NEAR);
    let receipts = get_created_receipts();
    assert!(receipts.iter().any(|r| r.receiver_id.as_str() == LP1));
    assert!(panics(|| p.withdraw(U128(0))).contains("at least one share"));
    assert!(panics(|| p.withdraw(U128(1_000 * NEAR))).contains("exceeds your shares"));
    call_as(LP2, 0, NOW);
    assert!(panics(|| p.withdraw(U128(1))).contains("exceeds your shares"));
}

#[test]
fn a_failed_withdraw_transfer_gives_the_shares_back() {
    let mut p = funded_pool();
    call_as(LP1, 0, NOW);
    let _ = p.withdraw(U128(10 * NEAR));
    assert_eq!(p.get_lp(acct(LP1)).shares.0, 90 * NEAR);
    testing_env!(
        ctx(POOL, 0, NOW).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    p.on_withdraw(acct(LP1), U128(10 * NEAR), U128(10 * NEAR));
    assert_eq!(p.get_lp(acct(LP1)).shares.0, 100 * NEAR);
    assert_eq!(p.idle, 100 * NEAR);
    assert_eq!(p.total_shares, 100 * NEAR);
}

// ---- cards ----

#[test]
fn register_card_checks_the_roles_the_card_answers() {
    let mut p = pool();
    let bad = |owner: &str, approver: Option<&str>, sponsor: Option<&str>| {
        format!(
            r#"{{"owner_id":"{owner}","approver":{},"sponsor":{}}}"#,
            approver.map_or("null".to_string(), |a| format!("\"{a}\"")),
            sponsor.map_or("null".to_string(), |a| format!("\"{a}\""))
        )
    };
    let cases = [
        (
            bad("someone.test.near", Some(BORROWER), Some(POOL)),
            "owner is not the pool's owner",
        ),
        (
            bad(OWNER, Some("other.test.near"), Some(POOL)),
            "approver is not the borrower",
        ),
        (bad(OWNER, None, Some(POOL)), "approver is not the borrower"),
        (
            bad(OWNER, Some(BORROWER), Some("other.test.near")),
            "sponsor is not this pool",
        ),
        (bad(OWNER, Some(BORROWER), None), "sponsor is not this pool"),
        ("not json".to_string(), "not readable"),
    ];
    for (answer, want) in cases {
        testing_env!(
            ctx(POOL, 0, NOW).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(answer.into_bytes())]
        );
        let text = panics(|| p.on_card_roles(acct(CARD), acct(BORROWER)));
        assert!(text.contains(want), "{want}: {text}");
    }
    testing_env!(
        ctx(POOL, 0, NOW).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(panics(|| p.on_card_roles(acct(CARD), acct(BORROWER))).contains("did not answer"));
    assert!(p.get_card(acct(CARD)).is_none());
    register(&mut p);
    assert_eq!(p.get_card(acct(CARD)).unwrap().as_str(), BORROWER);
    call_as(OWNER, 0, NOW);
    assert!(panics(|| p.register_card(acct(CARD), acct(BORROWER))).contains("already registered"));
}

#[test]
fn register_card_is_owner_only_and_never_the_pool_or_the_issuer_as_borrower() {
    let mut p = pool();
    call_as(LP1, 0, NOW);
    assert!(
        panics(|| p.register_card(acct(CARD), acct(BORROWER))).contains("Caller is not the owner")
    );
    call_as(OWNER, 0, NOW);
    assert!(panics(|| p.register_card(acct(POOL), acct(BORROWER))).contains("cannot be a card"));
    assert!(panics(|| p.register_card(acct(CARD), acct(OWNER))).contains("cannot be the issuer"));
}

// ---- lines ----

#[test]
fn open_line_needs_collateral_liquidity_and_sane_terms() {
    let mut p = funded_pool();
    call_as(OWNER, 0, NOW);
    let due = near_sdk::json_types::U64(NOW + 30 * DAY);
    assert!(
        panics(|| p.open_line(acct(CARD), U128(10 * NEAR), 100, due))
            .contains("collateral is below")
    );
    call_as(BORROWER, 2 * NEAR, NOW);
    p.post_collateral(acct(CARD));
    call_as(OWNER, 0, NOW);
    assert!(
        panics(|| p.open_line(acct(CARD), U128(10 * NEAR), 100, due))
            .contains("collateral is below"),
        "2 of 3 needed"
    );
    assert!(panics(|| p.open_line(acct(CARD), U128(0), 100, due)).contains("must be positive"));
    assert!(
        panics(|| p.open_line(acct(CARD), U128(NEAR), 5_001, due)).contains("above 50 percent")
    );
    assert!(
        panics(|| p.open_line(acct(CARD), U128(NEAR), 100, near_sdk::json_types::U64(NOW)))
            .contains("future")
    );
    assert!(
        panics(|| p.open_line(
            acct(CARD),
            U128(NEAR),
            100,
            near_sdk::json_types::U64(NOW + 91 * DAY)
        ))
        .contains("within 90 days")
    );
    assert!(
        panics(|| p.open_line(acct(CARD), U128(1_000 * NEAR), 100, due))
            .contains("collateral is below")
    );
    call_as(LP2, 0, NOW);
    assert!(
        panics(|| p.open_line(acct(CARD), U128(NEAR), 100, due))
            .contains("Caller is not the owner")
    );
    // idle liquidity: collateral is enough (400 NEAR posted) but the pool holds 100
    call_as(BORROWER, 400 * NEAR, NOW);
    p.post_collateral(acct(CARD));
    call_as(OWNER, 0, NOW);
    assert!(
        panics(|| p.open_line(acct(CARD), U128(200 * NEAR), 100, due)).contains("idle liquidity")
    );
    assert!(panics(|| p.open_line(acct(BORROWER), U128(NEAR), 100, due)).contains("unknown card"));
}

#[test]
fn only_the_borrower_posts_collateral() {
    let mut p = funded_pool();
    call_as(LP1, NEAR, NOW);
    assert!(panics(|| p.post_collateral(acct(CARD))).contains("not the card's borrower"));
    call_as(BORROWER, 0, NOW);
    assert!(panics(|| p.post_collateral(acct(CARD))).contains("must be positive"));
    call_as(BORROWER, NEAR, NOW);
    p.post_collateral(acct(CARD));
    assert_eq!(p.collateral_held, NEAR);
}

#[test]
fn open_line_moves_idle_to_lent_and_funds_the_card() {
    let mut p = funded_pool();
    open(&mut p, 50 * NEAR, 200);
    assert_eq!((p.idle, p.lent), (50 * NEAR, 50 * NEAR));
    assert_eq!(p.get_pool().assets.0, 100 * NEAR);
    let r = get_created_receipts();
    assert!(r.iter().any(|x| x.receiver_id.as_str() == CARD), "{r:?}");
    let line = p.get_line(acct(CARD)).unwrap();
    assert_eq!(
        (line.limit.0, line.drawn.0, line.returned.0),
        (50 * NEAR, 50 * NEAR, 0)
    );
    assert_eq!(line.state, LineState::Open);
    assert_eq!(p.get_pool().lines.len(), 1);
    // a second line on an open card is refused
    call_as(OWNER, 0, NOW);
    assert!(
        panics(|| p.open_line(
            acct(CARD),
            U128(NEAR),
            100,
            near_sdk::json_types::U64(NOW + DAY)
        ))
        .contains("already has an open line")
    );
    // a failed funding transfer closes it back
    fails_to_fund(&mut p, 50 * NEAR);
    assert_eq!((p.idle, p.lent), (100 * NEAR, 0));
    assert_eq!(p.get_line(acct(CARD)).unwrap().state, LineState::Collecting);
}

#[test]
fn only_the_card_returns_funds_and_the_excess_goes_back() {
    let mut p = funded_pool();
    open(&mut p, 50 * NEAR, 200);
    call_as(LP1, 10 * NEAR, NOW);
    assert!(panics(|| p.on_card_return(acct(CARD))).contains("only the card"));
    call_as(CARD, 0, NOW);
    assert!(panics(|| p.on_card_return(acct(CARD))).contains("nothing was returned"));
    call_as(CARD, 20 * NEAR, NOW);
    p.on_card_return(acct(CARD));
    assert_eq!((p.idle, p.lent), (70 * NEAR, 30 * NEAR));
    assert_eq!(p.get_line(acct(CARD)).unwrap().returned.0, 20 * NEAR);
    // 40 more than the 30 outstanding: 30 credited, 10 sent back to the card
    call_as(CARD, 40 * NEAR, NOW);
    p.on_card_return(acct(CARD));
    assert_eq!((p.idle, p.lent), (100 * NEAR, 0));
    assert_eq!(
        transfers(),
        vec![(CARD.to_string(), 10 * NEAR)],
        "the 10 NEAR over the outstanding go back to the card"
    );
    // a card with no line, an unknown card
    call_as("stranger.test.near", NEAR, NOW);
    assert!(panics(|| p.on_card_return(acct("stranger.test.near"))).contains("unknown card"));
}

#[test]
fn repay_charges_the_fee_on_what_the_card_kept_and_returns_the_collateral() {
    let mut p = funded_pool();
    open(&mut p, 50 * NEAR, 200);
    call_as(CARD, 30 * NEAR, NOW);
    p.on_card_return(acct(CARD));
    // 20 kept, fee 2 percent of 20 = 0.4
    let owed = 20 * NEAR + 4 * NEAR / 10;
    call_as(BORROWER, owed - 1, NOW);
    assert!(panics(|| p.repay(acct(CARD))).contains("repay needs at least"));
    call_as(BORROWER, owed + NEAR, NOW);
    p.repay(acct(CARD));
    assert_eq!(p.fees_earned, 4 * NEAR / 10);
    assert_eq!((p.idle, p.lent), (100 * NEAR + 4 * NEAR / 10, 0));
    assert_eq!(p.collateral_held, 0);
    assert_eq!(p.get_line(acct(CARD)).unwrap().state, LineState::Repaid);
    // LPs earned: their 100 shares are worth 100.4
    assert_eq!(p.get_lp(acct(LP1)).value.0, 100 * NEAR + 4 * NEAR / 10);
    let sent = transfers();
    assert!(
        sent.contains(&(BORROWER.to_string(), 15 * NEAR)),
        "the collateral (30 percent of 50) goes back: {sent:?}"
    );
    assert!(
        sent.contains(&(BORROWER.to_string(), NEAR)),
        "the excess of the repay goes back: {sent:?}"
    );
    assert_eq!(sent.len(), 2, "nothing else is sent: {sent:?}");
    call_as(BORROWER, owed, NOW);
    assert!(panics(|| p.repay(acct(CARD))).contains("no open line"));
}

#[test]
fn a_fully_swept_line_owes_nothing() {
    let mut p = funded_pool();
    open(&mut p, 50 * NEAR, 500);
    call_as(CARD, 50 * NEAR, NOW);
    p.on_card_return(acct(CARD));
    call_as(BORROWER, 0, NOW);
    p.repay(acct(CARD));
    assert_eq!(p.fees_earned, 0);
    assert_eq!(p.collateral_held, 0);
}

#[test]
fn default_seizes_collateral_principal_first_and_books_the_rest_as_a_loss() {
    let mut p = funded_pool();
    open(&mut p, 50 * NEAR, 1_000);
    // 50 outstanding, fee 5, owed 55, collateral 15: seized 15, all principal, loss 35
    call_as("anyone.test.near", 0, NOW + 29 * DAY);
    assert!(panics(|| p.default(acct(CARD))).contains("not due yet"));
    call_as("anyone.test.near", 0, NOW + 31 * DAY);
    p.default(acct(CARD));
    assert_eq!(p.losses, 35 * NEAR);
    assert_eq!((p.idle, p.lent), (50 * NEAR + 15 * NEAR, 0));
    assert_eq!(p.fees_earned, 0);
    assert_eq!(p.collateral_held, 0);
    assert_eq!(p.get_line(acct(CARD)).unwrap().state, LineState::Defaulted);
    assert_eq!(p.get_pool().assets.0, 65 * NEAR, "LPs lost 35");
    // a recovery sweep after the default is credited, never above the loss
    call_as(CARD, 40 * NEAR, NOW + 32 * DAY);
    p.on_card_return(acct(CARD));
    assert_eq!(p.losses, 0);
    assert_eq!(p.get_pool().assets.0, 100 * NEAR);
}

#[test]
fn default_with_collateral_above_what_is_owed_returns_the_rest() {
    let mut p = funded_pool();
    open(&mut p, 10 * NEAR, 1_000);
    call_as(BORROWER, 50 * NEAR, NOW);
    p.post_collateral(acct(CARD));
    // outstanding 10, fee 1, owed 11, collateral 53: seized 11, 42 back
    call_as("anyone.test.near", 0, NOW + 31 * DAY);
    p.default(acct(CARD));
    assert_eq!(p.losses, 0);
    assert_eq!(p.fees_earned, NEAR);
    assert_eq!(p.get_pool().assets.0, 101 * NEAR);
    assert_eq!(p.collateral_held, 0);
    assert_eq!(
        transfers(),
        vec![(BORROWER.to_string(), 42 * NEAR)],
        "the collateral beyond what is owed goes back"
    );
}

#[test]
fn default_refusals() {
    let mut p = funded_pool();
    call_as("anyone.test.near", 0, NOW + 40 * DAY);
    assert!(panics(|| p.default(acct(CARD))).contains("no line"));
    open(&mut p, 10 * NEAR, 100);
    call_as(CARD, 10 * NEAR, NOW);
    p.on_card_return(acct(CARD));
    call_as("anyone.test.near", 0, NOW + 40 * DAY);
    assert!(panics(|| p.default(acct(CARD))).contains("nothing is owed"));
}

#[test]
fn the_collateral_ratio_is_the_owner_s_and_open_lines_keep_theirs() {
    let mut p = funded_pool();
    call_as(LP1, 0, NOW);
    assert!(panics(|| p.set_collateral_bps(0)).contains("Caller is not the owner"));
    call_as(OWNER, 0, NOW);
    assert!(panics(|| p.set_collateral_bps(10_001)).contains("above 100 percent"));
    p.set_collateral_bps(0);
    let _ = p.open_line(
        acct(CARD),
        U128(10 * NEAR),
        100,
        near_sdk::json_types::U64(NOW + DAY),
    );
    assert_eq!(p.get_line(acct(CARD)).unwrap().collateral.0, 0);
}

#[test]
fn a_failed_payout_parks_the_amount_for_claim() {
    let mut p = funded_pool();
    testing_env!(
        ctx(POOL, 0, NOW).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    p.on_payout(acct(BORROWER), U128(3 * NEAR));
    assert_eq!(p.get_unclaimed(acct(BORROWER)).0, 3 * NEAR);
    call_as(BORROWER, 0, NOW);
    let _ = p.claim();
    assert_eq!(p.get_unclaimed(acct(BORROWER)).0, 0);
    assert!(panics(|| p.claim()).contains("nothing to claim"));
}

// ---- the accounting, as a property over random sequences ----

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn check(p: &Pool, lps: &[&str]) {
    assert_eq!(p.get_pool().assets.0, p.idle + p.lent + p.staked);
    let shares: u128 = lps.iter().map(|a| p.get_lp(acct(a)).shares.0).sum();
    assert_eq!(
        shares, p.total_shares,
        "the shares are exactly the LPs' shares"
    );
    let claims: u128 = lps.iter().map(|a| p.get_lp(acct(a)).value.0).sum();
    assert!(
        claims <= p.assets(),
        "claims {claims} above assets {}",
        p.assets()
    );
    let (mut lent, mut collateral) = (0u128, 0u128);
    for l in p.list_lines(None, None) {
        if matches!(l.state, LineState::Open) {
            lent += l.limit.0 - l.returned.0;
        }
        if matches!(l.state, LineState::Open | LineState::Collecting) {
            collateral += l.collateral.0;
        }
    }
    assert_eq!(
        lent, p.lent,
        "lent is the outstanding principal of the open lines"
    );
    assert_eq!(
        collateral, p.collateral_held,
        "collateral held is the collateral of live lines"
    );
}

/// One run of random operations; every seed runs in its own thread, because the mocked blockchain is thread local and each run needs an
/// empty storage.
fn run_property(seed: u64) {
    {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let mut p = pool();
        register(&mut p);
        let lps = [LP1, LP2];
        let mut now = NOW;
        for _ in 0..120 {
            now += rng.below(3) * DAY / 2;
            let price_before = math::share_price(p.assets(), p.total_shares).unwrap();
            let losses_before = p.losses;
            match rng.below(7) {
                0 | 1 => {
                    let who = lps[rng.below(2) as usize];
                    call_as(who, MIN_DEPOSIT + u128::from(rng.below(40)) * NEAR / 4, now);
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.deposit()));
                }
                2 => {
                    let who = lps[rng.below(2) as usize];
                    let have = p.get_lp(acct(who)).shares.0;
                    if have > 0 {
                        let s = have / 4 * u128::from(rng.below(4) + 1) + 1;
                        let worth = p.get_lp(acct(who)).value.0;
                        call_as(who, 0, now);
                        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            p.withdraw(U128(s.min(have)))
                        }));
                        if r.is_ok() {
                            let paid = p.get_lp(acct(who)).value.0;
                            assert!(paid <= worth, "a withdraw never raises what the LP holds");
                        }
                    }
                }
                3 => {
                    let line_open = p
                        .get_line(acct(CARD))
                        .is_some_and(|l| matches!(l.state, LineState::Open));
                    if !line_open {
                        let limit = u128::from(rng.below(30) + 1) * NEAR;
                        call_as(BORROWER, limit * 3 / 10 + 1, now);
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            p.post_collateral(acct(CARD))
                        }));
                        call_as(OWNER, 0, now);
                        let fee = (rng.below(20) * 100) as u32;
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            p.open_line(
                                acct(CARD),
                                U128(limit),
                                fee,
                                near_sdk::json_types::U64(now + 10 * DAY),
                            )
                        }));
                    }
                }
                4 => {
                    call_as(CARD, u128::from(rng.below(25)) * NEAR / 2 + 1, now);
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        p.on_card_return(acct(CARD))
                    }));
                }
                5 => {
                    call_as(BORROWER, u128::from(rng.below(40)) * NEAR, now);
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        p.repay(acct(CARD))
                    }));
                }
                _ => {
                    call_as("anyone.test.near", 0, now);
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        p.default(acct(CARD))
                    }));
                }
            }
            check(&p, &lps);
            if p.total_shares > 0 && p.assets() > 0 && p.losses == losses_before {
                let price = math::share_price(p.assets(), p.total_shares).unwrap();
                assert!(
                    price + 1 >= price_before,
                    "the share price fell without a loss: {price_before} to {price}"
                );
            }
        }
    }
}

#[test]
fn property_random_operations_keep_the_accounting() {
    for seed in 1..=12u64 {
        std::thread::spawn(move || run_property(seed))
            .join()
            .unwrap_or_else(|_| panic!("seed {seed} broke an invariant"));
    }
}

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
    Pool::new(
        OWNER.parse().unwrap(),
        Some(near_sdk::json_types::U64(0)),
        None,
    )
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
    // the Passport cap (AIR-333) is not the subject here: the base is raised far above these limits (min_hold_ms is 0 in this pool)
    call_as(OWNER, 1, NOW);
    p.set_passport_base(U128(1_000_000 * NEAR));
    p.apply_passport_base();
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
fn deposits_are_refused_while_a_line_is_past_due_and_reopen_after_default() {
    // F1 (security review): one valuation for both sides. A deposit priced at the impaired value lets a newcomer buy cheap before a
    // repay; priced un-impaired it lets an incumbent leave on newcomers' money before a default. So deposits are refused while any line
    // is overdue; `default` is permissionless and clears the impairment, which reopens them at the post-loss price.
    let mut p = funded_pool();
    open(&mut p, 60 * NEAR, 500);
    let late = NOW + 31 * DAY;
    call_as(LP2, 40 * NEAR, late);
    assert!(panics(|| p.deposit()).contains("deposits are paused while a line is past due"));
    // nothing moved: the incumbent holds the same shares and value, the pool the same totals
    assert_eq!(p.total_shares, 100 * NEAR);
    let value_before = p.get_lp(acct(LP1)).value.0;
    call_as("anyone.test.near", 0, late);
    p.default(acct(CARD));
    // 63 owed, 18 of collateral seized, 42 lost: 58 assets over 100 shares
    assert_eq!(p.get_lp(acct(LP1)).value.0, 58 * NEAR);
    assert!(value_before < 100 * NEAR);
    // the loss is unrecovered, so deposits stay closed (a later recovery would lift the price for a newcomer): the issuer's write off reopens
    call_as(LP2, 29 * NEAR, late);
    assert!(
        panics(|| p.deposit())
            .contains("deposits are paused while a defaulted line is being recovered")
    );
    call_as(OWNER, 0, late);
    p.write_off(acct(CARD));
    call_as(LP2, 29 * NEAR, late);
    assert_eq!(
        p.deposit().0,
        50 * NEAR,
        "bought at the post-loss price 0.58"
    );
    assert_eq!(
        p.get_lp(acct(LP1)).value.0,
        58 * NEAR,
        "the incumbent is not moved"
    );
}

#[test]
fn a_repay_after_the_due_date_reopens_deposits_at_the_restored_price() {
    let mut p = funded_pool();
    open(&mut p, 60 * NEAR, 500);
    let late = NOW + 31 * DAY;
    call_as(BORROWER, 63 * NEAR, late);
    p.repay(acct(CARD));
    call_as(LP2, 103 * NEAR, late);
    assert_eq!(p.deposit().0, 100 * NEAR, "price 1.03 after the fee");
    assert_eq!(p.get_lp(acct(LP1)).value.0, 103 * NEAR);
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

// ---- review findings (loss erasure, loss front-running, collateral lock) ----

fn defaulted_with_loss() -> Pool {
    let mut p = funded_pool();
    open(&mut p, 50 * NEAR, 1_000);
    call_as("anyone.test.near", 0, NOW + 31 * DAY);
    p.default(acct(CARD));
    assert!(p.losses > 0);
    p
}

#[test]
fn a_card_with_an_unrecovered_loss_is_terminal_until_recovered_or_written_off() {
    let mut p = defaulted_with_loss();
    let loss = p.losses;
    call_as(BORROWER, 20 * NEAR, NOW + 32 * DAY);
    assert!(panics(|| p.post_collateral(acct(CARD))).contains("unrecovered loss"));
    call_as(OWNER, 0, NOW + 32 * DAY);
    assert!(
        panics(|| p.open_line(
            acct(CARD),
            U128(NEAR),
            100,
            near_sdk::json_types::U64(NOW + 40 * DAY)
        ))
        .contains("unrecovered loss")
    );
    // only the owner writes a loss off, and the pool keeps the loss
    call_as(LP1, 0, NOW + 32 * DAY);
    assert!(panics(|| p.write_off(acct(CARD))).contains("Caller is not the owner"));
    call_as(OWNER, 0, NOW + 32 * DAY);
    let assets_before = p.get_pool().assets.0;
    p.write_off(acct(CARD));
    assert_eq!(p.losses, loss, "a write off keeps the loss in the pool");
    assert_eq!(
        p.get_pool().assets.0,
        assets_before,
        "and does not touch the share price"
    );
    assert!(panics(|| p.write_off(acct(CARD))).contains("no loss to write off"));
    // the card is free: a new line opens, and a sweep after the write off is not credited as a recovery
    call_as(BORROWER, 3 * NEAR, NOW + 32 * DAY);
    p.post_collateral(acct(CARD));
    call_as(OWNER, 0, NOW + 32 * DAY);
    let _ = p.open_line(
        acct(CARD),
        U128(10 * NEAR),
        100,
        near_sdk::json_types::U64(NOW + 40 * DAY),
    );
    assert_eq!(p.losses, loss, "a new line does not reset the loss");
}

#[test]
fn deposits_stay_closed_between_a_default_and_its_recovery() {
    // F1 again (third review): after `default` books a loss, a later recovery sweep raises the price. A deposit in between would buy
    // cheap and capture part of the recovery from the incumbents, so deposits wait for the recovery (or the issuer's write off).
    let mut p = defaulted_with_loss();
    assert_eq!(p.get_lp(acct(LP1)).value.0, 65 * NEAR);
    let t = NOW + 32 * DAY;
    call_as(LP2, 65 * NEAR, t);
    assert!(
        panics(|| p.deposit())
            .contains("deposits are paused while a defaulted line is being recovered")
    );
    // a partial recovery keeps them closed, the full one opens them at the recovered price
    call_as(CARD, 10 * NEAR, t);
    p.on_card_return(acct(CARD));
    call_as(LP2, 65 * NEAR, t);
    assert!(panics(|| p.deposit()).contains("being recovered"));
    call_as(CARD, 25 * NEAR, t);
    p.on_card_return(acct(CARD));
    assert_eq!(
        p.get_lp(acct(LP1)).value.0,
        100 * NEAR,
        "the incumbents got the whole recovery"
    );
    call_as(LP2, 100 * NEAR, t);
    assert_eq!(
        p.deposit().0,
        100 * NEAR,
        "bought at the recovered price 1.0"
    );
    assert_eq!(p.get_lp(acct(LP1)).value.0, 100 * NEAR);
}

#[test]
fn a_write_off_reopens_deposits() {
    let mut p = defaulted_with_loss();
    let t = NOW + 32 * DAY;
    call_as(LP2, 65 * NEAR, t);
    assert!(panics(|| p.deposit()).contains("being recovered"));
    call_as(OWNER, 0, t);
    p.write_off(acct(CARD));
    call_as(LP2, 65 * NEAR, t);
    assert_eq!(p.deposit().0, 100 * NEAR, "post-loss price 0.65");
    assert_eq!(p.get_lp(acct(LP1)).value.0, 65 * NEAR);
}

const HOLD: u64 = 3_600_000;

fn held_pool() -> Pool {
    call_as(OWNER, 0, NOW);
    let mut p = Pool::new(acct(OWNER), Some(near_sdk::json_types::U64(HOLD)), None);
    call_as(LP1, 100 * NEAR, NOW);
    p.deposit();
    register(&mut p);
    p
}

#[test]
fn shares_are_held_for_min_hold_ms_after_a_deposit() {
    let mut p = held_pool();
    assert_eq!(p.get_pool().min_hold_ms.0, HOLD);
    assert_eq!(p.get_lp(acct(LP1)).locked_until_ms.0, NOW + HOLD);
    call_as(LP1, 0, NOW + HOLD - 1);
    let e = panics(|| p.withdraw(U128(NEAR)));
    assert!(
        e.contains(&format!("withdraw is locked until {}", NOW + HOLD)),
        "{e}"
    );
    call_as(LP1, 0, NOW + HOLD);
    let _ = p.withdraw(U128(NEAR));
    // a second deposit restarts the clock for that LP's whole position
    call_as(LP1, NEAR, NOW + HOLD + 5);
    p.deposit();
    call_as(LP1, 0, NOW + HOLD + 6);
    assert!(panics(|| p.withdraw(U128(NEAR))).contains("withdraw is locked until"));
}

#[test]
fn a_deposit_just_before_a_repay_cannot_capture_the_fee() {
    // the sandwich: deposit, the borrower repays (the fee lands), withdraw. The hold makes the exit impossible inside the window.
    let mut p = held_pool();
    open(&mut p, 50 * NEAR, 1_000);
    call_as(LP2, 100 * NEAR, NOW + 1000);
    p.deposit();
    call_as(BORROWER, 55 * NEAR, NOW + 2000);
    p.repay(acct(CARD));
    call_as(LP2, 0, NOW + 3000);
    assert!(panics(|| p.withdraw(U128(100 * NEAR))).contains("withdraw is locked until"));
    assert_eq!(p.get_lp(acct(LP2)).locked_until_ms.0, NOW + 1000 + HOLD);
}

#[test]
fn a_recovered_loss_frees_the_card() {
    let mut p = defaulted_with_loss();
    let loss = p.losses;
    call_as(CARD, loss, NOW + 32 * DAY);
    p.on_card_return(acct(CARD));
    assert_eq!(p.losses, 0);
    call_as(BORROWER, 3 * NEAR, NOW + 32 * DAY);
    p.post_collateral(acct(CARD));
}

#[test]
fn an_overdue_line_is_impaired_in_the_share_price_before_anyone_calls_default() {
    let mut p = funded_pool();
    open(&mut p, 60 * NEAR, 500);
    // before the due date nothing is impaired: 100 shares are worth 100
    call_as(LP1, 0, NOW + 29 * DAY);
    assert_eq!(p.get_pool().assets.0, 100 * NEAR);
    // after it, with no default call yet, the 60 outstanding count as 0
    call_as(LP1, 0, NOW + 31 * DAY);
    let view = p.get_pool();
    assert_eq!(view.assets.0, 40 * NEAR, "{view:?}");
    assert_eq!(view.share_price.0, NEAR * 4 / 10);
    assert_eq!(p.get_lp(acct(LP1)).value.0, 40 * NEAR);
    // an LP who withdraws now gets the impaired price, not the old one
    let _ = p.withdraw(U128(10 * NEAR));
    assert_eq!(
        transfers(),
        vec![(LP1.to_string(), 4 * NEAR)],
        "10 shares at 0.4"
    );
    // and a deposit is refused while the line is past due (F1)
    call_as(LP2, 4 * NEAR, NOW + 31 * DAY);
    assert!(panics(|| p.deposit()).contains("deposits are paused while a line is past due"));
}

#[test]
fn a_repay_after_the_due_date_but_before_default_restores_the_price() {
    let mut p = funded_pool();
    open(&mut p, 60 * NEAR, 500);
    call_as(BORROWER, 63 * NEAR, NOW + 31 * DAY);
    p.repay(acct(CARD));
    call_as(LP1, 0, NOW + 31 * DAY);
    assert_eq!(p.get_pool().assets.0, 103 * NEAR);
}

#[test]
fn collateral_can_be_withdrawn_by_the_borrower_while_no_line_is_open() {
    let mut p = funded_pool();
    call_as(BORROWER, 3 * NEAR, NOW);
    p.post_collateral(acct(CARD));
    call_as(LP1, 0, NOW);
    assert!(
        panics(|| p.withdraw_collateral(acct(CARD), U128(NEAR)))
            .contains("not the card's borrower")
    );
    call_as(BORROWER, 0, NOW);
    assert!(panics(|| p.withdraw_collateral(acct(CARD), U128(0))).contains("must be positive"));
    assert!(
        panics(|| p.withdraw_collateral(acct(CARD), U128(4 * NEAR)))
            .contains("exceeds the posted collateral")
    );
    p.withdraw_collateral(acct(CARD), U128(NEAR));
    assert_eq!(
        p.collateral_held,
        2 * NEAR,
        "the state moves before the payout"
    );
    assert_eq!(transfers(), vec![(BORROWER.to_string(), NEAR)]);
    assert_eq!(p.get_line(acct(CARD)).unwrap().collateral.0, 2 * NEAR);
    // with a line open it is refused: the collateral secures the draw
    call_as(BORROWER, 10 * NEAR, NOW);
    p.post_collateral(acct(CARD));
    call_as(OWNER, 0, NOW);
    let _ = p.open_line(
        acct(CARD),
        U128(10 * NEAR),
        100,
        near_sdk::json_types::U64(NOW + DAY),
    );
    call_as(BORROWER, 0, NOW);
    assert!(
        panics(|| p.withdraw_collateral(acct(CARD), U128(NEAR))).contains("collateral secures it")
    );
    // nothing to withdraw on a card with no line
    let mut q = funded_pool();
    call_as(BORROWER, 0, NOW);
    assert!(panics(|| q.withdraw_collateral(acct(CARD), U128(1))).contains("no collateral"));
}

#[test]
fn a_failed_funding_transfer_refunds_the_collateral() {
    let mut p = funded_pool();
    open(&mut p, 50 * NEAR, 200);
    fails_to_fund(&mut p, 50 * NEAR);
    assert_eq!((p.idle, p.lent), (100 * NEAR, 0));
    assert_eq!(
        p.collateral_held, 0,
        "the collateral of the failed line is released"
    );
    assert_eq!(
        transfers(),
        vec![(BORROWER.to_string(), 15 * NEAR)],
        "and goes back to the borrower"
    );
    let line = p.get_line(acct(CARD)).unwrap();
    assert_eq!((line.collateral.0, line.state), (0, LineState::Collecting));
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
    assert_eq!(
        p.get_pool().assets.0,
        p.idle + p.lent + p.staked - p.get_pool().impaired.0
    );
    assert!(p.get_pool().impaired.0 <= p.lent);
    let shares: u128 = lps.iter().map(|a| p.get_lp(acct(a)).shares.0).sum();
    assert_eq!(
        shares, p.total_shares,
        "the shares are exactly the LPs' shares"
    );
    let claims: u128 = lps.iter().map(|a| p.get_lp(acct(a)).value.0).sum();
    assert!(
        claims <= p.get_pool().assets.0,
        "claims {claims} above assets {}",
        p.get_pool().assets.0
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
    // AIR-333: the Passport stays in bounds and its cap is the formula's
    if let Some(pp) = p.get_passport(acct(CARD)) {
        assert!(pp.score <= 1000);
        assert!(pp.record.recovered <= pp.record.defaults);
        assert_eq!(pp.limit_cap.0, math::limit_cap(p.passport_base, pp.score));
    }
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
            call_as(OWNER, 0, now);
            let price_before = p.get_pool().share_price.0;
            let impaired_before = p.get_pool().impaired.0;
            let losses_before = p.losses;
            match rng.below(7) {
                0 | 1 => {
                    let who = lps[rng.below(2) as usize];
                    call_as(who, MIN_DEPOSIT + u128::from(rng.below(40)) * NEAR / 4, now);
                    let value = |p: &Pool, who: &str| p.get_lp(acct(who)).value.0;
                    let other = if who == LP1 { LP2 } else { LP1 };
                    let (price_before, other_before) =
                        (p.get_pool().share_price.0, value(&p, other));
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.deposit()));
                    if r.is_ok() {
                        // F1: a deposit never moves what the other LP holds, and never lowers the price (rounding favours the pool)
                        call_as(OWNER, 0, now);
                        assert!(
                            p.get_pool().impaired.0 == 0,
                            "a deposit was accepted while a line was past due"
                        );
                        assert!(
                            p.cards.iter().all(|(_, c)| c.loss == 0),
                            "a deposit was accepted with an unrecovered loss"
                        );
                        assert!(
                            value(&p, other).abs_diff(other_before) <= 2,
                            "a deposit moved another LP's value"
                        );
                        assert!(p.get_pool().share_price.0 + 1 >= price_before);
                    }
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
                        let cap = p.get_passport(acct(CARD)).unwrap().limit_cap.0;
                        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            p.open_line(
                                acct(CARD),
                                U128(limit),
                                fee,
                                near_sdk::json_types::U64(now + 10 * DAY),
                            )
                        }));
                        if r.is_ok() {
                            assert!(
                                limit <= cap,
                                "a line of {limit} opened above the Passport cap {cap}"
                            );
                        }
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
            call_as(OWNER, 0, now);
            if p.total_shares > 0
                && p.get_pool().assets.0 > 0
                && p.losses == losses_before
                && p.get_pool().impaired.0 <= impaired_before
            {
                let price = p.get_pool().share_price.0;
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

// ---- the storage layout, pinned (airlock-credit has not been deployed; once it is, any change here needs a migration) ----

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn layout_the_storage_keys_follow_declaration_order() {
    let keys = [
        StorageKey::Lps,
        StorageKey::Cards,
        StorageKey::Unclaimed,
        StorageKey::Locks,
        StorageKey::Records,
    ];
    let bytes: Vec<Vec<u8>> = keys
        .iter()
        .map(|k| near_sdk::borsh::to_vec(k).unwrap())
        .collect();
    assert_eq!(
        bytes,
        vec![vec![0u8], vec![1u8], vec![2u8], vec![3u8], vec![4u8]],
        "a StorageKey is appended, never inserted"
    );
}

#[test]
fn layout_the_stored_structs_keep_their_borsh_bytes() {
    let line = Line {
        limit: 1,
        returned: 2,
        fee_bps: 3,
        due_ms: 4,
        collateral: 5,
        state: LineState::Open,
    };
    let card = Card {
        borrower: acct(BORROWER),
        line: Some(line.clone()),
        loss: 6,
    };
    let line_hex = hex(&near_sdk::borsh::to_vec(&line).unwrap());
    let card_hex = hex(&near_sdk::borsh::to_vec(&card).unwrap());
    assert_eq!(
        line_hex,
        "01000000000000000000000000000000020000000000000000000000000000000300000004000000000000000500000000000000000000000000000001",
        "Line: limit u128, returned u128, fee_bps u32, due_ms u64, collateral u128, state u8"
    );
    assert_eq!(
        card_hex,
        "12000000626f72726f7765722e746573742e6e656172010100000000000000000000000000000002000000000000000000000000000000030000000400000000000000050000000000000000000000000000000106000000000000000000000000000000",
        "Card: borrower string, Option<Line>, loss u128"
    );
    let states: Vec<u8> = [
        LineState::Collecting,
        LineState::Open,
        LineState::Repaid,
        LineState::Defaulted,
    ]
    .iter()
    .map(|s| near_sdk::borsh::to_vec(s).unwrap()[0])
    .collect();
    assert_eq!(
        states,
        vec![0, 1, 2, 3],
        "a LineState is appended, never inserted"
    );
}

#[test]
fn layout_the_pool_state_keeps_its_field_order_and_prefixes() {
    let mut p = pool();
    p.total_shares = 1;
    p.idle = 2;
    p.lent = 3;
    p.staked = 4;
    p.fees_earned = 5;
    p.losses = 6;
    p.collateral_held = 7;
    p.collateral_bps = 8;
    p.min_hold_ms = 9;
    p.passport_base = 10;
    p.pending_base = Some((11, 12));
    let pool_hex = hex(&near_sdk::borsh::to_vec(&p).unwrap());
    assert_eq!(
        pool_hex,
        format!(
            "{V1_HEX}{}{}{}{}",
            "0100000004",
            "0a000000000000000000000000000000",
            "010b0000000000000000000000000000000c00000000000000",
            "02000000"
        ),
        "Pool v2: the v1 bytes, then the records prefix (4), passport_base u128, pending_base Option<(u128, u64)>, version u32"
    );
}

/// The c1108d state bytes (version 1), as the layout test pinned them before AIR-333.
const V1_HEX: &str = "0f0000006f776e65722e746573742e6e656172080000000100000000000000000000000000000002000000000000000000000000000000030000000000000000000000000000000400000000000000000000000000000005000000000000000000000000000000060000000000000000000000000000000700000000000000000000000000000001000000000000000002000000017602000000016d010000000201000000030900000000000000";

#[test]
fn layout_pool_v1_is_the_deployed_layout() {
    call_as(OWNER, 0, NOW);
    let v1 = legacy::PoolV1 {
        owner_id: acct(OWNER),
        collateral_bps: 8,
        total_shares: 1,
        idle: 2,
        lent: 3,
        staked: 4,
        fees_earned: 5,
        losses: 6,
        collateral_held: 7,
        lps: LookupMap::new(StorageKey::Lps),
        cards: IterableMap::new(StorageKey::Cards),
        unclaimed: LookupMap::new(StorageKey::Unclaimed),
        locks: LookupMap::new(StorageKey::Locks),
        min_hold_ms: 9,
    };
    assert_eq!(
        hex(&near_sdk::borsh::to_vec(&v1).unwrap()),
        V1_HEX,
        "PoolV1 is a verbatim copy of the c1108d Pool"
    );
}

// ---- the Credit Passport (AIR-333) ----

const CARD2: &str = "card2.test.near";
const OTHER: &str = "other.test.near";
const CARD3: &str = "card3.test.near";

/// Registers `card` for `borrower` the way the callback does.
fn register_as(p: &mut Pool, card: &str, borrower: &str) {
    let roles = format!(r#"{{"owner_id":"{OWNER}","approver":"{borrower}","sponsor":"{POOL}"}}"#);
    testing_env!(
        ctx(POOL, 0, NOW).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(roles.into_bytes())]
    );
    p.on_card_roles(acct(card), acct(borrower));
}

/// The funding transfer of the line of `card` succeeded.
fn funded(p: &mut Pool, card: &str, limit: u128, now_ms: u64) {
    testing_env!(
        ctx(POOL, 0, now_ms).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    p.on_line_funded(acct(card), U128(limit));
}

/// Posts the collateral and opens a line of `limit` on `card` for `borrower`, due in 30 days from `now_ms`.
fn open_on(p: &mut Pool, card: &str, borrower: &str, limit: u128, fee_bps: u32, now_ms: u64) {
    call_as(borrower, limit * 3 / 10 + 1, now_ms);
    p.post_collateral(acct(card));
    call_as(OWNER, 0, now_ms);
    let _ = p.open_line(
        acct(card),
        U128(limit),
        fee_bps,
        near_sdk::json_types::U64(now_ms + 30 * DAY),
    );
}

/// The card returns `amount` (a sweep).
fn sweep_back(p: &mut Pool, card: &str, amount: u128, now_ms: u64) {
    call_as(card, amount, now_ms);
    p.on_card_return(acct(card));
}

/// The borrower repays what is owed on `card` at `now_ms`.
fn repay_at(p: &mut Pool, card: &str, borrower: &str, now_ms: u64) {
    let l = p.get_line(acct(card)).unwrap();
    let outstanding = l.limit.0 - l.returned.0;
    let owed = outstanding + math::fee_of(outstanding, l.fee_bps).unwrap();
    call_as(borrower, owed, now_ms);
    p.repay(acct(card));
}

fn passport(p: &Pool, card: &str) -> PassportView {
    p.get_passport(acct(card)).expect("a registered card")
}

fn set_base(p: &mut Pool, base: u128, now_ms: u64) {
    call_as(OWNER, 1, now_ms);
    p.set_passport_base(U128(base));
}

#[test]
fn a_fresh_borrower_starts_at_500_with_the_base_as_cap() {
    let p = funded_pool();
    let pp = passport(&p, CARD);
    assert_eq!(pp.borrower, acct(BORROWER));
    assert_eq!((pp.score, pp.limit_cap.0), (500, DEFAULT_PASSPORT_BASE));
    assert_eq!(pp.reasons, vec!["base +500".to_string()]);
    assert_eq!(pp.record, CreditRecordView::default());
    assert!(p.get_passport(acct("nobody.test.near")).is_none());
    let pv = p.get_pool_passport();
    assert_eq!(
        (pv.base.0, pv.pending_base, pv.effective_ms, pv.version),
        (DEFAULT_PASSPORT_BASE, None, None, STATE_VERSION)
    );
}

#[test]
fn the_record_counts_each_pool_event() {
    let mut p = funded_pool();
    // a failed funding counts nothing; a funded line counts once
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW);
    fails_to_fund(&mut p, 10 * NEAR);
    assert_eq!(passport(&p, CARD).record.lines_opened, 0);
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW);
    funded(&mut p, CARD, 10 * NEAR, NOW + 5);
    let r = passport(&p, CARD).record;
    assert_eq!((r.lines_opened, r.last_event_ms.0), (1, NOW + 5));
    // a qualifying repay on time: all 10 NEAR kept (the absolute floor at the default base of 100 NEAR), fee 5 percent
    repay_at(&mut p, CARD, BORROWER, NOW + 2 * DAY);
    let r = passport(&p, CARD).record;
    assert_eq!(
        (
            r.repaid_on_time,
            r.repaid_late,
            r.volume_repaid.0,
            r.fees_paid.0
        ),
        (1, 0, 10 * NEAR, NEAR / 2)
    );
    assert_eq!(r.last_event_ms.0, NOW + 2 * DAY);
    // a qualifying repay after the due date (before anyone defaulted it) is late
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW + 3 * DAY);
    repay_at(&mut p, CARD, BORROWER, NOW + 34 * DAY);
    let r = passport(&p, CARD).record;
    assert_eq!((r.repaid_on_time, r.repaid_late), (1, 1));
    // a default, a partial recovery (not counted) and the full one (counted once)
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW + 35 * DAY);
    call_as("anyone.test.near", 0, NOW + 66 * DAY);
    p.default(acct(CARD));
    assert_eq!(passport(&p, CARD).record.defaults, 1);
    let loss = p.cards.get(&acct(CARD)).unwrap().loss;
    sweep_back(&mut p, CARD, loss / 2, NOW + 67 * DAY);
    assert_eq!(passport(&p, CARD).record.recovered, 0);
    sweep_back(&mut p, CARD, loss, NOW + 68 * DAY);
    assert_eq!(passport(&p, CARD).record.recovered, 1);
    // a second default written off
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW + 69 * DAY);
    call_as("anyone.test.near", 0, NOW + 100 * DAY);
    p.default(acct(CARD));
    call_as(OWNER, 0, NOW + 101 * DAY);
    p.write_off(acct(CARD));
    let r = passport(&p, CARD).record;
    assert_eq!((r.defaults, r.recovered, r.written_off), (2, 1, 1));
    assert_eq!(r.last_event_ms.0, NOW + 101 * DAY);
    // 500 + 80 - 40 - 600 + 150 = 90
    assert_eq!(passport(&p, CARD).score, 90);
}

#[test]
fn dust_and_zero_fee_repays_do_not_count() {
    let mut p = funded_pool();
    // a cap base of 10 NEAR, so the absolute floor (1 NEAR) equals the relative one on these 10 NEAR lines; the absolute floor alone
    // is `ten_dust_lines_kept_in_full_do_not_raise_the_score`
    set_base(&mut p, 10 * NEAR, NOW);
    // 5 percent kept: below the 10 percent floor
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW);
    sweep_back(&mut p, CARD, 9_500 * NEAR / 1_000, NOW);
    repay_at(&mut p, CARD, BORROWER, NOW + DAY);
    // nothing kept at all
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW + DAY);
    sweep_back(&mut p, CARD, 10 * NEAR, NOW + DAY);
    repay_at(&mut p, CARD, BORROWER, NOW + DAY);
    // half kept but no fee
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 0, NOW + DAY);
    sweep_back(&mut p, CARD, 5 * NEAR, NOW + DAY);
    repay_at(&mut p, CARD, BORROWER, NOW + 2 * DAY);
    let pp = passport(&p, CARD);
    assert_eq!(
        (pp.record.repaid_on_time, pp.record.repaid_late, pp.score),
        (0, 0, 500),
        "no dust or zero fee repay moves the score"
    );
    assert_eq!(pp.record.volume_repaid.0, NEAR / 2 + 5 * NEAR);
    // exactly 10 percent kept with a fee counts
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW + 2 * DAY);
    sweep_back(&mut p, CARD, 9 * NEAR, NOW + 2 * DAY);
    repay_at(&mut p, CARD, BORROWER, NOW + 3 * DAY);
    let pp = passport(&p, CARD);
    assert_eq!((pp.record.repaid_on_time, pp.score), (1, 580));
    // a dust repay after the due date is not late either
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW + 3 * DAY);
    sweep_back(&mut p, CARD, 9_950 * NEAR / 1_000, NOW + 3 * DAY);
    repay_at(&mut p, CARD, BORROWER, NOW + 40 * DAY);
    assert_eq!(passport(&p, CARD).record.repaid_late, 0);
}

/// MERGE_GATE 2026-11-09: a relative floor alone lets the issuer and a borrower farm the score with lines of a few yocto that the card
/// keeps in full. The draw must also reach a tenth of the cap base, and the line must charge at least 1 percent.
#[test]
fn ten_dust_lines_kept_in_full_do_not_raise_the_score() {
    let mut p = funded_pool();
    let floor = DEFAULT_PASSPORT_BASE / crate::MIN_QUALIFYING_DRAW_DIV;
    // ten lines of a thousandth of the base, never swept (100 percent kept), fee 5 percent, each repaid on time
    for i in 0..10u64 {
        open_on(
            &mut p,
            CARD,
            BORROWER,
            DEFAULT_PASSPORT_BASE / 1_000,
            500,
            NOW + i * DAY,
        );
        repay_at(&mut p, CARD, BORROWER, NOW + i * DAY);
    }
    // one yocto under the absolute floor, kept in full
    open_on(&mut p, CARD, BORROWER, floor - 1, 500, NOW + 10 * DAY);
    repay_at(&mut p, CARD, BORROWER, NOW + 10 * DAY);
    // at the floor but the fee is under 1 percent (99 bps)
    open_on(
        &mut p,
        CARD,
        BORROWER,
        floor,
        crate::MIN_QUALIFYING_FEE_BPS - 1,
        NOW + 11 * DAY,
    );
    repay_at(&mut p, CARD, BORROWER, NOW + 11 * DAY);
    // a dust line repaid after the due date is not late either
    open_on(
        &mut p,
        CARD,
        BORROWER,
        DEFAULT_PASSPORT_BASE / 1_000,
        500,
        NOW + 12 * DAY,
    );
    repay_at(&mut p, CARD, BORROWER, NOW + 60 * DAY);
    let pp = passport(&p, CARD);
    assert_eq!(
        (
            pp.record.repaid_on_time,
            pp.record.repaid_late,
            pp.score,
            pp.limit_cap.0
        ),
        (0, 0, 500, DEFAULT_PASSPORT_BASE),
        "thirteen repays under the absolute floors move neither the score nor the cap"
    );
    // exactly at both floors: a tenth of the base kept, fee 1 percent
    open_on(
        &mut p,
        CARD,
        BORROWER,
        floor,
        crate::MIN_QUALIFYING_FEE_BPS,
        NOW + 61 * DAY,
    );
    repay_at(&mut p, CARD, BORROWER, NOW + 61 * DAY);
    let pp = passport(&p, CARD);
    assert_eq!((pp.record.repaid_on_time, pp.score), (1, 580));
}

#[test]
fn the_record_follows_the_borrower_not_the_card() {
    let mut p = funded_pool();
    open_on(&mut p, CARD, BORROWER, 10 * NEAR, 500, NOW);
    call_as("anyone.test.near", 0, NOW + 31 * DAY);
    p.default(acct(CARD));
    assert_eq!(passport(&p, CARD).score, 200);
    // the issuer registers a new card for the same borrower: it starts at the borrower's 200, not at 500
    register_as(&mut p, CARD2, BORROWER);
    let pp = passport(&p, CARD2);
    assert_eq!((pp.score, pp.record.defaults), (200, 1));
    assert_eq!(pp.limit_cap.0, DEFAULT_PASSPORT_BASE * 2 / 5);
    // a line on the new card above that cap is refused
    call_as(BORROWER, 30 * NEAR, NOW + 32 * DAY);
    p.post_collateral(acct(CARD2));
    call_as(OWNER, 0, NOW + 32 * DAY);
    let msg = panics(|| {
        p.open_line(
            acct(CARD2),
            U128(41 * NEAR),
            500,
            near_sdk::json_types::U64(NOW + 40 * DAY),
        )
    });
    assert!(msg.contains("Passport cap of 40 NEAR (score 200)"), "{msg}");
    // another borrower's card is not touched
    register_as(&mut p, CARD3, OTHER);
    assert_eq!(passport(&p, CARD3).score, 500);
}

#[test]
fn open_line_above_the_cap_is_refused_then_allowed_after_an_on_time_repay() {
    let mut p = funded_pool();
    set_base(&mut p, 10 * NEAR, NOW);
    call_as(BORROWER, 4 * NEAR, NOW);
    p.post_collateral(acct(CARD));
    call_as(OWNER, 0, NOW);
    let over = 11 * NEAR;
    let due = near_sdk::json_types::U64(NOW + 30 * DAY);
    let msg = panics(|| p.open_line(acct(CARD), U128(over), 500, due));
    assert!(
        msg.contains("the limit is above this card's Passport cap of 10 NEAR (score 500)"),
        "{msg}"
    );
    assert_eq!(
        (p.lent, p.get_line(acct(CARD)).unwrap().state),
        (0, LineState::Collecting),
        "a refused line moves nothing"
    );
    // at the cap it opens; a qualifying on-time repay raises the score to 580 and the cap to 11.6 NEAR
    call_as(OWNER, 0, NOW);
    let _ = p.open_line(acct(CARD), U128(10 * NEAR), 500, due);
    sweep_back(&mut p, CARD, 8 * NEAR, NOW + DAY);
    repay_at(&mut p, CARD, BORROWER, NOW + DAY);
    let pp = passport(&p, CARD);
    assert_eq!((pp.score, pp.limit_cap.0), (580, 116 * NEAR / 10));
    assert_eq!(
        pp.reasons,
        vec!["base +500".to_string(), "repaid_on_time x1 +80".to_string()]
    );
    call_as(BORROWER, 4 * NEAR, NOW + DAY);
    p.post_collateral(acct(CARD));
    call_as(OWNER, 0, NOW + DAY);
    // a decimal cap is printed as NEAR with its fraction
    let msg = panics(|| p.open_line(acct(CARD), U128(12 * NEAR), 500, due));
    assert!(
        msg.contains("the limit is above this card's Passport cap of 11.6 NEAR (score 580)"),
        "{msg}"
    );
    call_as(OWNER, 0, NOW + DAY);
    let _ = p.open_line(acct(CARD), U128(over), 500, due);
    assert_eq!(p.get_line(acct(CARD)).unwrap().state, LineState::Open);
}

#[test]
fn a_lower_base_applies_at_once_a_raise_only_after_min_hold_ms() {
    let mut p = held_pool();
    // lower: at once
    set_base(&mut p, 50 * NEAR, NOW);
    assert_eq!(p.get_pool_passport().base.0, 50 * NEAR);
    assert_eq!(passport(&p, CARD).limit_cap.0, 50 * NEAR);
    // LP2 deposits just before the announcement
    call_as(LP2, 10 * NEAR, NOW + 9);
    p.deposit();
    // raise: announced, not in force
    set_base(&mut p, 200 * NEAR, NOW + 10);
    let pv = p.get_pool_passport();
    assert_eq!(
        (
            pv.base.0,
            pv.pending_base.map(|b| b.0),
            pv.effective_ms.map(|t| t.0)
        ),
        (50 * NEAR, Some(200 * NEAR), Some(NOW + 10 + HOLD))
    );
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("passport_base_raise_announced"))
    );
    assert_eq!(passport(&p, CARD).limit_cap.0, 50 * NEAR);
    // one ms before it binds: refused, and LP2 (who deposited before the announcement) can already leave
    call_as("anyone.test.near", 0, NOW + 10 + HOLD - 1);
    let msg = panics(|| p.apply_passport_base());
    assert!(msg.contains("applies from"), "{msg}");
    call_as(LP2, 0, NOW + 10 + HOLD - 1);
    let shares = p.get_lp(acct(LP2)).shares.0;
    let _ = p.withdraw(U128(shares));
    assert_eq!(p.get_lp(acct(LP2)).shares.0, 0);
    // at the effective time anyone applies it
    call_as("anyone.test.near", 0, NOW + 10 + HOLD);
    p.apply_passport_base();
    assert_eq!(p.get_pool_passport().base.0, 200 * NEAR);
    assert_eq!(p.get_pool_passport().pending_base, None);
    let msg = panics(|| p.apply_passport_base());
    assert!(msg.contains("no raise"), "{msg}");
    // a lower value clears a pending raise
    set_base(&mut p, 300 * NEAR, NOW + 20 + HOLD);
    set_base(&mut p, 100 * NEAR, NOW + 21 + HOLD);
    let pv = p.get_pool_passport();
    assert_eq!((pv.base.0, pv.pending_base), (100 * NEAR, None));
    call_as("anyone.test.near", 0, NOW + 30 + 2 * HOLD);
    let msg = panics(|| p.apply_passport_base());
    assert!(msg.contains("no raise"), "{msg}");
}

#[test]
fn set_passport_base_is_owner_only_with_one_yocto() {
    let mut p = funded_pool();
    call_as(LP1, 1, NOW);
    let msg = panics(|| p.set_passport_base(U128(NEAR)));
    assert!(msg.contains("Caller is not the owner"), "{msg}");
    call_as(OWNER, 0, NOW);
    let msg = panics(|| p.set_passport_base(U128(NEAR)));
    assert!(msg.contains("1 yoctoNEAR"), "{msg}");
    assert_eq!(p.get_pool_passport().base.0, DEFAULT_PASSPORT_BASE);
}

/// A c1108d (version 1) state: four cards (a recovered default, a repaid line, an unrecovered default, a collecting line), two of them
/// for one borrower, plus an LP, a lock and an unclaimed payout.
fn write_v1_state() {
    call_as(POOL, 0, NOW);
    let line = |state, loss_left: bool| Line {
        limit: NEAR,
        returned: if loss_left { 0 } else { NEAR },
        fee_bps: 1_000,
        due_ms: NOW - DAY,
        collateral: 0,
        state,
    };
    let mut lps = LookupMap::new(StorageKey::Lps);
    lps.insert(acct(LP1), 7 * NEAR);
    let mut cards = IterableMap::new(StorageKey::Cards);
    cards.insert(
        acct(CARD),
        Card {
            borrower: acct(BORROWER),
            line: Some(line(LineState::Defaulted, true)),
            loss: 0,
        },
    );
    cards.insert(
        acct(CARD2),
        Card {
            borrower: acct(OTHER),
            line: Some(line(LineState::Repaid, false)),
            loss: 0,
        },
    );
    cards.insert(
        acct(CARD3),
        Card {
            borrower: acct(BORROWER),
            line: Some(line(LineState::Defaulted, true)),
            loss: NEAR / 3,
        },
    );
    cards.insert(
        acct("card4.test.near"),
        Card {
            borrower: acct("fresh.test.near"),
            line: Some(Line {
                limit: 0,
                returned: 0,
                fee_bps: 0,
                due_ms: 0,
                collateral: NEAR / 10,
                state: LineState::Collecting,
            }),
            loss: 0,
        },
    );
    let mut unclaimed = LookupMap::new(StorageKey::Unclaimed);
    unclaimed.insert(acct(LP2), 3);
    let mut locks = LookupMap::new(StorageKey::Locks);
    locks.insert(acct(LP1), NOW + 9);
    let v1 = legacy::PoolV1 {
        owner_id: acct(OWNER),
        collateral_bps: 2_500,
        total_shares: 11 * NEAR,
        idle: 12 * NEAR,
        lent: 0,
        staked: 14,
        fees_earned: 15,
        losses: NEAR / 3,
        collateral_held: NEAR / 10,
        lps,
        cards,
        unclaimed,
        locks,
        min_hold_ms: 60_000,
    };
    env::state_write(&v1);
}

#[test]
fn migrate_moves_every_field_and_backfills_only_what_the_state_proves() {
    write_v1_state();
    let p = Pool::migrate(U128(NEAR));
    assert_eq!(
        (
            p.owner_id.clone(),
            p.collateral_bps,
            p.total_shares,
            p.idle,
            p.lent,
            p.staked,
            p.fees_earned,
            p.losses,
            p.collateral_held,
            p.min_hold_ms
        ),
        (
            acct(OWNER),
            2_500,
            11 * NEAR,
            12 * NEAR,
            0,
            14,
            15,
            NEAR / 3,
            NEAR / 10,
            60_000
        )
    );
    assert_eq!(p.get_lp(acct(LP1)).shares.0, 7 * NEAR);
    assert_eq!(p.get_lp(acct(LP1)).locked_until_ms.0, NOW + 9);
    assert_eq!(p.get_unclaimed(acct(LP2)).0, 3);
    assert_eq!(p.list_lines(None, None).len(), 4);
    assert_eq!(p.cards.get(&acct(CARD3)).unwrap().loss, NEAR / 3);
    let pv = p.get_pool_passport();
    assert_eq!(
        (pv.base.0, pv.pending_base, pv.version),
        (NEAR, None, STATE_VERSION)
    );
    // BORROWER: two cards, each one line, each a default; the cleared loss is not a recovery, the open loss is not a write-off
    let pp = passport(&p, CARD);
    assert_eq!(
        (
            pp.record.lines_opened,
            pp.record.defaults,
            pp.record.recovered,
            pp.record.written_off,
            pp.record.repaid_on_time,
            pp.record.backfilled,
            pp.record.last_event_ms.0
        ),
        (2, 2, 0, 0, 0, true, 0)
    );
    assert_eq!(pp.score, 0);
    assert_eq!(pp, passport(&p, CARD3), "both cards read one record");
    assert!(
        pp.reasons.iter().any(|r| r.starts_with("backfilled")),
        "{:?}",
        pp.reasons
    );
    // OTHER: a repaid line whose timing is not stored counts neither on time nor late
    let pp = passport(&p, CARD2);
    assert_eq!(
        (
            pp.record.lines_opened,
            pp.record.repaid_on_time,
            pp.record.repaid_late,
            pp.record.volume_repaid.0,
            pp.score
        ),
        (1, 0, 0, 0, 500)
    );
    // a collecting line proves nothing: no record
    let pp = passport(&p, "card4.test.near");
    assert_eq!((pp.record, pp.score), (CreditRecordView::default(), 500));
}

#[test]
fn migrate_of_the_live_shape_gives_one_default_and_score_200() {
    // the c1108d pool holds one card whose second line defaulted and was recovered by a sweep
    call_as(POOL, 0, NOW);
    let mut cards = IterableMap::new(StorageKey::Cards);
    cards.insert(
        acct(CARD),
        Card {
            borrower: acct(BORROWER),
            line: Some(Line {
                limit: NEAR,
                returned: 0,
                fee_bps: 1_000,
                due_ms: NOW - DAY,
                collateral: 0,
                state: LineState::Defaulted,
            }),
            loss: 0,
        },
    );
    let v1 = legacy::PoolV1 {
        owner_id: acct(OWNER),
        collateral_bps: 3_000,
        total_shares: 2 * NEAR,
        idle: 2 * NEAR,
        lent: 0,
        staked: 0,
        fees_earned: NEAR / 20,
        losses: 0,
        collateral_held: 0,
        lps: LookupMap::new(StorageKey::Lps),
        cards,
        unclaimed: LookupMap::new(StorageKey::Unclaimed),
        locks: LookupMap::new(StorageKey::Locks),
        min_hold_ms: 60_000,
    };
    env::state_write(&v1);
    drop(v1);
    let p = Pool::migrate(U128(NEAR));
    let pp = passport(&p, CARD);
    assert_eq!(
        (pp.score, pp.limit_cap.0, pp.record.defaults),
        (200, 4 * NEAR / 10, 1)
    );
}

#[test]
fn migrate_twice_is_refused() {
    write_v1_state();
    let p = Pool::migrate(U128(NEAR));
    env::state_write(&p);
    drop(p);
    let msg = panics(|| Pool::migrate(U128(NEAR)));
    assert!(msg.contains("Cannot deserialize"), "{msg}");
}

#[test]
fn passport_vectors_match() {
    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde")]
    struct Vector {
        name: String,
        base: U128,
        record: CreditRecordView,
        score: u32,
        reasons: Vec<String>,
        limit_cap: U128,
    }
    let vectors: Vec<Vector> =
        near_sdk::serde_json::from_str(include_str!("../vectors/passport.json")).unwrap();
    assert!(vectors.len() >= 8);
    for v in vectors {
        let (score, reasons) = math::passport_score(&CreditRecord::from(&v.record));
        assert_eq!(score, v.score, "{}", v.name);
        assert_eq!(reasons, v.reasons, "{}", v.name);
        assert_eq!(
            math::limit_cap(v.base.0, score),
            v.limit_cap.0,
            "{}",
            v.name
        );
    }
}

#[test]
fn the_c1108d_wasm_is_pinned() {
    call_as(OWNER, 0, NOW);
    let sha = env::sha256(include_bytes!("../res/airlock_credit_c1108d.wasm"));
    assert_eq!(
        hex(&sha),
        "1f915ce22956f33c4b65d092838c0429e2255dd6d224b6c58db8f9b941343419",
        "res/airlock_credit_c1108d.wasm is the code deployed on pool.airlock-credit-c1108d.testnet"
    );
}

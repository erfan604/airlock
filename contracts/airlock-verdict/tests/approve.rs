//! AIR-026: the approve-time check (`airlock_verdict::approve`): the owner's `approve` arguments must equal the stored escalation field by
//! field, then the limits are rechecked against the current registry; the first failing check names the error.
//! Fixture: stored payee `near:acct.near`, symbol NEAR, 9.4 NEAR at 24 decimals, reason NewRecipient, not in the book, expires at 1,000 ms,
//! pending; args that say exactly that; live at 999 ms with the agent allowed, the task not revoked and no pause; asset limits hard cap 1,000,
//! remaining daily 1,000, max fee 50, max gas 100,000; request amount 1,000 (the happy path) or 10.

use airlock_verdict::approve::*;
use airlock_verdict::{AssetLimits, Labels, Reason, Request, ALL_REASONS};

fn stored() -> StoredView<'static> {
    StoredView {
        payee_key: b"near:acct.near",
        asset_symbol: b"NEAR",
        amount: 9_400_000_000_000_000_000_000_000,
        decimals: 24,
        reason: Reason::NewRecipient,
        in_book: false,
        expires_ms: 1_000,
        pending: true,
    }
}

fn args() -> ApproveArgs<'static> {
    ApproveArgs {
        to: b"near:acct.near",
        asset: b"NEAR",
        amount: b"9.4",
        why: b"NewRecipient",
        book: b"new",
    }
}

fn live() -> Live {
    Live {
        now_ms: 999,
        agent_allowed: true,
        task_revoked: false,
        paused: false,
    }
}

fn limits() -> Option<AssetLimits> {
    Some(AssetLimits {
        hard_cap: 1_000,
        remaining_daily: 1_000,
        max_fee_per_gas: 50,
        max_gas: 100_000,
    })
}

fn request(amount: u128) -> Request {
    Request {
        amount,
        fee_per_gas: None,
        gas: None,
        labels: Labels {
            recipient: 2,
            amount: 1,
            pc: 1,
        },
    }
}

fn check(
    s: &StoredView,
    a: &ApproveArgs,
    r: &Request,
    asset: Option<AssetLimits>,
    l: &Live,
) -> Result<(), ApproveError> {
    approve_check(s, a, r, asset, l)
}

fn happy() -> Result<(), ApproveError> {
    check(&stored(), &args(), &request(1_000), limits(), &live())
}

#[test]
fn happy_path_ok() {
    assert_eq!(happy(), Ok(()));
    assert_eq!(
        check(&stored(), &args(), &request(10), limits(), &live()),
        Ok(())
    );
}

#[test]
fn not_pending() {
    let s = StoredView {
        pending: false,
        ..stored()
    };
    assert_eq!(
        check(&s, &args(), &request(10), limits(), &live()),
        Err(ApproveError::NotPending)
    );
}

#[test]
fn expired_at_the_exact_boundary_ms() {
    let at = |now_ms| Live { now_ms, ..live() };
    assert_eq!(
        check(&stored(), &args(), &request(10), limits(), &at(999)),
        Ok(())
    );
    assert_eq!(
        check(&stored(), &args(), &request(10), limits(), &at(1_000)),
        Err(ApproveError::Expired)
    );
    assert_eq!(
        check(&stored(), &args(), &request(10), limits(), &at(1_001)),
        Err(ApproveError::Expired)
    );
    assert_eq!(
        check(&stored(), &args(), &request(10), limits(), &at(u64::MAX)),
        Err(ApproveError::Expired)
    );
}

#[test]
fn wrong_recipient() {
    for to in [
        &b"near:acct.nea"[..],
        b"near:acct.nearx",
        b"",
        b"near:other.near",
        b"NEAR:acct.near",
        b"near:acct.near ",
    ] {
        let a = ApproveArgs { to, ..args() };
        assert_eq!(
            check(&stored(), &a, &request(10), limits(), &live()),
            Err(ApproveError::WrongRecipient),
            "{:?}",
            String::from_utf8_lossy(to)
        );
    }
}

#[test]
fn wrong_asset() {
    for asset in [&b"near"[..], b"NEAR ", b"", b"NEA", b"NEARS"] {
        let a = ApproveArgs { asset, ..args() };
        assert_eq!(
            check(&stored(), &a, &request(10), limits(), &live()),
            Err(ApproveError::WrongAsset),
            "{:?}",
            String::from_utf8_lossy(asset)
        );
    }
}

#[test]
fn wrong_amount() {
    for amount in [
        &b"9.5"[..],
        b"9",
        b"",
        b"10",
        b"0",
        b"9.4000000000000000000000001",
    ] {
        let a = ApproveArgs { amount, ..args() };
        assert_eq!(
            check(&stored(), &a, &request(10), limits(), &live()),
            Err(ApproveError::WrongAmount),
            "{:?}",
            String::from_utf8_lossy(amount)
        );
    }
}

#[test]
fn wrong_reason() {
    for why in [
        &b"OverTaskBound"[..],
        b"newrecipient",
        b"NewRecipient ",
        b"",
        b"Limit:Paused",
    ] {
        let a = ApproveArgs { why, ..args() };
        assert_eq!(
            check(&stored(), &a, &request(10), limits(), &live()),
            Err(ApproveError::WrongReason),
            "{:?}",
            String::from_utf8_lossy(why)
        );
    }
    // the stored reason is what is compared: an UntrustedAmount escalation does not accept `NewRecipient`
    let s = StoredView {
        reason: Reason::UntrustedAmount,
        ..stored()
    };
    assert_eq!(
        check(&s, &args(), &request(10), limits(), &live()),
        Err(ApproveError::WrongReason)
    );
    let a = ApproveArgs {
        why: b"UntrustedAmount",
        ..args()
    };
    assert_eq!(check(&s, &a, &request(10), limits(), &live()), Ok(()));
}

#[test]
fn wrong_book_both_directions() {
    // stored as new: only `new` passes
    for book in [&b"in_book"[..], b"IN_BOOK", b"", b"new ", b"News"] {
        let a = ApproveArgs { book, ..args() };
        assert_eq!(
            check(&stored(), &a, &request(10), limits(), &live()),
            Err(ApproveError::WrongBook),
            "{:?}",
            String::from_utf8_lossy(book)
        );
    }
    // stored as in the book: only `in_book` passes
    let s = StoredView {
        in_book: true,
        ..stored()
    };
    assert_eq!(
        check(&s, &args(), &request(10), limits(), &live()),
        Err(ApproveError::WrongBook)
    );
    let a = ApproveArgs {
        book: b"in_book",
        ..args()
    };
    assert_eq!(check(&s, &a, &request(10), limits(), &live()), Ok(()));
    assert_eq!(BOOK_IN, b"in_book");
    assert_eq!(BOOK_NEW, b"new");
}

#[test]
fn agent_not_allowed() {
    let l = Live {
        agent_allowed: false,
        ..live()
    };
    assert_eq!(
        check(&stored(), &args(), &request(10), limits(), &l),
        Err(ApproveError::AgentNotAllowed)
    );
}

#[test]
fn task_revoked() {
    let l = Live {
        task_revoked: true,
        ..live()
    };
    assert_eq!(
        check(&stored(), &args(), &request(10), limits(), &l),
        Err(ApproveError::TaskRevoked)
    );
}

#[test]
fn limit_paused_and_unknown_asset() {
    let paused = Live {
        paused: true,
        ..live()
    };
    assert_eq!(
        check(&stored(), &args(), &request(10), limits(), &paused),
        Err(ApproveError::Limit(Reason::Paused))
    );
    assert_eq!(
        check(&stored(), &args(), &request(10), None, &live()),
        Err(ApproveError::Limit(Reason::UnknownAsset))
    );
    // an unknown asset is reported before the pause
    assert_eq!(
        check(&stored(), &args(), &request(10), None, &paused),
        Err(ApproveError::Limit(Reason::UnknownAsset))
    );
}

#[test]
fn limit_amount_zero_over_hard_cap_and_over_daily() {
    let err = |r: &Request, asset| check(&stored(), &args(), r, asset, &live());
    assert_eq!(
        err(&request(0), limits()),
        Err(ApproveError::Limit(Reason::AmountOutOfBounds))
    );
    assert_eq!(err(&request(1_000), limits()), Ok(()));
    assert_eq!(
        err(&request(1_001), limits()),
        Err(ApproveError::Limit(Reason::AmountOutOfBounds))
    );
    let daily = Some(AssetLimits {
        remaining_daily: 100,
        ..limits().unwrap()
    });
    assert_eq!(err(&request(100), daily), Ok(()));
    assert_eq!(
        err(&request(101), daily),
        Err(ApproveError::Limit(Reason::DailyLimit))
    );
    // the hard cap is judged before the daily cap
    assert_eq!(
        err(&request(1_001), daily),
        Err(ApproveError::Limit(Reason::AmountOutOfBounds))
    );
}

#[test]
fn limit_fee_and_gas_over_and_none_skips() {
    let with = |fee_per_gas, gas| Request {
        fee_per_gas,
        gas,
        ..request(10)
    };
    let err = |r: &Request| check(&stored(), &args(), r, limits(), &live());
    assert_eq!(err(&with(Some(50), Some(100_000))), Ok(()));
    assert_eq!(
        err(&with(Some(51), None)),
        Err(ApproveError::Limit(Reason::FeeTooHigh))
    );
    assert_eq!(
        err(&with(None, Some(100_001))),
        Err(ApproveError::Limit(Reason::FeeTooHigh))
    );
    assert_eq!(
        err(&with(Some(51), Some(100_001))),
        Err(ApproveError::Limit(Reason::FeeTooHigh))
    );
    // None skips the check (the contract supplies Some for every EVM asset)
    assert_eq!(err(&with(None, None)), Ok(()));
}

#[test]
fn error_order() {
    let bad_to = ApproveArgs {
        to: b"near:other.near",
        ..args()
    };
    // not pending before expired before a wrong `to`
    let s = StoredView {
        pending: false,
        ..stored()
    };
    let late = Live {
        now_ms: 5_000,
        ..live()
    };
    assert_eq!(
        check(&s, &bad_to, &request(10), limits(), &late),
        Err(ApproveError::NotPending)
    );
    assert_eq!(
        check(&stored(), &bad_to, &request(10), limits(), &late),
        Err(ApproveError::Expired)
    );
    // a wrong `to` beats a revoked agent, a revoked task, a pause and a zero amount
    let everything_wrong = Live {
        now_ms: 999,
        agent_allowed: false,
        task_revoked: true,
        paused: true,
    };
    assert_eq!(
        check(&stored(), &bad_to, &request(0), limits(), &everything_wrong),
        Err(ApproveError::WrongRecipient)
    );
    // the five argument checks in order: to, asset, amount, why, book
    let mut a = ApproveArgs {
        to: b"x",
        asset: b"x",
        amount: b"x",
        why: b"x",
        book: b"x",
    };
    let s = stored();
    let r = request(0);
    let rec = |a: &ApproveArgs| check(&s, a, &r, None, &everything_wrong);
    assert_eq!(rec(&a), Err(ApproveError::WrongRecipient));
    a.to = b"near:acct.near";
    assert_eq!(rec(&a), Err(ApproveError::WrongAsset));
    a.asset = b"NEAR";
    assert_eq!(rec(&a), Err(ApproveError::WrongAmount));
    a.amount = b"9.4";
    assert_eq!(rec(&a), Err(ApproveError::WrongReason));
    a.why = b"NewRecipient";
    assert_eq!(rec(&a), Err(ApproveError::WrongBook));
    a.book = b"new";
    // agent before task, task before the limits
    assert_eq!(rec(&a), Err(ApproveError::AgentNotAllowed));
    let task_and_pause = Live {
        agent_allowed: true,
        ..everything_wrong
    };
    assert_eq!(
        check(&s, &a, &r, None, &task_and_pause),
        Err(ApproveError::TaskRevoked)
    );
    let only_pause = Live {
        task_revoked: false,
        ..task_and_pause
    };
    assert_eq!(
        check(&s, &a, &r, None, &only_pause),
        Err(ApproveError::Limit(Reason::UnknownAsset))
    );
}

#[test]
fn amount_9_4_accepted_at_24_and_9_40_and_09_4_rejected() {
    let run = |amount: &[u8]| {
        let a = ApproveArgs { amount, ..args() };
        check(&stored(), &a, &request(10), limits(), &live())
    };
    assert_eq!(run(b"9.4"), Ok(()));
    for bad in [
        &b"9.40"[..],
        b"09.4",
        b"9.4 ",
        b"+9.4",
        b"94e-1",
        b"9,4",
        b" 9.4",
        b"9.4e0",
    ] {
        assert_eq!(
            run(bad),
            Err(ApproveError::WrongAmount),
            "{:?}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn unformattable_decimals_above_38_is_wrong_amount() {
    for decimals in [39u8, 40, 255] {
        let s = StoredView {
            decimals,
            ..stored()
        };
        assert_eq!(
            check(&s, &args(), &request(10), limits(), &live()),
            Err(ApproveError::WrongAmount),
            "decimals {decimals}"
        );
    }
    // 38 is the largest supported value and formats
    let s = StoredView {
        amount: u128::MAX,
        decimals: 38,
        ..stored()
    };
    let a = ApproveArgs {
        amount: b"3.40282366920938463463374607431768211455",
        ..args()
    };
    assert_eq!(check(&s, &a, &request(10), limits(), &live()), Ok(()));
}

#[test]
fn as_str_names() {
    assert_eq!(ApproveError::NotPending.as_str(), "NotPending");
    assert_eq!(ApproveError::Expired.as_str(), "Expired");
    assert_eq!(ApproveError::WrongRecipient.as_str(), "WrongRecipient");
    assert_eq!(ApproveError::WrongAsset.as_str(), "WrongAsset");
    assert_eq!(ApproveError::WrongAmount.as_str(), "WrongAmount");
    assert_eq!(ApproveError::WrongReason.as_str(), "WrongReason");
    assert_eq!(ApproveError::WrongBook.as_str(), "WrongBook");
    assert_eq!(ApproveError::AgentNotAllowed.as_str(), "AgentNotAllowed");
    assert_eq!(ApproveError::TaskRevoked.as_str(), "TaskRevoked");
    assert_eq!(ApproveError::Limit(Reason::Paused).as_str(), "Limit:Paused");
    for r in ALL_REASONS {
        let want = format!("Limit:{}", r.as_str());
        assert_eq!(ApproveError::Limit(r).as_str(), want);
    }
}

#[test]
fn recheck_standalone() {
    assert_eq!(recheck(&request(10), limits(), false), Ok(()));
    assert_eq!(recheck(&request(10), limits(), true), Err(Reason::Paused));
    assert_eq!(
        recheck(&request(10), None, false),
        Err(Reason::UnknownAsset)
    );
    assert_eq!(
        recheck(&request(0), limits(), false),
        Err(Reason::AmountOutOfBounds)
    );
    assert_eq!(
        recheck(&request(1_001), limits(), false),
        Err(Reason::AmountOutOfBounds)
    );
    let daily = Some(AssetLimits {
        remaining_daily: 5,
        ..limits().unwrap()
    });
    assert_eq!(recheck(&request(5), daily, false), Ok(()));
    assert_eq!(recheck(&request(6), daily, false), Err(Reason::DailyLimit));
    let fee = Request {
        fee_per_gas: Some(51),
        ..request(10)
    };
    assert_eq!(recheck(&fee, limits(), false), Err(Reason::FeeTooHigh));
    let gas = Request {
        gas: Some(100_001),
        ..request(10)
    };
    assert_eq!(recheck(&gas, limits(), false), Err(Reason::FeeTooHigh));
}

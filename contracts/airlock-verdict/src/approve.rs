//! The approve-time check as a pure function (F02 3.2, F03, SPEC 8.3 last paragraph, R4-01, R4-02, R4-13): the owner's `approve` arguments
//! must equal the stored escalation field by field (byte slices, so the contract passes `String::as_bytes()` and nothing here allocates),
//! the stored amount is compared byte for byte with its canonical decimal text (`decimal::format`), and then the limits are rechecked
//! against the current registry. The first failing check names the error; the contract panics with `approve rejected: <as_str>`.
//!
//! The comparison is against the stored display strings, not recomputed from the current registry: a registry rename between store and
//! approve makes the owner's screen differ from the stored card, so approve fails closed.
use crate::{decimal, AssetLimits, Reason, Request};

pub const BOOK_IN: &[u8] = b"in_book";
pub const BOOK_NEW: &[u8] = b"new";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApproveError {
    NotPending,
    Expired,
    WrongRecipient,
    WrongAsset,
    WrongAmount,
    WrongReason,
    WrongBook,
    AgentNotAllowed,
    TaskRevoked,
    Limit(Reason),
}

impl ApproveError {
    /// the text after `approve rejected: `; `Limit(r)` is `Limit:` plus `r.as_str()`
    pub fn as_str(self) -> &'static str {
        match self {
            ApproveError::NotPending => "NotPending",
            ApproveError::Expired => "Expired",
            ApproveError::WrongRecipient => "WrongRecipient",
            ApproveError::WrongAsset => "WrongAsset",
            ApproveError::WrongAmount => "WrongAmount",
            ApproveError::WrongReason => "WrongReason",
            ApproveError::WrongBook => "WrongBook",
            ApproveError::AgentNotAllowed => "AgentNotAllowed",
            ApproveError::TaskRevoked => "TaskRevoked",
            ApproveError::Limit(r) => limit_str(r),
        }
    }
}

/// no_std and no alloc cannot concatenate, so one literal per Reason variant (17 arms, a test checks all of them against `Reason::as_str`)
fn limit_str(r: Reason) -> &'static str {
    match r {
        Reason::UnknownAsset => "Limit:UnknownAsset",
        Reason::Paused => "Limit:Paused",
        Reason::AmountOutOfBounds => "Limit:AmountOutOfBounds",
        Reason::DailyLimit => "Limit:DailyLimit",
        Reason::FeeTooHigh => "Limit:FeeTooHigh",
        Reason::MissingProvenance => "Limit:MissingProvenance",
        Reason::BookLabelNotInBook => "Limit:BookLabelNotInBook",
        Reason::OutsideTask => "Limit:OutsideTask",
        Reason::OverTaskBound => "Limit:OverTaskBound",
        Reason::UntrustedTrigger => "Limit:UntrustedTrigger",
        Reason::UntrustedRecipient => "Limit:UntrustedRecipient",
        Reason::NewRecipient => "Limit:NewRecipient",
        Reason::OverPayeeLimit => "Limit:OverPayeeLimit",
        Reason::UntrustedAmount => "Limit:UntrustedAmount",
        Reason::PendingFull => "Limit:PendingFull",
        Reason::EscalationsLocked => "Limit:EscalationsLocked",
        Reason::EscalationBudget => "Limit:EscalationBudget",
    }
}

/// The stored escalation as the contract reads it back: the display fields the owner's screen showed, the stored reason and book status,
/// the expiry and whether it is still pending.
#[derive(Clone, Copy, Debug)]
pub struct StoredView<'a> {
    pub payee_key: &'a [u8],
    pub asset_symbol: &'a [u8],
    pub amount: u128,
    pub decimals: u8,
    pub reason: Reason,
    pub in_book: bool,
    pub expires_ms: u64,
    pub pending: bool,
}

/// The five arguments of `approve` after the id: `to`, `asset`, `amount`, `why` and `book`.
#[derive(Clone, Copy, Debug)]
pub struct ApproveArgs<'a> {
    pub to: &'a [u8],
    pub asset: &'a [u8],
    pub amount: &'a [u8],
    pub why: &'a [u8],
    pub book: &'a [u8],
}

/// What is true now: the clock, whether the agent is still allowed and the task not revoked, and the global pause.
#[derive(Clone, Copy, Debug)]
pub struct Live {
    pub now_ms: u64,
    pub agent_allowed: bool,
    pub task_revoked: bool,
    pub paused: bool,
}

fn over(x: Option<u128>, cap: u128) -> bool {
    matches!(x, Some(v) if v > cap)
}

/// the spike's P12 function: unknown asset, paused, amount 0 or over the hard cap, over the remaining daily cap, fee or gas over caps
pub fn recheck(req: &Request, asset: Option<AssetLimits>, paused: bool) -> Result<(), Reason> {
    let a = match asset {
        None => return Err(Reason::UnknownAsset),
        Some(a) => a,
    };
    if paused {
        return Err(Reason::Paused);
    }
    if req.amount == 0 || req.amount > a.hard_cap {
        return Err(Reason::AmountOutOfBounds);
    }
    if req.amount > a.remaining_daily {
        return Err(Reason::DailyLimit);
    }
    if over(req.fee_per_gas, a.max_fee_per_gas) || over(req.gas, a.max_gas) {
        return Err(Reason::FeeTooHigh);
    }
    Ok(())
}

fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// The checks in this order, the first failure wins: pending, not expired, `to`, `asset`, `amount`, `why`, `book`, agent still allowed,
/// task not revoked, then the limits (`recheck`). `req.amount`, `fee_per_gas` and `gas` feed only `recheck`; `stored.amount` feeds only
/// the display compare (the contract builds both from the same record field).
pub fn approve_check(
    stored: &StoredView,
    args: &ApproveArgs,
    req: &Request,
    asset: Option<AssetLimits>,
    live: &Live,
) -> Result<(), ApproveError> {
    if !stored.pending {
        return Err(ApproveError::NotPending);
    }
    if live.now_ms >= stored.expires_ms {
        return Err(ApproveError::Expired);
    }
    if !same(args.to, stored.payee_key) {
        return Err(ApproveError::WrongRecipient);
    }
    if !same(args.asset, stored.asset_symbol) {
        return Err(ApproveError::WrongAsset);
    }
    match decimal::format(stored.amount, stored.decimals) {
        Some((buf, len)) => {
            if !same(args.amount, &buf[..len]) {
                return Err(ApproveError::WrongAmount);
            }
        }
        None => return Err(ApproveError::WrongAmount),
    }
    if !same(args.why, stored.reason.as_str().as_bytes()) {
        return Err(ApproveError::WrongReason);
    }
    let book: &[u8] = if stored.in_book { BOOK_IN } else { BOOK_NEW };
    if !same(args.book, book) {
        return Err(ApproveError::WrongBook);
    }
    if !live.agent_allowed {
        return Err(ApproveError::AgentNotAllowed);
    }
    if live.task_revoked {
        return Err(ApproveError::TaskRevoked);
    }
    recheck(req, asset, live.paused).map_err(ApproveError::Limit)
}

#[cfg(kani)]
mod proofs {
    use super::*;
    use crate::*;

    fn any_request() -> Request {
        Request {
            amount: kani::any(),
            fee_per_gas: kani::any(),
            gas: kani::any(),
            labels: Labels {
                recipient: kani::any(),
                amount: kani::any(),
                pc: kani::any(),
            },
        }
    }

    fn any_asset() -> Option<AssetLimits> {
        if kani::any() {
            Some(AssetLimits {
                hard_cap: kani::any(),
                remaining_daily: kani::any(),
                max_fee_per_gas: kani::any(),
                max_gas: kani::any(),
            })
        } else {
            None
        }
    }

    /// P12: the approve-time recheck passes only for a registered asset that is not paused, with every limit holding, whatever the labels.
    #[kani::proof]
    fn p12_recheck_ok_implies_limits() {
        let (r, a, paused) = (any_request(), any_asset(), kani::any::<bool>());
        let res = recheck(&r, a, paused);
        kani::cover!(res.is_ok(), "recheck passes");
        kani::cover!(res.is_err(), "recheck fails");
        match a {
            None => assert!(res == Err(Reason::UnknownAsset)),
            Some(a) => {
                if res.is_ok() {
                    assert!(
                        !paused
                            && r.amount > 0
                            && r.amount <= a.hard_cap
                            && r.amount <= a.remaining_daily
                    );
                    if let Some(fee) = r.fee_per_gas {
                        assert!(fee <= a.max_fee_per_gas);
                    }
                    if let Some(g) = r.gas {
                        assert!(g <= a.max_gas);
                    }
                }
            }
        }
    }

    fn flip(buf: &mut [u8; 48], len: usize) {
        let i: usize = kani::any();
        kani::assume(i < len);
        let m: u8 = kani::any();
        kani::assume(m != 0);
        buf[i] ^= m;
    }

    /// everything symbolic except the stored amount, which the caller passes as LITERALS so that CBMC folds `decimal::format`
    fn mismatch_case(amount: u128, decimals: u8) {
        let kl: usize = kani::any();
        kani::assume(kl >= 1 && kl <= 6);
        let sl: usize = kani::any();
        kani::assume(sl >= 1 && sl <= 6);
        let key6: [u8; 6] = kani::any();
        let sym6: [u8; 6] = kani::any();
        let ri: usize = kani::any();
        kani::assume(ri < ALL_REASONS.len());
        let reason = ALL_REASONS[ri];
        let in_book: bool = kani::any();
        let expires_ms: u64 = kani::any();
        let live = Live {
            now_ms: kani::any(),
            agent_allowed: kani::any(),
            task_revoked: kani::any(),
            paused: kani::any(),
        };
        kani::assume(live.now_ms < expires_ms);
        let stored = StoredView {
            payee_key: &key6[..kl],
            asset_symbol: &sym6[..sl],
            amount,
            decimals,
            reason,
            in_book,
            expires_ms,
            pending: true,
        };
        let mut to = [0u8; 48];
        to[..kl].copy_from_slice(&key6[..kl]);
        let mut asset = [0u8; 48];
        asset[..sl].copy_from_slice(&sym6[..sl]);
        let (abuf, alen) = match decimal::format(amount, decimals) {
            Some(x) => x,
            None => {
                assert!(false, "bad decimals");
                return;
            }
        };
        let mut amt = abuf;
        let why_s = reason.as_str().as_bytes();
        let mut why = [0u8; 48];
        why[..why_s.len()].copy_from_slice(why_s);
        let book_s: &[u8] = if in_book { BOOK_IN } else { BOOK_NEW };
        let mut book = [0u8; 48];
        book[..book_s.len()].copy_from_slice(book_s);
        let which: u8 = kani::any();
        kani::assume(which < 5);
        let expected = match which {
            0 => {
                flip(&mut to, kl);
                ApproveError::WrongRecipient
            }
            1 => {
                flip(&mut asset, sl);
                ApproveError::WrongAsset
            }
            2 => {
                flip(&mut amt, alen);
                ApproveError::WrongAmount
            }
            3 => {
                flip(&mut why, why_s.len());
                ApproveError::WrongReason
            }
            _ => {
                flip(&mut book, book_s.len());
                ApproveError::WrongBook
            }
        };
        let args = ApproveArgs {
            to: &to[..kl],
            asset: &asset[..sl],
            amount: &amt[..alen],
            why: &why[..why_s.len()],
            book: &book[..book_s.len()],
        };
        let r = approve_check(&stored, &args, &any_request(), any_asset(), &live);
        kani::cover!(which == 2, "an amount byte is flipped");
        assert!(r == Err(expected));
    }

    /// AB10: changing one byte of exactly one of the five arguments returns that argument's Wrong* error, whatever the live state and the
    /// limits are (so no later error can mask it).
    #[kani::proof]
    #[kani::unwind(50)]
    fn approve_each_field_mismatch() {
        let c: u8 = kani::any();
        kani::assume(c < 3);
        match c {
            0 => mismatch_case(0, 0),
            1 => mismatch_case(4_200_000_000_000_000_000_000_000, 24),
            _ => mismatch_case(u128::MAX, 38),
        }
    }
}
